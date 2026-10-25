/// <reference types="@webgpu/types" />
import { Skia } from "react-native-skia";
import type { SkCanvas, SkImage, SkSurface } from "react-native-skia";
import { GPUTextureUsage } from "react-native-webgpu";
import { getVideoCanvas } from "./canvas";
import { releaseVideoMemory, reserveVideoMemory } from "./memory";
import { getVideoGpuDevice } from "./gpuDevice";
export { getVideoGpuDevice } from "./gpuDevice";

export type VideoGpuTextureFormat =
  | "rgba8unorm"
  | "bgra8unorm"
  | "rgba16float"
  | "r8unorm"
  | "depth24plus"
  | "depth32float";
export type VideoGpuTarget = {
  readonly texture: GPUTexture;
  readonly image: SkImage | null;
  readonly surface: SkSurface | null;
  readonly canvas: SkCanvas | null;
};
export type VideoGpuTextureOptions = {
  width: number;
  height: number;
  format?: VideoGpuTextureFormat;
  usage?: GPUTextureUsageFlags;
  /** Images sample the texture; surfaces let Skia draw into it. Both are
   * restricted to the color formats supported by Skia's native interop. */
  skia?: "image" | "surface" | "none";
  label?: string;
};
export type VideoGpuScope = {
  readonly device: GPUDevice;
  createTexture: (options: VideoGpuTextureOptions) => VideoGpuTarget;
  createBuffer: (descriptor: GPUBufferDescriptor) => GPUBuffer;
  /** Register pending CPU/ML work which reads this scope's resources. */
  track: <T>(start: () => Promise<T>) => Promise<T>;
  /** Submit owned Skia recordings, await tracked jobs and the shared GPU queue. */
  drain: () => Promise<void>;
  /** First detach every external image/surface consumer. Repeated calls return
   * the same promise; failed GPU drain retains resources and reservations. */
  dispose: () => Promise<void>;
};

type Resource = {
  reservation: number;
  texture?: GPUTexture;
  buffer?: GPUBuffer;
  image?: SkImage | null;
  surface?: SkSurface | null;
  canvas?: SkCanvas | null;
};

/** Create once on the consuming runtime, reuse targets across frames, then
 * dispose after removing consumers. Byte accounting is an explicit allocation
 * estimate, not driver RSS: codecs, shaders and driver padding are separate. */
export const createVideoGpuScope = (options?: {
  maxResources?: number;
  maxPendingJobs?: number;
}): VideoGpuScope => {
  "worklet";
  const device = getVideoGpuDevice();
  const maxResources = options?.maxResources ?? 32;
  const maxPendingJobs = options?.maxPendingJobs ?? 32;
  if (
    !Number.isSafeInteger(maxResources) ||
    maxResources <= 0 ||
    maxResources > 256 ||
    !Number.isSafeInteger(maxPendingJobs) ||
    maxPendingJobs <= 0 ||
    maxPendingJobs > 256
  ) {
    throw new Error("Invalid GPU scope bounds");
  }
  const resources: Resource[] = [];
  const pending = new Set<Promise<void>>();
  // Worklets materializes a separate lexical closure for each nested
  // function. Mutable primitives would be captured as stale copies.
  const state = {
    pendingCount: 0,
    jobGeneration: 0,
    jobFailure: undefined as unknown,
    hasJobFailure: false,
    closing: false,
    disposal: null as Promise<void> | null,
  };
  const ensureCapacity = () => {
    "worklet";
    if (state.closing) throw new Error("GPU scope is closing");
    if (resources.length >= maxResources)
      throw new Error("GPU scope resource limit exceeded");
  };
  const drainGpu = async () => {
    "worklet";
    // Wait even for rejected ML promises. Those failures do not imply that
    // other concurrent reads have finished.
    for (;;) {
      while (state.pendingCount) await Promise.all([...pending]);
      const generation = state.jobGeneration;
      for (const resource of resources) resource.surface?.flush(true);
      await device.queue.onSubmittedWorkDone();
      // drain() leaves the scope open. A job registered while awaiting the GPU
      // may submit further work after this fence; await that job and a new fence.
      if (!state.pendingCount && state.jobGeneration === generation) return;
    }
  };
  const drain = async () => {
    "worklet";
    await drainGpu();
    if (state.hasJobFailure) throw state.jobFailure;
  };
  const createTexture = (opts: VideoGpuTextureOptions): VideoGpuTarget => {
    "worklet";
    ensureCapacity();
    const format = opts.format ?? "rgba8unorm";
    const skia = opts.skia ?? "image";
    const bytesPerPixel =
      format === "rgba16float" ? 8 : format === "r8unorm" ? 1 : 4;
    const bytes = opts.width * opts.height * bytesPerPixel;
    if (
      !Number.isSafeInteger(opts.width) ||
      opts.width <= 0 ||
      !Number.isSafeInteger(opts.height) ||
      opts.height <= 0 ||
      !Number.isSafeInteger(bytes) ||
      ![
        "rgba8unorm",
        "bgra8unorm",
        "rgba16float",
        "r8unorm",
        "depth24plus",
        "depth32float",
      ].includes(format) ||
      !["image", "surface", "none"].includes(skia) ||
      (["r8unorm", "depth24plus", "depth32float"].includes(format) &&
        skia !== "none")
    ) {
      throw new Error("Invalid GPU texture dimensions, format or Skia view");
    }
    const required =
      skia === "surface"
        ? GPUTextureUsage.RENDER_ATTACHMENT
        : skia === "image"
          ? GPUTextureUsage.TEXTURE_BINDING
          : 0;
    const usage =
      (opts.usage ??
        GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST) | required;
    const reservation = reserveVideoMemory(
      bytes,
      opts.label ?? "video GPU texture",
    );
    const resource: Resource = { reservation };
    try {
      resource.texture = device.createTexture({
        size: { width: opts.width, height: opts.height },
        format,
        usage,
        label: opts.label,
      });
      if (skia === "surface") {
        resource.surface = Skia.Surface.MakeFromGPUTexture(resource.texture);
        resource.canvas = getVideoCanvas(resource.surface);
      } else if (skia === "image") {
        resource.image = Skia.Image.MakeFromGPUTexture(resource.texture);
      }
      resources.push(resource);
      return {
        texture: resource.texture,
        image: resource.image ?? null,
        surface: resource.surface ?? null,
        canvas: resource.canvas ?? null,
      };
    } catch (error) {
      // No texture has been exposed or submitted to any consumer yet.
      try {
        resource.canvas = null;
        resource.surface?.dispose();
        resource.surface = null;
        resource.image?.dispose();
        resource.image = null;
        resource.texture?.destroy();
        resource.texture = undefined;
        releaseVideoMemory(reservation);
      } catch {
        // Retain/account partial cleanup failures for the caller's state.disposal.
        resources.push(resource);
      }
      throw error;
    }
  };
  const createBuffer = (descriptor: GPUBufferDescriptor): GPUBuffer => {
    "worklet";
    ensureCapacity();
    if (!Number.isSafeInteger(descriptor.size) || descriptor.size <= 0)
      throw new Error("Invalid GPU buffer size");
    const reservation = reserveVideoMemory(
      descriptor.size,
      descriptor.label ?? "video GPU buffer",
    );
    try {
      const buffer = device.createBuffer(descriptor);
      resources.push({ buffer, reservation });
      return buffer;
    } catch (error) {
      try {
        releaseVideoMemory(reservation);
      } catch {
        // Keep a failed rollback reservation reachable for scope disposal.
        resources.push({ reservation });
      }
      throw error;
    }
  };
  const track = <T>(start: () => Promise<T>): Promise<T> => {
    "worklet";
    if (state.closing) throw new Error("GPU scope is closing");
    if (state.pendingCount >= maxPendingJobs)
      throw new Error("GPU scope pending job limit exceeded");
    state.pendingCount++;
    state.jobGeneration++;
    let job: Promise<T>;
    try {
      job = Promise.resolve(start());
    } catch (error) {
      state.pendingCount--;
      throw error;
    }
    let tracked: Promise<void>;
    tracked = job.then(
      () => {
        pending.delete(tracked);
        state.pendingCount--;
      },
      (error: unknown) => {
        if (!state.hasJobFailure) {
          state.hasJobFailure = true;
          state.jobFailure = error;
        }
        pending.delete(tracked);
        state.pendingCount--;
      },
    );
    pending.add(tracked);
    return job;
  };
  const dispose = (): Promise<void> => {
    "worklet";
    if (state.disposal) return state.disposal;
    state.closing = true;
    state.disposal = (async () => {
      "worklet";
      // If this fence fails, preserve all resources rather than destroy any
      // texture whose pending native use can no longer be established.
      await drainGpu();
      let failure: unknown;
      let hasFailure = false;
      for (let i = resources.length - 1; i >= 0; i--) {
        const resource = resources[i]!;
        try {
          resource.image?.dispose();
          resource.image = null;
          resource.canvas = null;
          resource.surface?.dispose();
          resource.surface = null;
          resource.texture?.destroy();
          resource.texture = undefined;
          resource.buffer?.destroy();
          resource.buffer = undefined;
          releaseVideoMemory(resource.reservation);
          resources.splice(i, 1);
        } catch (error) {
          if (!hasFailure) {
            hasFailure = true;
            failure = error;
          }
        }
      }
      if (hasFailure) throw failure;
    })();
    return state.disposal;
  };
  return { device, createTexture, createBuffer, track, drain, dispose };
};
