import type { SkCanvas, SkImage, SkSurface } from "react-native-skia";
import { releaseVideoFrameImage } from "./frameInterop";
import { getVideoGpuState, isVideoGpuDeviceGone } from "./gpuDevice";
import { releaseVideoMemory } from "./memory";
import type { VideoFrame } from "./types";

type PreviewResources = {
  surface?: SkSurface | null;
  canvas?: SkCanvas | null;
  images?: Array<SkImage | null>;
  frames?: VideoFrame[];
  reservation?: number;
  afterDraw?: (() => void) | null;
  native?: { dispose: () => void } | null;
  /** The GPU device generation the resources were made on (see
   * getVideoGpuState), when known. */
  generation?: number;
};

type QuarantineRuntime = typeof globalThis & {
  __rnskwgpuPreviewQuarantine?: PreviewResources[];
};

/** Whether the device the resources were made on was lost or replaced:
 * none of their work can still run, nor be waited for. */
const madeOnLostDevice = (resources: PreviewResources) => {
  "worklet";
  return (
    resources.generation !== undefined &&
    isVideoGpuDeviceGone({ generation: resources.generation, lost: false })
  );
};

/** Private UI-runtime quarantine. Detach consumers before calling this helper.
 * A failed drain keeps every potentially referenced resource and its accounting
 * alive until runtime teardown, or until React Native Skia replaced the GPU
 * device they were made on (see reclaimPreviewQuarantine); native codecs can
 * still close independently. Resources of a device that was lost or replaced
 * go without a drain. */
export const disposePreviewResources = (resources: PreviewResources) => {
  "worklet";
  const failure = { failed: false, error: undefined as unknown };
  try {
    if (!madeOnLostDevice(resources)) resources.surface?.flush(true);
    resources.afterDraw?.();
    resources.afterDraw = null;
    while (resources.images?.length) {
      resources.images[0]?.dispose();
      resources.images.shift();
    }
    while (resources.frames?.length) {
      const frame = resources.frames[0]!;
      releaseVideoFrameImage(frame);
      frame.dispose?.();
      resources.frames.shift();
    }
    resources.canvas = null;
    resources.surface?.dispose();
    resources.surface = null;
    releaseVideoMemory(resources.reservation ?? 0);
    resources.reservation = 0;
  } catch (error) {
    failure.failed = true;
    failure.error = error;
  }
  try {
    resources.native?.dispose();
    resources.native = null;
  } catch (error) {
    if (!failure.failed) failure.error = error;
    failure.failed = true;
  }
  if (failure.failed) {
    if (resources.generation === undefined) {
      try {
        resources.generation = getVideoGpuState().generation;
      } catch {
        /* without the recovery patch, kept until runtime teardown */
      }
    }
    ((globalThis as QuarantineRuntime).__rnskwgpuPreviewQuarantine ??= []).push(
      resources,
    );
  }
  return failure;
};

/** Releases what the quarantine kept for GPU devices that were lost or
 * replaced since: nothing of their work can still run. Call on the runtime
 * of the quarantine once its device changed (see getVideoGpuState). */
export const reclaimPreviewQuarantine = () => {
  "worklet";
  const quarantine = (globalThis as QuarantineRuntime)
    .__rnskwgpuPreviewQuarantine;
  if (!quarantine) return;
  for (let i = quarantine.length - 1; i >= 0; i--) {
    const resources = quarantine[i]!;
    if (!madeOnLostDevice(resources)) continue;
    quarantine.splice(i, 1);
    // A second failure puts it back, until runtime teardown.
    const failure = disposePreviewResources(resources);
    if (failure.failed)
      console.warn(
        "Video preview cleanup failed again after a GPU device replacement; resources remain accounted until native runtime teardown",
        failure.error,
      );
  }
};
