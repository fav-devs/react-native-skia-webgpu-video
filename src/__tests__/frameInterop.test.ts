import { Skia } from "react-native-skia";
import RNSkiaVideoModule from "../RNSkiaVideoModule";
import {
  imageFromVideoFrame,
  releaseVideoFrameImage,
  clearVideoFrameImages,
  ownVideoFrames,
} from "../frameInterop";
import type { VideoFrame } from "../types";

const mockCanvas = {
  drawColor: jest.fn(),
  drawImage: jest.fn(),
  dispose: jest.fn(),
};
const mockSurface = {
  enableCheckedSubmissions: jest.fn(),
  getCanvas: jest.fn(() => mockCanvas),
  makeImageSnapshot: jest.fn(() => ({ dispose: jest.fn() })),
  flush: jest.fn(),
  dispose: jest.fn(),
};
const mockUploadTexture = {
  nativePointer: 456n,
  format: "rgba8unorm",
  createView: jest.fn(() => ({})),
  destroy: jest.fn(),
};
const mockNativeSource = {
  width: 4,
  height: 2,
  pixelFormat: "bgra8",
  release: jest.fn(),
};
const mockCopy = jest.fn();
const mockWriteTexture = jest.fn();
const mockCreateTexture = jest.fn(
  (
    _descriptor: GPUTextureDescriptor,
  ): { nativePointer: bigint; destroy: jest.Mock } => mockUploadTexture,
);
const mockWrapNative = jest.fn((_pointer: bigint) => mockNativeSource);
// One wrapper per imported decoder buffer, in creation order.
const mockYuvImports: {
  externalTexture: object;
  beginAccess: jest.Mock;
  endAccess: jest.Mock;
  destroy: jest.Mock;
}[] = [];
const mockImportYuv = jest.fn((_source: unknown, _descriptor: unknown) => {
  const wrapper = {
    externalTexture: {},
    beginAccess: jest.fn(),
    endAccess: jest.fn(() => null),
    destroy: jest.fn(),
  };
  mockYuvImports.push(wrapper);
  return wrapper;
});
// One external texture per iOS NV12 frame, in import order.
const mockExternals: { destroy: jest.Mock }[] = [];
const mockImportExternal = jest.fn((_descriptor: unknown) => {
  const external = { destroy: jest.fn() };
  mockExternals.push(external);
  return external;
});
const mockWriteBuffer = jest.fn();
const mockSubmit = jest.fn();
const mockPass = {
  setPipeline: jest.fn(),
  setBindGroup: jest.fn(),
  draw: jest.fn(),
  end: jest.fn(),
};
jest.mock("../gpuDevice", () => ({
  getVideoGpuDevice: () => ({
    createTexture: mockCreateTexture,
    limits: { maxTextureDimension2D: 4096 },
    createBindGroupLayout: jest.fn(() => ({})),
    createPipelineLayout: jest.fn(() => ({})),
    createSampler: jest.fn(() => ({})),
    createShaderModule: jest.fn(() => ({})),
    createRenderPipeline: jest.fn(() => ({})),
    createNativeBufferExternalTexture: mockImportYuv,
    importExternalTexture: mockImportExternal,
    createBuffer: jest.fn(() => ({ destroy: jest.fn() })),
    createBindGroup: jest.fn(() => ({})),
    createCommandEncoder: jest.fn(() => ({
      beginRenderPass: jest.fn(() => mockPass),
      finish: jest.fn(() => ({})),
    })),
    queue: {
      copyExternalImageToTexture: mockCopy,
      writeTexture: mockWriteTexture,
      writeBuffer: mockWriteBuffer,
      submit: mockSubmit,
    },
  }),
  createNativeVideoGpuFrame: (pointer: bigint) => mockWrapNative(pointer),
  nativeVideoTextureUsage: 21,
  rgbaVideoTextureUsage: 23,
  videoShaderStages: { vertex: 1, fragment: 2 },
  videoUniformBufferUsage: 72,
}));
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
jest.mock("react-native-skia", () => ({
  Skia: {
    Surface: {
      MakeOffscreen: jest.fn(),
      MakeFromGPUTexture: jest.fn(() => ({ ...mockSurface })),
    },
    Color: jest.fn(() => 0),
    Data: { fromBytes: jest.fn(() => ({ dispose: jest.fn() })) },
    Image: {
      MakeRaster: jest.fn(() => ({ dispose: jest.fn() })),
      MakeFromGPUTexture: jest.fn(),
    },
  },
  BlendMode: { Clear: 0 },
  ColorType: { RGBA_8888: 4 },
  AlphaType: { Opaque: 0 },
}));
jest.mock("../RNSkiaVideoModule", () => ({
  __esModule: true,
  default: {
    frameProtocolVersion: 1,
    reserveMemory: jest.fn(() => 17),
    releaseMemory: jest.fn(),
  },
}));

const reserve = RNSkiaVideoModule.reserveMemory as jest.Mock;
const release = RNSkiaVideoModule.releaseMemory as jest.Mock;
const makeImage = Skia.Image.MakeRaster as jest.Mock;
const rgbaFrame = (id = 1, producerId = 1): VideoFrame => ({
  id,
  producerId,
  width: 4,
  height: 2,
  rotation: 0,
  texture: { kind: "rgba", data: new ArrayBuffer(32), bytesPerRow: 16 },
  dispose: jest.fn(),
});

const copyableRgbaFrame = (
  id = 1,
  producerId = 1,
  width = 4,
  height = 2,
  bytesPerRow = width * 4,
) => {
  const source = new Uint8Array(bytesPerRow * height);
  source.fill(id);
  const readData = jest.fn(() => source.buffer);
  const copyPixelsTo = jest.fn((destination: ArrayBuffer) => {
    new Uint8Array(destination).set(source);
  });
  const texture = { kind: "rgba", bytesPerRow, copyPixelsTo };
  Object.defineProperty(texture, "data", { get: readData });
  const frame: VideoFrame = {
    ...rgbaFrame(id, producerId),
    width,
    height,
    texture,
  };
  return { frame, source, readData, copyPixelsTo };
};

beforeEach(() => {
  clearVideoFrameImages(true);
  jest.clearAllMocks();
  mockYuvImports.length = 0;
  reserve.mockReset();
  release.mockReset();
  reserve.mockImplementation(() => 17);
});
afterEach(() => clearVideoFrameImages(true));

const withAndroidInterop = (
  check: (context: {
    interop: typeof import("../frameInterop");
    skia: typeof Skia;
    reserve: jest.Mock;
    release: jest.Mock;
  }) => void,
) => {
  jest.isolateModules(() => {
    const rn = require("react-native") as { Platform: { OS: string } };
    rn.Platform.OS = "android";
    const interop =
      require("../frameInterop") as typeof import("../frameInterop");
    const skia = (require("react-native-skia") as { Skia: typeof Skia }).Skia;
    const native = (
      require("../RNSkiaVideoModule") as { default: typeof RNSkiaVideoModule }
    ).default;
    try {
      check({
        interop,
        skia,
        reserve: native.reserveMemory as jest.Mock,
        release: native.releaseMemory as jest.Mock,
      });
    } finally {
      interop.clearVideoFrameImages(true);
    }
  });
};

describe("iOS NV12 frames", () => {
  const nv12Frame = (): VideoFrame => ({
    id: 1,
    producerId: 1,
    width: 4,
    height: 2,
    rotation: 90,
    texture: { kind: "native-buffer", nativeBuffer: 123n, format: "nv12" },
    dispose: jest.fn(),
  });
  const nv12Source = (width = 4, height = 2) => ({
    handle: 123n,
    width,
    height,
    pixelFormat: "nv12",
    release: jest.fn(),
  });

  afterEach(() => {
    mockExternals.length = 0;
    clearVideoFrameImages(true);
  });

  it("converts the decoder buffer on the GPU, in decoded orientation, and ends its import once submitted", () => {
    const source = nv12Source();
    mockWrapNative.mockReturnValueOnce(source);
    const frame = nv12Frame();
    expect(imageFromVideoFrame(frame)).not.toBeNull();
    expect(mockCopy).not.toHaveBeenCalled();
    // Only the matrix and range: the transfer function and primaries stay.
    expect(mockImportExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        source,
        sourceColorSpace: { primaries: "srgb", transfer: "srgb" },
      }),
    );
    expect(mockImportExternal.mock.calls[0]![0]).not.toHaveProperty("rotation");
    expect(mockPass.draw).toHaveBeenCalledWith(3);
    expect(mockSubmit).toHaveBeenCalled();
    expect(mockExternals[0]!.destroy).toHaveBeenCalled();
    // The lease goes back once the checked flush covered the draw.
    expect(source.release).toHaveBeenCalled();
    expect(frame.dispose).toHaveBeenCalled();
  });

  it("rejects a buffer whose size disagrees with the frame", () => {
    mockWrapNative.mockReturnValueOnce(nv12Source(8, 2));
    expect(() => imageFromVideoFrame(nv12Frame())).toThrow(
      "Native video buffer dimensions mismatch",
    );
    expect(mockImportExternal).not.toHaveBeenCalled();
  });
});

describe("Android ImageReader YUV frames", () => {
  // An 8×6 codec buffer whose 6×4 picture has right/bottom padding.
  const yuvFrame = (
    rotation: number,
    region = { x: 0, y: 0, width: 6, height: 4 },
  ): VideoFrame => {
    const turned = rotation === 90 || rotation === 270;
    return {
      id: 1,
      producerId: 1,
      width: turned ? region.height : region.width,
      height: turned ? region.width : region.height,
      rotation: 0,
      texture: { kind: "native-buffer", nativeBuffer: 123n, region, rotation },
      dispose: jest.fn(),
    };
  };
  const yuvSource = (handle = 123n) => ({
    handle,
    width: 8,
    height: 6,
    pixelFormat: "nv12",
    release: jest.fn(),
  });
  // The uv mapping written for the last frame: scale, then offset.
  const lastMapping = () =>
    Array.from(mockWriteBuffer.mock.calls.at(-1)![2] as Float32Array);
  const fround = (values: number[]) => values.map(Math.fround);

  it("converts, crops and turns the codec buffer into display-sized scratch", () => {
    withAndroidInterop(({ interop }) => {
      const source = yuvSource();
      const owned = yuvSource();
      mockWrapNative.mockReturnValueOnce(source).mockReturnValueOnce(owned);
      const frame = yuvFrame(90);
      expect(interop.imageFromVideoFrame(frame)).not.toBeNull();
      expect(mockCreateTexture).toHaveBeenCalledWith(
        expect.objectContaining({
          size: { width: 4, height: 6 },
          format: "rgba8unorm",
        }),
      );
      expect(mockCopy).not.toHaveBeenCalled();
      // Imported with a reference of its own, keeping the video's encoding.
      expect(mockWrapNative).toHaveBeenNthCalledWith(2, 123n);
      expect(mockImportYuv).toHaveBeenCalledWith(owned, {
        label: "video decoder buffer",
        rotation: 90,
        mirrored: false,
        sourceColorSpace: { primaries: "srgb", transfer: "srgb" },
      });
      // Turned clockwise the buffer is 6×8; the bottom padding comes first
      // along x.
      expect(lastMapping()).toEqual(fround([4 / 6, 6 / 8, 2 / 6, 0]));
      const [wrapper] = mockYuvImports;
      expect(wrapper!.beginAccess).toHaveBeenCalledTimes(1);
      expect(wrapper!.endAccess).toHaveBeenCalledTimes(1);
      expect(mockPass.draw).toHaveBeenCalledWith(3);
      expect(mockSubmit).toHaveBeenCalledTimes(1);
      // The snapshot owns the pixels: both native leases close after the
      // fence. The import keeps its own reference until it is released.
      expect(source.release).toHaveBeenCalledTimes(1);
      expect(frame.dispose).toHaveBeenCalledTimes(1);
      expect(owned.release).not.toHaveBeenCalled();
      interop.clearVideoFrameImages(true);
      expect(wrapper!.destroy).toHaveBeenCalledTimes(1);
      expect(owned.release).toHaveBeenCalledTimes(1);
    });
  });

  it("imports each decoder buffer once and releases them with their producer", () => {
    withAndroidInterop(({ interop }) => {
      const frames = [123n, 124n, 123n].map((handle, index) => {
        mockWrapNative.mockReturnValueOnce(yuvSource(handle));
        if (index < 2) mockWrapNative.mockReturnValueOnce(yuvSource(handle));
        const frame = { ...yuvFrame(0), id: index + 1 };
        interop.imageFromVideoFrame(frame);
        return frame;
      });
      // The third frame is the first buffer again: only its access reopens.
      expect(mockImportYuv).toHaveBeenCalledTimes(2);
      expect(mockYuvImports[0]!.beginAccess).toHaveBeenCalledTimes(2);
      expect(mockYuvImports[1]!.beginAccess).toHaveBeenCalledTimes(1);
      // The mapping did not change, so it is written once per import.
      expect(mockWriteBuffer).toHaveBeenCalledTimes(2);
      interop.releaseVideoFrameImage(frames[2]!);
      for (const wrapper of mockYuvImports)
        expect(wrapper.destroy).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps at most six decoder buffers per producer", () => {
    withAndroidInterop(({ interop }) => {
      let next = 200n;
      mockWrapNative.mockImplementation((pointer) =>
        // Each frame shows a new buffer; an import wraps the same one again.
        yuvSource(pointer === 123n ? next++ : pointer),
      );
      try {
        for (let index = 0; index < 7; index++)
          interop.imageFromVideoFrame({ ...yuvFrame(0), id: index + 1 });
      } finally {
        mockWrapNative.mockImplementation(() => mockNativeSource);
      }
      expect(mockImportYuv).toHaveBeenCalledTimes(7);
      // The least recently drawn buffer went first.
      expect(
        mockYuvImports.map((wrapper) => wrapper.destroy.mock.calls.length),
      ).toEqual([1, 0, 0, 0, 0, 0, 0]);
    });
  });

  it("closes the buffer access when the draw fails", () => {
    withAndroidInterop(({ interop }) => {
      mockWrapNative.mockReturnValueOnce(yuvSource());
      mockSubmit.mockImplementationOnce(() => {
        throw new Error("submit failed");
      });
      expect(() => interop.imageFromVideoFrame(yuvFrame(0))).toThrow(
        "submit failed",
      );
      expect(mockYuvImports[0]!.beginAccess).toHaveBeenCalledTimes(1);
      expect(mockYuvImports[0]!.endAccess).toHaveBeenCalledTimes(1);
    });
  });

  it("maps the crop rectangle for every rotation", () => {
    // An 8×6 buffer: one column of padding on each side, none above and two
    // rows below the 6×4 picture. Each turn moves those margins elsewhere.
    const region = { x: 1, y: 0, width: 6, height: 4 };
    const expected: Record<number, { x: number; y: number }> = {
      0: { x: 1, y: 0 },
      90: { x: 2, y: 1 },
      180: { x: 1, y: 2 },
      270: { x: 0, y: 1 },
    };
    for (const rotation of [0, 90, 180, 270]) {
      withAndroidInterop(({ interop }) => {
        mockWrapNative.mockReturnValueOnce(yuvSource());
        interop.imageFromVideoFrame(yuvFrame(rotation, region));
        // The offset is the origin in the upright buffer, 8×6 or turned 6×8.
        const turned = rotation === 90 || rotation === 270;
        const [width, height] = turned ? [6, 8] : [8, 6];
        expect(lastMapping().slice(2)).toEqual(
          fround([
            expected[rotation]!.x / width,
            expected[rotation]!.y / height,
          ]),
        );
      });
    }
  });

  it("scales the region to a capped frame size", () => {
    withAndroidInterop(({ interop }) => {
      mockWrapNative.mockReturnValueOnce(yuvSource());
      // A 6×4 region wanted at 3×2: the scratch has the frame's size, and the
      // blit samples the same region of the 8×6 buffer.
      const frame = { ...yuvFrame(0), width: 3, height: 2 };
      expect(interop.imageFromVideoFrame(frame)).not.toBeNull();
      expect(mockCreateTexture).toHaveBeenCalledWith(
        expect.objectContaining({ size: { width: 3, height: 2 } }),
      );
      expect(lastMapping()).toEqual(fround([6 / 8, 4 / 6, 0, 0]));
    });
  });

  it("rejects a region that overflows the buffer", () => {
    withAndroidInterop(({ interop }) => {
      expect(() =>
        interop.imageFromVideoFrame(
          yuvFrame(0, { x: 3, y: 0, width: 6, height: 4 }),
        ),
      ).toThrow("Native video buffer region or YUV layout mismatch");
      expect(mockCopy).not.toHaveBeenCalled();
      expect(mockImportYuv).not.toHaveBeenCalled();
    });
  });

  it("does not trust RN WebGPU's label for driver-defined YUV formats", () => {
    withAndroidInterop(({ interop }) => {
      // A Tensor decoder buffer (format 0x123) is labelled "bgra8".
      mockWrapNative.mockReturnValueOnce({
        ...yuvSource(),
        pixelFormat: "bgra8",
      });
      expect(interop.imageFromVideoFrame(yuvFrame(0))).not.toBeNull();
      expect(mockImportYuv).toHaveBeenCalledTimes(1);
    });
  });
});

describe("Android RGBA Graphite upload", () => {
  it("fills a budgeted private CPU scratch without materializing lazy native data", () => {
    withAndroidInterop(
      ({ interop, skia, reserve: androidReserve, release: androidRelease }) => {
        const { frame, readData, copyPixelsTo } = copyableRgbaFrame();
        readData.mockImplementation(() => {
          throw new Error("Lazy data must not be read");
        });
        interop.imageFromVideoFrame(frame);
        expect(readData).not.toHaveBeenCalled();
        expect(copyPixelsTo).toHaveBeenCalledTimes(1);
        const buffer = copyPixelsTo.mock.calls[0]![0];
        const uploaded = mockWriteTexture.mock.calls[0]![1] as Uint8Array;
        expect(buffer).toBeInstanceOf(ArrayBuffer);
        expect(uploaded.buffer).toBe(buffer);
        expect(Array.from(uploaded)).toEqual(new Array(32).fill(1));
        expect(skia.Data.fromBytes).not.toHaveBeenCalled();
        expect(skia.Image.MakeRaster).not.toHaveBeenCalled();
        expect(
          androidReserve.mock.calls.map((call) => call.slice(0, 2)),
        ).toEqual([
          [32, "owned video image"],
          [32, "RGBA frame WebGPU upload texture"],
          [32, "RGBA frame CPU upload buffer"],
        ]);
        expect(androidReserve.mock.invocationCallOrder[2]!).toBeLessThan(
          copyPixelsTo.mock.invocationCallOrder[0]!,
        );
        expect(copyPixelsTo.mock.invocationCallOrder[0]!).toBeLessThan(
          mockWriteTexture.mock.invocationCallOrder[0]!,
        );
        expect(mockSurface.flush.mock.invocationCallOrder[0]!).toBeLessThan(
          (frame.dispose as jest.Mock).mock.invocationCallOrder[0]!,
        );
        interop.clearVideoFrameImages(true);
        expect(androidRelease).toHaveBeenCalledTimes(3);
      },
    );
  });

  it("reuses and refreshes CPU scratch after the fence, preserving saved raw aliases and older snapshots", () => {
    withAndroidInterop(({ interop, skia, reserve: androidReserve }) => {
      let uploaded: number[] = [];
      mockWriteTexture.mockImplementation((_, pixels: Uint8Array) => {
        uploaded = Array.from(pixels);
      });
      const wrap = () => ({
        ...mockSurface,
        makeImageSnapshot: () => ({
          pixels: uploaded.slice(),
          dispose: jest.fn(),
        }),
      });
      (skia.Surface.MakeFromGPUTexture as jest.Mock)
        .mockImplementationOnce(wrap)
        .mockImplementationOnce(wrap);
      const first = copyableRgbaFrame(1, 1);
      const savedRaw = new Uint8Array(first.readData());
      first.readData.mockClear();
      const firstImage = interop.imageFromVideoFrame(first.frame)!;
      const second = copyableRgbaFrame(2, 2);
      const secondImage = interop.imageFromVideoFrame(second.frame)!;
      expect(first.copyPixelsTo.mock.calls[0]![0]).toBe(
        second.copyPixelsTo.mock.calls[0]![0],
      );
      expect(firstImage).toMatchObject({ pixels: new Array(32).fill(1) });
      expect(secondImage).toMatchObject({ pixels: new Array(32).fill(2) });
      expect(Array.from(savedRaw)).toEqual(new Array(32).fill(1));
      expect(first.readData).not.toHaveBeenCalled();
      expect(second.readData).not.toHaveBeenCalled();
      expect(mockSurface.flush.mock.invocationCallOrder[0]!).toBeLessThan(
        second.copyPixelsTo.mock.invocationCallOrder[0]!,
      );
      expect(mockCreateTexture).toHaveBeenCalledTimes(1);
      expect(
        androidReserve.mock.calls.filter(
          (call) => call[1] === "RGBA frame CPU upload buffer",
        ),
      ).toHaveLength(1);
      expect(interop.imageFromVideoFrame(first.frame)).toBe(firstImage);
      expect(first.copyPixelsTo).toHaveBeenCalledTimes(1);
      expect(firstImage.dispose).not.toHaveBeenCalled();
    });
  });

  it("keeps one accounted CPU scratch through padded-stride and resolution changes, then releases every reservation", () => {
    withAndroidInterop(
      ({ interop, reserve: androidReserve, release: androidRelease }) => {
        let nextToken = 1;
        const live = new Map<number, number>();
        androidReserve.mockImplementation((bytes: number) => {
          const token = nextToken++;
          live.set(token, bytes);
          return token;
        });
        androidRelease.mockImplementation((token: number) => {
          expect(live.delete(token)).toBe(true);
        });
        const first = copyableRgbaFrame(1, 1, 3, 2, 16);
        const padded = copyableRgbaFrame(2, 2, 3, 2, 20);
        const resized = copyableRgbaFrame(3, 3, 5, 2, 24);
        interop.imageFromVideoFrame(first.frame);
        expect([...live.values()].reduce((sum, bytes) => sum + bytes, 0)).toBe(
          80,
        );
        interop.imageFromVideoFrame(padded.frame);
        expect([...live.values()].reduce((sum, bytes) => sum + bytes, 0)).toBe(
          112,
        );
        expect(mockCreateTexture).toHaveBeenCalledTimes(1);
        interop.imageFromVideoFrame(resized.frame);
        expect([...live.values()].reduce((sum, bytes) => sum + bytes, 0)).toBe(
          176,
        );
        expect(mockCreateTexture).toHaveBeenCalledTimes(2);
        expect(first.copyPixelsTo.mock.calls[0]![0]).not.toBe(
          padded.copyPixelsTo.mock.calls[0]![0],
        );
        expect(padded.copyPixelsTo.mock.calls[0]![0]).not.toBe(
          resized.copyPixelsTo.mock.calls[0]![0],
        );
        expect(
          androidReserve.mock.calls
            .filter((call) => call[1] === "RGBA frame CPU upload buffer")
            .map((call) => call[0]),
        ).toEqual([32, 40, 48]);
        interop.clearVideoFrameImages(true);
        expect(live.size).toBe(0);
        expect(androidRelease).toHaveBeenCalledTimes(8);
      },
    );
  });

  it("drops unused CPU scratch when importing a raw-data compatibility frame", () => {
    withAndroidInterop(({ interop, release: androidRelease }) => {
      const native = copyableRgbaFrame();
      interop.imageFromVideoFrame(native.frame);
      const raw = rgbaFrame(2, 2);
      interop.imageFromVideoFrame(raw);
      const uploaded = mockWriteTexture.mock.calls[1]![1] as Uint8Array;
      expect(uploaded.buffer).toBe((raw.texture as { data: ArrayBuffer }).data);
      expect(androidRelease).toHaveBeenCalledTimes(1);
      expect(mockCreateTexture).toHaveBeenCalledTimes(1);
      interop.clearVideoFrameImages(true);
      expect(androidRelease).toHaveBeenCalledTimes(4);
    });
  });

  it("rejects invalid fast-path layouts and extents before copying or allocating", () => {
    withAndroidInterop(({ interop, reserve: androidReserve }) => {
      const misaligned = copyableRgbaFrame(1, 1, 3, 2, 14);
      const oversized = copyableRgbaFrame(2, 2, 4097, 1, 4097 * 4);
      expect(() => interop.imageFromVideoFrame(misaligned.frame)).toThrow(
        "Invalid RGBA",
      );
      expect(() => interop.imageFromVideoFrame(oversized.frame)).toThrow(
        "texture extent limit",
      );
      expect(androidReserve).not.toHaveBeenCalled();
      expect(misaligned.copyPixelsTo).not.toHaveBeenCalled();
      expect(oversized.copyPixelsTo).not.toHaveBeenCalled();
      expect(misaligned.readData).not.toHaveBeenCalled();
      expect(oversized.readData).not.toHaveBeenCalled();
      expect(misaligned.frame.dispose).toHaveBeenCalledTimes(1);
      expect(oversized.frame.dispose).toHaveBeenCalledTimes(1);
    });
  });

  it("preserves the current image after a synchronous native copy fails and refreshes scratch on retry", () => {
    withAndroidInterop(({ interop, release: androidRelease }) => {
      const first = copyableRgbaFrame(1, 1);
      const previousImage = interop.imageFromVideoFrame(first.frame)!;
      const failed = copyableRgbaFrame(2, 1);
      failed.copyPixelsTo.mockImplementation(() => {
        throw new Error("Native pixel copy failed");
      });
      expect(() => interop.imageFromVideoFrame(failed.frame)).toThrow(
        "Native pixel copy failed",
      );
      expect(failed.frame.dispose).toHaveBeenCalledTimes(1);
      expect(previousImage.dispose).not.toHaveBeenCalled();
      expect(interop.imageFromVideoFrame(first.frame)).toBe(previousImage);
      expect(androidRelease).toHaveBeenCalledTimes(1);
      expect(mockWriteTexture).toHaveBeenCalledTimes(1);
      const replacement = copyableRgbaFrame(3, 1);
      interop.imageFromVideoFrame(replacement.frame);
      expect(replacement.copyPixelsTo.mock.calls[0]![0]).toBe(
        first.copyPixelsTo.mock.calls[0]![0],
      );
      const pixels = mockWriteTexture.mock.calls[1]![1] as Uint8Array;
      expect(Array.from(pixels)).toEqual(new Array(32).fill(3));
      expect(previousImage.dispose).toHaveBeenCalledTimes(1);
      expect(failed.readData).not.toHaveBeenCalled();
    });
  });

  it("releases the image reservation when the CPU scratch budget refuses allocation before native copy", () => {
    withAndroidInterop(
      ({ interop, reserve: androidReserve, release: androidRelease }) => {
        androidReserve
          .mockReturnValueOnce(1)
          .mockReturnValueOnce(2)
          .mockImplementationOnce(() => {
            throw new Error("CPU upload budget exceeded");
          });
        const native = copyableRgbaFrame();
        expect(() => interop.imageFromVideoFrame(native.frame)).toThrow(
          "CPU upload budget exceeded",
        );
        expect(native.copyPixelsTo).not.toHaveBeenCalled();
        expect(native.readData).not.toHaveBeenCalled();
        expect(native.frame.dispose).toHaveBeenCalledTimes(1);
        expect(androidRelease).toHaveBeenCalledWith(1);
        expect(mockWriteTexture).not.toHaveBeenCalled();
        interop.clearVideoFrameImages(true);
        expect(androidRelease).toHaveBeenCalledWith(2);
        expect(androidRelease).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("releases CPU scratch accounting if its ArrayBuffer allocation throws", () => {
    withAndroidInterop(({ interop, release: androidRelease }) => {
      const native = copyableRgbaFrame();
      const allocate = jest.spyOn(globalThis, "ArrayBuffer");
      allocate.mockImplementationOnce(() => {
        throw new RangeError("CPU buffer allocation failed");
      });
      try {
        expect(() => interop.imageFromVideoFrame(native.frame)).toThrow(
          "CPU buffer allocation failed",
        );
      } finally {
        allocate.mockRestore();
      }
      expect(androidRelease).toHaveBeenCalledTimes(2);
      expect(native.copyPixelsTo).not.toHaveBeenCalled();
      expect(native.readData).not.toHaveBeenCalled();
      expect(native.frame.dispose).toHaveBeenCalledTimes(1);
      expect(mockWriteTexture).not.toHaveBeenCalled();
      interop.clearVideoFrameImages(true);
      expect(androidRelease).toHaveBeenCalledTimes(3);
    });
  });

  it("retains CPU scratch, source and snapshot after failed fences and blocks reuse until a checked drain succeeds", () => {
    withAndroidInterop(({ interop, release: androidRelease }) => {
      mockSurface.flush
        .mockImplementationOnce(() => {
          throw new Error("GPU fence failed");
        })
        .mockImplementationOnce(() => {
          throw new Error("Recovery fence failed");
        });
      const pending = copyableRgbaFrame();
      expect(() => interop.imageFromVideoFrame(pending.frame)).toThrow(
        "GPU fence failed",
      );
      expect(pending.frame.dispose).not.toHaveBeenCalled();
      expect(androidRelease).not.toHaveBeenCalled();
      expect(mockUploadTexture.destroy).not.toHaveBeenCalled();
      expect(() => interop.imageFromVideoFrame(pending.frame)).toThrow(
        "could not drain",
      );
      const incoming = copyableRgbaFrame(2, 2);
      expect(() => interop.imageFromVideoFrame(incoming.frame)).toThrow(
        "could not drain",
      );
      expect(incoming.copyPixelsTo).not.toHaveBeenCalled();
      expect(incoming.readData).not.toHaveBeenCalled();
      expect(incoming.frame.dispose).toHaveBeenCalledTimes(1);
      expect(pending.copyPixelsTo).toHaveBeenCalledTimes(1);
      interop.clearVideoFrameImages(true);
      expect(mockSurface.flush.mock.invocationCallOrder[2]!).toBeLessThan(
        (pending.frame.dispose as jest.Mock).mock.invocationCallOrder[0]!,
      );
      expect(pending.frame.dispose).toHaveBeenCalledTimes(1);
      expect(androidRelease).toHaveBeenCalledTimes(3);
      expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(1);
    });
  });

  it("uploads into a bounded RGBA texture without creating a raster image and fences before closing pixels", () => {
    withAndroidInterop(
      ({ interop, skia, reserve: androidReserve, release: androidRelease }) => {
        const frame = rgbaFrame();
        const image = interop.imageFromVideoFrame(frame)!;
        expect(mockCreateTexture).toHaveBeenCalledWith({
          size: { width: 4, height: 2 },
          format: "rgba8unorm",
          usage: 23,
          label: "video RGBA frame upload",
        });
        expect(mockWriteTexture).toHaveBeenCalledWith(
          { texture: mockUploadTexture },
          expect.any(Uint8Array),
          { offset: 0, bytesPerRow: 16, rowsPerImage: 2 },
          { width: 4, height: 2, depthOrArrayLayers: 1 },
        );
        expect(skia.Data.fromBytes).not.toHaveBeenCalled();
        expect(skia.Image.MakeRaster).not.toHaveBeenCalled();
        expect(mockCopy).not.toHaveBeenCalled();
        expect(mockWrapNative).not.toHaveBeenCalled();
        expect(mockSurface.enableCheckedSubmissions).toHaveBeenCalledTimes(1);
        const write = mockWriteTexture.mock.invocationCallOrder[0]!;
        const snapshot =
          mockSurface.makeImageSnapshot.mock.invocationCallOrder[0]!;
        const fence = mockSurface.flush.mock.invocationCallOrder[0]!;
        expect(androidReserve.mock.invocationCallOrder[1]!).toBeLessThan(
          mockCreateTexture.mock.invocationCallOrder[0]!,
        );
        expect(write).toBeLessThan(snapshot);
        expect(snapshot).toBeLessThan(fence);
        expect(fence).toBeLessThan(
          (frame.dispose as jest.Mock).mock.invocationCallOrder[0]!,
        );
        expect(
          androidReserve.mock.calls.map((call) => call.slice(0, 2)),
        ).toEqual([
          [32, "owned video image"],
          [32, "RGBA frame WebGPU upload texture"],
        ]);
        interop.releaseVideoFrameImage(frame);
        expect(image.dispose).toHaveBeenCalledTimes(1);
        expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(1);
        expect(androidRelease).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("uploads odd widths and padded rows through a bounded zero-offset view, excluding trailing storage", () => {
    withAndroidInterop(({ interop, reserve: androidReserve }) => {
      const storage = new ArrayBuffer(80);
      const pixels = new Uint8Array(storage);
      pixels.set([1, 2, 3, 255]);
      pixels.set([4, 5, 6, 255], 16);
      const frame = {
        ...rgbaFrame(),
        width: 3,
        texture: { kind: "rgba", data: storage, bytesPerRow: 16 },
      };
      interop.imageFromVideoFrame(frame);
      const view = mockWriteTexture.mock.calls[0]![1] as Uint8Array;
      expect(view.buffer).toBe(storage);
      expect(view.byteOffset).toBe(0);
      expect(view.byteLength).toBe(32);
      expect(Array.from(view.slice(0, 4))).toEqual([1, 2, 3, 255]);
      expect(Array.from(view.slice(16, 20))).toEqual([4, 5, 6, 255]);
      expect(mockWriteTexture.mock.calls[0]![2]).toEqual({
        offset: 0,
        bytesPerRow: 16,
        rowsPerImage: 2,
      });
      expect(androidReserve.mock.calls.map((call) => call[0])).toEqual([
        24, 24,
      ]);
    });
  });

  it("rejects misaligned, oversized or truncated layouts and unsupported extents before allocation", () => {
    withAndroidInterop(({ interop, reserve: androidReserve }) => {
      for (const bytesPerRow of [18, 16.5, NaN, Infinity, 0x100000000]) {
        const frame = {
          ...rgbaFrame(),
          texture: { kind: "rgba", data: new ArrayBuffer(48), bytesPerRow },
        };
        expect(() => interop.imageFromVideoFrame(frame)).toThrow(
          "Invalid RGBA",
        );
        expect(frame.dispose).toHaveBeenCalledTimes(1);
      }
      const short = {
        ...rgbaFrame(),
        texture: { kind: "rgba", data: new ArrayBuffer(31), bytesPerRow: 16 },
      };
      expect(() => interop.imageFromVideoFrame(short)).toThrow("Invalid RGBA");
      const tooWide = {
        ...rgbaFrame(),
        width: 4097,
        height: 1,
        texture: {
          kind: "rgba",
          data: new ArrayBuffer(4097 * 4),
          bytesPerRow: 4097 * 4,
        },
      };
      expect(() => interop.imageFromVideoFrame(tooWide)).toThrow(
        "texture extent limit",
      );
      expect(tooWide.dispose).toHaveBeenCalledTimes(1);
      expect(androidReserve).not.toHaveBeenCalled();
      expect(mockCreateTexture).not.toHaveBeenCalled();
      expect(mockWriteTexture).not.toHaveBeenCalled();
    });
  });

  it("reuses scratch storage but wraps a fresh surface so later writes cannot return an old snapshot", () => {
    withAndroidInterop(({ interop }) => {
      let version = 0;
      const views: Array<{
        snapshot: { version: number; dispose: jest.Mock } | null;
        dispose: jest.Mock;
      }> = [];
      const wrap = () => {
        const view = {
          snapshot: null as (typeof views)[number]["snapshot"],
          dispose: jest.fn(),
        };
        views.push(view);
        return {
          ...mockSurface,
          dispose: view.dispose,
          makeImageSnapshot: () => {
            view.snapshot ??= { version, dispose: jest.fn() };
            return view.snapshot;
          },
        };
      };
      const localSkia = (require("react-native-skia") as { Skia: typeof Skia })
        .Skia;
      (localSkia.Surface.MakeFromGPUTexture as jest.Mock)
        .mockImplementationOnce(wrap)
        .mockImplementationOnce(wrap);
      mockWriteTexture
        .mockImplementationOnce(() => {
          version = 1;
        })
        .mockImplementationOnce(() => {
          version = 2;
        });
      const firstFrame = rgbaFrame(1, 1);
      const secondFrame = rgbaFrame(2, 2);
      const first = interop.imageFromVideoFrame(firstFrame)!;
      const second = interop.imageFromVideoFrame(secondFrame)!;
      expect(first).toMatchObject({ version: 1 });
      expect(second).toMatchObject({ version: 2 });
      expect(first).not.toBe(second);
      expect(interop.imageFromVideoFrame(firstFrame)).toBe(first);
      expect(first.dispose).not.toHaveBeenCalled();
      expect(mockWriteTexture).toHaveBeenCalledTimes(2);
      expect(mockCreateTexture).toHaveBeenCalledTimes(1);
      expect(views.every((view) => view.dispose.mock.calls.length === 1)).toBe(
        true,
      );
    });
  });

  it("reuses Android RGBA scratch when raw CPU frames switch to AHB without invalidating another producer's image", () => {
    withAndroidInterop(({ interop }) => {
      const rgbaTexture = { nativePointer: 456n, destroy: jest.fn() };
      mockCreateTexture.mockReturnValueOnce(rgbaTexture);
      const rgba = interop.imageFromVideoFrame(rgbaFrame(1, 1))!;
      const native: VideoFrame = {
        ...rgbaFrame(2, 2),
        texture: { kind: "native-buffer", nativeBuffer: 123n },
      };
      interop.imageFromVideoFrame(native);
      expect(
        mockCreateTexture.mock.calls.map((call) => call[0].format),
      ).toEqual(["rgba8unorm"]);
      expect(mockCreateTexture.mock.calls.map((call) => call[0].usage)).toEqual(
        [23],
      );
      expect(rgbaTexture.destroy).not.toHaveBeenCalled();
      expect(rgba.dispose).not.toHaveBeenCalled();
      expect(mockCopy.mock.calls[0]![1].texture).toBe(rgbaTexture);
    });
  });

  it("blits an Android AHB into RGBA scratch and fences both native leases without accessing CPU pixels", () => {
    withAndroidInterop(
      ({ interop, skia, reserve: androidReserve, release: androidRelease }) => {
        const data = jest.fn(() => {
          throw new Error("AHB must not expose CPU data to the importer");
        });
        const texture = { kind: "native-buffer", nativeBuffer: 123n };
        Object.defineProperty(texture, "data", { get: data });
        const frame: VideoFrame = { ...rgbaFrame(), rotation: 90, texture };
        const image = interop.imageFromVideoFrame(frame)!;
        expect(mockCreateTexture).toHaveBeenCalledWith({
          size: { width: 4, height: 2 },
          format: "rgba8unorm",
          usage: 23,
          label: "video native frame upload",
        });
        // RN WebGPU reports single-plane RGBA AHBs using its RGB sentinel
        // "bgra8"; the native implementation imports the real AHB format.
        expect(mockNativeSource.pixelFormat).toBe("bgra8");
        expect(mockCopy).toHaveBeenCalledWith(
          {
            source: mockNativeSource,
            rotation: 0,
            mirrored: false,
            flipY: false,
          },
          { texture: mockUploadTexture, premultipliedAlpha: false },
          { width: 4, height: 2 },
        );
        expect(mockWriteTexture).not.toHaveBeenCalled();
        expect(data).not.toHaveBeenCalled();
        expect(skia.Data.fromBytes).not.toHaveBeenCalled();
        expect(skia.Image.MakeRaster).not.toHaveBeenCalled();
        expect(androidReserve.mock.calls.map((call) => call[0])).toEqual([
          32, 32,
        ]);
        const fence = mockSurface.flush.mock.invocationCallOrder[0]!;
        expect(fence).toBeLessThan(
          mockNativeSource.release.mock.invocationCallOrder[0]!,
        );
        expect(fence).toBeLessThan(
          (frame.dispose as jest.Mock).mock.invocationCallOrder[0]!,
        );
        interop.releaseVideoFrameImage(frame);
        expect(image.dispose).toHaveBeenCalledTimes(1);
        expect(androidRelease).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("releases CPU scratch on a same-format AHB transition while keeping the shared GPU texture and older snapshot", () => {
    withAndroidInterop(({ interop, release: androidRelease }) => {
      const cpu = copyableRgbaFrame(1, 1);
      const previous = interop.imageFromVideoFrame(cpu.frame)!;
      const ahb: VideoFrame = {
        ...rgbaFrame(2, 2),
        texture: { kind: "native-buffer", nativeBuffer: 123n },
      };
      interop.imageFromVideoFrame(ahb);
      expect(mockCreateTexture).toHaveBeenCalledTimes(1);
      expect(mockUploadTexture.destroy).not.toHaveBeenCalled();
      expect(androidRelease).toHaveBeenCalledTimes(1);
      expect(previous.dispose).not.toHaveBeenCalled();
      expect(interop.imageFromVideoFrame(cpu.frame)).toBe(previous);
      const raw = rgbaFrame(3, 3);
      interop.imageFromVideoFrame(raw);
      expect(mockCreateTexture).toHaveBeenCalledTimes(1);
      expect(mockCreateTexture.mock.calls[0]![0].usage).toBe(23);
      expect(mockWriteTexture).toHaveBeenCalledTimes(2);
      interop.clearVideoFrameImages(true);
      expect(androidRelease).toHaveBeenCalledTimes(5);
    });
  });

  it("allows CPU upload after a first AHB frame by retaining COPY_DST in Android's reusable texture", () => {
    withAndroidInterop(({ interop, reserve: androidReserve }) => {
      const ahb: VideoFrame = {
        ...rgbaFrame(),
        texture: { kind: "native-buffer", nativeBuffer: 123n },
      };
      const image = interop.imageFromVideoFrame(ahb)!;
      const cpu = copyableRgbaFrame(2, 2);
      interop.imageFromVideoFrame(cpu.frame);
      expect(mockCreateTexture).toHaveBeenCalledTimes(1);
      expect(mockCreateTexture.mock.calls[0]![0]).toMatchObject({
        format: "rgba8unorm",
        usage: 23,
      });
      expect(mockWriteTexture).toHaveBeenCalledTimes(1);
      expect(cpu.readData).not.toHaveBeenCalled();
      expect(androidReserve.mock.calls.map((call) => call[0])).toEqual([
        32, 32, 32, 32,
      ]);
      expect(image.dispose).not.toHaveBeenCalled();
    });
  });

  it("rejects AHB dimensions outside the shared device extent before allocating or wrapping", () => {
    withAndroidInterop(({ interop, reserve: androidReserve }) => {
      const ahb: VideoFrame = {
        ...rgbaFrame(),
        width: 4097,
        height: 1,
        texture: { kind: "native-buffer", nativeBuffer: 123n },
      };
      expect(() => interop.imageFromVideoFrame(ahb)).toThrow(
        "texture extent limit",
      );
      expect(androidReserve).not.toHaveBeenCalled();
      expect(mockCreateTexture).not.toHaveBeenCalled();
      expect(mockWrapNative).not.toHaveBeenCalled();
      expect(mockCopy).not.toHaveBeenCalled();
      expect(ahb.dispose).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects mismatched AHB dimensions and NV12 before submitting a copy, closing both leases", () => {
    withAndroidInterop(({ interop, release: androidRelease }) => {
      for (const source of [
        { ...mockNativeSource, width: 5 },
        { ...mockNativeSource, height: 3 },
        { ...mockNativeSource, pixelFormat: "nv12" },
      ]) {
        mockWrapNative.mockReturnValueOnce(source);
        const frame: VideoFrame = {
          ...rgbaFrame(),
          texture: { kind: "native-buffer", nativeBuffer: 123n },
        };
        expect(() => interop.imageFromVideoFrame(frame)).toThrow(
          "dimensions or BGRA layout mismatch",
        );
        expect(frame.dispose).toHaveBeenCalledTimes(1);
      }
      expect(mockNativeSource.release).toHaveBeenCalledTimes(3);
      expect(mockCopy).not.toHaveBeenCalled();
      expect(mockWriteTexture).not.toHaveBeenCalled();
      expect(mockSurface.makeImageSnapshot).not.toHaveBeenCalled();
      expect(androidRelease).toHaveBeenCalledTimes(3);
    });
  });

  it("retains an AHB and its wrapper after copy/drain failure and blocks incoming CPU copies until recovery", () => {
    withAndroidInterop(({ interop, release: androidRelease }) => {
      mockCopy.mockImplementationOnce(() => {
        throw new Error("AHB copy failed after enqueue");
      });
      mockSurface.flush.mockImplementationOnce(() => {
        throw new Error("AHB recovery fence failed");
      });
      const pending: VideoFrame = {
        ...rgbaFrame(),
        texture: { kind: "native-buffer", nativeBuffer: 123n },
      };
      expect(() => interop.imageFromVideoFrame(pending)).toThrow(
        "AHB copy failed after enqueue",
      );
      expect(pending.dispose).not.toHaveBeenCalled();
      expect(mockNativeSource.release).not.toHaveBeenCalled();
      expect(androidRelease).not.toHaveBeenCalled();
      const incoming = copyableRgbaFrame(2, 2);
      expect(() => interop.imageFromVideoFrame(incoming.frame)).toThrow(
        "could not drain",
      );
      expect(incoming.copyPixelsTo).not.toHaveBeenCalled();
      expect(incoming.readData).not.toHaveBeenCalled();
      expect(incoming.frame.dispose).toHaveBeenCalledTimes(1);
      interop.clearVideoFrameImages(true);
      expect(mockSurface.flush.mock.invocationCallOrder[1]!).toBeLessThan(
        mockNativeSource.release.mock.invocationCallOrder[0]!,
      );
      expect(pending.dispose).toHaveBeenCalledTimes(1);
      expect(androidRelease).toHaveBeenCalledTimes(2);
    });
  });

  it("retains the RGBA source and both reservations when a write throws after enqueue and its drain fails", () => {
    withAndroidInterop(({ interop, release: androidRelease }) => {
      const failure = new Error("Write failed after enqueue");
      mockWriteTexture.mockImplementationOnce(() => {
        throw failure;
      });
      mockSurface.flush.mockImplementationOnce(() => {
        throw new Error("Drain failed");
      });
      const pending = rgbaFrame();
      expect(() => interop.ownVideoFrames({ pending })).toThrow(failure);
      expect(pending.dispose).not.toHaveBeenCalled();
      expect(mockSurface.dispose).not.toHaveBeenCalled();
      expect(mockUploadTexture.destroy).not.toHaveBeenCalled();
      expect(androidRelease).not.toHaveBeenCalled();
      expect(() => interop.imageFromVideoFrame(pending)).toThrow(
        "could not drain",
      );
      expect(pending.dispose).not.toHaveBeenCalled();
      const incoming = rgbaFrame(2, 2);
      expect(() => interop.imageFromVideoFrame(incoming)).toThrow(
        "could not drain",
      );
      expect(incoming.dispose).toHaveBeenCalledTimes(1);
      interop.clearVideoFrameImages(true);
      const fence = mockSurface.flush.mock.invocationCallOrder[1]!;
      expect(fence).toBeLessThan(
        (pending.dispose as jest.Mock).mock.invocationCallOrder[0]!,
      );
      expect(pending.dispose).toHaveBeenCalledTimes(1);
      expect(androidRelease).toHaveBeenCalledTimes(2);
      expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the previous producer image if replacement snapshot allocation fails", () => {
    withAndroidInterop(({ interop, release: androidRelease }) => {
      const previousFrame = rgbaFrame(1, 1);
      const previous = interop.imageFromVideoFrame(previousFrame)!;
      mockSurface.makeImageSnapshot.mockReturnValueOnce(null as never);
      const replacement = rgbaFrame(2, 1);
      expect(() => interop.imageFromVideoFrame(replacement)).toThrow(
        "Cannot create a video frame image",
      );
      expect(replacement.dispose).toHaveBeenCalledTimes(1);
      expect(previous.dispose).not.toHaveBeenCalled();
      expect(interop.imageFromVideoFrame(previousFrame)).toBe(previous);
      expect(androidRelease).toHaveBeenCalledTimes(1);
    });
  });

  it("releases a reserved image if the scratch allocation is refused before any write", () => {
    withAndroidInterop(
      ({ interop, reserve: androidReserve, release: androidRelease }) => {
        androidReserve.mockReturnValueOnce(17).mockImplementationOnce(() => {
          throw new Error("Scratch budget exceeded");
        });
        const frame = rgbaFrame();
        expect(() => interop.imageFromVideoFrame(frame)).toThrow(
          "Scratch budget exceeded",
        );
        expect(frame.dispose).toHaveBeenCalledTimes(1);
        expect(androidRelease).toHaveBeenCalledTimes(1);
        expect(mockWriteTexture).not.toHaveBeenCalled();
        expect(mockCreateTexture).not.toHaveBeenCalled();
      },
    );
  });
});

describe("owned video frame transport", () => {
  it("closes a fresh native lease on a paused-image cache hit without another GPU import", () => {
    withAndroidInterop(({ interop }) => {
      const frame: VideoFrame = {
        ...rgbaFrame(),
        texture: { kind: "native-buffer", nativeBuffer: 123n },
      };
      const image = interop.imageFromVideoFrame(frame)!;
      const alias: VideoFrame = { ...frame, dispose: jest.fn() };
      const readTexture = jest.fn(() => {
        throw new Error("Cached pixels need no source");
      });
      Object.defineProperty(alias, "texture", { get: readTexture });
      expect(interop.imageFromVideoFrame(alias)).toBe(image);
      expect(interop.imageFromVideoFrame(alias)).toBe(image);
      expect(interop.imageFromVideoFrame(frame)).toBe(image);
      expect(frame.dispose).toHaveBeenCalledTimes(1);
      expect(alias.dispose).toHaveBeenCalledTimes(1);
      expect(readTexture).not.toHaveBeenCalled();
      expect(mockCopy).toHaveBeenCalledTimes(1);
      expect(mockSurface.makeImageSnapshot).toHaveBeenCalledTimes(1);
      expect(mockSurface.flush).toHaveBeenCalledTimes(1);
      expect(image.dispose).not.toHaveBeenCalled();
    });
  });

  it("keeps cached pixels and retries a fresh lease whose close failed", () => {
    const frame = rgbaFrame();
    const image = imageFromVideoFrame(frame)!;
    const alias = {
      ...frame,
      dispose: jest.fn().mockImplementationOnce(() => {
        throw new Error("lease close failed");
      }),
    };
    expect(() => imageFromVideoFrame(alias)).toThrow("lease close failed");
    expect(imageFromVideoFrame(alias)).toBe(image);
    expect(imageFromVideoFrame(alias)).toBe(image);
    expect(alias.dispose).toHaveBeenCalledTimes(2);
    expect(makeImage).toHaveBeenCalledTimes(1);
    expect(image.dispose).not.toHaveBeenCalled();
  });

  it("keeps iOS RGBA compatibility data without invoking the Android pixel-copy protocol", () => {
    const native = copyableRgbaFrame();
    native.copyPixelsTo.mockImplementation(() => {
      throw new Error("Android copy protocol must not run on iOS");
    });
    imageFromVideoFrame(native.frame);
    expect(native.readData).toHaveBeenCalledTimes(1);
    expect(native.copyPixelsTo).not.toHaveBeenCalled();
    expect(Skia.Data.fromBytes).toHaveBeenCalledWith(native.source);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(32, "owned video image");
    expect(mockWriteTexture).not.toHaveBeenCalled();
    expect(mockCreateTexture).not.toHaveBeenCalled();
    expect(native.frame.dispose).toHaveBeenCalledTimes(1);
  });

  it("caches immutable pixels after releasing the native source exactly once", () => {
    const frame = rgbaFrame();
    const image = imageFromVideoFrame(frame)!;
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(32, "owned video image");
    frame.texture = undefined;
    expect(imageFromVideoFrame(frame)).toBe(image);
    expect(makeImage).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    releaseVideoFrameImage(frame);
    expect(image.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(17);
  });

  it("replaces one producer image and preserves another paused producer", () => {
    const first = imageFromVideoFrame(rgbaFrame(1, 1))!;
    const pausedFrame = rgbaFrame(2, 2);
    const paused = imageFromVideoFrame(pausedFrame)!;
    imageFromVideoFrame(rgbaFrame(3, 1));
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(paused.dispose).not.toHaveBeenCalled();
    expect(imageFromVideoFrame(pausedFrame)).toBe(paused);
  });

  it("waits for native-buffer snapshot rendering before releasing its borrowed pixels", () => {
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    const image = imageFromVideoFrame(frame);
    expect(image).not.toBeNull();
    expect(mockWrapNative).toHaveBeenCalledWith(123n);
    expect(mockCopy).toHaveBeenCalledWith(
      { source: mockNativeSource, rotation: 0, mirrored: false, flipY: false },
      { texture: mockUploadTexture, premultipliedAlpha: false },
      { width: 4, height: 2 },
    );
    expect(Skia.Surface.MakeFromGPUTexture).toHaveBeenCalledWith(
      mockUploadTexture,
    );
    expect(Skia.Surface.MakeOffscreen).not.toHaveBeenCalled();
    expect(mockCanvas.drawImage).not.toHaveBeenCalled();
    expect(mockCanvas.drawColor).not.toHaveBeenCalled();
    expect(mockSurface.flush).toHaveBeenCalledWith(true);
    const flushOrder = mockSurface.flush.mock.invocationCallOrder[0]!;
    expect(mockCopy.mock.invocationCallOrder[0]!).toBeLessThan(flushOrder);
    expect(flushOrder).toBeLessThan(
      mockNativeSource.release.mock.invocationCallOrder[0]!,
    );
    expect(flushOrder).toBeLessThan(
      mockSurface.dispose.mock.invocationCallOrder[0]!,
    );
    expect(flushOrder).toBeLessThan(
      (frame.dispose as jest.Mock).mock.invocationCallOrder[0]!,
    );
    releaseVideoFrameImage(frame);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects short RGBA storage before reserving memory and releases its native lease", () => {
    const frame = {
      ...rgbaFrame(),
      texture: { kind: "rgba", data: new ArrayBuffer(8), bytesPerRow: 16 },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow("Invalid RGBA");
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(makeImage).not.toHaveBeenCalled();
  });

  it("bounds cached producer images and fails without evicting a paused image", () => {
    const firstFrame = rgbaFrame(1, 1);
    const first = imageFromVideoFrame(firstFrame)!;
    for (let i = 2; i <= 32; i++) imageFromVideoFrame(rgbaFrame(i, i));
    const overflow = rgbaFrame(33, 33);
    expect(() => imageFromVideoFrame(overflow)).toThrow("Too many cached");
    expect(overflow.dispose).toHaveBeenCalledTimes(1);
    expect(imageFromVideoFrame(firstFrame)).toBe(first);
    expect(first.dispose).not.toHaveBeenCalled();
  });

  it("releases a native lease when its image reservation exceeds the memory budget", () => {
    reserve.mockImplementationOnce(() => {
      throw new Error("Memory budget exceeded");
    });
    const frame = rgbaFrame();
    expect(() => imageFromVideoFrame(frame)).toThrow("Memory budget exceeded");
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it("releases an owned-image reservation if the upload texture exceeds the budget", () => {
    reserve
      .mockImplementationOnce(() => 17)
      .mockImplementationOnce(() => {
        throw new Error("Upload budget exceeded");
      });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow("Upload budget exceeded");
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(Skia.Surface.MakeFromGPUTexture).not.toHaveBeenCalled();
  });

  it("releases failed image creation storage, reservation, and native lease", () => {
    makeImage.mockReturnValueOnce(null);
    const frame = rgbaFrame();
    expect(() => imageFromVideoFrame(frame)).toThrow(
      "Cannot create a video frame image",
    );
    expect(Skia.Data.fromBytes).toHaveBeenCalledTimes(1);
    expect(
      (Skia.Data.fromBytes as jest.Mock).mock.results[0]?.value.dispose,
    ).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cleans already imported images and untouched native leases after a partial composition import fails", () => {
    const first = rgbaFrame(1, 1);
    const invalid = {
      ...rgbaFrame(2, 2),
      texture: { kind: "rgba", data: new ArrayBuffer(8), bytesPerRow: 16 },
    };
    const untouched = rgbaFrame(3, 3);
    expect(() => ownVideoFrames({ first, invalid, untouched })).toThrow(
      "Invalid RGBA",
    );
    const firstImage = makeImage.mock.results[0]?.value;
    expect(firstImage.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(first.dispose).toHaveBeenCalled();
    expect(invalid.dispose).toHaveBeenCalled();
    expect(untouched.dispose).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps published paused pixels when replacement reservation or image creation fails", () => {
    const previousFrame = rgbaFrame(1, 1);
    const previous = imageFromVideoFrame(previousFrame)!;
    reserve.mockImplementationOnce(() => {
      throw new Error("Replacement budget exceeded");
    });
    const replacement = rgbaFrame(2, 1);
    expect(() => imageFromVideoFrame(replacement)).toThrow(
      "Replacement budget exceeded",
    );
    expect(replacement.dispose).toHaveBeenCalledTimes(1);
    expect(previous.dispose).not.toHaveBeenCalled();
    expect(imageFromVideoFrame(previousFrame)).toBe(previous);
    makeImage.mockReturnValueOnce(null);
    expect(() => imageFromVideoFrame(rgbaFrame(3, 1))).toThrow(
      "Cannot create a video frame image",
    );
    expect(previous.dispose).not.toHaveBeenCalled();
    expect(imageFromVideoFrame(previousFrame)).toBe(previous);
  });

  it("releases malformed and missing frame transport leases even before allocating an image", () => {
    const unsupported = { ...rgbaFrame(), texture: { kind: "legacy-gl" } };
    expect(() => imageFromVideoFrame(unsupported)).toThrow(
      "Unsupported frame transport",
    );
    expect(unsupported.dispose).toHaveBeenCalledTimes(1);
    const missing = { ...rgbaFrame(), texture: undefined };
    expect(imageFromVideoFrame(missing)).toBeNull();
    expect(missing.dispose).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("cleans a partially created staging surface if its canvas cannot be created", () => {
    mockSurface.getCanvas.mockImplementationOnce(() => {
      throw new Error("Canvas creation failed");
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow("Canvas creation failed");
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("drains a recording left by snapshot failure before releasing borrowed decoder pixels", () => {
    mockSurface.makeImageSnapshot.mockImplementationOnce(() => {
      throw new Error("Snapshot failed");
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow("Snapshot failed");
    expect(mockSurface.flush).toHaveBeenCalledWith(true);
    expect(mockSurface.flush.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSurface.dispose.mock.invocationCallOrder[0]!,
    );
    expect(mockSurface.flush.mock.invocationCallOrder[0]!).toBeLessThan(
      (frame.dispose as jest.Mock).mock.invocationCallOrder[0]!,
    );
    expect(frame.dispose).toHaveBeenCalledTimes(1);
  });

  it("retains native leases after failed GPU fences, rejects new imports, and releases only after successful retry", () => {
    mockSurface.flush
      .mockImplementationOnce(() => {
        throw new Error("GPU fence failed");
      })
      .mockImplementationOnce(() => {
        throw new Error("GPU retry failed");
      });
    const pending: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => ownVideoFrames({ pending })).toThrow("GPU fence failed");
    const snapshot = mockSurface.makeImageSnapshot.mock.results[0]?.value;
    expect(pending.dispose).not.toHaveBeenCalled();
    expect(mockNativeSource.release).not.toHaveBeenCalled();
    expect(mockSurface.dispose).not.toHaveBeenCalled();
    expect(snapshot.dispose).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    const incoming = rgbaFrame(2, 2);
    expect(() => imageFromVideoFrame(incoming)).toThrow("could not drain");
    expect(incoming.dispose).toHaveBeenCalledTimes(1);
    expect(pending.dispose).not.toHaveBeenCalled();
    // Rejecting another import must not close the view used by pending work.
    expect(mockSurface.dispose).not.toHaveBeenCalled();
    expect(mockCanvas.dispose).not.toHaveBeenCalled();
    clearVideoFrameImages(true);
    expect(pending.dispose).toHaveBeenCalledTimes(1);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    expect(snapshot.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
    const successfulFence = mockSurface.flush.mock.invocationCallOrder[2]!;
    expect(successfulFence).toBeLessThan(
      (pending.dispose as jest.Mock).mock.invocationCallOrder[0]!,
    );
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(pending.dispose).toHaveBeenCalledTimes(1);
  });

  it("accounts the entire RGBA storage copied by Skia, including padding and trailing bytes", () => {
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "rgba", data: new ArrayBuffer(128), bytesPerRow: 32 },
    };
    imageFromVideoFrame(frame);
    expect(reserve).toHaveBeenCalledWith(128, "owned video image");
    const copied = (Skia.Data.fromBytes as jest.Mock).mock
      .calls[0]?.[0] as Uint8Array;
    expect(copied.byteLength).toBe(128);
    expect(copied.byteOffset).toBe(0);
    expect(copied.buffer.byteLength).toBe(128);
  });

  it("rejects non-finite, fractional and unsafe row strides before reserving or invoking Skia", () => {
    for (const bytesPerRow of [NaN, Infinity, 16.5, Number.MAX_SAFE_INTEGER]) {
      const frame: VideoFrame = {
        ...rgbaFrame(),
        texture: { kind: "rgba", data: new ArrayBuffer(32), bytesPerRow },
      };
      expect(() => imageFromVideoFrame(frame)).toThrow("Invalid RGBA");
      expect(frame.dispose).toHaveBeenCalledTimes(1);
    }
    expect(reserve).not.toHaveBeenCalled();
    expect(Skia.Data.fromBytes).not.toHaveBeenCalled();
  });

  it("retains only unfinished staging cleanup after allocation teardown throws", () => {
    mockSurface.getCanvas.mockImplementationOnce(() => {
      throw new Error("Canvas creation failed");
    });
    mockSurface.dispose.mockImplementationOnce(() => {
      throw new Error("Stage destruction failed");
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow("Canvas creation failed");
    // Cleanup is retained intact when the surface view cannot be closed.
    expect(frame.dispose).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    clearVideoFrameImages(true);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("does not dispose an image twice when releasing its reservation needs a retry", () => {
    const frame = rgbaFrame();
    const image = imageFromVideoFrame(frame)!;
    release.mockImplementationOnce(() => {
      throw new Error("Reservation release failed");
    });
    expect(() => releaseVideoFrameImage(frame)).toThrow(
      "Reservation release failed",
    );
    expect(image.dispose).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(image.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("preserves the published image when replacement native close fails before the handoff completes", () => {
    const first = rgbaFrame(1, 5);
    const previous = imageFromVideoFrame(first)!;
    const replacement = rgbaFrame(2, 5);
    const failure = new Error("Replacement native close failed");
    (replacement.dispose as jest.Mock).mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => imageFromVideoFrame(replacement)).toThrow(failure);
    const rejectedImage = (Skia.Image.MakeRaster as jest.Mock).mock
      .results[1]?.value;
    expect(rejectedImage.dispose).toHaveBeenCalledTimes(1);
    expect(previous.dispose).not.toHaveBeenCalled();
    expect(imageFromVideoFrame(first)).toBe(previous);
    expect(release).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(previous.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("attempts every untouched native close and preserves the primary import failure", () => {
    const invalid: VideoFrame = {
      ...rgbaFrame(1, 1),
      texture: { kind: "rgba", data: new ArrayBuffer(8), bytesPerRow: 16 },
    };
    const failedClose = rgbaFrame(2, 2);
    (failedClose.dispose as jest.Mock).mockImplementationOnce(() => {
      throw new Error("Native close failed");
    });
    const untouched = rgbaFrame(3, 3);
    expect(() => ownVideoFrames({ invalid, failedClose, untouched })).toThrow(
      "Invalid RGBA",
    );
    expect(untouched.dispose).toHaveBeenCalledTimes(1);
    expect(failedClose.dispose).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(failedClose.dispose).toHaveBeenCalledTimes(2);
  });

  it("provides a releasable cache identity for a single anonymous raw frame", () => {
    const frame = { ...rgbaFrame(), id: undefined, producerId: undefined };
    const owned = ownVideoFrames({ clip: frame }).clip!;
    const image = (owned.texture as { image: { dispose: jest.Mock } }).image;
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    releaseVideoFrameImage(owned);
    expect(image.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting pictures of one producer before either can invalidate the other", () => {
    const first = rgbaFrame(1, 1);
    const conflict = rgbaFrame(2, 1);
    expect(() => ownVideoFrames({ first, conflict })).toThrow(
      "different frames for one producer",
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(conflict.dispose).toHaveBeenCalledTimes(1);
    const alias = rgbaFrame(3, 3);
    const owned = ownVideoFrames({ first: alias, second: alias });
    expect((owned.first!.texture as { image: unknown }).image).toBe(
      (owned.second!.texture as { image: unknown }).image,
    );
    expect(alias.dispose).toHaveBeenCalledTimes(1);
  });

  it("reuses one bounded GPU upload target and preserves the previous immutable snapshot", () => {
    const nativeFrame = (id: number): VideoFrame => ({
      ...rgbaFrame(id),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    });
    const first = imageFromVideoFrame(nativeFrame(1))!;
    imageFromVideoFrame(nativeFrame(2));
    expect(mockCreateTexture).toHaveBeenCalledTimes(1);
    expect(mockCreateTexture).toHaveBeenCalledWith({
      size: { width: 4, height: 2 },
      format: "bgra8unorm",
      usage: 21,
      label: "video native frame upload",
    });
    expect(
      reserve.mock.calls.filter(
        (call) => call[1] === "native frame WebGPU upload texture",
      ),
    ).toEqual([[32, "native frame WebGPU upload texture"]]);
    expect(mockCopy).toHaveBeenCalledTimes(2);
    expect(mockNativeSource.release).toHaveBeenCalledTimes(2);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(mockUploadTexture.destroy).not.toHaveBeenCalled();
    clearVideoFrameImages(true);
    expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(1);
  });

  it("releases the extra wrapper and original lease if a native copy throws after submission", () => {
    const failure = new Error("Native blit failed");
    mockCopy.mockImplementationOnce(() => {
      throw failure;
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow(failure);
    expect(mockSurface.flush).toHaveBeenCalledWith(true);
    const fence = mockSurface.flush.mock.invocationCallOrder[0]!;
    expect(fence).toBeLessThan(
      mockNativeSource.release.mock.invocationCallOrder[0]!,
    );
    expect(fence).toBeLessThan(
      (frame.dispose as jest.Mock).mock.invocationCallOrder[0]!,
    );
    expect(mockNativeSource.release).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
  });

  it("retains both native leases if a failed copy also cannot drain", () => {
    mockCopy.mockImplementationOnce(() => {
      throw new Error("Native blit failed");
    });
    mockSurface.flush.mockImplementationOnce(() => {
      throw new Error("Drain failed");
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow("Native blit failed");
    expect(mockNativeSource.release).not.toHaveBeenCalled();
    expect(frame.dispose).not.toHaveBeenCalled();
    expect(mockUploadTexture.destroy).not.toHaveBeenCalled();
    expect(() => imageFromVideoFrame(rgbaFrame(2))).toThrow("could not drain");
    clearVideoFrameImages(true);
    expect(mockNativeSource.release).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched native frame before submitting any copy and closes its wrapper", () => {
    const mismatch = { ...mockNativeSource, width: 8, release: jest.fn() };
    mockWrapNative.mockReturnValueOnce(mismatch);
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow(
      "dimensions or BGRA layout mismatch",
    );
    expect(mockCopy).not.toHaveBeenCalled();
    expect(mismatch.release).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
  });

  it("retains an unsuccessfully closed native wrapper without re-disposing its Skia image", () => {
    const failure = new Error("Native wrapper release failed");
    mockNativeSource.release
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockImplementationOnce(() => {
        throw failure;
      });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow(failure);
    expect(frame.dispose).not.toHaveBeenCalled();
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(mockNativeSource.release).toHaveBeenCalledTimes(3);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
  });

  it("cleans staging allocations and the original lease if the upload texture allocation fails", () => {
    mockCreateTexture.mockImplementationOnce(() => {
      throw new Error("Texture allocation failed");
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow(
      "Texture allocation failed",
    );
    expect(mockWrapNative).not.toHaveBeenCalled();
    expect(mockNativeSource.release).not.toHaveBeenCalled();
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(mockSurface.dispose).not.toHaveBeenCalled();
    expect(mockCanvas.dispose).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("retries only unfinished scratch texture teardown when destroy fails", () => {
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    imageFromVideoFrame(frame);
    mockUploadTexture.destroy.mockImplementationOnce(() => {
      throw new Error("Texture destroy failed");
    });
    expect(() => clearVideoFrameImages(true)).toThrow("Texture destroy failed");
    expect(release).toHaveBeenCalledTimes(1);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
  });

  it("submits a Skia marker before the failure fence if native copying throws before any draw", () => {
    mockCopy.mockImplementationOnce(() => {
      throw new Error("Copy failed before drawing");
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow(
      "Copy failed before drawing",
    );
    expect(mockCanvas.drawImage).not.toHaveBeenCalled();
    expect(mockCanvas.drawColor).toHaveBeenCalledTimes(1);
    const marker = mockCanvas.drawColor.mock.invocationCallOrder[0]!;
    const fence = mockSurface.flush.mock.invocationCallOrder[0]!;
    expect(mockCopy.mock.invocationCallOrder[0]!).toBeLessThan(marker);
    expect(marker).toBeLessThan(fence);
    expect(fence).toBeLessThan(
      mockNativeSource.release.mock.invocationCallOrder[0]!,
    );
  });

  it("retains native leases if both the snapshot and the explicit drain marker fail", () => {
    const failure = new Error("Snapshot failed");
    mockSurface.makeImageSnapshot.mockImplementationOnce(() => {
      throw failure;
    });
    mockCanvas.drawColor.mockImplementationOnce(() => {
      throw new Error("Drain marker failed");
    });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow(failure);
    expect(mockCopy).toHaveBeenCalledTimes(1);
    expect(mockSurface.flush).not.toHaveBeenCalled();
    expect(mockNativeSource.release).not.toHaveBeenCalled();
    expect(frame.dispose).not.toHaveBeenCalled();
    clearVideoFrameImages(true);
    expect(mockNativeSource.release).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not close either lease when the same pending native frame is imported again", () => {
    mockSurface.flush
      .mockImplementationOnce(() => {
        throw new Error("GPU fence failed");
      })
      .mockImplementationOnce(() => {
        throw new Error("GPU retry failed");
      });
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow("GPU fence failed");
    expect(() => imageFromVideoFrame(frame)).toThrow("could not drain");
    expect(mockCopy).toHaveBeenCalledTimes(1);
    expect(mockNativeSource.release).not.toHaveBeenCalled();
    expect(frame.dispose).not.toHaveBeenCalled();
    clearVideoFrameImages(true);
    expect(mockNativeSource.release).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);
  });

  it("uses fresh surface views so external writes cannot reuse a cached snapshot", () => {
    let pixels = 0;
    const views: Array<{
      snapshot: { pixelVersion: number; dispose: jest.Mock } | null;
      dispose: jest.Mock;
    }> = [];
    const wrap = () => {
      const view = {
        snapshot: null as (typeof views)[number]["snapshot"],
        dispose: jest.fn(),
      };
      views.push(view);
      return {
        ...mockSurface,
        dispose: view.dispose,
        // Model SkSurface::refCachedImage: external writes alone do not
        // invalidate this surface's snapshot, even if its texture changed.
        makeImageSnapshot: () => {
          view.snapshot ??= { pixelVersion: pixels, dispose: jest.fn() };
          return view.snapshot;
        },
      };
    };
    (Skia.Surface.MakeFromGPUTexture as jest.Mock)
      .mockImplementationOnce(wrap)
      .mockImplementationOnce(wrap);
    mockCopy
      .mockImplementationOnce(() => {
        pixels = 11;
      })
      .mockImplementationOnce(() => {
        pixels = 22;
      });
    const firstFrame: VideoFrame = {
      ...rgbaFrame(1, 1),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    const secondFrame: VideoFrame = {
      ...rgbaFrame(2, 2),
      texture: { kind: "native-buffer", nativeBuffer: 124n },
    };
    const first = imageFromVideoFrame(firstFrame);
    const second = imageFromVideoFrame(secondFrame);
    expect(views).toHaveLength(2);
    expect(first).toMatchObject({ pixelVersion: 11 });
    expect(second).toMatchObject({ pixelVersion: 22 });
    expect(first).not.toBe(second);
    expect(imageFromVideoFrame(firstFrame)).toBe(first);
    expect(first!.dispose).not.toHaveBeenCalled();
    expect(mockCreateTexture).toHaveBeenCalledTimes(1);
    expect(Skia.Surface.MakeOffscreen).not.toHaveBeenCalled();
    expect(mockCanvas.drawColor).not.toHaveBeenCalled();
    expect(mockCanvas.drawImage).not.toHaveBeenCalled();
    expect(views.every((view) => view.dispose.mock.calls.length === 1)).toBe(
      true,
    );
    expect(reserve.mock.calls.map((call) => call[1])).toEqual([
      "owned video image",
      "native frame WebGPU upload texture",
      "owned video image",
    ]);
    clearVideoFrameImages(true);
    expect(first!.dispose).toHaveBeenCalledTimes(1);
    expect(second!.dispose).toHaveBeenCalledTimes(1);
    expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(1);
  });

  it("replaces only scratch storage on resize while preserving another producer's image", () => {
    const firstFrame: VideoFrame = {
      ...rgbaFrame(1, 1),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    const first = imageFromVideoFrame(firstFrame)!;
    const largerTexture = { nativePointer: 789n, destroy: jest.fn() };
    mockCreateTexture.mockReturnValueOnce(largerTexture);
    mockWrapNative.mockReturnValueOnce({ ...mockNativeSource, width: 8 });
    const secondFrame: VideoFrame = {
      ...rgbaFrame(2, 2),
      width: 8,
      texture: { kind: "native-buffer", nativeBuffer: 124n },
    };
    imageFromVideoFrame(secondFrame);
    expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(1);
    expect(mockSurface.dispose.mock.invocationCallOrder[0]!).toBeLessThan(
      mockUploadTexture.destroy.mock.invocationCallOrder[0]!,
    );
    expect(mockSurface.flush.mock.invocationCallOrder[0]!).toBeLessThan(
      mockUploadTexture.destroy.mock.invocationCallOrder[0]!,
    );
    expect(first.dispose).not.toHaveBeenCalled();
    expect(imageFromVideoFrame(firstFrame)).toBe(first);
    expect(
      reserve.mock.calls.filter((call) => call[1].includes("upload")),
    ).toEqual([
      [32, "native frame WebGPU upload texture"],
      [64, "native frame WebGPU upload texture"],
    ]);
    clearVideoFrameImages(true);
    expect(largerTexture.destroy).toHaveBeenCalledTimes(1);
    expect(first.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed surface wrap from submitting or claiming a completed GPU copy", () => {
    (Skia.Surface.MakeFromGPUTexture as jest.Mock).mockReturnValueOnce(null);
    const frame: VideoFrame = {
      ...rgbaFrame(),
      texture: { kind: "native-buffer", nativeBuffer: 123n },
    };
    expect(() => imageFromVideoFrame(frame)).toThrow(
      "Cannot wrap video upload texture",
    );
    expect(mockCopy).not.toHaveBeenCalled();
    expect(mockWrapNative).not.toHaveBeenCalled();
    expect(mockSurface.flush).not.toHaveBeenCalled();
    expect(frame.dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    clearVideoFrameImages(true);
    expect(mockUploadTexture.destroy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
