jest.mock("../gpuDevice", () => ({
  getVideoGpuDevice: jest.fn(() => {
    throw new Error("Unexpected native import in this test");
  }),
  createNativeVideoGpuFrame: jest.fn(),
  nativeVideoTextureUsage: 20,
}));

import { Skia } from "react-native-skia";
import { drawVideoFrame, makeVideoFrameImage } from "../videoFrameImage";
import type { VideoFrame } from "../types";

jest.mock("react-native-skia", () => ({
  Skia: {
    Image: {
      MakeFromGPUTexture: jest.fn(() => {
        throw new Error("Legacy imports cannot run under Graphite");
      }),
    },
    Paint: jest.fn(() => ({ kind: "paint", dispose: jest.fn() })),
  },
}));

jest.mock("../RNSkiaVideoModule", () => ({
  __esModule: true,
  default: { frameProtocolVersion: 1 },
}));

const makeImage = Skia.Image.MakeFromGPUTexture as jest.Mock;

const canvas = () => {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  return {
    calls,
    canvas: {
      drawImageRect: record("drawImageRect"),
      save: record("save"),
      restore: record("restore"),
      translate: record("translate"),
      rotate: record("rotate"),
    } as any,
  };
};

const copyFrame: VideoFrame = {
  texture: { kind: "skia-image", image: { kind: "owned-image" } },
  width: 1280,
  height: 720,
  rotation: 0,
};

// A 1080p H.264 buffer as Android hands it over with textureMode 'direct'.
const directFrame = (rotation: number): VideoFrame => ({
  texture: { kind: "skia-image", image: { kind: "owned-direct-image" } },
  width: 1920,
  height: 1088,
  rotation,
  crop: { x: 0, y: 0, width: 1920, height: 1080 },
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("makeVideoFrameImage", () => {
  it("wraps the whole texture of a frame without a crop", () => {
    const result = makeVideoFrameImage(copyFrame)!;
    expect(result.image).toBe((copyFrame.texture as any).image);
    expect(makeImage).not.toHaveBeenCalled();
    expect(result.rect).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(result.rotation).toBe(0);
    expect([result.width, result.height]).toEqual([1280, 720]);
  });

  it("keeps to the picture of a decoder buffer, and turns its size", () => {
    const result = makeVideoFrameImage(directFrame(90))!;
    expect(makeImage).not.toHaveBeenCalled();
    expect(result.rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(result.rotation).toBe(90);
    expect([result.width, result.height]).toEqual([1080, 1920]);
  });

  it("normalises the rotation", () => {
    expect(makeVideoFrameImage({ ...copyFrame, rotation: -90 })!.rotation).toBe(
      270,
    );
    expect(makeVideoFrameImage({ ...copyFrame, rotation: 450 })!.rotation).toBe(
      90,
    );
  });

  it("accepts a recycled output without overwriting the owned frame image", () => {
    const output = { kind: "recycled" } as any;
    expect(makeVideoFrameImage(copyFrame, output)!.image).toBe(
      (copyFrame.texture as any).image,
    );
    expect(makeImage).not.toHaveBeenCalled();
  });

  it("has nothing for a frame without a texture", () => {
    expect(
      makeVideoFrameImage({ ...copyFrame, texture: undefined }),
    ).toBeNull();
    expect(makeImage).not.toHaveBeenCalled();
  });
});

describe("drawVideoFrame", () => {
  const dst = { x: 10, y: 20, width: 100, height: 100 };

  it("stretches an upright frame over the destination by default", () => {
    const { canvas: c, calls } = canvas();
    drawVideoFrame(c, copyFrame, dst);
    expect(calls).toEqual([
      [
        "drawImageRect",
        expect.anything(),
        { x: 0, y: 0, width: 1280, height: 720 },
        dst,
        expect.objectContaining({ kind: "paint" }),
      ],
    ]);
  });

  it("draws only the picture of a decoder buffer", () => {
    const { canvas: c, calls } = canvas();
    drawVideoFrame(c, directFrame(0), dst);
    expect(calls[0]?.[2]).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it("covers with the middle of the picture", () => {
    const { canvas: c, calls } = canvas();
    drawVideoFrame(c, directFrame(0), dst, { fit: "cover" });
    expect(calls[0]?.[2]).toEqual({ x: 420, y: 0, width: 1080, height: 1080 });
    expect(calls[0]?.[3]).toEqual(dst);
  });

  it("contains the whole picture in the middle of the destination", () => {
    const { canvas: c, calls } = canvas();
    drawVideoFrame(c, directFrame(0), dst, { fit: "contain" });
    expect(calls[0]?.[2]).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(calls[0]?.[3]).toEqual({
      x: 10,
      y: 41.875,
      width: 100,
      height: 56.25,
    });
  });

  it("turns a rotated frame about the middle of the destination", () => {
    const { canvas: c, calls } = canvas();
    const portrait = { x: 0, y: 0, width: 108, height: 192 };
    drawVideoFrame(c, directFrame(90), portrait);
    expect(calls).toEqual([
      ["save"],
      ["translate", 54, 96],
      ["rotate", 90, 0, 0],
      [
        "drawImageRect",
        expect.anything(),
        { x: 0, y: 0, width: 1920, height: 1080 },
        { x: -96, y: -54, width: 192, height: 108 },
        expect.objectContaining({ kind: "paint" }),
      ],
      ["restore"],
    ]);
  });

  it("covers with the middle of a rotated picture", () => {
    for (const rotation of [90, 180, 270]) {
      const { canvas: c, calls } = canvas();
      drawVideoFrame(c, directFrame(rotation), dst, { fit: "cover" });
      const draw = calls.find((call) => call[0] === "drawImageRect")!;
      expect(draw[2]).toEqual({ x: 420, y: 0, width: 1080, height: 1080 });
    }
  });

  it("maps an offset crop through the rotation", () => {
    const frame: VideoFrame = {
      texture: { kind: "skia-image", image: { kind: "cropped-image" } },
      width: 200,
      height: 100,
      rotation: 90,
      crop: { x: 10, y: 20, width: 100, height: 50 },
    };
    const { canvas: c, calls } = canvas();
    drawVideoFrame(c, frame, dst);
    const draw = calls.find((call) => call[0] === "drawImageRect")!;
    expect(draw[2]).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it("uses the given paint, accepts recycled output and returns the owned frame image", () => {
    const { canvas: c, calls } = canvas();
    const paint = { kind: "faded" } as any;
    const output = { kind: "recycled" } as any;
    expect(drawVideoFrame(c, copyFrame, dst, { paint, output })).toBe(
      (copyFrame.texture as any).image,
    );
    expect(calls[0]?.[4]).toBe(paint);
  });

  it("draws nothing for a frame without a texture", () => {
    const { canvas: c, calls } = canvas();
    expect(
      drawVideoFrame(c, { ...copyFrame, texture: undefined }, dst),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it("disposes the default paint after drawing without disposing caller-owned paint", () => {
    const { canvas: c } = canvas();
    drawVideoFrame(c, copyFrame, dst);
    const generated = (Skia.Paint as jest.Mock).mock.results[0]?.value;
    expect(generated.dispose).toHaveBeenCalledTimes(1);
    const supplied = { dispose: jest.fn() } as any;
    drawVideoFrame(c, copyFrame, dst, { paint: supplied });
    expect(Skia.Paint).toHaveBeenCalledTimes(1);
    expect(supplied.dispose).not.toHaveBeenCalled();
  });

  it("restores canvas transforms and disposes default paint when a rotated draw throws", () => {
    const { canvas: c, calls } = canvas();
    const failure = new Error("draw failed");
    c.drawImageRect = () => {
      throw failure;
    };
    expect(() => drawVideoFrame(c, directFrame(90), dst)).toThrow(failure);
    expect(calls[calls.length - 1]).toEqual(["restore"]);
    expect(
      (Skia.Paint as jest.Mock).mock.results[0]?.value.dispose,
    ).toHaveBeenCalledTimes(1);
  });
});
