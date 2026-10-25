import RNSkiaVideoModule from "../RNSkiaVideoModule";
import {
  checkVideoCompositionFeatures,
  getVideoCompositionFeatures,
} from "../compositionFeatures";
import type {
  VideoComposition,
  VideoCompositionAudioItem,
  VideoCompositionVideoItem,
} from "../types";

jest.mock("../RNSkiaVideoModule", () => ({
  __esModule: true,
  default: { getBackendInfo: jest.fn() },
}));
const getBackendInfo = RNSkiaVideoModule.getBackendInfo as jest.Mock;

const clip = (playbackRate?: number): VideoCompositionVideoItem => ({
  id: "clip",
  path: "/videos/clip.mp4",
  compositionStartTime: 0,
  startTime: 1,
  duration: 2,
  ...(playbackRate === undefined ? {} : { playbackRate }),
});
const compositionOf = (
  ...items: VideoComposition["items"]
): VideoComposition => ({ duration: 2, items });
// An older binary: the same backend info, without the two flags.
const oldBinary = { platform: "ios", gpuDirectExport: true };
const newBinary = { ...oldBinary, playbackRate: true, syncBackwardSeek: true };

beforeEach(() => getBackendInfo.mockReset());

describe("getVideoCompositionFeatures", () => {
  it("reads both features from the native backend info", () => {
    getBackendInfo.mockReturnValue(newBinary);
    expect(getVideoCompositionFeatures()).toEqual({
      playbackRate: true,
      syncBackwardSeek: true,
    });
  });

  it("says neither on a binary built before them", () => {
    getBackendInfo.mockReturnValue(oldBinary);
    expect(getVideoCompositionFeatures()).toEqual({
      playbackRate: false,
      syncBackwardSeek: false,
    });
  });

  it("says neither without backend info, and only takes true for true", () => {
    getBackendInfo.mockReturnValue(undefined);
    expect(getVideoCompositionFeatures().playbackRate).toBe(false);
    getBackendInfo.mockReturnValue({
      playbackRate: "yes",
      syncBackwardSeek: 1,
    });
    expect(getVideoCompositionFeatures()).toEqual({
      playbackRate: false,
      syncBackwardSeek: false,
    });
  });
});

describe("checkVideoCompositionFeatures", () => {
  it("accepts any rate when the native code reads it", () => {
    getBackendInfo.mockReturnValue(newBinary);
    for (const rate of [0.25, 0.5, 2, 4])
      expect(() =>
        checkVideoCompositionFeatures(compositionOf(clip(rate))),
      ).not.toThrow();
  });

  it("refuses a rate an older binary would play at 1×", () => {
    getBackendInfo.mockReturnValue(oldBinary);
    expect(() =>
      checkVideoCompositionFeatures(compositionOf(clip(), clip(2))),
    ).toThrow("playbackRate needs a native build");
  });

  it("leaves 1× compositions alone, without asking the native code", () => {
    getBackendInfo.mockReturnValue(oldBinary);
    checkVideoCompositionFeatures(compositionOf(clip(), clip(1)));
    expect(getBackendInfo).not.toHaveBeenCalled();
  });

  it("leaves the value itself to the native checks", () => {
    // NaN, 0 and negative rates are refused with the other item fields.
    getBackendInfo.mockReturnValue(newBinary);
    for (const rate of [Number.NaN, 0, -1])
      expect(() =>
        checkVideoCompositionFeatures(compositionOf(clip(rate))),
      ).not.toThrow();
  });
});

describe("VideoCompositionVideoItem.playbackRate", () => {
  it("is a number on video items only", () => {
    const item: VideoCompositionVideoItem = { ...clip(), playbackRate: 2 };
    const music: VideoCompositionAudioItem = {
      kind: "audio",
      id: "music",
      path: "/audio/music.m4a",
      compositionStartTime: 0,
      startTime: 0,
      duration: 2,
      // @ts-expect-error audio items are played at 1×
      playbackRate: 2,
    };
    // @ts-expect-error a rate is a number
    const named: VideoCompositionVideoItem = { ...clip(), playbackRate: "2x" };
    expect([item.playbackRate, music.kind, named.id]).toEqual([
      2,
      "audio",
      "clip",
    ]);
  });
});
