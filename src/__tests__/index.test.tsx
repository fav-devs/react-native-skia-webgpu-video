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
import * as api from "../index";

// Only the module surface matters here: the hooks are not rendered.
jest.mock("react-native-reanimated", () => ({
  useSharedValue: jest.fn(),
  useFrameCallback: jest.fn(),
  runOnUI: jest.fn(),
}));
jest.mock("react-native-worklets", () => ({
  createWorkletRuntime: jest.fn(),
  runOnRuntime: jest.fn(),
  scheduleOnRN: jest.fn(),
  createSynchronizable: jest.fn(),
}));
jest.mock("react-native-skia", () => ({
  Skia: {},
  BlendMode: {},
  ColorType: { RGBA_8888: 4 },
  AlphaType: { Premul: 1 },
}));
jest.mock("../RNSkiaVideoModule", () => ({
  __esModule: true,
  default: {
    frameProtocolVersion: 1,
    getValidEncoderConfigurations: jest.fn(() => []),
    getDecodingCapabilitiesFor: jest.fn(() => null),
    isEncodingSupported: jest.fn(() => true),
  },
}));

describe("public API", () => {
  it("exposes the hooks and the export function", () => {
    expect(typeof api.useVideoPlayback).toBe("function");
    expect(typeof api.useVideoComposition).toBe("function");
    expect(api).not.toHaveProperty("useVideoPlayer");
    expect(api).not.toHaveProperty("useVideoCompositionPlayer");
    expect(typeof api.exportVideoComposition).toBe("function");
    expect(typeof api.isEncodingSupported).toBe("function");
  });

  it("only offers the codec capability helpers on Android", () => {
    // The React Native jest preset runs as iOS.
    expect(Platform.OS).toBe("ios");
    expect(() => api.getValidEncoderConfigurations(1920, 1080, 30, 1)).toThrow(
      "only available on Android",
    );
    expect(() => api.getDecodingCapabilitiesFor("video/avc")).toThrow(
      "only available on Android",
    );
  });

  it("answers codec support on both platforms", () => {
    expect(api.isEncodingSupported("hevc")).toBe(true);
  });
});
