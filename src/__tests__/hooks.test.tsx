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

import { act, Suspense, type ReactNode } from "react";
import { PixelRatio } from "react-native";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { Skia } from "react-native-skia";
import RNSkiaVideoModule from "../RNSkiaVideoModule";
import { useVideoPlayback } from "../videoPlayer";
import { useVideoComposition } from "../videoCompositionPlayer";
import type { VideoComposition, VideoFrame } from "../types";
import { createSerializedUiRuntime } from "../../test/utils/serializedUiRuntime";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks. The hooks run their per-frame work inside Reanimated's
// useFrameCallback: the mock records the latest callback so tests can drive
// the vsync ticks by hand.
// ---------------------------------------------------------------------------

const mockFrame: { callback: (() => void) | null } = { callback: null };
let mockDeferUi = false;
const mockUiTasks: Array<() => void> = [];
let mockSerializedRuntime: ReturnType<typeof createSerializedUiRuntime> | null =
  null;

jest.mock("react-native-reanimated", () => {
  const ReactModule = require("react");
  const {
    loadInstalledValueSetter,
  } = require("../../test/utils/serializedUiRuntime");
  const valueSetter = loadInstalledValueSetter();
  return {
    useSharedValue: (initial: unknown) => {
      const ref = ReactModule.useRef(null);
      if (ref.current === null) {
        const mutable: {
          value: unknown;
          modify: (modifier?: (value: unknown) => unknown) => void;
        } = {
          value: initial,
          modify: (modifier) => {
            if (modifier) {
              mutable.value = modifier(mutable.value);
            }
          },
        };
        const nativeSetter =
          mockSerializedRuntime?.unpackWorklet(valueSetter) ?? valueSetter;
        const storage = mutable as typeof mutable & {
          _value: unknown;
          _animation: null;
        };
        storage._value = initial;
        storage._animation = null;
        Object.defineProperty(mutable, "value", {
          get: () => storage._value,
          set: (value) => nativeSetter(storage, value),
        });
        ref.current = mockSerializedRuntime?.host(mutable) ?? mutable;
      }
      return ref.current;
    },
    useFrameCallback: (callback: () => void) => {
      mockFrame.callback =
        mockSerializedRuntime?.unpackWorklet(callback) ?? callback;
      return { setActive: () => {} };
    },
    runOnUI: (fn: () => void) => () => {
      const task = mockSerializedRuntime?.unpackWorklet(fn) ?? fn;
      if (mockDeferUi) mockUiTasks.push(task);
      else task();
    },
  };
});

jest.mock("react-native-worklets", () => ({
  scheduleOnRN: jest.fn(
    (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
      mockSerializedRuntime
        ? mockSerializedRuntime.scheduleOnRN(fn, ...args)
        : fn(...args),
  ),
}));

const mockCanvas = { kind: "canvas", drawColor: jest.fn(), dispose: jest.fn() };

const mockMakeSnapshot = jest.fn(
  (_bounds?: unknown, output?: unknown) =>
    output ?? { kind: "image", dispose: jest.fn() },
);

const mockSurface = {
  enableCheckedSubmissions: jest.fn(),
  getCanvas: jest.fn(() => mockCanvas),
  flush: jest.fn(),
  makeImageSnapshot: mockMakeSnapshot,
  dispose: jest.fn(),
};

// The 1x1 surface the composition player makes before prepare(), so that
// Skia's context exists on the UI thread.
const mockWarmUpSurface = { dispose: jest.fn() };

jest.mock("react-native-skia", () => ({
  BlendMode: { Clear: 0 },
  Skia: {
    Color: jest.fn(() => "transparent"),
    Surface: {
      MakeOffscreen: jest.fn((width: number, height: number) =>
        width === 1 && height === 1 ? mockWarmUpSurface : mockSurface,
      ),
    },
    Image: {
      MakeFromGPUTexture: jest.fn(
        (
          _texture: unknown,
          _width: number,
          _height: number,
          _mipmapped: boolean,
          output?: unknown,
        ) => output ?? { kind: "image" },
      ),
    },
  },
}));

jest.mock("../RNSkiaVideoModule", () => ({
  __esModule: true,
  default: {
    frameProtocolVersion: 1,
    createVideoPlayer: jest.fn(),
    createVideoCompositionFramesExtractor: jest.fn(),
    // A binary with signed rates: the hook hands out the native player.
    getBackendInfo: jest.fn(() => ({ signedPlaybackRate: true })),
    reserveMemory: jest.fn(() => 17),
    releaseMemory: jest.fn(),
  },
}));

const createVideoPlayer = RNSkiaVideoModule.createVideoPlayer as jest.Mock;
const createFramesExtractor =
  RNSkiaVideoModule.createVideoCompositionFramesExtractor as jest.Mock;
const getBackendInfo = RNSkiaVideoModule.getBackendInfo as jest.Mock;
const makeImage = Skia.Image.MakeFromGPUTexture as jest.Mock;
const makeOffscreen = Skia.Surface.MakeOffscreen as jest.Mock;
/** The player's own surfaces, without the warm-up one. */
const surfaceCalls = () =>
  makeOffscreen.mock.calls.filter(
    ([width, height]) => !(width === 1 && height === 1),
  );

const createPlayerMock = () => ({
  isPlaying: false,
  isLooping: false,
  volume: 1,
  playbackSpeed: 1,
  currentTime: 0,
  duration: 10,
  decodeNextFrame: jest.fn<VideoFrame | null, []>(() => null),
  play: jest.fn(),
  pause: jest.fn(),
  seekTo: jest.fn(),
  dispose: jest.fn(),
  on: jest.fn((..._args: unknown[]) => () => {}),
});

const createExtractorMock = () => ({
  isPlaying: false,
  isLooping: false,
  playbackRate: 1,
  currentTime: 0,
  framesVersion: 0,
  decodeCompositionFrames: jest.fn<Record<string, VideoFrame>, []>(() => ({})),
  prepare: jest.fn(),
  play: jest.fn(),
  pause: jest.fn(),
  seekTo: jest.fn(),
  dispose: jest.fn(),
  on: jest.fn((..._args: unknown[]) => () => {}),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderHook<Props, Result>(
  hook: (props: Props) => Result,
  initialProps: Props,
) {
  const result: { current: Result } = {
    current: undefined as unknown as Result,
  };
  function HookHost({ hookProps }: { hookProps: Props }) {
    result.current = hook(hookProps);
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<HookHost hookProps={initialProps} />);
  });
  return {
    result,
    rerender: (props: Props) =>
      act(() => {
        renderer.update(<HookHost hookProps={props} />);
      }),
    unmount: () =>
      act(() => {
        renderer.unmount();
      }),
  };
}

const tick = () =>
  act(() => {
    mockFrame.callback?.();
  });

const composition: VideoComposition = {
  duration: 2,
  items: [
    {
      id: "clip",
      path: "/videos/clip.mp4",
      compositionStartTime: 0,
      startTime: 0,
      duration: 2,
    },
  ],
};
const copyOwnedFrame = (): VideoFrame => ({
  texture: { kind: "skia-image", image: { dispose: jest.fn() } },
  width: 1280,
  height: 720,
  rotation: 0,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSurface.flush.mockReset();
  mockSurface.dispose.mockReset();
  mockCanvas.dispose.mockReset();
  delete (globalThis as { __rnskwgpuPreviewQuarantine?: unknown })
    .__rnskwgpuPreviewQuarantine;
  mockFrame.callback = null;
  mockDeferUi = false;
  mockSerializedRuntime = null;
  mockUiTasks.length = 0;
});

describe("serialized UI worklets", () => {
  it("draws and unmounts a composition through Babel's UI bodies without capturing React refs", () => {
    mockSerializedRuntime = createSerializedUiRuntime();
    const extractor = mockSerializedRuntime.host(createExtractorMock());
    const frame = copyOwnedFrame();
    extractor.decodeCompositionFrames.mockReturnValue({ clip: frame });
    createFramesExtractor.mockReturnValue(extractor);
    const observed = jest.fn();
    const drawFrame = (args: {
      width: number;
      frames: Record<string, VideoFrame>;
    }) => {
      "worklet";
      observed(args.width, args.frames.clip!.width);
    };
    const rendered = renderHook(
      () =>
        useVideoComposition({
          composition,
          width: 320,
          height: 180,
          drawFrame,
        }),
      undefined,
    );

    tick();
    expect(extractor.prepare).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledWith(320 * PixelRatio.get(), 1280);
    expect(rendered.result.current.currentFrame.value).not.toBeNull();
    rendered.unmount();
    expect(extractor.dispose).toHaveBeenCalledTimes(1);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    expect(RNSkiaVideoModule.releaseMemory).toHaveBeenCalledTimes(1);
    expect(mockSerializedRuntime.evaluatedBodies).toBeGreaterThan(5);
  });

  it("dispatches a UI prepare exception to the RN callback and closes the producer", () => {
    mockSerializedRuntime = createSerializedUiRuntime();
    const extractor = mockSerializedRuntime.host(createExtractorMock());
    const prepareError = new Error("decoder prepare failed");
    extractor.prepare.mockImplementation(() => {
      throw prepareError;
    });
    createFramesExtractor.mockReturnValue(extractor);
    const onError = jest.fn();
    const drawFrame = () => {
      "worklet";
    };
    const rendered = renderHook(
      () =>
        useVideoComposition({
          composition,
          width: 320,
          height: 180,
          drawFrame,
          onError,
        }),
      undefined,
    );

    expect(onError).toHaveBeenCalledWith(prepareError, expect.any(Function));
    expect(rendered.result.current.player).toBeNull();
    expect(extractor.dispose).toHaveBeenCalledTimes(1);
    rendered.unmount();
    expect(extractor.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps the native producer releasable after a UI draw exception", () => {
    mockSerializedRuntime = createSerializedUiRuntime();
    const extractor = mockSerializedRuntime.host(createExtractorMock());
    extractor.decodeCompositionFrames.mockReturnValue({
      clip: copyOwnedFrame(),
    });
    createFramesExtractor.mockReturnValue(extractor);
    const drawFrame = () => {
      "worklet";
      throw new Error("drawer failed");
    };
    const onError = jest.fn();
    const rendered = renderHook(
      () =>
        useVideoComposition({
          composition,
          width: 320,
          height: 180,
          drawFrame,
          onError,
        }),
      undefined,
    );

    tick();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "drawer failed" }),
      expect.any(Function),
    );
    expect(rendered.result.current.player).toBeNull();
    expect(extractor.dispose).toHaveBeenCalledTimes(1);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    rendered.unmount();
    expect(extractor.dispose).toHaveBeenCalledTimes(1);
  });

  it("runs frame cleanup once after GPU submission with the installed SharedValue setter", () => {
    mockSerializedRuntime = createSerializedUiRuntime();
    const extractor = mockSerializedRuntime.host(createExtractorMock());
    createFramesExtractor.mockReturnValue(extractor);
    const order = jest.fn();
    mockSurface.flush.mockImplementation(() => order("flush"));
    const beforeDrawFrame = () => {
      "worklet";
      return "frame context";
    };
    const drawFrame = () => {
      "worklet";
      order("draw");
    };
    const afterDrawFrame = (context: string) => {
      "worklet";
      order("after", context);
    };
    const rendered = renderHook(
      () =>
        useVideoComposition({
          composition,
          width: 320,
          height: 180,
          drawFrame,
          beforeDrawFrame,
          afterDrawFrame,
        }),
      undefined,
    );

    tick();
    expect(order.mock.calls).toEqual([
      ["draw"],
      ["flush"],
      ["after", "frame context"],
    ]);
    rendered.unmount();
    expect(
      order.mock.calls.filter(([stage]) => stage === "after"),
    ).toHaveLength(1);
  });

  it("retains a frame callback after failed GPU drains without invoking it as an animation", () => {
    mockSerializedRuntime = createSerializedUiRuntime();
    const extractor = mockSerializedRuntime.host(createExtractorMock());
    createFramesExtractor.mockReturnValue(extractor);
    const fenceError = new Error("GPU fence unavailable");
    mockSurface.flush.mockImplementation(() => {
      throw fenceError;
    });
    const release = jest.fn();
    const drawFrame = () => {
      "worklet";
    };
    const afterDrawFrame = () => {
      "worklet";
      release();
    };
    const onError = jest.fn();
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    const rendered = renderHook(
      () =>
        useVideoComposition({
          composition,
          width: 320,
          height: 180,
          drawFrame,
          afterDrawFrame,
          onError,
        }),
      undefined,
    );
    try {
      tick();
      expect(onError).toHaveBeenCalledWith(fenceError, expect.any(Function));
      expect(release).not.toHaveBeenCalled();
      expect(extractor.dispose).toHaveBeenCalledTimes(1);
      expect(mockSurface.dispose).not.toHaveBeenCalled();
      expect(RNSkiaVideoModule.releaseMemory).not.toHaveBeenCalled();
      rendered.unmount();
      expect(extractor.dispose).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it("publishes and releases a single player's frame under actual SharedValue semantics", () => {
    mockSerializedRuntime = createSerializedUiRuntime();
    const player = mockSerializedRuntime.host(createPlayerMock());
    const frame = copyOwnedFrame();
    player.decodeNextFrame.mockReturnValue(frame);
    createVideoPlayer.mockReturnValue(player);
    const rendered = renderHook(
      () => useVideoPlayback({ uri: "file:///videos/clip.mp4" }),
      undefined,
    );
    tick();
    expect(rendered.result.current.currentFrame.value).not.toBeNull();
    rendered.unmount();
    expect(player.dispose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// useVideoPlayback
// ---------------------------------------------------------------------------

describe("useVideoPlayback", () => {
  type Options = Parameters<typeof useVideoPlayback>[0];

  const setup = (options: Partial<Options> = {}) => {
    // A fresh native player per creation, as the real module does: the hook
    // tells them apart by identity when it re-creates one.
    createVideoPlayer.mockImplementation(createPlayerMock);
    const rendered = renderHook((props: Options) => useVideoPlayback(props), {
      uri: "file:///videos/clip.mp4",
      ...options,
    });
    const player = createVideoPlayer.mock.results[0]!.value as ReturnType<
      typeof createPlayerMock
    >;
    return { player, ...rendered };
  };

  it("creates the native player for the uri, without a texture mode by default", () => {
    setup();
    expect(createVideoPlayer).toHaveBeenCalledTimes(1);
    // No third argument: the native side keeps its own default, `copy`.
    expect(createVideoPlayer).toHaveBeenCalledWith(
      "file:///videos/clip.mp4",
      undefined,
      undefined,
    );
  });

  it("passes textureMode to the native player and re-creates it on change", () => {
    const { player, rerender } = setup({ textureMode: "direct" });
    expect(createVideoPlayer).toHaveBeenLastCalledWith(
      "file:///videos/clip.mp4",
      undefined,
      { textureMode: "direct" },
    );

    rerender({ uri: "file:///videos/clip.mp4", textureMode: "copy" });
    expect(createVideoPlayer).toHaveBeenCalledTimes(2);
    expect(createVideoPlayer).toHaveBeenLastCalledWith(
      "file:///videos/clip.mp4",
      undefined,
      { textureMode: "copy" },
    );
    expect(player.dispose).toHaveBeenCalledTimes(1);
  });

  it("re-creates the player when the resolution changes and disposes the old one", () => {
    const { player, rerender } = setup({
      resolution: { width: 640, height: 360 },
    });
    expect(createVideoPlayer).toHaveBeenLastCalledWith(
      "file:///videos/clip.mp4",
      { width: 640, height: 360 },
      undefined,
    );

    rerender({
      uri: "file:///videos/clip.mp4",
      resolution: { width: 320, height: 180 },
    });
    expect(createVideoPlayer).toHaveBeenCalledTimes(2);
    expect(createVideoPlayer).toHaveBeenLastCalledWith(
      "file:///videos/clip.mp4",
      { width: 320, height: 180 },
      undefined,
    );
    expect(player.dispose).toHaveBeenCalledTimes(1);
  });

  it("polls decodeNextFrame while paused and publishes the frame it returns", () => {
    const { player, result } = setup();
    expect(player.isPlaying).toBe(false);

    tick();
    expect(player.decodeNextFrame).toHaveBeenCalledTimes(1);
    expect(result.current.currentFrame.value).toBeNull();

    // The frame decoded after a seek performed while paused.
    const frame: VideoFrame = {
      texture: { kind: "skia-image", image: { kind: "owned-paused-image" } },
      width: 1920,
      height: 1080,
      rotation: 0,
    };
    player.decodeNextFrame.mockReturnValueOnce(frame);
    tick();
    expect(result.current.currentFrame.value).toMatchObject({
      width: frame.width,
      height: frame.height,
      rotation: frame.rotation,
      texture: frame.texture,
    });
    const ownedFrame = result.current.currentFrame.value;

    // Nothing new: the last frame stays.
    tick();
    expect(player.decodeNextFrame).toHaveBeenCalledTimes(3);
    expect(result.current.currentFrame.value).toBe(ownedFrame);
  });

  it("applies looping, volume and playback speed, and auto plays", () => {
    const { player } = setup({
      isLooping: true,
      volume: 0.5,
      playbackSpeed: 2,
      autoPlay: true,
    });
    expect(player.isLooping).toBe(true);
    expect(player.volume).toBe(0.5);
    expect(player.playbackSpeed).toBe(2);
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it("disposes the player on unmount", () => {
    const { player, unmount } = setup();
    unmount();
    expect(player.dispose).toHaveBeenCalledTimes(1);
  });

  it("quarantines a failed native close instead of throwing from unmount", () => {
    const warning = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { player, unmount } = setup();
    player.dispose.mockImplementationOnce(() => {
      throw new Error("Native close failed");
    });
    expect(unmount).not.toThrow();
    expect(player.dispose).toHaveBeenCalledTimes(1);
    const retained = (
      globalThis as { __rnskwgpuPreviewQuarantine?: Array<{ native: unknown }> }
    ).__rnskwgpuPreviewQuarantine!;
    expect(retained).toHaveLength(1);
    expect(retained[0]?.native).toBe(player);
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  it("does not allocate a native player for a React render that never commits", () => {
    const pending = new Promise<void>(() => {});
    function Abandoned(): ReactNode {
      useVideoPlayback({ uri: "file:///videos/clip.mp4" });
      throw pending;
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <Suspense fallback={null}>
          <Abandoned />
        </Suspense>,
      );
    });
    expect(createVideoPlayer).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("ignores a queued frame callback after the native player was disposed", () => {
    const { player, unmount } = setup();
    const queued = mockFrame.callback;
    unmount();
    act(() => queued?.());
    expect(player.decodeNextFrame).not.toHaveBeenCalled();
    expect(player.dispose).toHaveBeenCalledTimes(1);
  });

  it("reports creation failures through onError without leaking a partial player", () => {
    const error = new Error("decoder unavailable");
    const onError = jest.fn();
    createVideoPlayer.mockImplementationOnce(() => {
      throw error;
    });
    const rendered = renderHook((options: Options) => useVideoPlayback(options), {
      uri: "/missing.mp4",
      onError,
    });
    expect(onError).toHaveBeenCalledWith(error, expect.any(Function));
    expect(rendered.result.current.player).toBeNull();
    rendered.unmount();
  });

  it("opens a new URI after the previous URI failed without requiring retry", () => {
    createVideoPlayer.mockImplementationOnce(() => {
      throw new Error("missing asset");
    });
    createVideoPlayer.mockImplementation(createPlayerMock);
    const rendered = renderHook((options: Options) => useVideoPlayback(options), {
      uri: "/missing.mp4",
    });
    expect(rendered.result.current.player).toBeNull();
    rendered.rerender({ uri: "/videos/valid.mp4" });
    expect(createVideoPlayer).toHaveBeenCalledTimes(2);
    expect(rendered.result.current.player).not.toBeNull();
    rendered.unmount();
  });

  it("opens a new URI after an active decoder reports an error", () => {
    const { player, result, rerender, unmount } = setup();
    const error = player.on.mock.calls.find(
      (call) => call[0] === "error",
    )?.[1] as (error: Error) => void;
    act(() => error(new Error("network lost")));
    expect(result.current.player).toBeNull();
    expect(player.dispose).toHaveBeenCalledTimes(1);
    rerender({ uri: "/videos/local.mp4" });
    expect(result.current.player).not.toBeNull();
    expect(createVideoPlayer).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("invalidates queued frame and error callbacks from a replaced native session", () => {
    const onError = jest.fn();
    const { player, result, rerender, unmount } = setup({ onError });
    const previousTick = mockFrame.callback!;
    const oldError = player.on.mock.calls.find(
      (call) => call[0] === "error",
    )?.[1] as unknown as (error: Error) => void;
    rerender({ uri: "/videos/second.mp4", onError });
    const next = createVideoPlayer.mock.results[1]?.value as ReturnType<
      typeof createPlayerMock
    >;
    act(() => {
      previousTick();
      oldError(new Error("late old error"));
    });
    expect(player.decodeNextFrame).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.player).toBe(next);
    expect(next.dispose).not.toHaveBeenCalled();
    tick();
    expect(next.decodeNextFrame).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("delayed cleanup from an old player does not clear the new session frame", () => {
    const { player, result, rerender, unmount } = setup();
    mockDeferUi = true;
    rerender({ uri: "/videos/second.mp4" });
    const next = createVideoPlayer.mock.results[1]?.value as ReturnType<
      typeof createPlayerMock
    >;
    next.decodeNextFrame.mockReturnValueOnce({
      ...copyOwnedFrame(),
      id: 2,
      producerId: 2,
    });
    tick();
    const current = result.current.currentFrame.value;
    expect(current).not.toBeNull();
    act(() => mockUiTasks.shift()?.());
    expect(player.dispose).toHaveBeenCalledTimes(1);
    expect(next.dispose).not.toHaveBeenCalled();
    expect(result.current.currentFrame.value).toBe(current);
    mockDeferUi = false;
    unmount();
  });

  it("ignores ready and complete events delivered after their source was replaced", () => {
    const onReadyToPlay = jest.fn();
    const onComplete = jest.fn();
    const { player, rerender, unmount } = setup({ onReadyToPlay, onComplete });
    const ready = player.on.mock.calls.find(
      (call) => call[0] === "ready",
    )?.[1] as (...args: unknown[]) => void;
    const complete = player.on.mock.calls.find(
      (call) => call[0] === "complete",
    )?.[1] as () => void;
    mockDeferUi = true;
    rerender({ uri: "/videos/second.mp4", onReadyToPlay, onComplete });
    act(() => {
      ready({ width: 1920, height: 1080 });
      complete();
    });
    expect(onReadyToPlay).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    act(() => {
      for (const task of mockUiTasks.splice(0)) task();
    });
    mockDeferUi = false;
    unmount();
  });

  it("delivers events to updated callbacks without accumulating native subscriptions", () => {
    const old = jest.fn();
    const latest = jest.fn();
    const { player, rerender, unmount } = setup({ onReadyToPlay: old });
    const ready = player.on.mock.calls.find(
      (call) => call[0] === "ready",
    )?.[1] as (...args: unknown[]) => void;
    const subscriptions = player.on.mock.calls.length;
    rerender({ uri: "file:///videos/clip.mp4", onReadyToPlay: latest });
    act(() => ready({ width: 1920, height: 1080 }));
    expect(old).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(player.on.mock.calls.length).toBe(subscriptions);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// useVideoComposition
// ---------------------------------------------------------------------------

describe("useVideoComposition", () => {
  type Options = Parameters<typeof useVideoComposition>[0];

  const setup = (options: Partial<Options> = {}) => {
    const extractor = createExtractorMock();
    createFramesExtractor.mockReturnValue(extractor);
    const drawFrame = jest.fn();
    const rendered = renderHook(
      (props: Options) => useVideoComposition(props),
      { composition, drawFrame, width: 100, height: 50, ...options },
    );
    return { extractor, drawFrame, ...rendered };
  };

  it("prepares the extractor and disposes it on unmount", () => {
    const { extractor, unmount } = setup();
    expect(createFramesExtractor).toHaveBeenCalledWith(composition);
    expect(extractor.prepare).toHaveBeenCalledTimes(1);
    unmount();
    expect(extractor.dispose).toHaveBeenCalledTimes(1);
  });

  it("while paused, draws once then skips until the frames or the time change", () => {
    const { extractor, drawFrame } = setup();

    tick();
    tick();
    tick();
    expect(drawFrame).toHaveBeenCalledTimes(1);
    // The frames are still pulled at every tick: that is how the frame of a
    // seek performed while paused gets noticed.
    expect(extractor.decodeCompositionFrames).toHaveBeenCalledTimes(3);

    extractor.framesVersion = 1;
    tick();
    expect(drawFrame).toHaveBeenCalledTimes(2);
    tick();
    expect(drawFrame).toHaveBeenCalledTimes(2);

    extractor.currentTime = 0.5;
    tick();
    expect(drawFrame).toHaveBeenCalledTimes(3);
  });

  it("redraws at every tick while playing", () => {
    const { extractor, drawFrame } = setup();
    extractor.isPlaying = true;
    tick();
    tick();
    tick();
    expect(drawFrame).toHaveBeenCalledTimes(3);
  });

  it("keeps drawing while paused when drawWhenPaused is set", () => {
    const { drawFrame } = setup({ drawWhenPaused: true });
    tick();
    tick();
    tick();
    expect(drawFrame).toHaveBeenCalledTimes(3);
  });

  describe("redrawOnTime", () => {
    it("while playing, redraws only for new frames when the time alone changes nothing", () => {
      const redrawOnTime = jest.fn(() => false);
      const { extractor, drawFrame } = setup({ redrawOnTime });
      extractor.isPlaying = true;

      tick();
      expect(drawFrame).toHaveBeenCalledTimes(1);
      extractor.currentTime = 0.01;
      tick();
      extractor.currentTime = 0.02;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(1);

      extractor.framesVersion = 1;
      extractor.currentTime = 0.03;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(2);
    });

    it("redraws when it says the time changes the picture", () => {
      // A transition from 1 s on: the picture moves with the time there.
      const redrawOnTime = jest.fn(
        (_previous: number, current: number) => current >= 1,
      );
      const { extractor, drawFrame } = setup({ redrawOnTime });
      extractor.isPlaying = true;

      tick();
      extractor.currentTime = 0.5;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(1);

      extractor.currentTime = 1;
      tick();
      extractor.currentTime = 1.01;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(3);
    });

    it("compares the time with the last drawn one, not the last tick's", () => {
      const redrawOnTime = jest.fn(() => false);
      const { extractor } = setup({ redrawOnTime });
      extractor.isPlaying = true;
      extractor.currentTime = 0.1;
      tick();
      extractor.currentTime = 0.2;
      tick();
      extractor.currentTime = 0.3;
      tick();
      expect(redrawOnTime).toHaveBeenNthCalledWith(1, 0.1, 0.2);
      expect(redrawOnTime).toHaveBeenNthCalledWith(2, 0.1, 0.3);
    });

    it("is not asked about a time that has not changed", () => {
      const redrawOnTime = jest.fn(() => true);
      const { extractor, drawFrame } = setup({ redrawOnTime });
      extractor.isPlaying = true;
      tick();
      tick();
      tick();
      expect(redrawOnTime).not.toHaveBeenCalled();
      expect(drawFrame).toHaveBeenCalledTimes(1);
    });

    it("leaves a player without it drawing at every tick", () => {
      const { extractor, drawFrame } = setup();
      extractor.isPlaying = true;
      extractor.currentTime = 0.01;
      tick();
      extractor.currentTime = 0.02;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(2);
    });

    it("gives way to drawWhenPaused: true", () => {
      const redrawOnTime = jest.fn(() => false);
      const { extractor, drawFrame } = setup({
        redrawOnTime,
        drawWhenPaused: true,
      });
      extractor.isPlaying = true;
      tick();
      tick();
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(3);
    });

    it("redraws for a changed drawWhenPaused input", () => {
      const input = { value: 1 } as { value: number };
      const redrawOnTime = jest.fn(() => false);
      const { extractor, drawFrame } = setup({
        redrawOnTime,
        drawWhenPaused: [input] as never,
      });
      extractor.isPlaying = true;
      tick();
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(1);
      input.value = 2;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(2);
    });

    it("redraws once for a new drawFrame", () => {
      const redrawOnTime = jest.fn(() => false);
      const { extractor, drawFrame, rerender } = setup({ redrawOnTime });
      extractor.isPlaying = true;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(1);

      const nextDrawFrame = jest.fn();
      rerender({
        composition,
        drawFrame: nextDrawFrame,
        width: 100,
        height: 50,
        redrawOnTime,
      });
      extractor.currentTime = 0.01;
      tick();
      expect(nextDrawFrame).toHaveBeenCalledTimes(1);
      extractor.currentTime = 0.02;
      tick();
      expect(nextDrawFrame).toHaveBeenCalledTimes(1);
    });

    it("redraws when the size changes", () => {
      const redrawOnTime = jest.fn(() => false);
      const { extractor, drawFrame, rerender } = setup({ redrawOnTime });
      extractor.isPlaying = true;
      tick();
      rerender({ composition, drawFrame, width: 200, height: 50, redrawOnTime });
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(2);
      expect(surfaceCalls()).toHaveLength(2);
    });

    it("still skips while paused with nothing new", () => {
      const redrawOnTime = jest.fn(() => true);
      const { drawFrame } = setup({ redrawOnTime });
      tick();
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(1);
    });
  });

  describe("splitImportAndDraw", () => {
    it("draws the first frame as soon as it is imported", () => {
      const { extractor, drawFrame } = setup({ splitImportAndDraw: true });
      extractor.framesVersion = 1;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(1);
    });

    it("imports a new frame in one tick and draws it in the next", () => {
      const { extractor, drawFrame } = setup({ splitImportAndDraw: true });
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(1);

      extractor.framesVersion = 1;
      tick();
      expect(extractor.decodeCompositionFrames).toHaveBeenCalledTimes(2);
      expect(drawFrame).toHaveBeenCalledTimes(1);

      tick();
      expect(drawFrame).toHaveBeenCalledTimes(2);
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(2);
    });

    it("never defers twice in a row", () => {
      const { extractor, drawFrame } = setup({ splitImportAndDraw: true });
      tick();
      extractor.framesVersion = 1;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(1);
      // The next frame lands on the tick owed a draw: drawn at once, or the
      // frame before it would never be shown.
      extractor.framesVersion = 2;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(2);
      expect(drawFrame).toHaveBeenLastCalledWith(
        expect.objectContaining({ currentTime: 0 }),
      );
      // Frames arriving at every tick leave no tick free for the draw:
      // deferring the third would let the fourth replace it unseen.
      extractor.framesVersion = 3;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(3);
      extractor.framesVersion = 4;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(4);
    });

    it("splits again once a tick brings no new frame", () => {
      const { extractor, drawFrame } = setup({ splitImportAndDraw: true });
      tick();
      extractor.framesVersion = 1;
      tick();
      extractor.framesVersion = 2;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(2);
      // A tick without a new frame: the next one is deferred again.
      tick();
      extractor.framesVersion = 3;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(2);
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(3);
    });

    it("skips the draw of the importing tick even while playing", () => {
      const { extractor, drawFrame } = setup({ splitImportAndDraw: true });
      extractor.isPlaying = true;
      tick();
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(2);
      extractor.framesVersion = 1;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(2);
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(3);
    });

    it("draws the deferred frame with redrawOnTime saying nothing changed", () => {
      const { extractor, drawFrame } = setup({
        splitImportAndDraw: true,
        redrawOnTime: () => false,
      });
      extractor.isPlaying = true;
      tick();
      extractor.framesVersion = 1;
      extractor.currentTime = 0.04;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(1);
      extractor.currentTime = 0.05;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(2);
      expect(drawFrame).toHaveBeenLastCalledWith(
        expect.objectContaining({ currentTime: 0.05 }),
      );
    });

    it("draws a new frame in the tick that imports it by default", () => {
      const { extractor, drawFrame } = setup();
      tick();
      extractor.framesVersion = 1;
      tick();
      expect(drawFrame).toHaveBeenCalledTimes(2);
    });
  });

  it("prepares a player drawn first without the legacy GL warm-up surface", () => {
    const { extractor } = setup();
    expect(makeOffscreen).not.toHaveBeenCalled();
    expect(mockWarmUpSurface.dispose).not.toHaveBeenCalled();
    expect(extractor.prepare).toHaveBeenCalledTimes(1);
  });

  it("waits for a real size before creating the surface", () => {
    const { drawFrame, rerender } = setup({ width: 0, height: 0 });
    tick();
    expect(surfaceCalls()).toHaveLength(0);
    expect(drawFrame).not.toHaveBeenCalled();

    rerender({ composition, drawFrame, width: 100, height: 50 });
    tick();
    expect(surfaceCalls()).toHaveLength(1);
    expect(drawFrame).toHaveBeenCalledTimes(1);
  });

  it("clears the canvas before each draw, as the export does", () => {
    const { extractor, drawFrame } = setup();
    extractor.isPlaying = true;
    drawFrame.mockImplementation(() => {
      expect(mockCanvas.drawColor).toHaveBeenCalledTimes(
        drawFrame.mock.calls.length,
      );
    });
    tick();
    tick();
    expect(drawFrame).toHaveBeenCalledTimes(2);
    expect(mockCanvas.drawColor).toHaveBeenLastCalledWith("transparent", 0);
  });

  it("hands the decoded frames and the time to drawFrame at the surface size", () => {
    const { extractor, drawFrame } = setup();
    const frames: Record<string, VideoFrame> = {
      clip: {
        texture: {
          kind: "skia-image",
          image: { kind: "owned-composition-image", dispose: jest.fn() },
        },
        width: 1280,
        height: 720,
        rotation: 0,
      },
    };
    extractor.decodeCompositionFrames.mockReturnValue(frames);
    extractor.currentTime = 1.25;

    tick();

    const pixelWidth = Math.floor(100 * PixelRatio.get());
    const pixelHeight = Math.floor(50 * PixelRatio.get());
    expect(makeOffscreen).toHaveBeenCalledWith(pixelWidth, pixelHeight);
    expect(drawFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        frames,
        currentTime: 1.25,
        videoComposition: composition,
        width: pixelWidth,
        height: pixelHeight,
      }),
    );
  });

  it("creates the surface once and recycles the output image", () => {
    const { extractor, result } = setup();
    extractor.isPlaying = true;

    tick();
    const firstImage = result.current.currentFrame.value;
    expect(firstImage).not.toBeNull();

    tick();
    expect(surfaceCalls()).toHaveLength(1);
    expect(mockMakeSnapshot).toHaveBeenCalledTimes(2);
    expect(makeImage).not.toHaveBeenCalled();
    // Skia 3 reuses the snapshot wrapper rather than importing a borrowed GL texture.
    expect(mockMakeSnapshot.mock.calls[1]?.[1]).toBe(firstImage);
    expect(mockSurface.flush).toHaveBeenCalledWith(true);
    expect(result.current.currentFrame.value).toBe(firstImage);
  });

  it("re-keys the surface when the size changes", () => {
    const { extractor, rerender } = setup();
    extractor.isPlaying = true;
    tick();
    expect(surfaceCalls()).toHaveLength(1);

    rerender({
      composition,
      drawFrame: jest.fn(),
      width: 200,
      height: 50,
    });
    tick();
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    expect(surfaceCalls()).toHaveLength(2);
  });

  it("runs beforeDrawFrame and afterDrawFrame around each draw", () => {
    const context = { kind: "context" };
    const beforeDrawFrame = jest.fn(() => context);
    const afterDrawFrame = jest.fn();
    const { drawFrame } = setup({
      beforeDrawFrame,
      afterDrawFrame,
    } as unknown as Partial<Options>);

    tick();

    expect(beforeDrawFrame).toHaveBeenCalledTimes(1);
    expect(drawFrame).toHaveBeenCalledWith(
      expect.objectContaining({ context }),
    );
    expect(afterDrawFrame).toHaveBeenCalledWith(context);
  });

  it("drains partially recorded commands before cleaning the context when drawing throws", () => {
    const context = { kind: "borrowed-texture" };
    const afterDrawFrame = jest.fn(() => {
      expect(mockSurface.flush).toHaveBeenCalledWith(true);
    });
    const onError = jest.fn();
    const { drawFrame, unmount } = setup({
      beforeDrawFrame: () => context,
      afterDrawFrame,
      onError,
    } as unknown as Partial<Options>);
    drawFrame.mockImplementation(() => {
      throw new Error("partial draw");
    });
    tick();
    expect(afterDrawFrame).toHaveBeenCalledWith(context);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(mockSurface.flush.mock.invocationCallOrder[0]).toBeLessThan(
      afterDrawFrame.mock.invocationCallOrder[0]!,
    );
    unmount();
  });

  it("retains frame context, target and reservation after a failed drawing recording cannot drain while closing its extractor", () => {
    const warning = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const primary = new Error("Partial draw failed");
    const context = { dispose: jest.fn() };
    const afterDrawFrame = jest.fn((value: unknown) =>
      (value as typeof context).dispose(),
    );
    const onError = jest.fn();
    const { extractor, drawFrame, result, unmount } = setup({
      beforeDrawFrame: () => context,
      afterDrawFrame,
      onError,
    } as unknown as Partial<Options>);
    drawFrame.mockImplementation(() => {
      throw primary;
    });
    mockSurface.flush.mockImplementation(() => {
      throw new Error("GPU drain failed");
    });
    expect(tick).not.toThrow();
    expect(onError).toHaveBeenCalledWith(primary, expect.any(Function));
    expect(afterDrawFrame).not.toHaveBeenCalled();
    expect(context.dispose).not.toHaveBeenCalled();
    expect(mockCanvas.dispose).not.toHaveBeenCalled();
    expect(mockSurface.dispose).not.toHaveBeenCalled();
    expect(RNSkiaVideoModule.releaseMemory).not.toHaveBeenCalled();
    expect(extractor.dispose).toHaveBeenCalledTimes(1);
    expect(result.current.currentFrame.value).toBeNull();
    const retained = (
      globalThis as {
        __rnskwgpuPreviewQuarantine?: Array<{
          surface: unknown;
          reservation: number;
          afterDraw: unknown;
        }>;
      }
    ).__rnskwgpuPreviewQuarantine!;
    expect(retained).toHaveLength(1);
    expect(retained[0]).toEqual(
      expect.objectContaining({
        surface: mockSurface,
        reservation: 17,
        afterDraw: expect.any(Function),
      }),
    );
    expect(unmount).not.toThrow();
    expect(extractor.dispose).toHaveBeenCalledTimes(1);
    expect(RNSkiaVideoModule.releaseMemory).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it("keeps an unpublished snapshot reachable when its submission drain fails", () => {
    const warning = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const snapshot = { dispose: jest.fn() };
    mockMakeSnapshot.mockReturnValueOnce(snapshot);
    mockSurface.flush.mockImplementation(() => {
      throw new Error("GPU drain failed");
    });
    const { extractor, result, unmount } = setup();
    expect(tick).not.toThrow();
    expect(snapshot.dispose).not.toHaveBeenCalled();
    expect(result.current.currentFrame.value).toBeNull();
    const retained = (
      globalThis as {
        __rnskwgpuPreviewQuarantine?: Array<{ images: unknown[] }>;
      }
    ).__rnskwgpuPreviewQuarantine!;
    expect(retained[0]?.images).toContain(snapshot);
    expect(extractor.dispose).toHaveBeenCalledTimes(1);
    expect(RNSkiaVideoModule.releaseMemory).not.toHaveBeenCalled();
    expect(unmount).not.toThrow();
    warning.mockRestore();
  });

  it("quarantines a displayed preview when unmount cannot drain, without throwing an unhandled UI task error", () => {
    const warning = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { extractor, result, unmount } = setup();
    tick();
    const snapshot = result.current.currentFrame.value!;
    mockSurface.flush.mockImplementation(() => {
      throw new Error("GPU drain failed");
    });
    mockDeferUi = true;
    unmount();
    expect(() => {
      while (mockUiTasks.length) mockUiTasks.shift()!();
    }).not.toThrow();
    expect(snapshot.dispose).not.toHaveBeenCalled();
    expect(mockSurface.dispose).not.toHaveBeenCalled();
    expect(mockCanvas.dispose).not.toHaveBeenCalled();
    expect(extractor.dispose).toHaveBeenCalledTimes(1);
    expect(RNSkiaVideoModule.releaseMemory).not.toHaveBeenCalled();
    expect(result.current.currentFrame.value).toBeNull();
    expect(
      (globalThis as { __rnskwgpuPreviewQuarantine?: unknown[] })
        .__rnskwgpuPreviewQuarantine,
    ).toHaveLength(1);
    warning.mockRestore();
  });

  it("opens a new composition after the previous creation failed", () => {
    createFramesExtractor.mockImplementationOnce(() => {
      throw new Error("missing clip");
    });
    createFramesExtractor.mockImplementation(createExtractorMock);
    const drawFrame = jest.fn();
    const rendered = renderHook(
      (options: Options) => useVideoComposition(options),
      {
        composition,
        drawFrame,
        width: 100,
        height: 50,
      },
    );
    expect(rendered.result.current.player).toBeNull();
    rendered.rerender({
      composition: { ...composition, duration: 3 },
      drawFrame,
      width: 100,
      height: 50,
    });
    expect(rendered.result.current.player).not.toBeNull();
    expect(createFramesExtractor).toHaveBeenCalledTimes(2);
    rendered.unmount();
  });

  it("does not create an extractor for a React render that never commits", () => {
    const pending = new Promise<void>(() => {});
    function Abandoned(): ReactNode {
      useVideoComposition({
        composition,
        drawFrame: jest.fn(),
        width: 100,
        height: 50,
      });
      throw pending;
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <Suspense fallback={null}>
          <Abandoned />
        </Suspense>,
      );
    });
    expect(createFramesExtractor).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("releases its canvas, surface and displayed image on unmount", () => {
    const { result, unmount } = setup();
    tick();
    const image = result.current.currentFrame.value!;
    unmount();
    expect(image.dispose).toHaveBeenCalledTimes(1);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    expect(mockSurface.flush).toHaveBeenCalledWith(true);
    expect(result.current.currentFrame.value).toBeNull();
  });

  it("invalidates ticks and errors from a replaced composition extractor", () => {
    const onError = jest.fn();
    const { extractor, result, drawFrame, rerender, unmount } = setup({
      onError,
    });
    const oldTick = mockFrame.callback!;
    const oldError = extractor.on.mock.calls.find(
      (call) => call[0] === "error",
    )?.[1] as (error: Error) => void;
    const next = createExtractorMock();
    createFramesExtractor.mockReturnValueOnce(next);
    const secondComposition = { ...composition, duration: 3 };
    rerender({
      composition: secondComposition,
      drawFrame,
      width: 100,
      height: 50,
      onError,
    });
    act(() => {
      oldTick();
      oldError(new Error("stale decoder error"));
    });
    expect(extractor.decodeCompositionFrames).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.player).toBe(next);
    expect(next.dispose).not.toHaveBeenCalled();
    tick();
    expect(next.decodeCompositionFrames).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("hands out the native player, playbackRate included, where it plays at a signed rate", () => {
    const { extractor, result, rerender, drawFrame, unmount } = setup();
    const player = result.current.player!;
    expect(player).toBe(extractor);
    player.playbackRate = -2;
    expect(extractor.playbackRate).toBe(-2);
    rerender({ composition, drawFrame, width: 100, height: 50 });
    expect(result.current.player).toBe(player);
    unmount();
  });

  it("refuses a signed rate on a binary without it, and passes the rest through", () => {
    getBackendInfo.mockReturnValueOnce({ playbackRate: true });
    const { extractor, result, rerender, drawFrame, unmount } = setup();
    const player = result.current.player!;
    expect(player).not.toBe(extractor);
    expect(player.playbackRate).toBe(1);
    expect(() => {
      player.playbackRate = 1;
    }).not.toThrow();
    expect(() => {
      player.playbackRate = -1;
    }).toThrow("signedPlaybackRate");
    // Nothing reached the native player, which would have played at 1×.
    expect(extractor.playbackRate).toBe(1);
    player.play();
    player.seekTo(1);
    expect(extractor.play).toHaveBeenCalledTimes(1);
    expect(extractor.seekTo).toHaveBeenCalledWith(1);
    extractor.currentTime = 1.25;
    expect(player.currentTime).toBe(1.25);
    // The same object for the session's life: effects keyed on it run once.
    rerender({ composition, drawFrame, width: 100, height: 50 });
    expect(result.current.player).toBe(player);
    unmount();
  });

  it("goes idle without a complete event once playing backward stops at 0", () => {
    const onComplete = jest.fn();
    const { extractor, drawFrame, unmount } = setup({ onComplete });
    extractor.playbackRate = -1;
    extractor.isPlaying = true;
    extractor.currentTime = 0.1;
    tick();
    extractor.currentTime = 0.05;
    tick();
    expect(drawFrame).toHaveBeenCalledTimes(2);
    // The native clock reached the start: paused there, its first frame held.
    extractor.isPlaying = false;
    extractor.currentTime = 0;
    extractor.framesVersion = 1;
    tick();
    tick();
    tick();
    expect(drawFrame).toHaveBeenCalledTimes(3);
    expect(drawFrame.mock.calls[2]![0].currentTime).toBe(0);
    expect(onComplete).not.toHaveBeenCalled();
    unmount();
  });

  it("delayed old extractor cleanup preserves the newly displayed generation", () => {
    const { extractor, result, drawFrame, rerender, unmount } = setup();
    tick();
    mockDeferUi = true;
    const next = createExtractorMock();
    createFramesExtractor.mockReturnValueOnce(next);
    rerender({
      composition: { ...composition, duration: 3 },
      drawFrame,
      width: 100,
      height: 50,
    });
    tick();
    const current = result.current.currentFrame.value!;
    act(() => mockUiTasks.shift()?.());
    expect(extractor.dispose).toHaveBeenCalledTimes(1);
    expect(next.dispose).not.toHaveBeenCalled();
    expect(current.dispose).not.toHaveBeenCalled();
    expect(result.current.currentFrame.value).toBe(current);
    // Deliver the new extractor preparation, then clean up the new session.
    act(() => {
      for (const task of mockUiTasks.splice(0)) task();
    });
    mockDeferUi = false;
    unmount();
  });

  it("does not prepare again when onError changes and delivers errors to the latest callback", () => {
    const oldHandler = jest.fn();
    const latestHandler = jest.fn();
    const { extractor, drawFrame, rerender, unmount } = setup({
      onError: oldHandler,
    });
    const handler = extractor.on.mock.calls.find(
      (call) => call[0] === "error",
    )?.[1] as (error: Error) => void;
    rerender({
      composition,
      drawFrame,
      width: 100,
      height: 50,
      onError: latestHandler,
    });
    expect(extractor.prepare).toHaveBeenCalledTimes(1);
    const failure = new Error("decoder failed");
    act(() => handler(failure));
    expect(oldHandler).not.toHaveBeenCalled();
    expect(latestHandler).toHaveBeenCalledWith(failure, expect.any(Function));
    unmount();
  });

  it("disposes a partially allocated preview surface and budget when getCanvas throws", () => {
    const onError = jest.fn();
    const failure = new Error("preview canvas failed");
    const { drawFrame, result, unmount } = setup({ onError });
    mockSurface.getCanvas.mockImplementationOnce(() => {
      throw failure;
    });
    tick();
    expect(drawFrame).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(failure, expect.any(Function));
    expect(result.current.player).toBeNull();
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    expect(RNSkiaVideoModule.releaseMemory).toHaveBeenCalledWith(17);
    unmount();
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps a partially allocated preview surface and its budget when setup and surface cleanup both fail", () => {
    const warning = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const failure = new Error("Preview canvas failed");
    const onError = jest.fn();
    const { extractor, unmount } = setup({ onError });
    mockSurface.getCanvas.mockImplementationOnce(() => {
      throw failure;
    });
    mockSurface.dispose.mockImplementation(() => {
      throw new Error("Surface close failed");
    });
    expect(tick).not.toThrow();
    expect(onError).toHaveBeenCalledWith(failure, expect.any(Function));
    expect(extractor.dispose).toHaveBeenCalledTimes(1);
    expect(RNSkiaVideoModule.releaseMemory).not.toHaveBeenCalled();
    const retained = (
      globalThis as {
        __rnskwgpuPreviewQuarantine?: Array<{
          surface: unknown;
          reservation: number;
        }>;
      }
    ).__rnskwgpuPreviewQuarantine!;
    expect(retained[0]).toEqual(
      expect.objectContaining({ surface: mockSurface, reservation: 17 }),
    );
    expect(unmount).not.toThrow();
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// GPU device loss: React Native Skia replaces a lost device with a new one.
// ---------------------------------------------------------------------------

describe("after a GPU device loss", () => {
  afterEach(() => {
    mockGpuState.generation = 1;
    mockGpuState.lost = false;
  });

  it("waits while the device is lost, then remakes a paused composition preview on the replacement without draining the lost one", () => {
    mockSerializedRuntime = createSerializedUiRuntime();
    const extractor = mockSerializedRuntime.host(createExtractorMock());
    extractor.decodeCompositionFrames.mockReturnValue({
      clip: copyOwnedFrame(),
    });
    extractor.currentTime = 1.5;
    createFramesExtractor.mockReturnValue(extractor);
    const drawn = mockSerializedRuntime.host(jest.fn());
    const drawFrame = () => {
      "worklet";
      drawn();
    };
    const onError = jest.fn();
    const rendered = renderHook(
      () =>
        useVideoComposition({
          composition,
          width: 320,
          height: 180,
          drawFrame,
          onError,
        }),
      undefined,
    );
    tick();
    expect(drawn).toHaveBeenCalledTimes(1);
    const lostImage = rendered.result.current.currentFrame.value as unknown as {
      dispose: jest.Mock;
    };

    // Lost and not replaced yet: nothing is decoded nor drawn.
    mockGpuState.lost = true;
    const decodes = extractor.decodeCompositionFrames.mock.calls.length;
    tick();
    tick();
    expect(drawn).toHaveBeenCalledTimes(1);
    expect(extractor.decodeCompositionFrames).toHaveBeenCalledTimes(decodes);
    expect(mockSurface.dispose).not.toHaveBeenCalled();

    mockGpuState.lost = false;
    mockGpuState.generation = 2;
    const flushes = mockSurface.flush.mock.calls.length;
    tick();
    expect(onError).not.toHaveBeenCalled();
    // The lost surface and image go without a drain; the new ones are drawn.
    expect(lostImage.dispose).toHaveBeenCalledTimes(1);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    expect(surfaceCalls()).toHaveLength(2);
    expect(drawn).toHaveBeenCalledTimes(2);
    expect(mockSurface.flush.mock.calls.length).toBe(flushes + 1);
    expect(rendered.result.current.currentFrame.value).not.toBe(lostImage);
    // Paused: its picture is decoded again, from the RN runtime.
    expect(extractor.seekTo).toHaveBeenCalledWith(1.5);
    // Then the paused preview skips again until something changes.
    tick();
    expect(drawn).toHaveBeenCalledTimes(2);
    rendered.unmount();
    expect(extractor.dispose).toHaveBeenCalledTimes(1);
  });

  it("lets a playing composition draw the frames it decodes next, without seeking", () => {
    const extractor = createExtractorMock();
    extractor.isPlaying = true;
    createFramesExtractor.mockReturnValue(extractor);
    const drawFrame = jest.fn();
    renderHook(
      () =>
        useVideoComposition({ composition, drawFrame, width: 10, height: 10 }),
      undefined,
    );
    tick();
    mockGpuState.generation = 2;
    tick();
    expect(drawFrame).toHaveBeenCalledTimes(2);
    expect(extractor.seekTo).not.toHaveBeenCalled();
  });

  it("does not report a frame that failed because the device was lost meanwhile, and draws again once it was replaced", () => {
    const extractor = createExtractorMock();
    createFramesExtractor.mockReturnValue(extractor);
    const onError = jest.fn();
    const drawFrame = jest.fn();
    renderHook(
      () =>
        useVideoComposition({
          composition,
          drawFrame,
          width: 10,
          height: 10,
          onError,
        }),
      undefined,
    );
    mockSurface.flush.mockImplementationOnce(() => {
      mockGpuState.lost = true;
      throw new Error(
        "The GPU device was lost; a checked recording did not complete",
      );
    });
    tick();
    expect(onError).not.toHaveBeenCalled();
    tick();
    expect(drawFrame).toHaveBeenCalledTimes(1);
    mockGpuState.lost = false;
    mockGpuState.generation = 2;
    tick();
    expect(onError).not.toHaveBeenCalled();
    expect(drawFrame).toHaveBeenCalledTimes(2);
    // A failure on a live device is still the app's to handle.
    const failure = new Error("drawer failed");
    drawFrame.mockImplementationOnce(() => {
      throw failure;
    });
    extractor.framesVersion++;
    tick();
    expect(onError).toHaveBeenCalledWith(failure, expect.any(Function));
  });

  it("releases a preview quarantined on the lost device once it was replaced", () => {
    const extractor = createExtractorMock();
    createFramesExtractor.mockReturnValue(extractor);
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rendered = renderHook(
        () =>
          useVideoComposition({
            composition,
            drawFrame: jest.fn(),
            width: 10,
            height: 10,
          }),
        undefined,
      );
      tick();
      mockSurface.flush.mockImplementationOnce(() => {
        throw new Error("GPU fence unavailable");
      });
      rendered.unmount();
      const quarantine = (
        globalThis as { __rnskwgpuPreviewQuarantine?: unknown[] }
      ).__rnskwgpuPreviewQuarantine!;
      expect(quarantine).toHaveLength(1);
      expect(mockSurface.dispose).not.toHaveBeenCalled();
      // Another preview's next frame, on the replacement device.
      createFramesExtractor.mockReturnValue(createExtractorMock());
      renderHook(
        () =>
          useVideoComposition({
            composition,
            drawFrame: jest.fn(),
            width: 10,
            height: 10,
          }),
        undefined,
      );
      tick();
      mockGpuState.generation = 2;
      tick();
      expect(quarantine).toHaveLength(0);
      expect(mockSurface.dispose).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("releases a preview unmounted after the replacement without draining the lost device", () => {
    createFramesExtractor.mockReturnValue(createExtractorMock());
    const rendered = renderHook(
      () =>
        useVideoComposition({
          composition,
          drawFrame: jest.fn(),
          width: 10,
          height: 10,
        }),
      undefined,
    );
    tick();
    const flushes = mockSurface.flush.mock.calls.length;
    // A checked drain on the lost device's surface would throw.
    mockSurface.flush.mockImplementation(() => {
      throw new Error(
        "The GPU device was lost; a checked recording cannot run",
      );
    });
    mockGpuState.generation = 2;
    rendered.unmount();
    expect(mockSurface.flush.mock.calls.length).toBe(flushes);
    expect(mockSurface.dispose).toHaveBeenCalledTimes(1);
    expect(RNSkiaVideoModule.releaseMemory).toHaveBeenCalledTimes(1);
    expect(
      (globalThis as { __rnskwgpuPreviewQuarantine?: unknown[] })
        .__rnskwgpuPreviewQuarantine,
    ).toBeUndefined();
  });

  it("drops a single player's lost frame and decodes a paused one again", () => {
    createVideoPlayer.mockImplementation(createPlayerMock);
    const onError = jest.fn();
    const rendered = renderHook(
      () => useVideoPlayback({ uri: "file:///videos/clip.mp4", onError }),
      undefined,
    );
    const player = createVideoPlayer.mock.results[0]!.value as ReturnType<
      typeof createPlayerMock
    >;
    player.currentTime = 4;
    player.decodeNextFrame.mockReturnValueOnce(copyOwnedFrame());
    tick();
    expect(rendered.result.current.currentFrame.value).not.toBeNull();
    mockGpuState.lost = true;
    tick();
    expect(player.decodeNextFrame).toHaveBeenCalledTimes(1);
    mockGpuState.lost = false;
    mockGpuState.generation = 2;
    tick();
    expect(rendered.result.current.currentFrame.value).toBeNull();
    expect(player.seekTo).toHaveBeenCalledWith(4);
    const next = copyOwnedFrame();
    player.decodeNextFrame.mockReturnValueOnce(next);
    tick();
    expect(rendered.result.current.currentFrame.value).toMatchObject({
      texture: next.texture,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps a paused player's recovery seek out of onSeekComplete, and reports the app's own seeks", () => {
    createVideoPlayer.mockImplementation(createPlayerMock);
    const onSeekComplete = jest.fn();
    renderHook(
      () =>
        useVideoPlayback({ uri: "file:///videos/clip.mp4", onSeekComplete }),
      undefined,
    );
    const player = createVideoPlayer.mock.results[0]!.value as ReturnType<
      typeof createPlayerMock
    >;
    const seekComplete = player.on.mock.calls.find(
      (call) => call[0] === "seekComplete",
    )?.[1] as () => void;
    player.currentTime = 4;
    player.decodeNextFrame.mockReturnValueOnce(copyOwnedFrame());
    tick();
    mockGpuState.generation = 2;
    tick();
    expect(player.seekTo).toHaveBeenCalledWith(4);
    act(() => seekComplete());
    expect(onSeekComplete).not.toHaveBeenCalled();
    act(() => seekComplete());
    expect(onSeekComplete).toHaveBeenCalledTimes(1);
  });
});
