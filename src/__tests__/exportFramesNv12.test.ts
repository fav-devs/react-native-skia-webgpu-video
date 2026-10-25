import { Skia } from "react-native-skia";
import {
  createExportFrameImports,
  importExportFrame,
  releaseExportFrame,
  releaseExportFrames,
} from "../exportFrames";
import type { VideoFrame } from "../types";

const mockExternals: { destroy: jest.Mock }[] = [];
const mockTextures: { width: number; height: number; destroy: jest.Mock }[] = [];
const mockSource = {
  handle: 1123n,
  width: 640,
  height: 360,
  pixelFormat: "nv12",
  release: jest.fn(),
};
jest.mock("../gpuDevice", () => ({
  getVideoGpuDevice: () => ({
    createTexture: jest.fn((descriptor: { size: { width: number; height: number } }) => {
      const texture = {
        ...descriptor.size,
        format: "rgba8unorm",
        createView: jest.fn(() => ({})),
        destroy: jest.fn(),
      };
      mockTextures.push(texture);
      return texture;
    }),
    importExternalTexture: jest.fn(() => {
      const external = { destroy: jest.fn() };
      mockExternals.push(external);
      return external;
    }),
    createBindGroupLayout: jest.fn(() => ({})),
    createPipelineLayout: jest.fn(() => ({})),
    createSampler: jest.fn(() => ({})),
    createShaderModule: jest.fn(() => ({})),
    createRenderPipeline: jest.fn(() => ({})),
    createBuffer: jest.fn(() => ({ destroy: jest.fn() })),
    createBindGroup: jest.fn(() => ({})),
    createCommandEncoder: jest.fn(() => ({
      beginRenderPass: jest.fn(() => ({
        setPipeline: jest.fn(),
        setBindGroup: jest.fn(),
        draw: jest.fn(),
        end: jest.fn(),
      })),
      finish: jest.fn(() => ({})),
    })),
    queue: { writeBuffer: jest.fn(), submit: jest.fn() },
  }),
  createNativeVideoGpuFrame: jest.fn(() => mockSource),
  nativeVideoTextureUsage: 21,
  videoShaderStages: { vertex: 1, fragment: 2 },
  videoUniformBufferUsage: 72,
}));
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
jest.mock("react-native-skia", () => ({
  Skia: {
    Image: { MakeFromGPUTexture: jest.fn(() => ({ dispose: jest.fn() })) },
    Surface: { MakeFromGPUTexture: jest.fn() },
    Color: jest.fn(() => 0),
  },
  BlendMode: { Clear: 0 },
}));
jest.mock("../RNSkiaVideoModule", () => ({
  __esModule: true,
  default: { reserveMemory: jest.fn(() => 7), releaseMemory: jest.fn() },
}));

const nv12Frame = (): VideoFrame => ({
  id: 5,
  producerId: 2,
  width: 640,
  height: 360,
  rotation: 0,
  texture: { kind: "native-buffer", nativeBuffer: 123n, format: "nv12" },
  dispose: jest.fn(),
});

describe("iOS NV12 frames in an export", () => {
  it("converts into the producer's texture and keeps the lease until the frame is released", () => {
    const imports = createExportFrameImports();
    const frame = nv12Frame();
    const entry = importExportFrame(frame, imports);
    expect(mockTextures).toHaveLength(1);
    expect(mockTextures[0]).toMatchObject({ width: 640, height: 360 });
    expect(Skia.Image.MakeFromGPUTexture).toHaveBeenCalledWith(mockTextures[0]);
    // The import ends with the submit; the buffer stays leased.
    expect(mockExternals[0]!.destroy).toHaveBeenCalled();
    expect(mockSource.release).not.toHaveBeenCalled();
    expect(frame.dispose).not.toHaveBeenCalled();

    releaseExportFrame(entry);
    expect(mockSource.release).toHaveBeenCalledTimes(1);
    expect(frame.dispose).toHaveBeenCalledTimes(1);

    // The next frame of the clip reuses its texture.
    importExportFrame({ ...nv12Frame(), id: 6 }, imports);
    expect(mockTextures).toHaveLength(1);
    releaseExportFrames(imports);
    expect(mockTextures[0]!.destroy).toHaveBeenCalled();
  });
});
