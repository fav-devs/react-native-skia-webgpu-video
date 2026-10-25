import { Skia } from "react-native-skia";
import { importDevice } from "react-native-webgpu";
import RNSkiaVideoModule from "../RNSkiaVideoModule";

const mockCanvas = { dispose: jest.fn() };
const mockSurface = {
  enableCheckedSubmissions: jest.fn(),
  getCanvas: jest.fn(() => mockCanvas),
  flush: jest.fn(),
  dispose: jest.fn(),
};
const mockImage = { dispose: jest.fn() };
const mockTexture = () => ({ nativePointer: 123n, destroy: jest.fn() });
const mockBuffer = () => ({ destroy: jest.fn() });
const mockDevice = {
  createTexture: jest.fn(mockTexture),
  createBuffer: jest.fn(mockBuffer),
  queue: { onSubmittedWorkDone: jest.fn(() => Promise.resolve()) },
  destroy: jest.fn(),
};
jest.mock("react-native-skia", () => ({
  Skia: {
    getNativeDevice: jest.fn(() => 99n),
    Surface: { MakeFromGPUTexture: jest.fn(() => mockSurface) },
    Image: { MakeFromGPUTexture: jest.fn(() => mockImage) },
  },
}));
jest.mock("react-native-webgpu", () => ({
  importDevice: jest.fn(() => mockDevice),
  installWebGPU: jest.fn(),
  GPUTextureUsage: {
    RENDER_ATTACHMENT: 16,
    TEXTURE_BINDING: 4,
    COPY_SRC: 1,
    COPY_DST: 2,
  },
  GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8 },
  GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 },
}));
jest.mock("../RNSkiaVideoModule", () => ({
  __esModule: true,
  default: {
    reserveMemory: jest.fn(() => 17),
    releaseMemory: jest.fn(),
  },
}));
// The optional GPU entry imports the native shared device during initialization.
const { createVideoGpuScope, getVideoGpuDevice } =
  require("../gpu") as typeof import("../gpu");
const { nativeVideoTextureUsage } =
  require("../gpuDevice") as typeof import("../gpuDevice");
const deviceImportCount = (importDevice as jest.Mock).mock.calls.length;
const reserve = RNSkiaVideoModule.reserveMemory as jest.Mock;
const release = RNSkiaVideoModule.releaseMemory as jest.Mock;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flushMicrotasks = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
beforeEach(() => {
  jest.clearAllMocks();
  mockDevice.createTexture.mockReset().mockImplementation(mockTexture);
  mockDevice.createBuffer.mockReset().mockImplementation(mockBuffer);
  mockDevice.queue.onSubmittedWorkDone.mockReset().mockResolvedValue(undefined);
  (Skia.Surface.MakeFromGPUTexture as jest.Mock)
    .mockReset()
    .mockReturnValue(mockSurface);
  (Skia.Image.MakeFromGPUTexture as jest.Mock)
    .mockReset()
    .mockReturnValue(mockImage);
  mockSurface.getCanvas.mockReset().mockReturnValue(mockCanvas);
  reserve.mockReset().mockReturnValue(17);
});

describe("managed shared GPU scope", () => {
  it("uses the one imported Skia device, requires native texture usage, and never destroys that device", async () => {
    const scope = createVideoGpuScope();
    const second = createVideoGpuScope();
    expect(deviceImportCount).toBe(1);
    // Native snapshots must be copyable, as well as renderable and sampleable.
    expect(nativeVideoTextureUsage).toBe(1 | 4 | 16);
    expect(scope.device).toBe(mockDevice);
    expect(second.device).toBe(scope.device);
    expect(getVideoGpuDevice()).toBe(scope.device);
    const target = scope.createTexture({ width: 8, height: 4, usage: 1 });
    expect(reserve).toHaveBeenCalledWith(128, "video GPU texture");
    expect(mockDevice.createTexture).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: 5,
        size: { width: 8, height: 4 },
        format: "rgba8unorm",
      }),
    );
    expect(Skia.Image.MakeFromGPUTexture).toHaveBeenCalledWith(
      expect.objectContaining({ nativePointer: 123n }),
    );
    expect(target.image).toBe(mockImage);
    await scope.dispose();
    await second.dispose();
    expect(target.texture.destroy).toHaveBeenCalledTimes(1);
    expect(mockDevice.destroy).not.toHaveBeenCalled();
  });

  it("accounts format sizes and enforces resource bounds before native allocation", async () => {
    const scope = createVideoGpuScope({ maxResources: 2 });
    scope.createTexture({
      width: 4,
      height: 2,
      format: "rgba16float",
      skia: "none",
    });
    scope.createTexture({
      width: 4,
      height: 2,
      format: "r8unorm",
      skia: "none",
    });
    expect(reserve.mock.calls.map((call) => call[0])).toEqual([64, 8]);
    expect(() => scope.createBuffer({ size: 16, usage: 4 })).toThrow(
      "resource limit",
    );
    expect(mockDevice.createBuffer).not.toHaveBeenCalled();
    expect(() => createVideoGpuScope({ maxPendingJobs: 0 })).toThrow("bounds");
    await scope.dispose();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("releases failed texture and buffer allocation reservations", async () => {
    const scope = createVideoGpuScope();
    mockDevice.createTexture.mockImplementationOnce(() => {
      throw new Error("texture allocation failed");
    });
    expect(() => scope.createTexture({ width: 4, height: 2 })).toThrow(
      "texture allocation failed",
    );
    mockDevice.createBuffer.mockImplementationOnce(() => {
      throw new Error("buffer allocation failed");
    });
    expect(() => scope.createBuffer({ size: 64, usage: 4 })).toThrow(
      "buffer allocation failed",
    );
    expect(release).toHaveBeenCalledTimes(2);
    await scope.dispose();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("cleans partial Skia surface creation without publishing its GPU texture", async () => {
    const scope = createVideoGpuScope();
    mockSurface.getCanvas.mockImplementationOnce(() => {
      throw new Error("canvas creation failed");
    });
    expect(() =>
      scope.createTexture({ width: 4, height: 2, skia: "surface" }),
    ).toThrow("canvas creation failed");
    const texture = mockDevice.createTexture.mock.results[0]?.value;
    expect(Skia.Surface.MakeFromGPUTexture).toHaveBeenCalledWith(
      expect.objectContaining({ nativePointer: 123n }),
    );
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    expect(texture.destroy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    await scope.dispose();
    expect(texture.destroy).toHaveBeenCalledTimes(1);
  });

  it("waits for tracked CPU/ML work and the GPU fence before destroying resources", async () => {
    const scope = createVideoGpuScope();
    const target = scope.createTexture({
      width: 4,
      height: 2,
      skia: "surface",
    });
    const work = deferred();
    const fence = deferred();
    mockDevice.queue.onSubmittedWorkDone.mockReturnValueOnce(fence.promise);
    const job = scope.track(() => work.promise);
    const disposal = scope.dispose();
    expect(scope.dispose()).toBe(disposal);
    await flushMicrotasks();
    expect(mockDevice.queue.onSubmittedWorkDone).not.toHaveBeenCalled();
    expect(target.texture.destroy).not.toHaveBeenCalled();
    work.resolve();
    await job;
    await flushMicrotasks();
    expect(mockSurface.flush).toHaveBeenCalledWith(true);
    expect(mockDevice.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
    expect(target.texture.destroy).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    fence.resolve();
    await disposal;
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    expect(target.texture.destroy).toHaveBeenCalledTimes(1);
    expect(mockSurface.flush.mock.invocationCallOrder[0]!).toBeLessThan(
      (target.texture.destroy as jest.Mock).mock.invocationCallOrder[0]!,
    );
    expect(() => scope.createBuffer({ size: 16, usage: 4 })).toThrow("closing");
  });

  it("retains GPU resources and their reservations after a rejected completion fence", async () => {
    const scope = createVideoGpuScope();
    const target = scope.createTexture({ width: 4, height: 2 });
    const failure = new Error("device lost");
    mockDevice.queue.onSubmittedWorkDone.mockRejectedValueOnce(failure);
    const disposal = scope.dispose();
    await expect(disposal).rejects.toBe(failure);
    expect(scope.dispose()).toBe(disposal);
    expect(mockImage.dispose).not.toHaveBeenCalled();
    expect(target.texture.destroy).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(mockDevice.destroy).not.toHaveBeenCalled();
  });

  it("enforces job bounds before calling a factory, including reentrant factories", async () => {
    const scope = createVideoGpuScope({ maxPendingJobs: 1 });
    const work = deferred();
    const forbiddenFactory = jest.fn(() => Promise.resolve());
    const first = scope.track(() => {
      expect(() => scope.track(forbiddenFactory)).toThrow("pending job limit");
      return work.promise;
    });
    expect(() => scope.track(forbiddenFactory)).toThrow("pending job limit");
    expect(forbiddenFactory).not.toHaveBeenCalled();
    work.resolve();
    await first;
    await scope.dispose();
  });

  it("reports rejected tracked work but still drains other jobs and safely disposes", async () => {
    const scope = createVideoGpuScope();
    const target = scope.createTexture({ width: 4, height: 2 });
    const remaining = deferred();
    const failure = new Error("inference failed");
    const failed = scope.track(async () => {
      throw failure;
    });
    void failed.catch(() => undefined);
    const job = scope.track(() => remaining.promise);
    const drained = scope.drain();
    void drained.catch(() => undefined);
    await flushMicrotasks();
    expect(mockDevice.queue.onSubmittedWorkDone).not.toHaveBeenCalled();
    expect(target.texture.destroy).not.toHaveBeenCalled();
    remaining.resolve();
    await job;
    await expect(failed).rejects.toBe(failure);
    await expect(drained).rejects.toBe(failure);
    await expect(scope.dispose()).resolves.toBeUndefined();
    expect(target.texture.destroy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("retains accounting if destruction fails and cleans independent resources", async () => {
    const scope = createVideoGpuScope();
    const texture = scope.createTexture({
      width: 4,
      height: 2,
      skia: "none",
    }).texture;
    const buffer = scope.createBuffer({ size: 16, usage: 4 });
    const failure = new Error("texture destroy failed");
    (texture.destroy as jest.Mock).mockImplementationOnce(() => {
      throw failure;
    });
    await expect(scope.dispose()).rejects.toBe(failure);
    expect(buffer.destroy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(mockDevice.destroy).not.toHaveBeenCalled();
  });

  it("retains only the remaining resources when failed construction cleanup needs a retry", async () => {
    const scope = createVideoGpuScope();
    const failure = new Error("Skia surface creation failed");
    (Skia.Surface.MakeFromGPUTexture as jest.Mock).mockImplementationOnce(
      () => {
        throw failure;
      },
    );
    mockDevice.createTexture.mockImplementationOnce(() => {
      const texture = mockTexture();
      texture.destroy.mockImplementationOnce(() => {
        throw new Error("Texture destruction failed");
      });
      return texture;
    });
    expect(() =>
      scope.createTexture({ width: 4, height: 2, skia: "surface" }),
    ).toThrow(failure);
    expect(release).not.toHaveBeenCalled();
    await scope.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(
      mockDevice.createTexture.mock.results[0]?.value.destroy,
    ).toHaveBeenCalledTimes(2);
  });

  it("drains jobs registered during an in-flight GPU fence before declaring the scope ready", async () => {
    const scope = createVideoGpuScope();
    const firstFence = deferred();
    const secondFence = deferred();
    const work = deferred();
    mockDevice.queue.onSubmittedWorkDone
      .mockReturnValueOnce(firstFence.promise)
      .mockReturnValueOnce(secondFence.promise);
    let settled = false;
    const drained = scope.drain().then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(mockDevice.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
    const job = scope.track(() => work.promise);
    firstFence.resolve();
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(mockDevice.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
    work.resolve();
    await job;
    await flushMicrotasks();
    expect(mockDevice.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    secondFence.resolve();
    await drained;
    expect(settled).toBe(true);
    await scope.dispose();
  });

  it("preserves a failed buffer allocation error and retries a failed accounting rollback at disposal", async () => {
    const scope = createVideoGpuScope();
    const failure = new Error("GPU buffer allocation failed");
    mockDevice.createBuffer.mockImplementationOnce(() => {
      throw failure;
    });
    release.mockImplementationOnce(() => {
      throw new Error("Rollback release failed");
    });
    expect(() => scope.createBuffer({ size: 16, usage: 4 })).toThrow(failure);
    expect(release).toHaveBeenCalledTimes(1);
    await scope.dispose();
    expect(release).toHaveBeenCalledTimes(2);
    expect(mockDevice.destroy).not.toHaveBeenCalled();
  });
});
