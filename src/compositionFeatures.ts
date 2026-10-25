import RNSkiaVideoModule from "./RNSkiaVideoModule";
import type { VideoComposition, VideoCompositionFeatures } from "./types";

/**
 * What the installed native code implements. JS can reach an app ahead of its
 * native build (Metro, an over-the-air update); check this before relying on
 * a feature an older binary would silently ignore.
 */
export const getVideoCompositionFeatures = (): VideoCompositionFeatures => {
  const backend = RNSkiaVideoModule.getBackendInfo?.();
  return {
    playbackRate: backend?.playbackRate === true,
    syncBackwardSeek: backend?.syncBackwardSeek === true,
    signedPlaybackRate: backend?.signedPlaybackRate === true,
  };
};

/**
 * The player of a binary without `signedPlaybackRate`: its native code ignores
 * the rate and would play forward at 1×, so a rate other than 1 is refused
 * rather than dropped. A JS object over the native one, which it keeps as its
 * prototype: every other member is the native one's, on any runtime (worklets
 * serialize it as they do a TurboModule). The check is the RN runtime's; a
 * copy captured by a worklet reads 1 and keeps what it is given.
 */
export const legacyPlaybackRatePlayer = <T extends object>(
  native: T,
): T & { playbackRate: number } =>
  Object.create(native, {
    playbackRate: {
      enumerable: true,
      get: () => 1,
      set: (rate: unknown) => {
        if (rate !== 1)
          throw new Error(
            "playbackRate needs a native build of react-native-skia-webgpu-video with signedPlaybackRate; rebuild the app",
          );
      },
    },
  });

/**
 * Refuses a composition the native code would play differently than asked:
 * an item at another rate than 1 on a binary without `playbackRate`, which
 * would play it at 1× and run past its range. The rate itself is checked
 * natively, with the other item fields.
 */
export const checkVideoCompositionFeatures = (
  composition: VideoComposition,
) => {
  const retimed = composition.items.some(
    (item) =>
      item.kind !== "audio" &&
      item.playbackRate !== undefined &&
      item.playbackRate !== 1,
  );
  if (retimed && !getVideoCompositionFeatures().playbackRate) {
    throw new Error(
      "playbackRate needs a native build of react-native-skia-webgpu-video that supports it; rebuild the app",
    );
  }
};
