const mockRuntimeTasks: Array<() => void> = [];
const mockCalls: string[] = [];
const mockImport = jest.fn();
jest.mock("../gpuDevice", () => ({
  getVideoGpuDevice: jest.fn(() => ({ importSharedTextureMemory: mockImport })),
  createNativeVideoGpuFrame: jest.fn((pointer: bigint) => ({
    handle: pointer + 1000n,
    width: 640,
    height: 360,
    pixelFormat: "bgra8",
    release: jest.fn(() => mockCalls.push("frame.release")),
  })),
  nativeVideoTextureUsage: 20,
}));
jest.mock("react-native-worklets", () => ({
  createWorkletRuntime: jest.fn(() => ({ name: "export" })),
  runOnRuntime: jest.fn((_runtime: unknown, fn: () => void) => () => {
    mockRuntimeTasks.push(fn);
  }),
  scheduleOnRN: jest.fn(
    (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
  ),
  createSynchronizable: jest.fn((initial: boolean) => {
    let value = initial;
    return {
      getBlocking: () => value,
      setBlocking: (next: boolean) => {
        value = next;
      },
    };
  }),
}));
jest.mock("../runtimeYield", () => ({
  yieldToRuntime: jest.fn((fn: () => void) => {
    mockRuntimeTasks.push(fn);
  }),
}));
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
// The copying importer is covered by frameInterop.test.ts.
jest.mock("../frameInterop", () => ({
  ownVideoFrames: jest.fn((frames: Record<string, { id?: number }>) => {
    const owned: Record<string, unknown> = {};
    for (const [key, frame] of Object.entries(frames))
      owned[key] = { ...frame, texture: { kind: "skia-image", image: {} } };
    return owned;
  }),
  releaseVideoFrameImage: jest.fn(),
  clearVideoFrameImages: jest.fn(),
}));
const mockSurface = (label: string) => {
  const canvas = {
    drawColor: jest.fn(),
    readPixels: jest.fn(
      (_x: number, _y: number, _info: unknown, destination: Uint8Array) =>
        destination,
    ),
    dispose: jest.fn(() => mockCalls.push(`${label}.canvas.dispose`)),
  };
  return {
    canvas,
    enableCheckedSubmissions: jest.fn(),
    getCanvas: jest.fn(() => canvas),
    flush: jest.fn(() => mockCalls.push(`${label}.flush`)),
    dispose: jest.fn(() => mockCalls.push(`${label}.dispose`)),
  };
};
jest.mock("react-native-skia", () => ({
  Skia: {
    __rnskvTrimRecorderCache: jest.fn(),
    Surface: {
      MakeOffscreen: jest.fn(() => mockSurface("offscreen")),
      MakeFromGPUTexture: jest.fn(() => mockSurface("target")),
    },
    Image: {
      MakeFromGPUTexture: jest.fn(() => ({
        dispose: jest.fn(() => mockCalls.push("source.image.dispose")),
      })),
    },
    Color: jest.fn(() => 0),
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
    runWithAutoreleasePool: jest.fn((fn: () => unknown) => fn()),
    getBackendInfo: jest.fn(() => ({ gpuDirectExport: true })),
  },
}));

import { Skia } from "react-native-skia";
import RNSkiaVideoModule from "../RNSkiaVideoModule";
import { exportVideoComposition } from "../exportVideoComposition";
import { ownVideoFrames } from "../frameInterop";

const createVideoEncoder = RNSkiaVideoModule.createVideoEncoder as jest.Mock;
const createExtractor =
  RNSkiaVideoModule.createVideoCompositionFramesExtractorSync as jest.Mock;
const reserveMemory = RNSkiaVideoModule.reserveMemory as jest.Mock;
const makeOffscreen = Skia.Surface.MakeOffscreen as jest.Mock;
const makeFromTexture = (
  Skia.Surface as unknown as { MakeFromGPUTexture: jest.Mock }
).MakeFromGPUTexture;

const makeImageFromTexture = (
  Skia.Image as unknown as { MakeFromGPUTexture: jest.Mock }
).MakeFromGPUTexture;

// Encoder targets and decoded source frames share the import mock; the label
// tells them apart in the recorded call order.
const sharedMemory = (descriptor: { label?: string }) => {
  const kind =
    descriptor.label === "video export source frame" ? "source" : "target";
  return {
    kind,
    createTexture: jest.fn(() => ({
      destroy: jest.fn(() => mockCalls.push(`${kind}.texture.destroy`)),
    })),
    beginAccess: jest.fn(() => mockCalls.push(`${kind}.beginAccess`)),
    endAccess: jest.fn(() => {
      mockCalls.push(`${kind}.endAccess`);
      return {
        initialized: true,
        fences: [
          {
            fence: {
              destroy: jest.fn(() => mockCalls.push(`${kind}.fence.destroy`)),
            },
            signaledValue: 1n,
          },
        ],
      };
    }),
    destroy: jest.fn(() => mockCalls.push(`${kind}.memory.destroy`)),
  };
};

type MockFrame = {
  id: number;
  producerId: number;
  width: number;
  height: number;
  rotation: number;
  texture: { kind: "native-buffer"; nativeBuffer: bigint };
  dispose: jest.Mock;
};
const decodedFrame = (id: number, producerId = 7): MockFrame => ({
  id,
  producerId,
  width: 640,
  height: 360,
  rotation: 0,
  texture: { kind: "native-buffer", nativeBuffer: BigInt(100 + id) },
  dispose: jest.fn(() => mockCalls.push(`source${id}.dispose`)),
});

const prepare = (
  drawFrame: jest.Mock = jest.fn(() => {
    mockCalls.push("draw");
  }),
  decode: (time: number) => Record<string, MockFrame> = () => ({}),
) => {
  let next = 1n;
  const encoder = {
    prepare: jest.fn(),
    acquireFrameBuffer: jest.fn(() => next++),
    releaseFrameBuffer: jest.fn(() => mockCalls.push("releaseFrameBuffer")),
    encodeFrame: jest.fn((_frame: unknown, _time: number) => {
      mockCalls.push("encode");
    }),
    finishWriting: jest.fn(),
    dispose: jest.fn(),
  };
  const extractor = {
    start: jest.fn(),
    decodeCompositionFrames: jest.fn(decode),
    dispose: jest.fn(),
  };
  createVideoEncoder.mockReturnValueOnce(encoder);
  createExtractor.mockReturnValueOnce(extractor);
  const promise = exportVideoComposition({
    videoComposition: { duration: 1, items: [] },
    outPath: "/tmp/out.mp4",
    width: 640,
    height: 360,
    frameRate: 3,
    bitRate: 1_000_000,
    drawFrame,
  });
  void promise.catch(() => undefined);
  return { encoder, extractor, promise };
};

const pumpAll = async () => {
  for (let i = 0; i < 200; i++) {
    for (let j = 0; j < 20; j++) await Promise.resolve();
    const task = mockRuntimeTasks.shift();
    if (!task) return;
    task();
  }
  throw new Error("Export did not settle");
};

beforeEach(() => {
  delete (globalThis as { __rnskwgpuExport?: unknown }).__rnskwgpuExport;
  jest.clearAllMocks();
  mockCalls.length = 0;
  mockRuntimeTasks.length = 0;
  mockImport
    .mockReset()
    .mockImplementation((descriptor: { label?: string }) =>
      sharedMemory(descriptor),
    );
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("iOS GPU export", () => {
  it("draws into lent encoder buffers and encodes them without readback", async () => {
    const { encoder, promise } = prepare();
    await pumpAll();
    await promise;
    expect(makeOffscreen).not.toHaveBeenCalled();
    expect(reserveMemory).not.toHaveBeenCalled();
    // The probe returns its buffer; every frame then encodes its own.
    expect(encoder.acquireFrameBuffer).toHaveBeenCalledTimes(4);
    expect(encoder.releaseFrameBuffer).toHaveBeenCalledTimes(1);
    expect(encoder.encodeFrame.mock.calls).toEqual([
      [{ kind: "native-buffer", nativeBuffer: 2n }, 0],
      [{ kind: "native-buffer", nativeBuffer: 3n }, 1 / 3],
      [{ kind: "native-buffer", nativeBuffer: 4n }, 2 / 3],
    ]);
    expect(mockImport).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 1002n }),
    );
    // Fences and the IOSurface import close as soon as the access ends.
    const close = [
      "target.dispose",
      "target.endAccess",
      "target.fence.destroy",
      "target.texture.destroy",
      "target.memory.destroy",
      "frame.release",
    ];
    const frame = [
      "target.beginAccess",
      "draw",
      "target.flush",
      ...close,
      "encode",
    ];
    const probe = [
      "target.beginAccess",
      "target.flush",
      ...close,
      "releaseFrameBuffer",
    ];
    expect(mockCalls).toEqual([...probe, ...frame, ...frame, ...frame]);
    for (const result of makeFromTexture.mock.results)
      expect(result.value.canvas.readPixels).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("falls back to CPU readback when the device cannot import the buffer", async () => {
    mockImport.mockImplementation(() => {
      throw new Error("no IOSurface interop");
    });
    const { encoder, promise } = prepare();
    await pumpAll();
    await promise;
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(encoder.releaseFrameBuffer).toHaveBeenCalledTimes(1);
    expect(encoder.acquireFrameBuffer).toHaveBeenCalledTimes(1);
    expect(makeOffscreen).toHaveBeenCalledTimes(1);
    expect(encoder.encodeFrame).toHaveBeenCalledTimes(3);
    for (const [pixels] of encoder.encodeFrame.mock.calls)
      expect(pixels).toMatchObject({ kind: "bgra", width: 640, height: 360 });
  });

  it("ends GPU access and returns nothing to encode when drawing fails", async () => {
    let calls = 0;
    const drawFrame = jest.fn(() => {
      if (++calls === 2) throw new Error("draw failed");
    });
    const { encoder, promise } = prepare(drawFrame);
    await pumpAll();
    await expect(promise).rejects.toThrow("draw failed");
    expect(encoder.encodeFrame).toHaveBeenCalledTimes(1);
    const memories = mockImport.mock.results.map((r) => r.value);
    expect(memories).toHaveLength(3);
    for (const memory of memories) {
      expect(memory.endAccess).toHaveBeenCalledTimes(1);
      const texture = memory.createTexture.mock.results[0].value;
      expect(texture.destroy).toHaveBeenCalledTimes(1);
      expect(memory.destroy).toHaveBeenCalledTimes(1);
    }
    const failed = makeFromTexture.mock.results[2]!.value;
    expect(failed.flush).toHaveBeenCalledWith(true);
    expect(failed.dispose).toHaveBeenCalledTimes(1);
    expect(encoder.dispose).toHaveBeenCalledTimes(1);
  });

  it("reports a per-stage profile once, before resolving", async () => {
    const order: string[] = [];
    const onProfile = jest.fn(() => order.push("profile"));
    let id = 0;
    let next = 1n;
    const encoder = {
      prepare: jest.fn(),
      acquireFrameBuffer: jest.fn(() => next++),
      releaseFrameBuffer: jest.fn(),
      encodeFrame: jest.fn(),
      finishWriting: jest.fn(),
      dispose: jest.fn(),
    };
    createVideoEncoder.mockReturnValueOnce(encoder);
    createExtractor.mockReturnValueOnce({
      start: jest.fn(),
      decodeCompositionFrames: jest.fn(() => ({ clip: decodedFrame(++id) })),
      dispose: jest.fn(),
    });
    const promise = exportVideoComposition({
      videoComposition: { duration: 1, items: [] },
      outPath: "/tmp/out.mp4",
      width: 640,
      height: 360,
      frameRate: 3,
      bitRate: 1_000_000,
      drawFrame: jest.fn(),
      onProfile,
    }).then(() => order.push("resolved"));
    await pumpAll();
    await promise;
    expect(order).toEqual(["profile", "resolved"]);
    const profile = (onProfile.mock.calls[0] as unknown[])[0] as Record<
      string,
      number
    >;
    expect(profile.frames).toBe(3);
    const stages = [
      "decodeMs",
      "importMs",
      "prepareMs",
      "targetMs",
      "drawMs",
      "gpuMs",
      "encodeMs",
      "yieldMs",
    ];
    for (const stage of stages)
      expect(profile[stage]).toBeGreaterThanOrEqual(0);
    const sum = stages.reduce((total, stage) => total + profile[stage]!, 0);
    expect(profile.totalMs).toBeCloseTo(sum, 6);
  });

  describe("decoded frames sampled in place", () => {
    it("draws the decoder's IOSurface and releases it after the next frame's import", async () => {
      const first = decodedFrame(1);
      const second = decodedFrame(2);
      // The extractor hands the held frame back while the clip shows it.
      const timeline = [first, first, second];
      let call = 0;
      const drawFrame = jest.fn(({ frames }) => {
        mockCalls.push("draw");
        expect(frames.clip.texture.kind).toBe("skia-image");
      });
      const { promise } = prepare(drawFrame, () => ({
        clip: timeline[call++]!,
      }));
      await pumpAll();
      await promise;
      const sources = mockImport.mock.calls.filter(
        ([d]) => d.label === "video export source frame",
      );
      expect(sources.map(([d]) => d.handle)).toEqual([1101n, 1102n]);
      for (const result of mockImport.mock.results) {
        if (result.value.kind !== "source") continue;
        // Decoded pixels are meaningful: the access starts initialized.
        expect(result.value.beginAccess).toHaveBeenCalledWith(
          expect.anything(),
          true,
        );
      }
      expect(makeImageFromTexture).toHaveBeenCalledTimes(2);
      expect(ownVideoFrames).not.toHaveBeenCalled();
      // No blit, snapshot or GPU wait per clip: one checked flush per frame.
      expect(mockCalls.filter((c) => c === "target.flush")).toHaveLength(4);
      const release = [
        "source.image.dispose",
        "source.endAccess",
        "source.fence.destroy",
        "source.texture.destroy",
        "source.memory.destroy",
        "frame.release",
      ];
      // The first frame stays open across the frame that reuses it, and
      // closes once the second is imported, after that frame's GPU wait.
      const secondImport = mockCalls.lastIndexOf("source.beginAccess");
      expect(mockCalls.slice(secondImport + 1, secondImport + 8)).toEqual([
        ...release,
        "source1.dispose",
      ]);
      expect(
        mockCalls.lastIndexOf("target.flush", secondImport),
      ).toBeGreaterThan(mockCalls.indexOf("source.beginAccess"));
      expect(first.dispose).toHaveBeenCalledTimes(1);
      // The last frame closes at the end, after the final submissions.
      expect(mockCalls.slice(-7)).toEqual([...release, "source2.dispose"]);
      expect(second.dispose).toHaveBeenCalledTimes(1);
    });

    it("releases a clip's frame once it leaves the composition", async () => {
      const frame = decodedFrame(1);
      let call = 0;
      const { promise } = prepare(undefined, (): Record<string, MockFrame> =>
        call++ === 0 ? { clip: frame } : {},
      );
      await pumpAll();
      await promise;
      const released = mockCalls.indexOf("source1.dispose");
      expect(released).toBeGreaterThan(-1);
      // Released while decoding the second frame, before its draw.
      expect(
        mockCalls.filter((c, i) => c === "draw" && i < released),
      ).toHaveLength(1);
      expect(frame.dispose).toHaveBeenCalledTimes(1);
    });

    it("copies decoded frames for the session when the first import fails", async () => {
      mockImport.mockImplementation((descriptor: { label?: string }) => {
        if (descriptor.label === "video export source frame")
          throw new Error("no in-place import");
        return sharedMemory(descriptor);
      });
      let id = 0;
      const { promise } = prepare(undefined, () => ({
        clip: decodedFrame(++id),
      }));
      await pumpAll();
      await promise;
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(String(jest.mocked(console.warn).mock.calls[0]![1])).toContain(
        "no in-place import",
      );
      // One attempt only; every frame then goes through the copying importer.
      expect(
        mockImport.mock.calls.filter(
          ([d]) => d.label === "video export source frame",
        ),
      ).toHaveLength(1);
      expect(ownVideoFrames).toHaveBeenCalledTimes(3);
    });

    it("keeps a frame whose access cannot end and fails the export", async () => {
      mockImport.mockImplementation((descriptor: { label?: string }) => {
        const memory = sharedMemory(descriptor);
        if (memory.kind === "source")
          memory.endAccess.mockImplementation(() => {
            throw new Error("access stuck");
          });
        return memory;
      });
      const frame = decodedFrame(1);
      const { promise } = prepare(undefined, () => ({ clip: frame }));
      await pumpAll();
      await expect(promise).rejects.toThrow("access stuck");
      expect(frame.dispose).not.toHaveBeenCalled();
      expect(mockCalls).not.toContain("source.memory.destroy");
      const state = (
        globalThis as { __rnskwgpuExport?: { poisoned?: boolean } }
      ).__rnskwgpuExport;
      expect(state?.poisoned).toBe(true);
    });
  });
});
