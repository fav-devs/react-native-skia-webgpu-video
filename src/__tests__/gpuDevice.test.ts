import { installWebGPU } from "react-native-webgpu";
import { Platform } from "react-native";

const mockDevice = { features: new Set<string>(), destroy: jest.fn() };
// React Native Skia's device generation (negated while it is lost), and the
// promise Skia.gpu.lost returns.
const mockGpu: { generation: number; lost: Promise<unknown> | null } = {
  generation: 1,
  lost: null,
};
const mockConfigureInterop = jest.fn();
const mockNativeModule: { configureNativeBufferInterop?: jest.Mock } = {
  configureNativeBufferInterop: mockConfigureInterop,
};
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
jest.mock("../RNSkiaVideoModule", () => ({
  __esModule: true,
  default: mockNativeModule,
}));
jest.mock("react-native-skia", () => ({
  Skia: {
    getNativeDevice: jest.fn(() => 55n),
    __rnskvGpuGeneration: jest.fn(() => mockGpu.generation),
    get gpu() {
      return { lost: mockGpu.lost ?? new Promise(() => {}) };
    },
  },
}));
jest.mock("react-native-webgpu", () => ({
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

const importDevice = jest.fn((_pointer: bigint) => mockDevice);
/** The RNWebGPU global the native module installs on the RN runtime. */
const installBridge = (extra: Record<string, unknown> = {}) => {
  (globalThis as unknown as Record<string, unknown>).RNWebGPU = {
    importDevice,
    ...extra,
  };
};
const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  (Platform as unknown as { OS: string }).OS = "ios";
  mockGpu.generation = 1;
  mockGpu.lost = null;
  delete (globalThis as unknown as Record<string, unknown>).__rnskwgpuDevice;
  mockDevice.features.clear();
  mockConfigureInterop.mockReset();
  mockNativeModule.configureNativeBufferInterop = mockConfigureInterop;
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).RNWebGPU;
  jest.clearAllMocks();
});

describe("shared video GPU runtime inputs", () => {
  it("keeps the RN native object captured even when the consuming runtime has no RNWebGPU global", () => {
    const source = { release: jest.fn() };
    const bridge = {
      importDevice,
      createVideoFrameFromNativeBuffer: jest.fn(() => source),
    };
    (globalThis as unknown as Record<string, unknown>).RNWebGPU = bridge;
    jest.isolateModules(() => {
      const gpu = require("../gpuDevice") as typeof import("../gpuDevice");
      delete (globalThis as unknown as Record<string, unknown>).RNWebGPU;
      expect(gpu.createNativeVideoGpuFrame(123n)).toBe(source);
      expect(bridge.createVideoFrameFromNativeBuffer).toHaveBeenCalledWith(
        123n,
      );
      expect(gpu.getVideoGpuDevice()).toBe(mockDevice);
      expect(gpu.getVideoGpuDevice()).toBe(mockDevice);
      expect(gpu.nativeVideoTextureUsage).toBe(21);
      expect(gpu.rgbaVideoTextureUsage).toBe(23);
      expect(importDevice.mock.calls).toEqual([[55n]]);
      expect(installWebGPU).toHaveBeenCalledTimes(1);
      expect(mockDevice.destroy).not.toHaveBeenCalled();
    });
    // This checks JS capture only; native Worklets boxing/prototype restoration
    // still requires an actual app runtime and is not claimed by this test.
  });

  it("fails clearly when the native wrapper bridge was unavailable at initialization", () => {
    delete (globalThis as unknown as Record<string, unknown>).RNWebGPU;
    jest.isolateModules(() => {
      const gpu = require("../gpuDevice") as typeof import("../gpuDevice");
      expect(() => gpu.createNativeVideoGpuFrame(123n)).toThrow(
        "React Native WebGPU is missing from the native app",
      );
    });
  });

  it("enables Android AHB setup only when the shared device supports import and the returned sync-fd fence", () => {
    (Platform as unknown as { OS: string }).OS = "android";
    mockDevice.features.add("shared-texture-memory-ahardware-buffer");
    mockDevice.features.add("shared-fence-sync-fd");
    installBridge({ createVideoFrameFromNativeBuffer: jest.fn() });
    jest.isolateModules(() => {
      require("../gpuDevice");
      expect(mockConfigureInterop).toHaveBeenCalledTimes(1);
      expect(mockConfigureInterop).toHaveBeenCalledWith(true);
      expect(
        (importDevice as jest.Mock).mock.invocationCallOrder[0]!,
      ).toBeLessThan(mockConfigureInterop.mock.invocationCallOrder[0]!);
      expect(mockDevice.destroy).not.toHaveBeenCalled();
    });
  });

  it("selects CPU before decoder setup if either required Dawn feature is absent", () => {
    (Platform as unknown as { OS: string }).OS = "android";
    installBridge({ createVideoFrameFromNativeBuffer: jest.fn() });
    for (const feature of [
      "shared-texture-memory-ahardware-buffer",
      "shared-fence-sync-fd",
    ]) {
      mockDevice.features.clear();
      mockDevice.features.add(feature);
      mockConfigureInterop.mockClear();
      jest.isolateModules(() => {
        require("../gpuDevice");
        expect(mockConfigureInterop).toHaveBeenCalledTimes(1);
        expect(mockConfigureInterop).toHaveBeenCalledWith(false);
      });
    }
  });

  it("selects CPU if the native frame wrapper was not installed", () => {
    (Platform as unknown as { OS: string }).OS = "android";
    mockDevice.features.add("shared-texture-memory-ahardware-buffer");
    mockDevice.features.add("shared-fence-sync-fd");
    installBridge();
    jest.isolateModules(() => {
      require("../gpuDevice");
      expect(mockConfigureInterop).toHaveBeenCalledWith(false);
    });
  });

  it("keeps the native CPU default when an older binding has no negotiation method", () => {
    (Platform as unknown as { OS: string }).OS = "android";
    delete mockNativeModule.configureNativeBufferInterop;
    jest.isolateModules(() => {
      require("../gpuDevice");
      expect(mockConfigureInterop).not.toHaveBeenCalled();
    });
  });

  it("falls back before decoding only for the controlled native capability refusal", () => {
    (Platform as unknown as { OS: string }).OS = "android";
    mockDevice.features.add("shared-texture-memory-ahardware-buffer");
    mockDevice.features.add("shared-fence-sync-fd");
    installBridge({ createVideoFrameFromNativeBuffer: jest.fn() });
    mockConfigureInterop.mockImplementationOnce(() => {
      throw new Error(
        "Exception in HostFunction: Android native buffer interop unavailable: EGL extension missing",
      );
    });
    jest.isolateModules(() => {
      require("../gpuDevice");
      expect(mockConfigureInterop.mock.calls).toEqual([[true], [false]]);
    });
  });

  it("preserves allocation and unexpected setup failures instead of disguising them as a CPU fallback", () => {
    (Platform as unknown as { OS: string }).OS = "android";
    mockDevice.features.add("shared-texture-memory-ahardware-buffer");
    mockDevice.features.add("shared-fence-sync-fd");
    installBridge({ createVideoFrameFromNativeBuffer: jest.fn() });
    const failure = new Error("Native AHB memory budget exhausted");
    mockConfigureInterop.mockImplementationOnce(() => {
      throw failure;
    });
    jest.isolateModules(() => {
      expect(() => require("../gpuDevice")).toThrow(failure);
      expect(mockConfigureInterop.mock.calls).toEqual([[true]]);
    });
  });

  it("does not retry a failed disable operation even if its error contains the capability prefix", () => {
    (Platform as unknown as { OS: string }).OS = "android";
    const failure = new Error(
      "Android native buffer interop unavailable: cannot disable",
    );
    installBridge();
    mockConfigureInterop.mockImplementationOnce(() => {
      throw failure;
    });
    jest.isolateModules(() => {
      expect(() => require("../gpuDevice")).toThrow(failure);
      expect(mockConfigureInterop.mock.calls).toEqual([[false]]);
    });
  });

  it("does not configure Android buffer interop on iOS", () => {
    mockDevice.features.add("shared-texture-memory-ahardware-buffer");
    mockDevice.features.add("shared-fence-sync-fd");
    installBridge({ createVideoFrameFromNativeBuffer: jest.fn() });
    jest.isolateModules(() => {
      require("../gpuDevice");
      expect(mockConfigureInterop).not.toHaveBeenCalled();
    });
  });
});

describe("following React Native Skia's device replacement", () => {
  const skia = () =>
    (require("react-native-skia") as typeof import("react-native-skia"))
      .Skia as unknown as { getNativeDevice: jest.Mock };

  it("imports the device in use on first use, again once it was replaced, and never destroys one", () => {
    const replacement = { features: new Set<string>(), destroy: jest.fn() };
    importDevice.mockImplementation((pointer) =>
      pointer === 56n ? (replacement as never) : mockDevice,
    );
    installBridge();
    jest.isolateModules(() => {
      const gpu = require("../gpuDevice") as typeof import("../gpuDevice");
      // iOS imports nothing at load: each runtime imports on first use.
      expect(importDevice).not.toHaveBeenCalled();
      expect(gpu.getVideoGpuDevice()).toBe(mockDevice);
      const before = gpu.getVideoGpuState();
      expect(before).toEqual({ generation: 1, lost: false });
      // Lost, not replaced yet: the lost device stays, nothing renders.
      mockGpu.generation = -1;
      expect(gpu.getVideoGpuState()).toEqual({ generation: 1, lost: true });
      expect(gpu.isVideoGpuDeviceGone(before)).toBe(true);
      expect(gpu.getVideoGpuDevice()).toBe(mockDevice);
      mockGpu.generation = 2;
      skia().getNativeDevice.mockReturnValue(56n);
      expect(gpu.isVideoGpuDeviceGone(before)).toBe(true);
      expect(gpu.getVideoGpuDevice()).toBe(replacement);
      expect(gpu.getVideoGpuDevice()).toBe(replacement);
      expect(gpu.isVideoGpuDeviceGone(gpu.getVideoGpuState())).toBe(false);
      expect(importDevice.mock.calls).toEqual([[55n], [56n]]);
    });
    expect(mockDevice.destroy).not.toHaveBeenCalled();
    expect(replacement.destroy).not.toHaveBeenCalled();
    skia().getNativeDevice.mockReturnValue(55n);
    importDevice.mockImplementation(() => mockDevice);
  });

  it("fails clearly when the native binary lacks the GPU recovery patch", () => {
    installBridge();
    jest.isolateModules(() => {
      const native = (
        require("react-native-skia") as { Skia: Record<string, unknown> }
      ).Skia;
      const read = native.__rnskvGpuGeneration;
      delete native.__rnskvGpuGeneration;
      try {
        const gpu = require("../gpuDevice") as typeof import("../gpuDevice");
        expect(() => gpu.getVideoGpuDevice()).toThrow(
          "Skia GPU recovery patch is missing from the native binary",
        );
        expect(gpu.isVideoGpuDeviceGone({ generation: 1, lost: false })).toBe(
          false,
        );
      } finally {
        native.__rnskvGpuGeneration = read;
      }
    });
  });

  it("negotiates Android buffer interop again for each replacement device, on the RN runtime", async () => {
    (Platform as unknown as { OS: string }).OS = "android";
    mockDevice.features.add("shared-texture-memory-ahardware-buffer");
    mockDevice.features.add("shared-fence-sync-fd");
    installBridge({ createVideoFrameFromNativeBuffer: jest.fn() });
    let lose!: () => void;
    mockGpu.lost = new Promise<void>((resolve) => {
      lose = resolve;
    });
    await jest.isolateModulesAsync(async () => {
      require("../gpuDevice");
      expect(mockConfigureInterop.mock.calls).toEqual([[true]]);
      // The replacement lacks the AHB features: new decoders use the CPU.
      const replacement = { features: new Set<string>(), destroy: jest.fn() };
      importDevice.mockImplementation(() => replacement as never);
      let loseAgain!: () => void;
      const next = new Promise<void>((resolve) => {
        loseAgain = resolve;
      });
      mockGpu.generation = 2;
      lose();
      mockGpu.lost = next;
      await flushMicrotasks();
      expect(mockConfigureInterop.mock.calls).toEqual([[true], [false]]);
      // And it follows the next loss too.
      replacement.features.add("shared-texture-memory-ahardware-buffer");
      replacement.features.add("shared-fence-sync-fd");
      const third = { features: replacement.features, destroy: jest.fn() };
      importDevice.mockImplementation(() => third as never);
      mockGpu.generation = 3;
      // Read again after it settled, Skia.gpu.lost is the next device's.
      mockGpu.lost = null;
      loseAgain();
      await flushMicrotasks();
      expect(mockConfigureInterop.mock.calls).toEqual([
        [true],
        [false],
        [true],
      ]);
    });
    importDevice.mockImplementation(() => mockDevice);
  });

  it("keeps the previous interop configuration and warns when a replacement cannot be negotiated", async () => {
    (Platform as unknown as { OS: string }).OS = "android";
    installBridge({ createVideoFrameFromNativeBuffer: jest.fn() });
    let lose!: () => void;
    mockGpu.lost = new Promise<void>((resolve) => {
      lose = resolve;
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await jest.isolateModulesAsync(async () => {
        require("../gpuDevice");
        expect(mockConfigureInterop.mock.calls).toEqual([[false]]);
        const replacement = {
          features: new Set([
            "shared-texture-memory-ahardware-buffer",
            "shared-fence-sync-fd",
          ]),
        };
        importDevice.mockImplementation(() => replacement as never);
        mockConfigureInterop.mockImplementationOnce(() => {
          throw new Error("Native AHB memory budget exhausted");
        });
        mockGpu.generation = 2;
        mockGpu.lost = null;
        lose();
        await flushMicrotasks();
        expect(mockConfigureInterop.mock.calls).toEqual([[false], [true]]);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("could not be negotiated"),
          expect.stringContaining("memory budget exhausted"),
        );
      });
    } finally {
      warn.mockRestore();
      importDevice.mockImplementation(() => mockDevice);
    }
  });
});
