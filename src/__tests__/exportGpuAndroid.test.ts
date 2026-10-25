const mockRuntimeTasks: Array<() => void> = [];
const mockCalls: string[] = [];
const mockImport = jest.fn();
const mockNativeFrame = jest.fn();
// The canvas context presenting to the encoder's input window.
const mockWindowFormat = { value: "rgba8unorm" };
const mockWindowContext = {
  configure: jest.fn(() => mockCalls.push("configure")),
  getCurrentTexture: jest.fn(() => {
    mockCalls.push("acquire");
    return {
      width: 640,
      height: 360,
      format: mockWindowFormat.value,
      destroy: jest.fn(() => mockCalls.push("window.texture.destroy")),
    };
  }),
  present: jest.fn(() => mockCalls.push("present")),
  unconfigure: jest.fn(() => mockCalls.push("unconfigure")),
};
const mockMakeWindowContext = jest.fn();
// The YUV conversion of decoded ImageReader frames (see yuvBlit.ts).
const mockYuvWrappers: { destroy: jest.Mock }[] = [];
const mockDevice = {
  importSharedTextureMemory: mockImport,
  createTexture: jest.fn((descriptor: { size: object; label?: string }) => {
    // The window's own frames, or a producer's converted YUV frames.
    const name =
      descriptor.label === "video export window slot" ? "slot" : "source";
    return {
      ...descriptor.size,
      format: "rgba8unorm",
      createView: jest.fn(() => ({})),
      destroy: jest.fn(() => mockCalls.push(`${name}.destroy`)),
    };
  }),
  createBindGroupLayout: jest.fn(() => ({})),
  createPipelineLayout: jest.fn(() => ({})),
  createSampler: jest.fn(() => ({})),
  createShaderModule: jest.fn(() => ({})),
  createRenderPipeline: jest.fn(() => ({})),
  createNativeBufferExternalTexture: jest.fn(() => {
    const wrapper = {
      externalTexture: {},
      beginAccess: jest.fn(),
      endAccess: jest.fn(() => null),
      destroy: jest.fn(() => mockCalls.push("yuv.destroy")),
    };
    mockYuvWrappers.push(wrapper);
    return wrapper;
  }),
  createBuffer: jest.fn(() => ({ destroy: jest.fn() })),
  createBindGroup: jest.fn(() => ({})),
  createCommandEncoder: jest.fn((descriptor?: { label?: string }) => ({
    beginRenderPass: jest.fn(() => ({
      setPipeline: jest.fn(),
      setBindGroup: jest.fn(),
      draw: jest.fn(),
      end: jest.fn(),
    })),
    copyTextureToTexture: jest.fn(),
    finish: jest.fn(() => ({ label: descriptor?.label })),
  })),
  queue: {
    writeBuffer: jest.fn(),
    // A YUV conversion, or the copy of a frame into the window.
    submit: jest.fn(([buffer]: { label?: string }[]) =>
      mockCalls.push(
        buffer?.label === "video export window copy" ? "copy" : "convert",
      ),
    ),
  },
};
jest.mock("../gpuDevice", () => ({
  getVideoGpuDevice: jest.fn(() => mockDevice),
  createNativeVideoGpuFrame: (handle: bigint) => mockNativeFrame(handle),
  createNativeWindowGpuContext: (
    window: bigint,
    width: number,
    height: number,
  ) => mockMakeWindowContext(window, width, height),
  nativeVideoTextureUsage: 20,
  encoderWindowTextureUsage: 24,
  videoShaderStages: { vertex: 1, fragment: 2 },
  videoUniformBufferUsage: 72,
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
jest.mock("react-native", () => ({ Platform: { OS: "android" } }));
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
  };
  return {
    canvas,
    enableCheckedSubmissions: jest.fn(),
    getCanvas: jest.fn(() => canvas),
    // A checked flush waits for the GPU; otherwise the recording is submitted.
    flush: jest.fn((sync?: boolean) =>
      mockCalls.push(`${label}.${sync ? "flush" : "submit"}`),
    ),
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
    Image: { MakeFromGPUTexture: jest.fn() },
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
    getBackendInfo: jest.fn(() => ({ gpuDirectExport: true })),
  },
}));

import { Skia } from "react-native-skia";
import RNSkiaVideoModule from "../RNSkiaVideoModule";
import type { VideoFrame } from "../types";
import { exportVideoComposition } from "../exportVideoComposition";
import { ownVideoFrames } from "../frameInterop";

const createVideoEncoder = RNSkiaVideoModule.createVideoEncoder as jest.Mock;
const createExtractor =
  RNSkiaVideoModule.createVideoCompositionFramesExtractorSync as jest.Mock;
const makeOffscreen = Skia.Surface.MakeOffscreen as jest.Mock;
const makeFromTexture = (
  Skia.Surface as unknown as { MakeFromGPUTexture: jest.Mock }
).MakeFromGPUTexture;

const prepare = (decode: () => Record<string, unknown> = () => ({})) => {
  const encoder = {
    prepare: jest.fn(),
    acquireInputWindow: jest.fn(() => 900n),
    // Natively: sets the frame's time on the window, then presents.
    encodeFrame: jest.fn(
      (frame: { kind: string; present?: () => void }, _time: number) => {
        mockCalls.push("encode");
        if (frame.kind === "window") frame.present!();
      },
    ),
    finishWriting: jest.fn(),
    dispose: jest.fn(() => mockCalls.push("encoder.dispose")),
  };
  createVideoEncoder.mockReturnValueOnce(encoder);
  createExtractor.mockReturnValueOnce({
    start: jest.fn(),
    decodeCompositionFrames: jest.fn(decode),
    dispose: jest.fn(),
  });
  const promise = exportVideoComposition({
    videoComposition: { duration: 1, items: [] },
    outPath: "/tmp/out.mp4",
    width: 640,
    height: 360,
    frameRate: 3,
    bitRate: 1_000_000,
    drawFrame: jest.fn(() => mockCalls.push("draw")),
  });
  void promise.catch(() => undefined);
  return { encoder, promise };
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
  mockYuvWrappers.length = 0;
  mockWindowFormat.value = "rgba8unorm";
  mockMakeWindowContext.mockReset().mockReturnValue(mockWindowContext);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("Android GPU export", () => {
  it("draws into its own textures and copies each frame into the encoder's window", async () => {
    const { encoder, promise } = prepare();
    await pumpAll();
    await promise;
    expect(encoder.acquireInputWindow).toHaveBeenCalledTimes(1);
    expect(mockMakeWindowContext).toHaveBeenCalledWith(900n, 640, 360);
    expect(mockWindowContext.configure).toHaveBeenCalledWith({
      device: mockDevice,
      format: "rgba8unorm",
      usage: 24,
    });
    // No readback, no AHardwareBuffer lent or imported for the output. Two
    // slots, each wrapped once, both accounted.
    expect(makeOffscreen).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
    expect(makeFromTexture).toHaveBeenCalledTimes(2);
    expect(RNSkiaVideoModule.reserveMemory).toHaveBeenCalledTimes(2);
    expect(RNSkiaVideoModule.releaseMemory).toHaveBeenCalledTimes(2);
    expect(encoder.encodeFrame.mock.calls).toEqual([
      [{ kind: "window", present: expect.any(Function) }, 0],
      [{ kind: "window", present: expect.any(Function) }, 1 / 3],
      [{ kind: "window", present: expect.any(Function) }, 2 / 3],
    ]);
    // A frame's drawing is submitted without a wait; the window texture is
    // acquired, the copy into it submitted, then presented.
    const present = ["copy", "encode", "present"];
    // The first frame draws into the slot the probe cleared, and copies into
    // the window texture the probe acquired. The GPU work of each frame is
    // waited for once the next frame is decoded, or before the export ends.
    expect(mockCalls).toEqual([
      "configure",
      "acquire",
      "target.flush",
      "draw",
      "target.submit",
      ...present,
      "target.flush",
      "draw",
      "target.submit",
      "acquire",
      ...present,
      "target.flush",
      "draw",
      "target.submit",
      "acquire",
      ...present,
      "target.flush",
      // The codec gets its buffers back before the encoder goes; the slots
      // go once everything is released.
      "unconfigure",
      "encoder.dispose",
      "target.dispose",
      "slot.destroy",
      "target.dispose",
      "slot.destroy",
    ]);
    // Frames alternate between the two slots; each wait goes through the
    // slot the next frame draws into.
    const slots = makeFromTexture.mock.results.map((result) => result.value);
    expect(slots.map((slot) => slot.flush.mock.calls)).toEqual([
      [[true], [false], [true], [false]],
      [[true], [false], [true]],
    ]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("falls back to CPU readback when the window texture is not RGBA", async () => {
    mockWindowFormat.value = "bgra8unorm";
    const { encoder, promise } = prepare();
    await pumpAll();
    await promise;
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String(jest.mocked(console.warn).mock.calls[0]![1])).toContain(
      "RGBA layout mismatch",
    );
    // Closed before the readback frames, which EGL draws into the window.
    expect(mockWindowContext.unconfigure).toHaveBeenCalledTimes(1);
    expect(mockCalls.filter((call) => call === "slot.destroy")).toHaveLength(2);
    expect(mockWindowContext.present).not.toHaveBeenCalled();
    expect(makeOffscreen).toHaveBeenCalledTimes(1);
    expect(encoder.encodeFrame).toHaveBeenCalledTimes(3);
    for (const [pixels] of encoder.encodeFrame.mock.calls)
      expect(pixels).toMatchObject({ kind: "rgba", width: 640, height: 360 });
  });

  it("falls back to CPU readback when WebGPU cannot present to a native window", async () => {
    mockMakeWindowContext.mockImplementation(() => {
      throw new Error("React Native WebGPU cannot present to a native window");
    });
    const { encoder, promise } = prepare();
    await pumpAll();
    await promise;
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(mockWindowContext.unconfigure).not.toHaveBeenCalled();
    expect(makeOffscreen).toHaveBeenCalledTimes(1);
    for (const [pixels] of encoder.encodeFrame.mock.calls)
      expect(pixels).toMatchObject({ kind: "rgba" });
  });

  it("closes the window before the encoder when presenting a frame fails", async () => {
    mockWindowContext.present.mockImplementationOnce(() => {
      throw new Error("present failed");
    });
    const { encoder, promise } = prepare();
    await pumpAll();
    await expect(promise).rejects.toThrow("present failed");
    expect(encoder.encodeFrame).toHaveBeenCalledTimes(1);
    expect(encoder.finishWriting).not.toHaveBeenCalled();
    // The window closes before the encoder; then the slots are freed.
    const closed = mockCalls.indexOf("unconfigure");
    expect(mockCalls.slice(closed)).toEqual([
      "unconfigure",
      "encoder.dispose",
      "target.dispose",
      "slot.destroy",
      "target.dispose",
      "slot.destroy",
    ]);
  });

  it("samples ImageReader frames in place once converted, without snapshots or waits", async () => {
    const makeImage = Skia.Image.MakeFromGPUTexture as jest.Mock;
    makeImage.mockImplementation(() => ({
      dispose: jest.fn(() => mockCalls.push("image.dispose")),
    }));
    mockNativeFrame.mockImplementation((handle: bigint) => ({
      handle,
      width: 648,
      height: 368,
      pixelFormat: "bgra8",
      release: jest.fn(() => mockCalls.push(`frame${handle}.release`)),
    }));
    const frames: VideoFrame[] = [];
    let id = 0;
    const { promise } = prepare(() => {
      const frameId = ++id;
      const frame: VideoFrame = {
        id: frameId,
        producerId: 7,
        width: 640,
        height: 360,
        rotation: 0,
        // The ImageReader cycles through its buffers.
        texture: {
          kind: "native-buffer",
          nativeBuffer: frameId === 2 ? 501n : 500n,
          region: { x: 0, y: 0, width: 640, height: 360 },
          rotation: 0,
        },
        dispose: jest.fn(() => mockCalls.push(`lease${frameId}.dispose`)),
      };
      frames.push(frame);
      return { clip: frame };
    });
    await pumpAll();
    await promise;
    expect(jest.mocked(console.warn).mock.calls).toEqual([]);
    // No copy through frameInterop, no snapshot, no wait of its own.
    expect(ownVideoFrames).not.toHaveBeenCalled();
    // One producer texture, besides the window's two slots.
    const sources = mockDevice.createTexture.mock.calls
      .map(([descriptor], index) => ({ descriptor, index }))
      .filter(
        ({ descriptor }) => descriptor.label !== "video export window slot",
      );
    expect(sources).toHaveLength(1);
    const source =
      mockDevice.createTexture.mock.results[sources[0]!.index]!.value;
    expect(makeImage.mock.calls).toEqual([[source], [source], [source]]);
    // Two buffers, each imported once.
    expect(mockDevice.createNativeBufferExternalTexture).toHaveBeenCalledTimes(
      2,
    );
    // After the probe's flush.
    const exported = mockCalls.slice(mockCalls.indexOf("target.flush") + 1);
    // The conversion precedes the drawing, submitted without a wait; a lease
    // is given back after the next frame's conversion, once the checked wait
    // made when that frame was decoded returned.
    expect(exported.slice(0, 3)).toEqual(["convert", "draw", "target.submit"]);
    const waited = exported.indexOf("target.flush");
    const second = exported.indexOf("convert", 3);
    expect(waited).toBeGreaterThan(exported.indexOf("draw"));
    expect(waited).toBeLessThan(second);
    expect(exported.indexOf("lease1.dispose")).toBeGreaterThan(second);
    // The last frame is waited for before the export releases it.
    expect(exported.lastIndexOf("target.flush")).toBeGreaterThan(
      exported.lastIndexOf("draw"),
    );
    expect(exported.lastIndexOf("target.flush")).toBeLessThan(
      exported.indexOf("lease3.dispose"),
    );
    for (const frame of frames) expect(frame.dispose).toHaveBeenCalledTimes(1);
    // Everything is released once the export ends.
    for (const wrapper of mockYuvWrappers)
      expect(wrapper.destroy).toHaveBeenCalledTimes(1);
    expect(source.destroy).toHaveBeenCalledTimes(1);
    expect(RNSkiaVideoModule.releaseMemory).toHaveBeenCalledWith(42);
    makeImage.mockReset();
    mockNativeFrame.mockReset();
  });

  it("closes the fresh lease Android hands out for a picture a clip holds", async () => {
    const makeImage = Skia.Image.MakeFromGPUTexture as jest.Mock;
    makeImage.mockImplementation(() => ({ dispose: jest.fn() }));
    mockNativeFrame.mockImplementation((handle: bigint) => ({
      handle,
      width: 640,
      height: 360,
      pixelFormat: "bgra8",
      release: jest.fn(),
    }));
    // The first picture is held over two export frames: each decode leases
    // it again.
    const ids = [1, 1, 2];
    const frames: VideoFrame[] = [];
    const { promise } = prepare(() => {
      const frame: VideoFrame = {
        id: ids[frames.length]!,
        producerId: 7,
        width: 640,
        height: 360,
        rotation: 0,
        texture: {
          kind: "native-buffer",
          nativeBuffer: 500n,
          region: { x: 0, y: 0, width: 640, height: 360 },
          rotation: 0,
        },
        dispose: jest.fn(),
      };
      frames.push(frame);
      return { clip: frame };
    });
    await pumpAll();
    await promise;
    expect(console.warn).not.toHaveBeenCalled();
    // Two pictures, two conversions; every lease closes exactly once.
    expect(makeImage).toHaveBeenCalledTimes(2);
    for (const frame of frames) expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(RNSkiaVideoModule.releaseMemory).toHaveBeenCalledWith(42);
    makeImage.mockReset();
    mockNativeFrame.mockReset();
  });

  it("keeps copying decoded frames: only the output is GPU-direct", async () => {
    let id = 0;
    const { promise } = prepare(() => ({
      clip: {
        id: ++id,
        producerId: 7,
        width: 640,
        height: 360,
        rotation: 0,
        texture: { kind: "native-buffer", nativeBuffer: 500n },
        dispose: jest.fn(),
      },
    }));
    await pumpAll();
    await promise;
    expect(ownVideoFrames).toHaveBeenCalledTimes(3);
    expect(
      mockImport.mock.calls.filter(
        ([d]) => d.label === "video export source frame",
      ),
    ).toHaveLength(0);
  });
});
