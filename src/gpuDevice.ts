/// <reference types="@webgpu/types" />
import { Platform } from "react-native";
import { Skia } from "react-native-skia";
import {
  GPUBufferUsage,
  GPUShaderStage,
  GPUTextureUsage,
  installWebGPU,
} from "react-native-webgpu";
import type { NativeVideoFrame, RNCanvasContext } from "react-native-webgpu";
import RNSkiaVideoModule from "./RNSkiaVideoModule";

// Captured on the RN runtime: NativeObject serializers carry it to each
// consuming worklet, where installWebGPU does not install RNWebGPU. Its
// methods run on the calling runtime.
const nativeWebGPU = globalThis.RNWebGPU;

/** Skia's GPU device, as this library follows it. React Native Skia replaces
 * a lost device (driver reset, out of memory, GPU work refused in the
 * background on iOS) with a new one: everything made on the lost device,
 * the GPUDevice imported from it included, then draws nothing. `generation`
 * numbers the device in use (React Native Skia's own count, the same on
 * every runtime); `lost` is true while that device is lost and not replaced
 * yet, when nothing renders. */
export type VideoGpuState = { generation: number; lost: boolean };

type SkiaGpuRecovery = typeof Skia & { __rnskvGpuGeneration?: () => number };

/** Any runtime, and cheap enough for every frame. Do not read `Skia.gpu`
 * off the RN runtime instead: its `lost` promise is kept for the runtime
 * that read it first, and settles on the RN runtime only. */
export const getVideoGpuState = (): VideoGpuState => {
  "worklet";
  const skia = Skia as SkiaGpuRecovery;
  if (typeof skia.__rnskvGpuGeneration !== "function") {
    throw new Error(
      "Skia GPU recovery patch is missing from the native binary. Apply the patch and rebuild the native app.",
    );
  }
  const value = skia.__rnskvGpuGeneration();
  return { generation: Math.abs(value), lost: !(value > 0) };
};

/** Whether the device of `since` was lost or replaced since it was read:
 * GPU work that failed meanwhile failed for that reason, and recovers once
 * the device is replaced. */
export const isVideoGpuDeviceGone = (since: VideoGpuState): boolean => {
  "worklet";
  try {
    const now = getVideoGpuState();
    return now.lost || now.generation !== since.generation;
  } catch {
    return false;
  }
};

type RuntimeDevice = { generation: number; device: GPUDevice | null };

/** Skia's device in use, imported once per runtime and device: on the RN,
 * UI and export runtimes alike, each import is the calling runtime's own.
 * After a replacement the next call imports the new device; objects made
 * from the previous one belong to the lost device. While the device is lost
 * and not replaced yet, this is still the lost one. Never destroy it, Skia
 * owns the device, and never hand a command encoder to another runtime. */
export const getVideoGpuDevice = (): GPUDevice => {
  "worklet";
  const runtime = globalThis as typeof globalThis & {
    __rnskwgpuDevice?: RuntimeDevice;
  };
  const { generation } = getVideoGpuState();
  let current = runtime.__rnskwgpuDevice;
  if (!current || current.generation !== generation) {
    // A later replacement than `generation` reads as a newer generation on
    // the next call, which imports again.
    current = runtime.__rnskwgpuDevice = { generation, device: null };
  }
  if (!current.device) {
    if (!nativeWebGPU)
      throw new Error("React Native WebGPU is missing from the native app");
    installWebGPU();
    current.device = nativeWebGPU.importDevice(Skia.getNativeDevice());
  }
  return current.device;
};

// Negotiate before any Android decoder is prepared. The native side starts in
// CPU mode and probes EGL/AHB setup only when this shared Dawn device can
// import and end access to AHBs. Missing capability is a clean CPU fallback;
// budget failures, OOM and unrelated setup errors must remain visible.
const negotiateNativeBufferInterop = (device: GPUDevice) => {
  const features = device.features as ReadonlySet<string> | undefined;
  const supported = Boolean(
    typeof nativeWebGPU?.createVideoFrameFromNativeBuffer === "function" &&
    typeof features?.has === "function" &&
    features.has("shared-texture-memory-ahardware-buffer") &&
    features.has("shared-fence-sync-fd"),
  );
  try {
    RNSkiaVideoModule.configureNativeBufferInterop!(supported);
  } catch (error) {
    if (
      !supported ||
      !(error instanceof Error) ||
      !error.message.includes("Android native buffer interop unavailable:")
    )
      throw error;
    RNSkiaVideoModule.configureNativeBufferInterop!(false);
  }
};

/** RN runtime only, where `Skia.gpu.lost` settles: negotiates again for each
 * replacement device. Decoders made from then on follow the answer; a
 * replacement on the same adapter normally has the same features. */
const renegotiateAfterDeviceLoss = () => {
  let lost: Promise<unknown> | undefined;
  try {
    lost = (Skia as { gpu?: { lost?: Promise<unknown> } }).gpu?.lost;
  } catch {
    return;
  }
  lost?.then(
    () => {
      try {
        negotiateNativeBufferInterop(getVideoGpuDevice());
      } catch (error) {
        // The previous configuration stays: a failed enable left it off.
        console.warn(
          "[react-native-skia-webgpu-video] Android native buffer interop could not be negotiated for the replaced GPU device:",
          String(error),
        );
      }
      renegotiateAfterDeviceLoss();
    },
    () => {},
  );
};

if (
  Platform.OS === "android" &&
  RNSkiaVideoModule.configureNativeBufferInterop
) {
  negotiateNativeBufferInterop(getVideoGpuDevice());
  renegotiateAfterDeviceLoss();
}

export const createNativeVideoGpuFrame = (
  pointer: bigint,
): NativeVideoFrame => {
  "worklet";
  if (!nativeWebGPU)
    throw new Error("React Native WebGPU is missing from the native app");
  return nativeWebGPU.createVideoFrameFromNativeBuffer(pointer);
};

/** Android: a canvas context presenting to a native window that is not a
 * view, such as an encoder's input Surface. */
export const createNativeWindowGpuContext = (
  window: bigint,
  width: number,
  height: number,
): RNCanvasContext => {
  "worklet";
  if (
    typeof nativeWebGPU?.MakeWebGPUCanvasContextFromNativeWindow !== "function"
  )
    throw new Error(
      "React Native WebGPU cannot present to a native window; 0.19.0 or later is required",
    );
  return nativeWebGPU.MakeWebGPUCanvasContextFromNativeWindow(
    window,
    width,
    height,
  );
};

export const nativeVideoTextureUsage =
  GPUTextureUsage.RENDER_ATTACHMENT |
  GPUTextureUsage.TEXTURE_BINDING |
  GPUTextureUsage.COPY_SRC;

// An encoder's input window only receives copies of the frames Skia drew.
export const encoderWindowTextureUsage =
  GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST;

// CPU RGBA uploads additionally need COPY_DST. Keep the native-buffer blit's
// descriptor unchanged: that path renders into its destination attachment.
export const rgbaVideoTextureUsage =
  nativeVideoTextureUsage | GPUTextureUsage.COPY_DST;

// The flag globals exist only on the RN runtime: worklets capture these.
export const videoShaderStages = {
  vertex: GPUShaderStage.VERTEX,
  fragment: GPUShaderStage.FRAGMENT,
};
export const videoUniformBufferUsage =
  GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
