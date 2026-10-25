import { getVideoCanvas } from "./canvas";
import { Platform } from "react-native";
import { AlphaType, BlendMode, ColorType, Skia } from "react-native-skia";
import type { SkCanvas, SkImage, SkSurface } from "react-native-skia";
import type { VideoFrame } from "./types";
import type { NativeVideoFrame } from "react-native-webgpu";
import {
  getVideoGpuDevice,
  getVideoGpuState,
  createNativeVideoGpuFrame,
  nativeVideoTextureUsage,
  rgbaVideoTextureUsage,
} from "./gpuDevice";
import {
  frameByteSize,
  releaseVideoMemory,
  reserveVideoMemory,
} from "./memory";
import {
  blitNv12Frame,
  blitYuvFrame,
  releaseYuvImport,
  releaseYuvImports,
  yuvFrameRegion,
} from "./yuvBlit";
import type { YuvImport } from "./yuvBlit";

type FrameTexture =
  | {
      kind: "native-buffer";
      nativeBuffer: bigint;
      /** Android ImageReader frames: the codec's YUV buffer, whose picture is
       * this crop rectangle turned clockwise by `rotation` for display. */
      region?: { x: number; y: number; width: number; height: number };
      rotation?: number;
      /** iOS: the decoder's NV12 buffer (`framePixelFormat: 'yuv'`), or BGRA. */
      format?: "nv12" | "bgra8";
    }
  | {
      kind: "rgba";
      data: ArrayBuffer;
      bytesPerRow: number;
      copyPixelsTo?: (destination: ArrayBuffer) => void;
    }
  | { kind: "skia-image"; image: SkImage };
type Entry = {
  id: number;
  image: SkImage | null;
  reservation: number;
  releasedSources: WeakSet<VideoFrame>;
};
type PendingSource = {
  owned: SkImage | null;
  reservation: number;
  frame: VideoFrame;
  needsDrain: boolean;
  sourceReleased: boolean;
  nativeSource?: NativeVideoFrame | null;
};
type Cache = {
  /** The GPU device generation everything below was made on. */
  generation: number;
  images: Map<number, Entry>;
  stage: SkSurface | null;
  canvas: SkCanvas | null;
  width: number;
  height: number;
  format: GPUTextureFormat | null;
  uploadTexture: GPUTexture | null;
  uploadReservation: number;
  cpuPixels: Uint8Array<ArrayBuffer> | null;
  cpuReservation: number;
  cpuBytesPerRow: number;
  pendingSources: PendingSource[];
  /** Android decoder buffers imported once, per producer. */
  yuvImports: Map<number, YuvImport[]>;
};

// Capture a scalar on the RN runtime instead of importing Platform inside a
// worklet. iOS keeps its existing native-buffer and RGBA compatibility paths.
const uploadAndroidRgba = Platform.OS === "android";

/** Everything the cache holds was made on a GPU device that React Native
 * Skia has since replaced: none of its work can still run, so it is let go
 * without the drains a live device needs, leases a failed drain retained
 * included. Best effort: an object that cannot close is left to its JS
 * owner, and the pixels are gone either way. */
const abandonCache = (cache: Cache) => {
  "worklet";
  const attempt = (release: () => void) => {
    "worklet";
    try {
      release();
    } catch {
      /* made on the lost device; its wrapper closes when collected */
    }
  };
  for (const source of cache.pendingSources) {
    attempt(() => source.owned?.dispose());
    attempt(() => source.nativeSource?.release());
    if (!source.sourceReleased) attempt(() => source.frame.dispose?.());
    attempt(() => releaseVideoMemory(source.reservation));
  }
  for (const entry of cache.images.values()) {
    attempt(() => entry.image?.dispose());
    attempt(() => releaseVideoMemory(entry.reservation));
  }
  for (const entries of cache.yuvImports.values())
    for (const entry of entries) attempt(() => releaseYuvImport(entry));
  cache.canvas = null;
  attempt(() => cache.stage?.dispose());
  attempt(() => cache.uploadTexture?.destroy());
  attempt(() => releaseVideoMemory(cache.uploadReservation));
  attempt(() => releaseVideoMemory(cache.cpuReservation));
};

const getCache = (): Cache => {
  "worklet";
  const runtime = globalThis as typeof globalThis & {
    __rnskwgpuFrames?: Cache;
  };
  const { generation } = getVideoGpuState();
  const previous = runtime.__rnskwgpuFrames;
  if (previous && previous.generation !== generation) {
    runtime.__rnskwgpuFrames = undefined;
    abandonCache(previous);
  }
  if (!runtime.__rnskwgpuFrames) {
    runtime.__rnskwgpuFrames = {
      generation,
      images: new Map(),
      stage: null,
      canvas: null,
      width: 0,
      height: 0,
      format: null,
      uploadTexture: null,
      uploadReservation: 0,
      cpuPixels: null,
      cpuReservation: 0,
      cpuBytesPerRow: 0,
      pendingSources: [],
      yuvImports: new Map(),
    };
  }
  return runtime.__rnskwgpuFrames;
};

const clearEntry = (cache: Cache, producer: number) => {
  "worklet";
  const entry = cache.images.get(producer);
  if (entry) {
    entry.image?.dispose();
    entry.image = null;
    releaseVideoMemory(entry.reservation);
    cache.images.delete(producer);
  }
};

/** Release only the current Skia view, never the shared texture it wraps.
 * The caller has either not submitted a copy or has completed its GPU fence. */
const clearSurfaceView = (cache: Cache) => {
  "worklet";
  cache.canvas = null;
  cache.stage?.dispose();
  cache.stage = null;
};

const clearCpuPixels = (cache: Cache) => {
  "worklet";
  cache.cpuPixels = null;
  releaseVideoMemory(cache.cpuReservation);
  cache.cpuReservation = 0;
  cache.cpuBytesPerRow = 0;
};

const clearStagingSurface = (cache: Cache) => {
  "worklet";
  cache.stage?.flush(true);
  clearSurfaceView(cache);
  cache.uploadTexture?.destroy();
  cache.uploadTexture = null;
  releaseVideoMemory(cache.uploadReservation);
  cache.uploadReservation = 0;
  clearCpuPixels(cache);
  cache.width = cache.height = 0;
  cache.format = null;
};

/** Record explicit recovery work after a possibly submitted external copy.
 * Clearing scratch cannot modify an already owned snapshot. The checked fence
 * must succeed before either native lease or the texture can be released. */
const drainNativeCopies = (cache: Cache): void => {
  "worklet";
  if (!cache.stage || !cache.canvas)
    throw new Error("Video import drain surface is unavailable");
  cache.canvas.drawColor(Skia.Color("#00000000"), BlendMode.Clear);
  cache.stage.flush(true);
};

/** Clear a runtime's imported images after ending all its producers.
 * Do not clear a paused producer's current frame: its native source has
 * already been released, and the owned snapshot is its remaining pixels. */
export const clearVideoFrameImages = (releaseStagingSurface = false): void => {
  "worklet";
  const cache = getCache();
  if (cache.pendingSources.length) {
    // A failed drain retains leases; only a successful fence can release them.
    if (cache.pendingSources.some((source) => source.needsDrain)) {
      drainNativeCopies(cache);
      for (const source of cache.pendingSources) source.needsDrain = false;
    }
    while (cache.pendingSources.length) {
      const source = cache.pendingSources[0]!;
      source.owned?.dispose();
      source.owned = null;
      source.nativeSource?.release();
      source.nativeSource = null;
      if (!source.sourceReleased) {
        source.frame.dispose?.();
        source.sourceReleased = true;
      }
      releaseVideoMemory(source.reservation);
      cache.pendingSources.shift();
    }
  }
  clearSurfaceView(cache);
  for (const producer of cache.images.keys()) clearEntry(cache, producer);
  if (releaseStagingSurface) {
    clearStagingSurface(cache);
    // Every import's last frame completed: the queue drained above.
    releaseYuvImports(cache.yuvImports);
  }
};

/** Release an item which has left a composition or a producer being closed. */
export const releaseVideoFrameImage = (frame: VideoFrame): void => {
  "worklet";
  // Synthetic processor images without decoder identities belong to their
  // GPU scope. They must not evict the fallback native producer cache.
  if (
    frame.producerId === undefined &&
    frame.id === undefined &&
    (frame.texture as FrameTexture | null)?.kind === "skia-image"
  )
    return;
  const producer = frame.producerId ?? frame.id ?? -1;
  const cache = getCache();
  const entry = cache.images.get(producer);
  if (entry && entry.id === (frame.id ?? -1)) clearEntry(cache, producer);
  // Each import ends with a checked flush; after a failed one, only the
  // drain in clearVideoFrameImages may release the decoder buffers.
  if (!cache.pendingSources.length)
    releaseYuvImports(cache.yuvImports, producer);
  if (cache.images.size === 0) clearVideoFrameImages(true);
};

/** Returns immutable, owned pixels. WebGPU uploads Android RGBA pixels or blits
 * native buffers into one reusable texture, then snapshots a fresh Skia view.
 * Graphite-backed snapshots bypass the raster ImageProvider's image-count LRU.
 * Wait for completion before releasing sources or rewriting the scratch texture. */
export const imageFromVideoFrame = (frame: VideoFrame): SkImage | null => {
  "worklet";
  const cache = getCache();
  const producer = frame.producerId ?? frame.id;
  if (producer !== undefined && frame.id !== undefined) {
    const existing = cache.images.get(producer);
    if (existing?.id === frame.id && existing.image) {
      // Android can issue a fresh lease for the same paused picture. The
      // snapshot already owns its pixels, so close that unused native lease.
      // Weak tracking avoids retaining raw buffers or closing one wrapper twice.
      if (!existing.releasedSources.has(frame)) {
        frame.dispose?.();
        existing.releasedSources.add(frame);
      }
      return existing.image;
    }
  }
  let reservation = 0;
  let image: SkImage | null = null;
  let copyPending = false;
  let ownsSurfaceView = false;
  let nativeSource: NativeVideoFrame | null = null;
  let sourceDrained = false;
  let releaseSource = true;
  let importFailed = false;
  try {
    if (cache.pendingSources.length) {
      // A caller may retry the same native frame (or an alias of its stable
      // identity). Its existing pending entry still owns both leases; do not
      // let this rejected re-entry revoke the original decoder reservation.
      if (
        cache.pendingSources.some(
          (source) =>
            source.frame === frame ||
            (frame.id !== undefined &&
              source.frame.id === frame.id &&
              source.frame.producerId === frame.producerId),
        )
      )
        releaseSource = false;
      throw new Error(
        "Previous video import could not drain its GPU work; restart the native runtime",
      );
    }
    const texture = frame.texture as FrameTexture | null | undefined;
    if (!texture) return null;
    if (texture.kind === "skia-image") return texture.image;
    if (texture.kind !== "rgba" && texture.kind !== "native-buffer") {
      throw new Error(
        "Unsupported frame transport; use the Skia 3 video backend",
      );
    }
    const bytes = frameByteSize(frame.width, frame.height);
    // Keep the published image valid until its replacement has succeeded.
    // Account for the replacement's peak memory rather than evict paused pixels.
    const key = producer ?? -1;
    if (!cache.images.has(key) && cache.images.size >= 32) {
      throw new Error(
        "Too many cached video producers; close unused extractors",
      );
    }
    let rgbaPixels: Uint8Array<ArrayBuffer> | null = null;
    let requiredRgbaBytes = 0;
    let copyRgbaPixels = false;
    if (texture.kind === "rgba") {
      const required = texture.bytesPerRow * frame.height;
      if (
        !Number.isSafeInteger(texture.bytesPerRow) ||
        !Number.isSafeInteger(required) ||
        texture.bytesPerRow < frame.width * 4 ||
        (uploadAndroidRgba &&
          (texture.bytesPerRow > 0xffffffff || texture.bytesPerRow % 4 !== 0))
      ) {
        throw new Error("Invalid RGBA video frame storage");
      }
      requiredRgbaBytes = required;
      // Native Android data is lazy. Inspect the optional copy protocol before
      // reading that getter, which would otherwise retain a Java backing per
      // external ArrayBuffer until Hermes and ART have both collected it.
      copyRgbaPixels =
        uploadAndroidRgba && typeof texture.copyPixelsTo === "function";
      if (!copyRgbaPixels) {
        const pixels = new Uint8Array(texture.data);
        if (pixels.byteLength < required)
          throw new Error("Invalid RGBA video frame storage");
        if (uploadAndroidRgba) {
          // Exclude unused trailing storage without another pixel copy.
          rgbaPixels = new Uint8Array(texture.data, 0, required);
        } else {
          // Preserve the iOS compatibility raster path.
          reservation = reserveVideoMemory(
            pixels.byteLength,
            "owned video image",
          );
          const data = Skia.Data.fromBytes(pixels);
          try {
            image = Skia.Image.MakeRaster(
              {
                width: frame.width,
                height: frame.height,
                colorType: ColorType.RGBA_8888,
                alphaType: AlphaType.Opaque,
              },
              data,
              texture.bytesPerRow,
            );
          } finally {
            data.dispose();
          }
        }
      }
    }
    if (texture.kind === "native-buffer" || rgbaPixels || copyRgbaPixels) {
      const device = getVideoGpuDevice();
      const uploadRgba = texture.kind === "rgba";
      if (uploadRgba || uploadAndroidRgba) {
        const extentLimit = device.limits.maxTextureDimension2D;
        if (
          !Number.isSafeInteger(extentLimit) ||
          extentLimit <= 0 ||
          frame.width > extentLimit ||
          frame.height > extentLimit
        )
          throw new Error(
            "Video frame exceeds the WebGPU texture extent limit",
          );
      }
      const format =
        uploadRgba || uploadAndroidRgba ? "rgba8unorm" : "bgra8unorm";
      reservation = reserveVideoMemory(bytes, "owned video image");
      if (
        !cache.uploadTexture ||
        cache.width !== frame.width ||
        cache.height !== frame.height ||
        cache.format !== format
      ) {
        clearStagingSurface(cache);
        cache.uploadReservation = reserveVideoMemory(
          bytes,
          uploadRgba
            ? "RGBA frame WebGPU upload texture"
            : "native frame WebGPU upload texture",
        );
        try {
          // One scratch texture per runtime. COPY_SRC lets Graphite snapshot
          // it with a GPU blit rather than draw into another staging target.
          cache.uploadTexture = device.createTexture({
            size: { width: frame.width, height: frame.height },
            format,
            // Android AHB and CPU frames share the RGBA scratch. Include
            // COPY_DST even for a first AHB frame, so a later CPU fallback
            // cannot reuse a texture that forbids writeTexture.
            usage:
              uploadRgba || uploadAndroidRgba
                ? rgbaVideoTextureUsage
                : nativeVideoTextureUsage,
            label: uploadRgba
              ? "video RGBA frame upload"
              : "video native frame upload",
          });
          cache.width = frame.width;
          cache.height = frame.height;
          cache.format = format;
        } catch (error) {
          try {
            clearStagingSurface(cache);
          } catch {
            /* unfinished cleanup/accounting stays reachable */
          }
          throw error;
        }
      }
      if (copyRgbaPixels && texture.kind === "rgba") {
        if (
          !cache.cpuPixels ||
          cache.cpuPixels.byteLength !== requiredRgbaBytes ||
          cache.cpuBytesPerRow !== texture.bytesPerRow
        ) {
          clearCpuPixels(cache);
          cache.cpuReservation = reserveVideoMemory(
            requiredRgbaBytes,
            "RGBA frame CPU upload buffer",
          );
          try {
            cache.cpuPixels = new Uint8Array(
              new ArrayBuffer(requiredRgbaBytes),
            );
            cache.cpuBytesPerRow = texture.bytesPerRow;
          } catch (error) {
            try {
              clearCpuPixels(cache);
            } catch {
              /* unfinished accounting stays reachable */
            }
            throw error;
          }
        }
        // The host function finishes memcpy synchronously. The private buffer
        // is never exposed as texture.data and is rewritten only after the
        // preceding import's checked fence. Saved raw aliases remain separate.
        texture.copyPixelsTo!(cache.cpuPixels.buffer);
        rgbaPixels = cache.cpuPixels;
      } else {
        // Native AHB frames and raw compatibility frames need no private CPU
        // scratch. This also closes CPU scratch on same-format RGBA -> AHB.
        clearCpuPixels(cache);
      }
      clearSurfaceView(cache);
      // WebGPU writes do not invalidate SkSurface's cached snapshot. A fresh
      // surface wrapper for every frame prevents stale pixels without another
      // GPU allocation or a write through Skia that would overwrite the input.
      cache.stage = Skia.Surface.MakeFromGPUTexture(cache.uploadTexture!);
      if (!cache.stage) throw new Error("Cannot wrap video upload texture");
      ownsSurfaceView = true;
      cache.canvas = getVideoCanvas(cache.stage);
      if (rgbaPixels && texture.kind === "rgba") {
        // Dawn consumes this typed-array view synchronously. Keep the source
        // alive through the checked fence, including a throw after enqueue.
        copyPending = true;
        device.queue.writeTexture(
          { texture: cache.uploadTexture! },
          rgbaPixels,
          {
            offset: 0,
            bytesPerRow: texture.bytesPerRow,
            rowsPerImage: frame.height,
          },
          { width: frame.width, height: frame.height, depthOrArrayLayers: 1 },
        );
      } else if (texture.kind === "native-buffer") {
        nativeSource = createNativeVideoGpuFrame(texture.nativeBuffer);
        const region = texture.region;
        const rotation = texture.rotation ?? 0;
        const nv12 = !region && texture.format === "nv12";
        let upright: ReturnType<typeof yuvFrameRegion> | null = null;
        if (region) {
          // An Android codec buffer: padded, YUV, in encoded orientation. The
          // blit converts, crops, turns and scales it into the frame-sized
          // scratch, as the GL path's SurfaceTexture transform did. RN WebGPU
          // labels driver-defined YUV formats "bgra8", yet Dawn imports them
          // as YUV: the native side checked the format, so the label is not
          // read.
          upright = yuvFrameRegion(region, rotation, nativeSource);
        } else if (nv12) {
          if (
            nativeSource.width !== frame.width ||
            nativeSource.height !== frame.height
          )
            throw new Error("Native video buffer dimensions mismatch");
        } else if (
          // RN WebGPU labels a single-plane Android RGBA AHB "bgra8". Dawn
          // reads the actual AHB format; the string distinguishes RGB from
          // NV12 and must not be read as Android's physical byte order.
          nativeSource.width !== frame.width ||
          nativeSource.height !== frame.height ||
          nativeSource.pixelFormat !== "bgra8"
        ) {
          throw new Error(
            "Native video buffer dimensions or BGRA layout mismatch",
          );
        }
        // The native call can throw after submitting; retain leases until a
        // checked queue drain even when it does not return normally.
        copyPending = true;
        if (region) {
          // copyExternalImageToTexture would also convert the video's
          // transfer function and primaries to sRGB (see yuvBlit.ts).
          blitYuvFrame(
            device,
            cache.yuvImports,
            key,
            nativeSource,
            rotation,
            upright!,
            cache.uploadTexture!,
          );
        } else if (nv12) {
          // Decoded orientation, as below: drawVideoFrame applies rotation.
          blitNv12Frame(device, nativeSource, cache.uploadTexture!);
        } else {
          // Keep decoded orientation: drawVideoFrame applies rotation once.
          device.queue.copyExternalImageToTexture(
            {
              source: nativeSource,
              rotation: 0,
              mirrored: false,
              flipY: false,
            },
            { texture: cache.uploadTexture!, premultipliedAlpha: false },
            { width: frame.width, height: frame.height },
          );
        }
      }
      // Snapshot records an independent texture copy and submits it after
      // the external blit on the shared queue. The wrapper never draws.
      image = cache.stage.makeImageSnapshot();
      cache.stage.flush(true);
      sourceDrained = true;
    }
    if (!image) throw new Error("Cannot create a video frame image");
    // Complete the native handoff before replacing published pixels. A failed
    // source close must not evict a paused image or leave an unpublished cache
    // entry behind when the caller receives an import error.
    if (ownsSurfaceView) {
      clearSurfaceView(cache);
      ownsSurfaceView = false;
    }
    nativeSource?.release();
    nativeSource = null;
    frame.dispose?.();
    releaseSource = false;
    clearEntry(cache, key);
    cache.images.set(key, {
      id: frame.id ?? -1, image, reservation,
      releasedSources: new WeakSet([frame]),
    });
    return image;
  } catch (error) {
    importFailed = true;
    if (copyPending && !sourceDrained) {
      try {
        drainNativeCopies(cache);
      } catch {
        cache.pendingSources.push({
          nativeSource,
          owned: image,
          reservation,
          frame,
          needsDrain: true,
          sourceReleased: false,
        });
        nativeSource = null;
        image = null;
        reservation = 0;
        releaseSource = false;
      }
    }
    try {
      // Failed drains retain the view along with its texture and source.
      if (releaseSource && ownsSurfaceView) {
        clearSurfaceView(cache);
        ownsSurfaceView = false;
      }
      image?.dispose();
      image = null;
      releaseVideoMemory(reservation);
    } catch {
      cache.pendingSources.push({
        nativeSource,
        owned: image,
        reservation,
        frame,
        needsDrain: false,
        sourceReleased: false,
      });
      nativeSource = null;
      releaseSource = false;
    }
    throw error;
  } finally {
    if (releaseSource) {
      try {
        nativeSource?.release();
        nativeSource = null;
        frame.dispose?.();
      } catch (error) {
        cache.pendingSources.push({
          nativeSource,
          owned: null,
          reservation: 0,
          frame,
          needsDrain: false,
          sourceReleased: false,
        });
        if (!importFailed) throw error;
      }
    }
  }
};

/** Stage all issued frames, including items a callback currently hides.
 * This releases decoder leases promptly instead of waiting for JS GC. */
export const ownVideoFrames = (
  frames: Record<string, VideoFrame>,
): Record<string, VideoFrame> => {
  "worklet";
  const owned: Record<string, VideoFrame> = {};
  const visited = new Set<VideoFrame>();
  const failed = { value: false, error: undefined as unknown };
  try {
    // Two different pictures from one producer would invalidate the first
    // owned image while importing the second. Reject before allocating, and
    // permit aliases of the same stable native frame.
    const producers = new Map<number, VideoFrame>();
    for (const frame of Object.values(frames)) {
      if ((frame.texture as FrameTexture | null)?.kind === "skia-image")
        continue;
      const producer = frame.producerId ?? frame.id ?? -1;
      const previous = producers.get(producer);
      if (
        previous &&
        previous !== frame &&
        (frame.id === undefined ||
          previous.id === undefined ||
          previous.id !== frame.id)
      ) {
        throw new Error(
          "Composition yielded different frames for one producer; stable native frame identities are required",
        );
      }
      producers.set(producer, frame);
    }
    for (const [key, frame] of Object.entries(frames)) {
      visited.add(frame);
      const image = imageFromVideoFrame(frame);
      if (image)
        owned[key] = {
          width: frame.width,
          height: frame.height,
          rotation: frame.rotation,
          crop: frame.crop,
          // Synthetic processor images belong to their GPU scope. Raw anonymous
          // input uses the fallback cache, which still needs a releasable key.
          id:
            frame.id ??
            ((frame.texture as FrameTexture | null)?.kind === "skia-image"
              ? undefined
              : -1),
          producerId:
            frame.producerId ??
            frame.id ??
            ((frame.texture as FrameTexture | null)?.kind === "skia-image"
              ? undefined
              : -1),
          texture: { kind: "skia-image", image },
        };
    }
    return owned;
  } catch (error) {
    failed.value = true;
    failed.error = error;
    for (const frame of Object.values(owned)) {
      try {
        releaseVideoFrameImage(frame);
      } catch {
        /* retained/accounted by cache */
      }
    }
    throw error;
  } finally {
    // Idempotent native dispose covers untouched frames after an import fails.
    const pending = getCache().pendingSources;
    for (const frame of Object.values(frames)) {
      if (visited.has(frame)) continue;
      // Do not undo the failed-drain retention established by the importer.
      try {
        if (
          !pending.some(
            (source) =>
              source.frame === frame ||
              (frame.id !== undefined &&
                source.frame.id === frame.id &&
                source.frame.producerId === frame.producerId),
          )
        )
          frame.dispose?.();
      } catch (error) {
        // Keep an unsuccessful native close reachable for retry, but continue
        // releasing every independent untouched item and preserve import error.
        pending.push({
          owned: null,
          reservation: 0,
          frame,
          needsDrain: false,
          sourceReleased: false,
        });
        if (!failed.value) failed.error = error;
        failed.value = true;
      }
    }
    if (failed.value) throw failed.error;
  }
};
