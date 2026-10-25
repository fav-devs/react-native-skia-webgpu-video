// The GPU device generation React Native Skia reports (see gpuDevice.ts).
const mockGpuState = { generation: 1, lost: false };
jest.mock("../gpuDevice", () => ({
  getVideoGpuState: jest.fn(() => ({ ...mockGpuState })),
  isVideoGpuDeviceGone: jest.fn(
    (since: { generation: number }) =>
      mockGpuState.lost || mockGpuState.generation !== since.generation,
  ),
  getVideoGpuDevice: jest.fn(() => {
    throw new Error("Unexpected native import in this test");
  }),
  createNativeVideoGpuFrame: jest.fn(),
  nativeVideoTextureUsage: 20,
}));

import { Platform } from "react-native";
import { runOnRuntime, scheduleOnRN } from "react-native-worklets";
import { yieldToRuntime } from "../runtimeYield";
import { Skia } from "react-native-skia";
import RNSkiaVideoModule from "../RNSkiaVideoModule";
import {
  exportVideoComposition,
  type VideoFrameProcessingContext,
} from "../exportVideoComposition";
import type { VideoComposition, VideoFrame } from "../types";
import { createSerializedUiRuntime } from "../../test/utils/serializedUiRuntime";

// Separate worklet turns expose cancellation and overlapping export races.
const mockRuntimeTasks: Array<() => void> = [];
let mockSerializedRuntime: ReturnType<typeof createSerializedUiRuntime> | null =
  null;
let mockPoolDepth = 0;
const mockPoolReturnedThenables: boolean[] = [];
jest.mock("react-native-worklets", () => ({
  createWorkletRuntime: jest.fn(() => ({ name: "RNSkiaVideoExportRuntime" })),
  runOnRuntime: jest.fn((_runtime: unknown, fn: () => void) => () => {
    mockRuntimeTasks.push(mockSerializedRuntime?.unpackWorklet(fn) ?? fn);
  }),
  scheduleOnRN: jest.fn(
    (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
      mockSerializedRuntime
        ? mockSerializedRuntime.scheduleOnRN(fn, ...args)
        : fn(...args),
  ),
  createSynchronizable: jest.fn((initial: boolean) => {
    let value = initial;
    const synchronizable = {
      // Native getDirty reads a shared_ptr without reader/writer synchronization.
      getDirty: () => {
        throw new Error("Unsafe unsynchronized cancellation read");
      },
      getBlocking: () => value,
      setBlocking: (next: boolean) => {
        value = next;
      },
    };
    return mockSerializedRuntime?.host(synchronizable) ?? synchronizable;
  }),
}));
// Frames continue on the export runtime's own event loop.
jest.mock("../runtimeYield", () => ({
  yieldToRuntime: jest.fn((fn: () => void) => {
    mockRuntimeTasks.push(fn);
  }),
}));
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
let mockSurfaceCount = 0;
const mockMakeSurface = (_width: number, _height: number) => {
  const id = mockSurfaceCount++;
  const canvas = {
    id,
    drawColor: jest.fn(),
    readPixels: jest.fn(
      (
        _x: number,
        _y: number,
        _info: unknown,
        destination: Uint8Array<ArrayBuffer>,
      ) => destination,
    ),
    dispose: jest.fn(),
  };
  return {
    id,
    enableCheckedSubmissions: jest.fn(),
    getCanvas: jest.fn(() => canvas),
    flush: jest.fn(),
    dispose: jest.fn(),
  };
};
jest.mock("react-native-skia", () => ({
  Skia: {
    __rnskvTrimRecorderCache: jest.fn(),
    Surface: {
      MakeOffscreen: jest.fn((width: number, height: number) =>
        mockMakeSurface(width, height),
      ),
    },
    Color: jest.fn(() => 0),
    Data: { fromBytes: jest.fn() },
    Image: { MakeRaster: jest.fn() },
  },
  BlendMode: { Clear: 0 },
  ColorType: { RGBA_8888: 4, BGRA_8888: 6 },
  AlphaType: { Premul: 1, Opaque: 0 },
}));
jest.mock("../RNSkiaVideoModule", () => ({
  __esModule: true,
  default: {
    createVideoEncoder: jest.fn(),
    createVideoCompositionFramesExtractorSync: jest.fn(),
    reserveMemory: jest.fn(() => 42),
    releaseMemory: jest.fn(),
    runWithAutoreleasePool: jest.fn(),
  },
}));
const makeOffscreen = Skia.Surface.MakeOffscreen as jest.Mock;
const cacheApi = Skia as typeof Skia & {
  __rnskvTrimRecorderCache?: jest.Mock;
};
const trimRecorderCache = cacheApi.__rnskvTrimRecorderCache!;
const createVideoEncoder = RNSkiaVideoModule.createVideoEncoder as jest.Mock;
const createExtractor =
  RNSkiaVideoModule.createVideoCompositionFramesExtractorSync as jest.Mock;
const reserveMemory = RNSkiaVideoModule.reserveMemory as jest.Mock;
const releaseMemory = RNSkiaVideoModule.releaseMemory as jest.Mock;
const runWithAutoreleasePool =
  RNSkiaVideoModule.runWithAutoreleasePool as jest.Mock;
const makeImage = Skia.Image.MakeRaster as jest.Mock;
const dataFromBytes = Skia.Data.fromBytes as jest.Mock;
type Surface = ReturnType<typeof mockMakeSurface>;
const createEncoderMock = () => ({
  prepare: jest.fn(),
  encodeFrame: jest.fn(),
  finishWriting: jest.fn(),
  dispose: jest.fn(),
});
const createExtractorMock = () => ({
  start: jest.fn(),
  decodeCompositionFrames: jest.fn(() => ({})),
  dispose: jest.fn(),
});
const composition: VideoComposition = {
  duration: 1,
  items: [
    {
      id: "clip",
      path: "/videos/clip.mp4",
      compositionStartTime: 0,
      startTime: 0,
      duration: 1,
    },
  ],
};
const baseOptions = {
  videoComposition: composition,
  outPath: "/tmp/out.mp4",
  width: 640,
  height: 360,
  frameRate: 4,
  bitRate: 1_000_000,
};
type Options = Parameters<typeof exportVideoComposition>[0];
const prepareExport = (options: Partial<Options> = {}) => {
  const encoder = createEncoderMock();
  const extractor = createExtractorMock();
  createVideoEncoder.mockReturnValueOnce(encoder);
  createExtractor.mockReturnValueOnce(extractor);
  const drawFrame = jest.fn();
  const promise = exportVideoComposition({
    ...baseOptions,
    drawFrame,
    ...options,
  });
  void promise.catch(() => undefined);
  return { encoder, extractor, drawFrame, promise };
};
const flushMicrotasks = async () => {
  // Worklet setup, adapter preparation/disposal and queue settlement all use
  // promises. Drain their continuations before looking for the next task.
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const pumpTurn = async () => {
  await flushMicrotasks();
  const turn = mockRuntimeTasks.shift();
  if (turn) turn();
  await flushMicrotasks();
  return Boolean(turn);
};
const pumpAll = async () => {
  let idleTurns = 0;
  for (let i = 0; i < 1000; i++) {
    const ran = await pumpTurn();
    idleTurns = !ran && mockRuntimeTasks.length === 0 ? idleTurns + 1 : 0;
    if (idleTurns === 3) return;
  }
  throw new Error("Export did not yield or settle after 1000 turns");
};
const runExport = async (options: Partial<Options> = {}) => {
  const result = prepareExport(options);
  await pumpAll();
  await result.promise;
  return result;
};
const surfaceAt = (index = 0) =>
  makeOffscreen.mock.results[index]?.value as Surface;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const expectDisposed = (
  result: ReturnType<typeof prepareExport>,
  index = 0,
) => {
  expect(result.encoder.dispose).toHaveBeenCalledTimes(1);
  expect(result.extractor.dispose).toHaveBeenCalledTimes(1);
  // Disposing the surface detaches its canvas.
  expect(surfaceAt(index).dispose).toHaveBeenCalledTimes(1);
};
beforeEach(() => {
  delete (globalThis as { __rnskwgpuExport?: unknown }).__rnskwgpuExport;
  delete (globalThis as { __rnskwgpuFrames?: unknown }).__rnskwgpuFrames;
  jest.clearAllMocks();
  cacheApi.__rnskvTrimRecorderCache = trimRecorderCache;
  trimRecorderCache.mockReset();
  mockSerializedRuntime = null;
  mockPoolDepth = 0;
  mockPoolReturnedThenables.length = 0;
  runWithAutoreleasePool.mockReset().mockImplementation((fn: () => unknown) => {
    mockPoolDepth++;
    try {
      const result = fn();
      mockPoolReturnedThenables.push(
        result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          typeof (result as { then?: unknown }).then === "function",
      );
      return result;
    } finally {
      mockPoolDepth--;
    }
  });
  dataFromBytes.mockReset().mockImplementation(() => ({ dispose: jest.fn() }));
  makeImage.mockReset().mockImplementation(() => ({ dispose: jest.fn() }));
  // Aborted/failed setup may never consume a queued mock return value.
  createVideoEncoder.mockReset();
  createExtractor.mockReset();
  reserveMemory.mockReset().mockReturnValue(42);
  releaseMemory.mockReset();
  makeOffscreen.mockImplementation((width: number, height: number) =>
    mockMakeSurface(width, height),
  );
  mockRuntimeTasks.length = 0;
  mockSurfaceCount = 0;
  (Platform as { OS: string }).OS = "ios";
});

afterEach(() => {
  expect(mockPoolDepth).toBe(0);
  // A native autorelease pool ends when its callback returns. A Promise would
  // therefore let asynchronous native work escape the intended lifetime.
  expect(mockPoolReturnedThenables).not.toContain(true);
});

describe("exportVideoComposition", () => {
  it("keeps the serialized export graph bounded independently of frame count", async () => {
    const first = await runExport({ frameRate: 360 });
    const submitted = jest.mocked(runOnRuntime).mock.calls.map((call) => call[1]);
    // One setup closure and one frame closure; later frames yield on the
    // export runtime instead of hopping through the RN thread.
    expect(first.encoder.encodeFrame).toHaveBeenCalledTimes(360);
    expect(submitted).toHaveLength(2);
    expect(submitted[0]).not.toBe(submitted[1]);
    expect(yieldToRuntime).toHaveBeenCalledTimes(359);
    // The first frame's hop and the settlement.
    expect(scheduleOnRN).toHaveBeenCalledTimes(2);
    expectDisposed(first);
    jest.mocked(runOnRuntime).mockClear();
    const second = await runExport({ frameRate: 360 });
    const next = jest.mocked(runOnRuntime).mock.calls.map((call) => call[1]);
    expect(next).toHaveLength(2);
    expect(next[1]).not.toBe(submitted[1]);
    expectDisposed(second, 1);
  });

  it("encodes every full BGRA frame, synchronizes rendering, and releases the surface", async () => {
    const result = await runExport();
    const { encoder, extractor, drawFrame } = result;
    expect(makeOffscreen).toHaveBeenCalledTimes(1);
    expect(makeOffscreen).toHaveBeenCalledWith(640, 360);
    expect(encoder.prepare).toHaveBeenCalledTimes(1);
    expect(extractor.start).toHaveBeenCalledTimes(1);
    expect(encoder.encodeFrame.mock.calls.map((call) => call[1])).toEqual([
      0, 0.25, 0.5, 0.75,
    ]);
    for (const [pixels] of encoder.encodeFrame.mock.calls) {
      expect(pixels).toMatchObject({
        kind: "bgra",
        width: 640,
        height: 360,
        bytesPerRow: 2560,
      });
      expect(pixels.data).toBeInstanceOf(ArrayBuffer);
      expect(pixels.data.byteLength).toBe(640 * 360 * 4);
    }
    expect(extractor.decodeCompositionFrames).toHaveBeenNthCalledWith(3, 0.5);
    expect(drawFrame).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ currentTime: 0.5, width: 640, height: 360 }),
    );
    const surface = surfaceAt();
    const canvas = surface.getCanvas.mock.results[0]?.value;
    // Four rendered frames, a drain before processor disposal and final drain.
    expect(surface.flush).toHaveBeenCalledTimes(6);
    expect(surface.flush).toHaveBeenCalledWith(true);
    expect(canvas.readPixels).toHaveBeenCalledTimes(4);
    expect(canvas.readPixels).toHaveBeenCalledWith(
      0,
      0,
      expect.objectContaining({ width: 640, height: 360, colorType: 6 }),
      expect.any(Uint8Array),
      2560,
    );
    for (let i = 0; i < 4; i++) {
      expect(drawFrame.mock.invocationCallOrder[i]!).toBeLessThan(
        surface.flush.mock.invocationCallOrder[i]!,
      );
      expect(surface.flush.mock.invocationCallOrder[i]!).toBeLessThan(
        canvas.readPixels.mock.invocationCallOrder[i]!,
      );
      expect(canvas.readPixels.mock.invocationCallOrder[i]!).toBeLessThan(
        encoder.encodeFrame.mock.invocationCallOrder[i]!,
      );
    }
    expect(encoder.finishWriting).toHaveBeenCalledTimes(1);
    expectDisposed(result);
    expect(createVideoEncoder.mock.calls[0]?.[0]).toMatchObject({
      outPath: "/tmp/out.mp4",
      width: 640,
      height: 360,
      frameRate: 4,
      bitRate: 1_000_000,
      audioBitRate: 128000,
      audioSampleRate: 44100,
      audioChannelCount: 2,
    });
    expect(createVideoEncoder.mock.calls[0]?.[1]).toBe(composition);
  });
  it("reads RGBA on Android without changing frame dimensions", async () => {
    (Platform as { OS: string }).OS = "android";
    const { encoder } = await runExport({ width: 320, height: 180 });
    expect(encoder.encodeFrame.mock.calls[0]?.[0]).toMatchObject({
      kind: "rgba",
      width: 320,
      height: 180,
      bytesPerRow: 1280,
    });
    expect(
      surfaceAt().getCanvas.mock.results[0]?.value.readPixels,
    ).toHaveBeenCalledWith(
      0,
      0,
      expect.objectContaining({ width: 320, height: 180, colorType: 4 }),
      expect.any(Uint8Array),
      1280,
    );
  });
  it("forwards encoderMode and leaves it undefined by default", async () => {
    await runExport();
    expect(createVideoEncoder.mock.calls[0]?.[0].encoderMode).toBeUndefined();
    await runExport({ encoderMode: "direct" });
    expect(createVideoEncoder.mock.calls[1]?.[0]).toMatchObject({
      encoderMode: "direct",
    });
    await runExport({ encoderMode: "copy" });
    expect(createVideoEncoder.mock.calls[2]?.[0]).toMatchObject({
      encoderMode: "copy",
    });
  });
  it("retains no surface across equal or mixed-resolution exports", async () => {
    for (const size of [
      { width: 640, height: 360 },
      { width: 640, height: 360 },
      { width: 320, height: 180 },
    ]) {
      const result = await runExport(size);
      expectDisposed(result, makeOffscreen.mock.calls.length - 1);
    }
    expect(makeOffscreen).toHaveBeenCalledTimes(3);
    expect(makeOffscreen).toHaveBeenLastCalledWith(320, 180);
  });
  it("reports progress after every encoded frame", async () => {
    const onProgress = jest.fn();
    const { encoder } = await runExport({ onProgress });
    expect(onProgress.mock.calls.map((call) => call[0])).toEqual(
      [1, 2, 3, 4].map((framesCompleted) => ({ framesCompleted, nbFrames: 4 })),
    );
    for (let i = 0; i < 4; i++)
      expect(encoder.encodeFrame.mock.invocationCallOrder[i]!).toBeLessThan(
        onProgress.mock.invocationCallOrder[i]!,
      );
  });
  it("encodes an integer frame count for summed durations near a frame boundary", async () => {
    for (const duration of [1 - 1e-12, 1 + 1e-12]) {
      const onProgress = jest.fn();
      const { encoder } = await runExport({
        videoComposition: { ...composition, duration },
        onProgress,
      });
      expect(encoder.encodeFrame).toHaveBeenCalledTimes(4);
      expect(onProgress).toHaveBeenLastCalledWith({
        framesCompleted: 4,
        nbFrames: 4,
      });
    }
  });
  it("rejects an already aborted signal without allocating native resources", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runExport({ abortSignal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(createVideoEncoder).not.toHaveBeenCalled();
    expect(makeOffscreen).not.toHaveBeenCalled();
  });
  it("runs before/after hooks for each frame with matching context", async () => {
    const contexts = Array.from({ length: 4 }, (_, i) => ({ i }));
    let nextContext = 0;
    const beforeDrawFrame = jest.fn(() => contexts[nextContext++]);
    const afterDrawFrame = jest.fn();
    const drawFrame = jest.fn();
    await runExport({ beforeDrawFrame, afterDrawFrame, drawFrame });
    expect(beforeDrawFrame).toHaveBeenCalledTimes(4);
    expect(afterDrawFrame.mock.calls.map((call) => call[0])).toEqual(contexts);
    expect(drawFrame.mock.calls.map((call) => call[0].context)).toEqual(
      contexts,
    );
    for (let i = 0; i < 4; i++) {
      expect(beforeDrawFrame.mock.invocationCallOrder[i]!).toBeLessThan(
        drawFrame.mock.invocationCallOrder[i]!,
      );
      expect(drawFrame.mock.invocationCallOrder[i]!).toBeLessThan(
        afterDrawFrame.mock.invocationCallOrder[i]!,
      );
    }
  });
  it("releases frame context and every resource when drawing fails", async () => {
    const context = { dispose: jest.fn() };
    const afterDrawFrame = jest.fn((value: unknown) =>
      (value as typeof context).dispose(),
    );
    const failure = new Error("draw failed");
    const result = prepareExport({
      beforeDrawFrame: () => context,
      afterDrawFrame,
      drawFrame: () => {
        throw failure;
      },
    });
    await pumpAll();
    await expect(result.promise).rejects.toBe(failure);
    expect(afterDrawFrame).toHaveBeenCalledTimes(1);
    expect(context.dispose).toHaveBeenCalledTimes(1);
    expect(surfaceAt().flush.mock.invocationCallOrder[0]!).toBeLessThan(
      context.dispose.mock.invocationCallOrder[0]!,
    );
    expect(result.encoder.encodeFrame).not.toHaveBeenCalled();
    expect(result.encoder.finishWriting).not.toHaveBeenCalled();
    expectDisposed(result);
  });
  it("rejects failed readback without encoding invalid storage and releases all resources", async () => {
    makeOffscreen.mockImplementationOnce((width: number, height: number) => {
      const surface = mockMakeSurface(width, height);
      surface
        .getCanvas()
        .readPixels.mockReturnValue(null as unknown as Uint8Array<ArrayBuffer>);
      return surface;
    });
    const result = prepareExport();
    await pumpAll();
    await expect(result.promise).rejects.toThrow();
    expect(result.encoder.encodeFrame).not.toHaveBeenCalled();
    expect(result.encoder.finishWriting).not.toHaveBeenCalled();
    expectDisposed(result);
  });
  it("releases initialized resources if encoder preparation fails", async () => {
    const result = prepareExport();
    const failure = new Error("encoder prepare failed");
    result.encoder.prepare.mockImplementation(() => {
      throw failure;
    });
    await pumpAll();
    await expect(result.promise).rejects.toBe(failure);
    expect(result.encoder.dispose).toHaveBeenCalledTimes(1);
    expect(result.encoder.finishWriting).not.toHaveBeenCalled();
    expect(result.extractor.start).not.toHaveBeenCalled();
    expect(surfaceAt().dispose).toHaveBeenCalledTimes(1);
  });
  it("releases initialized resources if extractor start fails", async () => {
    const result = prepareExport();
    const failure = new Error("extractor start failed");
    result.extractor.start.mockImplementation(() => {
      throw failure;
    });
    await pumpAll();
    await expect(result.promise).rejects.toBe(failure);
    expect(result.encoder.finishWriting).not.toHaveBeenCalled();
    expectDisposed(result);
  });
  it("releases resources and rejects when finalizing the file fails", async () => {
    const result = prepareExport();
    const failure = new Error("finish failed");
    result.encoder.finishWriting.mockImplementation(() => {
      throw failure;
    });
    await pumpAll();
    await expect(result.promise).rejects.toBe(failure);
    expect(result.encoder.encodeFrame).toHaveBeenCalledTimes(4);
    expectDisposed(result);
  });
  it("cancels between frames, settles after cleanup, and removes the signal listener", async () => {
    const controller = new AbortController();
    const removeListener = jest.spyOn(controller.signal, "removeEventListener");
    const result = prepareExport({
      abortSignal: controller.signal,
      onProgress: () => controller.abort(),
    });
    let settledAfterCleanup = false;
    void result.promise.catch(() => {
      settledAfterCleanup =
        result.encoder.dispose.mock.calls.length === 1 &&
        surfaceAt().dispose.mock.calls.length === 1;
    });
    await pumpAll();
    await expect(result.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(result.encoder.encodeFrame).toHaveBeenCalledTimes(1);
    expect(result.encoder.finishWriting).not.toHaveBeenCalled();
    expectDisposed(result);
    expect(settledAfterCleanup).toBe(true);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it("serializes overlapping exports without allocating the next surface early", async () => {
    const first = prepareExport({ outPath: "/tmp/first.mp4" });
    const second = prepareExport({ outPath: "/tmp/second.mp4" });
    while (first.encoder.dispose.mock.calls.length === 0) {
      expect(await pumpTurn()).toBe(true);
      if (first.encoder.dispose.mock.calls.length === 0)
        expect(createVideoEncoder).toHaveBeenCalledTimes(1);
    }
    await pumpAll();
    await Promise.all([first.promise, second.promise]);
    expectDisposed(first, 0);
    expectDisposed(second, 1);
    expect(first.encoder.dispose.mock.invocationCallOrder[0]!).toBeLessThan(
      second.encoder.prepare.mock.invocationCallOrder[0]!,
    );
    expect(
      first.encoder.finishWriting.mock.invocationCallOrder[0]!,
    ).toBeLessThan(second.encoder.encodeFrame.mock.invocationCallOrder[0]!);
  });
  it("cancels a queued export without creating its native resources", async () => {
    const controller = new AbortController();
    const first = prepareExport({ outPath: "/tmp/first.mp4" });
    const queued = prepareExport({
      outPath: "/tmp/queued.mp4",
      abortSignal: controller.signal,
    });
    controller.abort();
    await expect(queued.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(queued.encoder.prepare).not.toHaveBeenCalled();
    await pumpAll();
    await first.promise;
    expect(createVideoEncoder).toHaveBeenCalledTimes(1);
    expect(makeOffscreen).toHaveBeenCalledTimes(1);
  });

  it("initializes one processor and awaits its preparation before drawing each frame", async () => {
    const preparation = deferred();
    const prepareFrame = jest.fn().mockReturnValueOnce(preparation.promise);
    const dispose = jest.fn();
    const createFrameProcessor = jest.fn(() => ({ prepareFrame, dispose }));
    const result = prepareExport({ createFrameProcessor });
    await pumpAll();
    expect(createFrameProcessor).toHaveBeenCalledTimes(1);
    expect(createFrameProcessor).toHaveBeenCalledWith({
      width: 640,
      height: 360,
      videoComposition: composition,
      isCancelled: expect.any(Function),
    });
    expect(prepareFrame).toHaveBeenCalledTimes(1);
    expect(prepareFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTime: 0,
        width: 640,
        height: 360,
        frames: {},
        isCancelled: expect.any(Function),
      }),
    );
    expect(result.drawFrame).not.toHaveBeenCalled();
    expect(result.encoder.encodeFrame).not.toHaveBeenCalled();
    preparation.resolve();
    await pumpAll();
    await result.promise;
    expect(prepareFrame.mock.calls.map((call) => call[0].currentTime)).toEqual([
      0, 0.25, 0.5, 0.75,
    ]);
    for (let i = 0; i < 4; i++) {
      expect(prepareFrame.mock.invocationCallOrder[i]!).toBeLessThan(
        result.drawFrame.mock.invocationCallOrder[i]!,
      );
    }
    expect(dispose).toHaveBeenCalledTimes(1);
    expectDisposed(result);
  });

  it("waits for processor work and cleanup after cancellation and never draws its stale frame", async () => {
    const controller = new AbortController();
    const preparation = deferred();
    const cleanup = deferred();
    const prepareFrame = jest.fn(
      (_context: VideoFrameProcessingContext) => preparation.promise,
    );
    const dispose = jest.fn(() => cleanup.promise);
    const result = prepareExport({
      abortSignal: controller.signal,
      createFrameProcessor: () => ({ prepareFrame, dispose }),
    });
    let settled = false;
    void result.promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await pumpAll();
    controller.abort();
    await pumpAll();
    expect(prepareFrame.mock.calls[0]?.[0].isCancelled()).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    preparation.resolve();
    await pumpAll();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(surfaceAt().dispose).not.toHaveBeenCalled();
    expect(result.encoder.dispose).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    cleanup.resolve();
    await pumpAll();
    await expect(result.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(result.drawFrame).not.toHaveBeenCalled();
    expect(result.encoder.encodeFrame).not.toHaveBeenCalled();
    expect(result.encoder.finishWriting).not.toHaveBeenCalled();
    expectDisposed(result);
  });

  it("releases native resources if asynchronous processor initialization fails", async () => {
    const failure = new Error("processor init failed");
    const result = prepareExport({
      createFrameProcessor: async () => {
        throw failure;
      },
    });
    await pumpAll();
    await expect(result.promise).rejects.toBe(failure);
    expect(result.drawFrame).not.toHaveBeenCalled();
    expect(result.encoder.finishWriting).not.toHaveBeenCalled();
    expectDisposed(result);
  });

  it("disposes a processor and native resources if frame preparation rejects", async () => {
    const failure = new Error("model inference failed");
    const prepareFrame = jest.fn(async () => {
      throw failure;
    });
    const dispose = jest.fn();
    const result = prepareExport({
      createFrameProcessor: () => ({ prepareFrame, dispose }),
    });
    await pumpAll();
    await expect(result.promise).rejects.toBe(failure);
    expect(prepareFrame).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(result.drawFrame).not.toHaveBeenCalled();
    expect(result.encoder.finishWriting).not.toHaveBeenCalled();
    expectDisposed(result);
  });

  it("retains potentially read GPU resources and budget if processor disposal fails, blocking subsequent allocations", async () => {
    const failure = new Error("processor disposal failed");
    const dispose = jest.fn(async () => {
      throw failure;
    });
    const result = prepareExport({
      createFrameProcessor: () => ({ prepareFrame: jest.fn(), dispose }),
    });
    await pumpAll();
    await expect(result.promise).rejects.toBe(failure);
    expect(result.encoder.encodeFrame).toHaveBeenCalledTimes(4);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(result.encoder.dispose).toHaveBeenCalledTimes(1);
    expect(result.extractor.dispose).toHaveBeenCalledTimes(1);
    expect(surfaceAt().dispose).not.toHaveBeenCalled();
    expect(
      surfaceAt().getCanvas.mock.results[0]?.value.dispose,
    ).not.toHaveBeenCalled();
    expect(releaseMemory).not.toHaveBeenCalled();
    expect(
      (globalThis as { __rnskwgpuExport?: { poisoned: boolean } })
        .__rnskwgpuExport?.poisoned,
    ).toBe(true);
    const next = prepareExport();
    await pumpAll();
    await expect(next.promise).rejects.toThrow("Restart the native runtime");
    expect(makeOffscreen).toHaveBeenCalledTimes(1);
    expect(createVideoEncoder).toHaveBeenCalledTimes(1);
  });

  it("closes independent resources but retains GPU resources and accounting when native cleanup throws", async () => {
    const failure = new Error("decoder disposal failed");
    const result = prepareExport();
    result.extractor.dispose.mockImplementation(() => {
      throw failure;
    });
    await pumpAll();
    await expect(result.promise).rejects.toBe(failure);
    expect(result.extractor.dispose).toHaveBeenCalledTimes(1);
    expect(result.encoder.dispose).toHaveBeenCalledTimes(1);
    expect(surfaceAt().dispose).not.toHaveBeenCalled();
    expect(
      surfaceAt().getCanvas.mock.results[0]?.value.dispose,
    ).not.toHaveBeenCalled();
    expect(releaseMemory).not.toHaveBeenCalled();
  });

  it("releases the first reservation when export readback exceeds the memory budget", async () => {
    const failure = new Error("export budget exceeded");
    reserveMemory.mockReturnValueOnce(42).mockImplementationOnce(() => {
      throw failure;
    });
    const result = prepareExport();
    await pumpAll();
    await expect(result.promise).rejects.toBe(failure);
    expect(makeOffscreen).not.toHaveBeenCalled();
    expect(createVideoEncoder).not.toHaveBeenCalled();
    expect(createExtractor).not.toHaveBeenCalled();
    expect(releaseMemory).toHaveBeenCalledTimes(1);
    expect(releaseMemory).toHaveBeenCalledWith(42);
  });

  it("rejects a fifth overlapping export and holds at most one active export and three queued", async () => {
    const first = prepareExport();
    const controllers = [
      new AbortController(),
      new AbortController(),
      new AbortController(),
    ];
    const queued = controllers.map((controller) =>
      prepareExport({ abortSignal: controller.signal }),
    );
    const overflow = prepareExport();
    await expect(overflow.promise).rejects.toThrow("queue is full");
    expect(makeOffscreen).not.toHaveBeenCalled();
    for (const controller of controllers) controller.abort();
    for (const result of queued)
      await expect(result.promise).rejects.toMatchObject({
        name: "AbortError",
      });
    await pumpAll();
    await first.promise;
    expect(makeOffscreen).toHaveBeenCalledTimes(1);
    expect(createVideoEncoder).toHaveBeenCalledTimes(1);
    expectDisposed(first);
  });

  it("reuses exactly one readback buffer across frames and allocates a distinct one for the next export", async () => {
    const first = await runExport();
    const buffers = first.encoder.encodeFrame.mock.calls.map(
      (call) => call[0].data,
    );
    expect(new Set(buffers).size).toBe(1);
    const canvas = surfaceAt().getCanvas.mock.results[0]?.value;
    for (const call of canvas.readPixels.mock.calls)
      expect(call[3].buffer).toBe(buffers[0]);
    expect(reserveMemory.mock.calls.map((call) => call[0])).toEqual([
      640 * 360 * 4,
      640 * 360 * 8,
    ]);
    const second = await runExport();
    expect(second.encoder.encodeFrame.mock.calls[0]?.[0].data).not.toBe(
      buffers[0],
    );
    expect(
      new Set(second.encoder.encodeFrame.mock.calls.map((call) => call[0].data))
        .size,
    ).toBe(1);
  });

  it("cancels an active export before its setup worklet without allocating any pixels or native resources", async () => {
    const controller = new AbortController();
    const result = prepareExport({ abortSignal: controller.signal });
    await flushMicrotasks();
    expect(mockRuntimeTasks).toHaveLength(1);
    controller.abort();
    await pumpAll();
    await expect(result.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(reserveMemory).not.toHaveBeenCalled();
    expect(makeOffscreen).not.toHaveBeenCalled();
    expect(createVideoEncoder).not.toHaveBeenCalled();
    expect(createExtractor).not.toHaveBeenCalled();
  });

  it("removes its cancellation listener when creating the worklet runtime fails", async () => {
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, "removeEventListener");
    const failure = new Error("Runtime creation failed");
    const { createWorkletRuntime } = require("react-native-worklets") as {
      createWorkletRuntime: jest.Mock;
    };
    createWorkletRuntime.mockImplementationOnce(() => {
      throw failure;
    });
    let isolatedExport!: typeof exportVideoComposition;
    jest.isolateModules(() => {
      isolatedExport =
        require("../exportVideoComposition").exportVideoComposition;
    });
    const promise = isolatedExport({
      ...baseOptions,
      drawFrame: jest.fn(),
      abortSignal: controller.signal,
    });
    void promise.catch(() => undefined);
    await pumpAll();
    await expect(promise).rejects.toBe(failure);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(makeOffscreen).not.toHaveBeenCalled();
    expect(reserveMemory).not.toHaveBeenCalled();
  });

  it("drains drawing left by an exception before disposing processor textures", async () => {
    const failure = new Error("draw failed after recording");
    const dispose = jest.fn();
    const result = prepareExport({
      createFrameProcessor: () => ({ prepareFrame: jest.fn(), dispose }),
      drawFrame: () => {
        throw failure;
      },
    });
    await pumpAll();
    await expect(result.promise).rejects.toBe(failure);
    expect(surfaceAt().flush.mock.invocationCallOrder[0]!).toBeLessThan(
      dispose.mock.invocationCallOrder[0]!,
    );
    expect(dispose.mock.invocationCallOrder[0]!).toBeLessThan(
      surfaceAt().dispose.mock.invocationCallOrder[0]!,
    );
    expectDisposed(result);
  });

  it("retains a failed-drain session and skips processor destruction while closing independent codecs", async () => {
    const drawFailure = new Error("recorded draw failed");
    const fenceFailure = new Error("GPU drain failed");
    makeOffscreen.mockImplementationOnce((width: number, height: number) => {
      const surface = mockMakeSurface(width, height);
      surface.flush.mockImplementationOnce(() => {
        throw fenceFailure;
      });
      return surface;
    });
    const dispose = jest.fn();
    const result = prepareExport({
      createFrameProcessor: () => ({ prepareFrame: jest.fn(), dispose }),
      drawFrame: () => {
        throw drawFailure;
      },
    });
    await pumpAll();
    await expect(result.promise).rejects.toBe(drawFailure);
    expect(dispose).not.toHaveBeenCalled();
    expect(surfaceAt().dispose).not.toHaveBeenCalled();
    expect(result.encoder.dispose).toHaveBeenCalledTimes(1);
    expect(result.extractor.dispose).toHaveBeenCalledTimes(1);
    expect(releaseMemory).not.toHaveBeenCalled();
    const next = prepareExport();
    await pumpAll();
    await expect(next.promise).rejects.toThrow("Restart the native runtime");
    expect(makeOffscreen).toHaveBeenCalledTimes(1);
  });

  it("rejects null thrown by initialization, drawing or processor cleanup instead of reporting success", async () => {
    const init = prepareExport({
      createFrameProcessor: () => {
        throw null;
      },
    });
    await pumpAll();
    await expect(init.promise).rejects.toBeNull();
    expectDisposed(init);
    const drawn = prepareExport({
      drawFrame: () => {
        throw null;
      },
    });
    await pumpAll();
    await expect(drawn.promise).rejects.toBeNull();
    expectDisposed(drawn, 1);
    const disposed = prepareExport({
      createFrameProcessor: () => ({
        prepareFrame: jest.fn(),
        dispose: () => {
          throw null;
        },
      }),
    });
    await pumpAll();
    await expect(disposed.promise).rejects.toBeNull();
    expect(surfaceAt(2).dispose).not.toHaveBeenCalled();
  });

  it("retains an unreleased frame context when the failed drawing recording cannot drain", async () => {
    const primary = new Error("Drawing failed");
    const context = { dispose: jest.fn() };
    const afterDrawFrame = jest.fn((value: unknown) =>
      (value as typeof context).dispose(),
    );
    makeOffscreen.mockImplementationOnce((width: number, height: number) => {
      const surface = mockMakeSurface(width, height);
      surface.flush.mockImplementation(() => {
        throw new Error("GPU drain failed");
      });
      return surface;
    });
    const dispose = jest.fn();
    const result = prepareExport({
      beforeDrawFrame: () => context,
      afterDrawFrame,
      drawFrame: () => {
        throw primary;
      },
      createFrameProcessor: () => ({ prepareFrame: jest.fn(), dispose }),
    });
    await pumpAll();
    await expect(result.promise).rejects.toBe(primary);
    expect(afterDrawFrame).not.toHaveBeenCalled();
    expect(context.dispose).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(surfaceAt().dispose).not.toHaveBeenCalled();
    expect(result.encoder.dispose).toHaveBeenCalledTimes(1);
    expect(result.extractor.dispose).toHaveBeenCalledTimes(1);
    expect(releaseMemory).not.toHaveBeenCalled();
    expect(
      (globalThis as { __rnskwgpuExport?: { pendingAfterDraw: unknown } })
        .__rnskwgpuExport?.pendingAfterDraw,
    ).toEqual(expect.any(Function));
  });

  it("releases the deferred frame context only after cleanup successfully drains the recording", async () => {
    const primary = new Error("Drawing failed");
    const afterDrawFrame = jest.fn();
    makeOffscreen.mockImplementationOnce((width: number, height: number) => {
      const surface = mockMakeSurface(width, height);
      surface.flush.mockImplementationOnce(() => {
        throw new Error("First drain failed");
      });
      return surface;
    });
    const result = prepareExport({
      afterDrawFrame,
      drawFrame: () => {
        throw primary;
      },
    });
    await pumpAll();
    await expect(result.promise).rejects.toBe(primary);
    expect(afterDrawFrame).toHaveBeenCalledTimes(1);
    expect(surfaceAt().flush.mock.invocationCallOrder[1]!).toBeLessThan(
      afterDrawFrame.mock.invocationCallOrder[0]!,
    );
    expectDisposed(result);
  });

  it("preserves a drawing failure when the per-frame cleanup also throws", async () => {
    const primary = new Error("Drawing failed");
    const afterDrawFrame = jest.fn(() => {
      throw new Error("Context cleanup failed");
    });
    const result = prepareExport({
      drawFrame: () => {
        throw primary;
      },
      afterDrawFrame,
    });
    await pumpAll();
    await expect(result.promise).rejects.toBe(primary);
    expect(afterDrawFrame).toHaveBeenCalledTimes(1);
    expectDisposed(result);
  });

  it("retains failed reservation releases and blocks another export without losing their accounting", async () => {
    const failure = new Error("Reservation release failed");
    releaseMemory.mockImplementationOnce(() => {
      throw failure;
    });
    const result = prepareExport();
    await pumpAll();
    await expect(result.promise).rejects.toBe(failure);
    expectDisposed(result);
    const retained = (
      globalThis as {
        __rnskwgpuExport?: { poisoned: boolean; reservations: number[] };
      }
    ).__rnskwgpuExport!;
    expect(retained.poisoned).toBe(true);
    expect(retained.reservations).toHaveLength(1);
    const next = prepareExport();
    await pumpAll();
    await expect(next.promise).rejects.toThrow("Restart the native runtime");
    expect(makeOffscreen).toHaveBeenCalledTimes(1);
  });
});

describe("export native autorelease lifetimes", () => {
  it("scopes actual frame imports and native teardown in serialized worklets while awaiting adapters outside pools", async () => {
    mockSerializedRuntime = createSerializedUiRuntime();
    const initialization = deferred();
    const preparation = deferred();
    const cleanup = deferred();
    const depths: Record<string, number[]> = {};
    const observe = jest.fn((stage: string) => {
      (depths[stage] ??= []).push(mockPoolDepth);
    });
    const waitForInitialization = jest.fn(() => initialization.promise);
    const waitForPreparation = jest
      .fn()
      .mockReturnValueOnce(preparation.promise);
    const waitForCleanup = jest.fn(() => cleanup.promise);
    const createFrameProcessor = async () => {
      "worklet";
      observe("adapter:create");
      await waitForInitialization();
      observe("adapter:created");
      return {
        prepareFrame: async () => {
          "worklet";
          observe("adapter:prepare");
          await waitForPreparation();
          observe("adapter:prepared");
        },
        dispose: async () => {
          "worklet";
          observe("adapter:dispose");
          await waitForCleanup();
          observe("adapter:disposed");
        },
      };
    };
    const drawFrame = () => {
      "worklet";
      observe("draw");
    };
    const result = prepareExport({ createFrameProcessor, drawFrame });
    reserveMemory.mockImplementation(() => {
      observe("memory:reserve");
      return 42;
    });
    releaseMemory.mockImplementation(() => observe("memory:release"));
    createVideoEncoder.mockReset().mockImplementation(() => {
      observe("encoder:create");
      return result.encoder;
    });
    createExtractor.mockReset().mockImplementation(() => {
      observe("extractor:create");
      return result.extractor;
    });
    for (const method of [
      "prepare",
      "encodeFrame",
      "finishWriting",
      "dispose",
    ] as const)
      result.encoder[method].mockImplementation(() =>
        observe(`encoder:${method}`),
      );
    for (const method of ["start", "dispose"] as const)
      result.extractor[method].mockImplementation(() =>
        observe(`extractor:${method}`),
      );
    const sourceDisposals: jest.Mock[] = [];
    let frameId = 0;
    result.extractor.decodeCompositionFrames.mockImplementation(() => {
      observe("extractor:decode");
      const dispose = jest.fn(() => observe("source:dispose"));
      sourceDisposals.push(dispose);
      const frame: VideoFrame = {
        id: ++frameId,
        producerId: 1,
        width: 2,
        height: 2,
        rotation: 0,
        texture: { kind: "rgba", data: new ArrayBuffer(16), bytesPerRow: 8 },
        dispose,
      };
      return { clip: frame };
    });
    dataFromBytes.mockImplementation(() => {
      observe("data:create");
      return { dispose: jest.fn(() => observe("data:dispose")) };
    });
    const imageDisposals: jest.Mock[] = [];
    makeImage.mockImplementation(() => {
      observe("image:create");
      const dispose = jest.fn(() => observe("image:dispose"));
      imageDisposals.push(dispose);
      return { dispose };
    });
    makeOffscreen.mockImplementation((width: number, height: number) => {
      observe("surface:create");
      const surface = mockMakeSurface(width, height);
      const canvas = surface.getCanvas();
      surface.getCanvas.mockImplementation(() => {
        observe("canvas:get");
        return canvas;
      });
      surface.flush.mockImplementation(() => observe("surface:flush"));
      surface.dispose.mockImplementation(() => observe("surface:dispose"));
      canvas.drawColor.mockImplementation(() => observe("canvas:drawColor"));
      canvas.dispose.mockImplementation(() => observe("canvas:dispose"));
      canvas.readPixels.mockImplementation((_x, _y, _info, destination) => {
        observe("canvas:readPixels");
        return destination;
      });
      return surface;
    });

    await pumpAll();
    expect(depths["adapter:create"]).toEqual([0]);
    expect(result.extractor.decodeCompositionFrames).not.toHaveBeenCalled();
    expect(mockPoolDepth).toBe(0);
    initialization.resolve();
    await pumpAll();
    expect(depths["adapter:prepare"]).toEqual([0]);
    expect(depths.draw).toBeUndefined();
    expect(sourceDisposals).toHaveLength(1);
    expect(sourceDisposals[0]).toHaveBeenCalledTimes(1);
    expect(mockPoolDepth).toBe(0);
    preparation.resolve();
    await pumpAll();
    expect(result.encoder.encodeFrame).toHaveBeenCalledTimes(4);
    expect(depths["adapter:dispose"]).toEqual([0]);
    expect(result.encoder.dispose).not.toHaveBeenCalled();
    expect(surfaceAt().dispose).not.toHaveBeenCalled();
    expect(mockPoolDepth).toBe(0);
    cleanup.resolve();
    await pumpAll();
    await result.promise;

    for (const [stage, calls] of Object.entries(depths)) {
      if (stage.startsWith("adapter:"))
        expect(calls.every((depth) => depth === 0)).toBe(true);
      else expect(calls.every((depth) => depth > 0)).toBe(true);
    }
    for (const stage of [
      "memory:reserve",
      "surface:create",
      "canvas:get",
      "encoder:create",
      "encoder:prepare",
      "extractor:create",
      "extractor:start",
      "extractor:decode",
      "data:create",
      "data:dispose",
      "image:create",
      "source:dispose",
      "draw",
      "canvas:drawColor",
      "canvas:readPixels",
      "encoder:encodeFrame",
      "encoder:finishWriting",
      "surface:flush",
      "extractor:dispose",
      "encoder:dispose",
      "image:dispose",
      "surface:dispose",
      "memory:release",
    ])
      expect(depths[stage]?.length).toBeGreaterThan(0);
    expect(sourceDisposals).toHaveLength(4);
    expect(imageDisposals).toHaveLength(4);
    for (const dispose of [...sourceDisposals, ...imageDisposals])
      expect(dispose).toHaveBeenCalledTimes(1);
    expectDisposed(result);
    expect(mockSerializedRuntime.evaluatedBodies).toBeGreaterThan(10);
  });

  it("closes every pool before cancellation waits for an asynchronous adapter drain", async () => {
    mockSerializedRuntime = createSerializedUiRuntime();
    const controller = new AbortController();
    const preparation = deferred();
    const cleanup = deferred();
    const prepareDepths: number[] = [];
    const disposeDepths: number[] = [];
    const prepareFrame = jest.fn(() => {
      prepareDepths.push(mockPoolDepth);
      return preparation.promise;
    });
    const dispose = jest.fn(() => {
      disposeDepths.push(mockPoolDepth);
      return cleanup.promise;
    });
    const result = prepareExport({
      abortSignal: controller.signal,
      createFrameProcessor: jest.fn(() => ({ prepareFrame, dispose })),
    });
    let settled = false;
    void result.promise
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await pumpAll();
    expect(prepareDepths).toEqual([0]);
    controller.abort();
    await pumpAll();
    expect(mockPoolDepth).toBe(0);
    expect(dispose).not.toHaveBeenCalled();
    preparation.resolve();
    await pumpAll();
    expect(disposeDepths).toEqual([0]);
    expect(mockPoolDepth).toBe(0);
    expect(result.encoder.dispose).not.toHaveBeenCalled();
    expect(surfaceAt().dispose).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    cleanup.resolve();
    await pumpAll();
    await expect(result.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(result.encoder.encodeFrame).not.toHaveBeenCalled();
    expectDisposed(result);
    expect(settled).toBe(true);
  });

  it.each(["setup", "import", "draw", "cleanup"] as const)(
    "balances native pools and preserves resource ownership when %s fails in serialized worklets",
    async (phase) => {
      mockSerializedRuntime = createSerializedUiRuntime();
      const failure = new Error(`${phase} failed`);
      const failureDepths: number[] = [];
      const fail = jest.fn(() => {
        failureDepths.push(mockPoolDepth);
        throw failure;
      });
      const result = prepareExport(phase === "draw" ? { drawFrame: fail } : {});
      if (phase === "setup") result.encoder.prepare.mockImplementation(fail);
      if (phase === "cleanup")
        result.extractor.dispose.mockImplementation(fail);
      const sourceDispose = jest.fn(() => {
        expect(mockPoolDepth).toBeGreaterThan(0);
      });
      if (phase === "import") {
        const frame: VideoFrame = {
          id: 1,
          producerId: 1,
          width: 2,
          height: 2,
          rotation: 0,
          texture: { kind: "rgba", data: new ArrayBuffer(16), bytesPerRow: 8 },
          dispose: sourceDispose,
        };
        result.extractor.decodeCompositionFrames.mockReturnValue({
          clip: frame,
        });
        makeImage.mockImplementation(fail);
      }
      await pumpAll();
      await expect(result.promise).rejects.toBe(failure);
      expect(failureDepths).toEqual([1]);
      expect(mockPoolDepth).toBe(0);
      expect(result.encoder.dispose).toHaveBeenCalledTimes(1);
      if (phase === "setup") {
        expect(result.extractor.start).not.toHaveBeenCalled();
        expect(surfaceAt().dispose).toHaveBeenCalledTimes(1);
      } else if (phase === "cleanup") {
        expect(result.extractor.dispose).toHaveBeenCalledTimes(1);
        expect(surfaceAt().dispose).not.toHaveBeenCalled();
        expect(releaseMemory).not.toHaveBeenCalled();
      } else {
        expectDisposed(result);
        expect(result.encoder.encodeFrame).not.toHaveBeenCalled();
      }
      if (phase === "import") {
        expect(sourceDispose).toHaveBeenCalledTimes(1);
        expect(
          dataFromBytes.mock.results[0]?.value.dispose,
        ).toHaveBeenCalledTimes(1);
      }
    },
  );
});

describe("dedicated export recorder cleanup", () => {
  it("trims once after consumers close and before memory reservations are released", async () => {
    trimRecorderCache.mockImplementation(() => {
      expect(surfaceAt().dispose).toHaveBeenCalledTimes(1);
      expect(releaseMemory).not.toHaveBeenCalled();
    });
    const result = await runExport();
    expect(result.drawFrame).toHaveBeenCalledTimes(4);
    expect(trimRecorderCache).toHaveBeenCalledTimes(1);
    expect(releaseMemory).toHaveBeenCalled();
  });

  it("rejects an old native binary before allocating export resources", async () => {
    cacheApi.__rnskvTrimRecorderCache = undefined;
    const result = prepareExport();
    await pumpAll();
    await expect(result.promise).rejects.toThrow(
      "Skia export cache patch is missing",
    );
    expect(reserveMemory).not.toHaveBeenCalled();
    expect(makeOffscreen).not.toHaveBeenCalled();
    expect(createVideoEncoder).not.toHaveBeenCalled();
  });

  it("does not purge a recorder whose surface could not be drained", async () => {
    const result = prepareExport();
    await pumpTurn();
    const failure = new Error("GPU drain failed");
    surfaceAt().flush.mockImplementation(() => {
      throw failure;
    });
    await pumpAll();
    await expect(result.promise).rejects.toBe(failure);
    expect(trimRecorderCache).not.toHaveBeenCalled();
    expect(releaseMemory).not.toHaveBeenCalled();
  });

  it("quarantines a failed cache drain and refuses reuse of that runtime", async () => {
    const failure = new Error("Recorder cache drain failed");
    trimRecorderCache.mockImplementation(() => {
      throw failure;
    });
    const first = prepareExport();
    await pumpAll();
    await expect(first.promise).rejects.toBe(failure);
    expect(trimRecorderCache).toHaveBeenCalledTimes(1);
    expect(releaseMemory).not.toHaveBeenCalled();
    const second = prepareExport();
    await pumpAll();
    await expect(second.promise).rejects.toThrow(
      "Previous export cleanup failed",
    );
    expect(trimRecorderCache).toHaveBeenCalledTimes(1);
    expect(makeOffscreen).toHaveBeenCalledTimes(1);
  });
});

describe("GPU device loss during an export", () => {
  const lostMessage = "Video export failed: the GPU device was lost";
  const session = () =>
    (globalThis as { __rnskwgpuExport?: { poisoned?: boolean } })
      .__rnskwgpuExport;
  afterEach(() => {
    mockGpuState.generation = 1;
    mockGpuState.lost = false;
  });

  it("stops before drawing on a lost device, writes nothing more and releases everything without draining it", async () => {
    const result = prepareExport();
    result.encoder.encodeFrame.mockImplementationOnce(() => {
      mockGpuState.lost = true;
    });
    await pumpAll();
    await expect(result.promise).rejects.toThrow(lostMessage);
    expect(result.drawFrame).toHaveBeenCalledTimes(1);
    expect(result.encoder.encodeFrame).toHaveBeenCalledTimes(1);
    expect(result.encoder.finishWriting).not.toHaveBeenCalled();
    expectDisposed(result);
    // The first frame's checked wait only: nothing waits on the lost device.
    expect(surfaceAt().flush).toHaveBeenCalledTimes(1);
    expect(trimRecorderCache).not.toHaveBeenCalled();
    expect(releaseMemory).toHaveBeenCalledTimes(
      reserveMemory.mock.calls.length,
    );
    expect(session()).toBeUndefined();
    // Once React Native Skia replaced the device, the next export runs.
    mockGpuState.lost = false;
    mockGpuState.generation = 2;
    const next = await runExport();
    expect(next.encoder.finishWriting).toHaveBeenCalledTimes(1);
  });

  it("reports a checked submission refused on a lost device as the loss, with the native error as its cause", async () => {
    const refused = new Error(
      "The GPU device was lost; a checked recording did not complete",
    );
    makeOffscreen.mockImplementationOnce((width: number, height: number) => {
      const surface = mockMakeSurface(width, height);
      surface.flush
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          mockGpuState.lost = true;
          throw refused;
        });
      return surface;
    });
    const result = prepareExport();
    await pumpAll();
    const failure = await result.promise.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(lostMessage);
    expect((failure as Error & { cause?: unknown }).cause).toBe(refused);
    // The frame whose wait failed never reached the encoder.
    expect(result.encoder.encodeFrame).toHaveBeenCalledTimes(1);
    expectDisposed(result);
    expect(session()).toBeUndefined();
  });

  it("does not finish a file whose device was replaced after its last frame was encoded", async () => {
    const result = prepareExport();
    result.encoder.encodeFrame
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        mockGpuState.generation = 2;
      });
    await pumpAll();
    await expect(result.promise).rejects.toThrow(lostMessage);
    expect(result.encoder.encodeFrame).toHaveBeenCalledTimes(4);
    expect(result.encoder.finishWriting).not.toHaveBeenCalled();
    expectDisposed(result);
  });

  it("fails before allocating anything while the device is lost", async () => {
    mockGpuState.lost = true;
    const result = prepareExport();
    await pumpAll();
    await expect(result.promise).rejects.toThrow(lostMessage);
    expect(makeOffscreen).not.toHaveBeenCalled();
    expect(createVideoEncoder).not.toHaveBeenCalled();
    expect(session()).toBeUndefined();
  });

  it("lets a session kept after a failed drain go once its device was replaced", async () => {
    const failure = new Error("processor disposal failed");
    const first = prepareExport({
      createFrameProcessor: () => ({
        prepareFrame: jest.fn(),
        dispose: jest.fn(async () => {
          throw failure;
        }),
      }),
    });
    await pumpAll();
    await expect(first.promise).rejects.toBe(failure);
    expect(session()?.poisoned).toBe(true);
    expect(releaseMemory).not.toHaveBeenCalled();
    const flushes = surfaceAt(0).flush.mock.calls.length;
    mockGpuState.generation = 2;
    const next = await runExport();
    expect(next.encoder.finishWriting).toHaveBeenCalledTimes(1);
    // The kept surface and its reservations went first, without a drain.
    expect(surfaceAt(0).dispose).toHaveBeenCalledTimes(1);
    expect(surfaceAt(0).flush).toHaveBeenCalledTimes(flushes);
    expect(releaseMemory).toHaveBeenCalledTimes(
      reserveMemory.mock.calls.length,
    );
  });
});
