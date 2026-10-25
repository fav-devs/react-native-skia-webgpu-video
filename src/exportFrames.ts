/// <reference types="@webgpu/types" />
import { Platform } from "react-native";
import { BlendMode, Skia } from "react-native-skia";
import type { SkImage } from "react-native-skia";
import type {
  GPUSharedTextureMemory,
  GPUSharedTextureMemoryDescriptor,
  NativeVideoFrame,
} from "react-native-webgpu";
import {
  createNativeVideoGpuFrame,
  getVideoGpuDevice,
  nativeVideoTextureUsage,
} from "./gpuDevice";
import {
  frameByteSize,
  releaseVideoMemory,
  reserveVideoMemory,
} from "./memory";
import type { VideoFrame } from "./types";
import {
  blitNv12Frame,
  blitYuvFrame,
  releaseYuvImport,
  releaseYuvImports,
  yuvFrameRegion,
} from "./yuvBlit";
import type { YuvImport } from "./yuvBlit";

/** A decoded frame sampled in place, without an owned snapshot: a BGRA
 * frame's IOSurface on iOS, or for a YUV frame (Android, iOS NV12) its
 * producer's RGBA texture, which the decoder buffer was just converted into.
 * The decoder lease stays open while the image is in use. */
export type ExportFrameImport = {
  id: number;
  frame: VideoFrame;
  nativeFrame: NativeVideoFrame | null;
  memory: GPUSharedTextureMemory | null;
  texture: GPUTexture | null;
  accessing: boolean;
  image: SkImage | null;
  /** Android: later leases of the same picture, already closed. */
  aliases?: WeakSet<VideoFrame>;
};

/** The texture a producer's YUV frames are converted into. */
type ProducerTexture = { texture: GPUTexture; reservation: number };

/** Per export session, keyed by producer. `enabled` turns off after a first
 * failed import, before any frame was sampled in place. */
export type ExportFrameImports = {
  entries: Map<number, ExportFrameImport>;
  /** Producers sampled in place; frameInterop never caches their frames. */
  producers: Set<number>;
  enabled: boolean;
  imported: boolean;
  /** One RGBA texture per producer of YUV frames, rewritten by each frame. */
  textures: Map<number, ProducerTexture>;
  /** Android: decoder buffers imported once (see yuvBlit.ts). */
  yuv: Map<number, YuvImport[]>;
};

type SharedMemoryDevice = GPUDevice & {
  importSharedTextureMemory?: (
    descriptor: GPUSharedTextureMemoryDescriptor,
  ) => GPUSharedTextureMemory;
};

type NativeBufferTexture = {
  kind: "native-buffer";
  nativeBuffer: bigint;
  region?: { x: number; y: number; width: number; height: number };
  rotation?: number;
  /** iOS: the decoder's NV12 buffer (`framePixelFormat: 'yuv'`), or BGRA. */
  format?: "nv12" | "bgra8";
};

// Captured on the RN runtime. Android samples its ImageReader YUV frames
// (those with a `region`) once converted; other Android frames are copied.
const convertsYuv = Platform.OS === "android";

export const createExportFrameImports = (): ExportFrameImports => {
  "worklet";
  return {
    entries: new Map(),
    producers: new Set(),
    enabled: true,
    imported: false,
    textures: new Map(),
    yuv: new Map(),
  };
};

/** Decoder frames this path can sample in place; others use frameInterop. */
export const canImportInPlace = (frame: VideoFrame): boolean => {
  "worklet";
  const texture = frame.texture as NativeBufferTexture | null | undefined;
  return (
    texture?.kind === "native-buffer" &&
    frame.id !== undefined &&
    (!convertsYuv || texture.region !== undefined)
  );
};

// Declared before its callers: worklets capture their closure on creation.
/** Call only once every recording sampling the image has completed (a
 * checked flush(true)). An access that cannot end throws: the export must
 * then keep the lease and fail rather than recycle a buffer still in use. */
export const releaseExportFrame = (entry: ExportFrameImport): void => {
  "worklet";
  entry.image?.dispose();
  entry.image = null;
  if (entry.accessing && entry.memory && entry.texture) {
    const ended = entry.memory.endAccess(entry.texture);
    entry.accessing = false;
    for (const state of ended?.fences ?? []) state.fence.destroy();
  }
  entry.accessing = false;
  entry.texture?.destroy();
  entry.texture = null;
  entry.memory?.destroy();
  entry.memory = null;
  entry.nativeFrame?.release();
  entry.nativeFrame = null;
  entry.frame.dispose?.();
};

/** Releases a producer's texture and decoder buffer imports. Call only once
 * its last frame's GPU work has completed. */
const releaseProducerTexture = (
  imports: ExportFrameImports,
  producer: number,
): void => {
  "worklet";
  releaseYuvImports(imports.yuv, producer);
  const target = imports.textures.get(producer);
  if (target) {
    target.texture.destroy();
    releaseVideoMemory(target.reservation);
    imports.textures.delete(producer);
  }
};

/** Converts a decoded YUV frame (an Android ImageReader buffer, or an iOS
 * NV12 one) into its producer's RGBA texture, wrapped as a Skia image. The
 * conversion is submitted ahead of the frame's drawing, on the same queue;
 * the export's checked flush waits for both before the lease or the texture
 * is reused. */
const importYuvExportFrame = (
  imports: ExportFrameImports,
  frame: VideoFrame,
): ExportFrameImport => {
  "worklet";
  const entry: ExportFrameImport = {
    id: frame.id!,
    frame,
    nativeFrame: null,
    memory: null,
    texture: null,
    accessing: false,
    image: null,
  };
  const producer = frame.producerId ?? frame.id!;
  const source = frame.texture as NativeBufferTexture;
  let submitted = false;
  let target: ProducerTexture | undefined;
  try {
    entry.nativeFrame = createNativeVideoGpuFrame(source.nativeBuffer);
    const rotation = source.rotation ?? 0;
    // iOS NV12: the whole buffer, in decoded orientation.
    const nv12 = source.format === "nv12";
    if (
      nv12 &&
      (entry.nativeFrame.width !== frame.width ||
        entry.nativeFrame.height !== frame.height)
    )
      throw new Error("Native video buffer dimensions mismatch");
    const region = nv12
      ? null
      : yuvFrameRegion(source.region!, rotation, entry.nativeFrame);
    const device = getVideoGpuDevice();
    target = imports.textures.get(producer);
    if (
      target &&
      (target.texture.width !== frame.width ||
        target.texture.height !== frame.height)
    ) {
      // A resized clip: its previous frame completed with the last export
      // frame, so the texture can go.
      releaseProducerTexture(imports, producer);
      target = undefined;
    }
    if (!target) {
      const reservation = reserveVideoMemory(
        frameByteSize(frame.width, frame.height),
        "export frame texture",
      );
      try {
        target = {
          texture: device.createTexture({
            size: { width: frame.width, height: frame.height },
            format: "rgba8unorm",
            usage: nativeVideoTextureUsage,
            label: "video export source frame",
          }),
          reservation,
        };
      } catch (error) {
        releaseVideoMemory(reservation);
        throw error;
      }
      imports.textures.set(producer, target);
    }
    // Can throw after submitting: drain below before giving the lease back.
    submitted = true;
    if (nv12) blitNv12Frame(device, entry.nativeFrame, target.texture);
    else
      blitYuvFrame(
        device,
        imports.yuv,
        producer,
        entry.nativeFrame,
        rotation,
        region!,
        target.texture,
      );
    entry.image = Skia.Image.MakeFromGPUTexture(target.texture);
    if (!entry.image) throw new Error("Cannot wrap the decoded frame");
    return entry;
  } catch (error) {
    // The lease stays with the caller, which still owns the decoded frame;
    // a submitted conversion must have completed before it is given back.
    try {
      entry.image?.dispose();
      if (submitted && target) {
        const drain = Skia.Surface.MakeFromGPUTexture(target.texture);
        drain?.getCanvas().drawColor(Skia.Color("#00000000"), BlendMode.Clear);
        drain?.flush(true);
        drain?.dispose();
      }
      entry.nativeFrame?.release();
    } catch {
      /* the native wrappers close with their JS objects */
    }
    throw error;
  }
};

/** Wraps a decoded BGRA CVPixelBuffer's IOSurface as a Skia image, read-only.
 * The decoder already finished writing it; no producer fence is needed. A
 * YUV frame (Android, iOS NV12) is converted instead (see importYuvExportFrame). */
export const importExportFrame = (
  frame: VideoFrame,
  imports?: ExportFrameImports,
): ExportFrameImport => {
  "worklet";
  if (
    convertsYuv ||
    (frame.texture as NativeBufferTexture).format === "nv12"
  ) {
    if (!imports) throw new Error("YUV in-place frames need their imports");
    return importYuvExportFrame(imports, frame);
  }
  const entry: ExportFrameImport = {
    id: frame.id!,
    frame,
    nativeFrame: null,
    memory: null,
    texture: null,
    accessing: false,
    image: null,
  };
  try {
    const texture = frame.texture as NativeBufferTexture;
    entry.nativeFrame = createNativeVideoGpuFrame(texture.nativeBuffer);
    if (
      entry.nativeFrame.width !== frame.width ||
      entry.nativeFrame.height !== frame.height ||
      entry.nativeFrame.pixelFormat !== "bgra8"
    ) {
      throw new Error("Native video buffer dimensions or BGRA layout mismatch");
    }
    const device = getVideoGpuDevice() as SharedMemoryDevice;
    if (typeof device.importSharedTextureMemory !== "function") {
      throw new Error("WebGPU shared texture memory is unavailable");
    }
    entry.memory = device.importSharedTextureMemory({
      handle: entry.nativeFrame.handle,
      label: "video export source frame",
    });
    entry.texture = entry.memory.createTexture();
    entry.memory.beginAccess(entry.texture, true);
    entry.accessing = true;
    entry.image = Skia.Image.MakeFromGPUTexture(entry.texture);
    if (!entry.image) throw new Error("Cannot wrap the decoded frame");
    return entry;
  } catch (error) {
    // Nothing was submitted: closing this access cannot race the GPU. The
    // lease stays with the caller, which still owns the decoded frame.
    try {
      entry.image?.dispose();
      entry.image = null;
      if (entry.accessing && entry.memory && entry.texture) {
        const ended = entry.memory.endAccess(entry.texture);
        for (const state of ended?.fences ?? []) state.fence.destroy();
      }
      entry.accessing = false;
      entry.texture?.destroy();
      entry.memory?.destroy();
      entry.nativeFrame?.release();
    } catch {
      /* the native wrappers close with their JS objects */
    }
    throw error;
  }
};

/** Releases every in-place frame; the last GPU recording must have completed. */
export const releaseExportFrames = (imports: ExportFrameImports): void => {
  "worklet";
  for (const [producer, entry] of imports.entries) {
    releaseExportFrame(entry);
    imports.entries.delete(producer);
  }
  for (const producer of [...imports.textures.keys(), ...imports.yuv.keys()])
    releaseProducerTexture(imports, producer);
};

/** Releases every in-place frame of a session whose GPU device was lost or
 * replaced, without the completion that releaseExportFrames needs: nothing
 * submitted on that device can still run. Best effort, one object at a
 * time: one that cannot close is left to its JS owner. */
export const abandonExportFrames = (imports: ExportFrameImports): void => {
  "worklet";
  const attempt = (release: () => void) => {
    "worklet";
    try {
      release();
    } catch {
      /* made on the lost device; its wrapper closes when collected */
    }
  };
  for (const entry of imports.entries.values())
    attempt(() => releaseExportFrame(entry));
  imports.entries.clear();
  for (const entries of imports.yuv.values())
    for (const entry of entries) attempt(() => releaseYuvImport(entry));
  imports.yuv.clear();
  for (const target of imports.textures.values()) {
    attempt(() => target.texture.destroy());
    attempt(() => releaseVideoMemory(target.reservation));
  }
  imports.textures.clear();
};

/** The export counterpart of ownVideoFrames on iOS: decoded frames are drawn
 * in place, and a producer's previous frame is released once its next one is
 * imported, since the export waits for the GPU to complete a frame before it
 * imports the next one. Other frames, or every frame after a first failed
 * import, use `fallback`. */
export const ownExportFrames = (
  imports: ExportFrameImports,
  decoded: Record<string, VideoFrame>,
  fallback: (frames: Record<string, VideoFrame>) => Record<string, VideoFrame>,
): Record<string, VideoFrame> => {
  "worklet";
  const owned: Record<string, VideoFrame> = {};
  const held = new Set<VideoFrame>();
  const current = new Map<number, number>();
  try {
    for (const [key, frame] of Object.entries(decoded)) {
      if (!imports.enabled || !canImportInPlace(frame)) continue;
      const producer = frame.producerId ?? frame.id!;
      const seen = current.get(producer);
      if (seen !== undefined && seen !== frame.id) {
        throw new Error(
          "Composition yielded different frames for one producer; stable native frame identities are required",
        );
      }
      let entry = imports.entries.get(producer);
      // The extractor hands back the same native frame while a clip holds
      // its picture: that lease is still ours, keep sampling it.
      if (entry?.id !== frame.id) {
        let next: ExportFrameImport;
        try {
          next = importExportFrame(frame, imports);
        } catch (error) {
          if (imports.imported) throw error;
          imports.enabled = false;
          console.warn(
            "[react-native-skia-webgpu-video] In-place frame import unavailable, copying decoded frames:",
            String(error),
          );
          continue;
        }
        imports.imported = true;
        if (entry) {
          try {
            releaseExportFrame(entry);
          } catch (error) {
            // Keep the unreleased entry tracked; the new one was never used.
            try {
              releaseExportFrame(next);
            } catch {
              /* nothing was submitted with it */
            }
            throw error;
          }
        }
        imports.entries.set(producer, next);
        imports.producers.add(producer);
        entry = next;
      } else if (convertsYuv && entry && entry.frame !== frame) {
        // Android leases a picture afresh on every decode, also one a clip
        // still holds: the entry keeps its first lease, this one closes.
        entry.aliases ??= new WeakSet();
        if (!entry.aliases.has(frame)) {
          entry.aliases.add(frame);
          frame.dispose?.();
        }
      }
      held.add(frame);
      current.set(producer, frame.id!);
      owned[key] = {
        width: frame.width,
        height: frame.height,
        rotation: frame.rotation,
        crop: frame.crop,
        id: frame.id,
        producerId: producer,
        texture: { kind: "skia-image", image: entry!.image! },
      };
    }
    // Clips that left the composition. A failed release stays tracked.
    for (const [producer, entry] of imports.entries) {
      if (current.has(producer)) continue;
      releaseExportFrame(entry);
      imports.entries.delete(producer);
      releaseProducerTexture(imports, producer);
    }
  } catch (error) {
    // Close the leases this call does not hold; none reached the fallback.
    for (const frame of Object.values(decoded)) {
      if (held.has(frame)) continue;
      const producer = frame.producerId ?? frame.id;
      const entry =
        producer === undefined ? undefined : imports.entries.get(producer);
      if (entry && entry.id === frame.id) continue;
      try {
        frame.dispose?.();
      } catch {
        /* the native frame closes with its JS object */
      }
    }
    throw error;
  }
  // The fallback owns, closes or retains every frame it is handed.
  const rest: Record<string, VideoFrame> = {};
  let copying = false;
  for (const [key, frame] of Object.entries(decoded)) {
    if (held.has(frame)) continue;
    rest[key] = frame;
    copying = true;
  }
  return copying ? { ...owned, ...fallback(rest) } : owned;
};
