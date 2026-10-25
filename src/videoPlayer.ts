import {
  useSharedValue,
  useFrameCallback,
  type SharedValue,
} from "react-native-reanimated";
import { useCallback, useEffect, useRef, useState } from "react";
import useEventListener from "./utils/useEventListener";
import type {
  BufferingRange,
  VideoDimensions,
  VideoFrame,
  VideoPlayer,
  VideoTextureMode,
} from "./types";
import RNSkiaVideoModule from "./RNSkiaVideoModule";
import { imageFromVideoFrame, releaseVideoFrameImage } from "./frameInterop";
import {
  getVideoGpuState,
  isVideoGpuDeviceGone,
  type VideoGpuState,
} from "./gpuDevice";
import { runOnUI } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import {
  disposePreviewResources,
  reclaimPreviewQuarantine,
} from "./previewLifecycle";

type UseVideoPlayerOptions = {
  /**
   * The URI of the video to play.
   * if null, the video player won't be created.
   */
  uri: string | null;
  /**
   * If provided, the resolution to scale the video to.
   * If not provided, the original resolution of the video will be used.
   * Downscaling the video can improve performance.
   * Changing the resolution after the video player will lead to re-creating the video player.
   */
  resolution?: { width: number; height: number } | null;
  /**
   * How the decoded frames reach Skia on iOS, see `VideoTextureMode`.
   * Changing it re-creates the video player. Ignored on Android.
   * @default 'copy'
   */
  textureMode?: VideoTextureMode;
  /**
   * Whether the video should start playing automatically.
   */
  autoPlay?: boolean;
  /**
   * Weather the video should loop.
   */
  isLooping?: boolean;
  /**
   * The volume of the video.
   */
  volume?: number;
  /**
   * The playback speed of the video.
   * The value should be greater than 0. 1.0 is normal speed, 2.0 is double speed, 0.5 is half speed.
   */
  playbackSpeed?: number;
  /**
   * Callback that is called when the video is ready to play.
   * @param dimensions The dimensions of the video.
   */
  onReadyToPlay?: (dimensions: VideoDimensions) => void;
  /**
   * Callback that is called when the video starts buffering.
   */
  onBufferingStart?: () => void;
  /**
   * Callback that is called when the video stops buffering.
   */
  onBufferingEnd?: () => void;
  /**
   * Callback that is called when the buffered ranges are updated.
   * @param loadedRanges The buffered ranges.
   */
  onBufferingUpdate?: (loadedRanges: BufferingRange[]) => void;
  /**
   * Callback that is called when the video playback completes.
   */
  onComplete?: () => void;
  /**
   * Callback that is called when an error occurs.
   * @param error the error that occurred.
   * @param retry a function that can be called to retry the operation.
   */
  onError?: (error: any, retry: () => void) => void;
  /**
   * Callback that is called when the playing status changes.
   * @param playing Whether the video is playing.
   */
  onPlayingStatusChange?: (playing: boolean) => void;
  /**
   * Callback that is called when a seek operation completes.
   * @returns
   */
  onSeekComplete?: () => void;
};

type VideoPlayerController = Pick<
  VideoPlayer,
  "currentTime" | "duration" | "play" | "pause" | "seekTo" | "isPlaying"
>;

type UseVideoPlayerReturnType = {
  /**
   * The current frame of the playing video.
   */
  currentFrame: SharedValue<VideoFrame | null>;
  /**
   * The video player controller.
   */
  player: VideoPlayerController | null;
};

/**
 * Hook that creates a video player and manages its state.
 * @param options The options for the video player.
 * @returns
 */
export const useVideoPlayback = ({
  uri,
  resolution,
  textureMode,
  autoPlay = false,
  isLooping = false,
  volume = 1,
  playbackSpeed = 1,
  onReadyToPlay,
  onBufferingStart,
  onBufferingEnd,
  onBufferingUpdate,
  onComplete,
  onError,
  onPlayingStatusChange,
  onSeekComplete,
}: UseVideoPlayerOptions): UseVideoPlayerReturnType => {
  const sourceKey = JSON.stringify([
    uri,
    resolution?.width,
    resolution?.height,
    textureMode,
  ]);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const isErrored = failedSource === sourceKey;
  const [session, setSession] = useState<{
    player: VideoPlayer;
    generation: number;
    sourceKey: string;
  } | null>(null);
  const player = session?.player ?? null;
  const generation = session?.generation ?? 0;
  const nextGeneration = useRef(0);
  const activeOnRN = useRef(0);
  const currentFrame = useSharedValue<null | VideoFrame>(null);
  const activeGeneration = useSharedValue(0);
  const frameGeneration = useSharedValue(0);
  // The GPU device generation of the current frame (see getVideoGpuState).
  const gpuGeneration = useSharedValue(0);
  const onCreationError = useRef(onError);
  onCreationError.current = onError;
  useEffect(() => {
    if (!uri || isErrored) {
      setSession(null);
      return;
    }
    let created: VideoPlayer;
    try {
      created = RNSkiaVideoModule.createVideoPlayer(
        uri,
        resolution,
        textureMode ? { textureMode } : undefined,
      );
    } catch (error) {
      setFailedSource(sourceKey);
      onCreationError.current?.(error, () => setFailedSource(null));
      return;
    }
    const createdGeneration = ++nextGeneration.current;
    activeOnRN.current = createdGeneration;
    activeGeneration.value = createdGeneration;
    setSession({ player: created, generation: createdGeneration, sourceKey });
    return () => {
      if (activeOnRN.current === createdGeneration) {
        activeOnRN.current = 0;
        activeGeneration.value = 0;
      }
      runOnUI(() => {
        "worklet";
        const frames = [];
        if (frameGeneration.value === createdGeneration) {
          const frame = currentFrame.value;
          currentFrame.value = null;
          frameGeneration.value = 0;
          if (frame) frames.push(frame);
        }
        const failure = disposePreviewResources({
          frames,
          native: created,
          generation: gpuGeneration.value || undefined,
        });
        if (failure.failed)
          console.warn(
            "Video preview cleanup failed; resources remain accounted until native runtime teardown",
            failure.error,
          );
      })();
    };
    // Resolution object identity does not recreate an unchanged decoder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isErrored,
    sourceKey,
    resolution?.width,
    resolution?.height,
    uri,
    textureMode,
    currentFrame,
    activeGeneration,
    frameGeneration,
    gpuGeneration,
  ]);

  const retry = useCallback(() => {
    setFailedSource(null);
  }, []);

  const errorHandler = useCallback(
    (error: any) => {
      if (generation !== activeOnRN.current) return;
      activeOnRN.current = 0;
      activeGeneration.value = 0;
      setFailedSource(session!.sourceKey);
      onCreationError.current?.(error, retry);
    },
    [retry, generation, activeGeneration, session],
  );

  useEffect(() => {
    if (player) {
      player.isLooping = isLooping;
    }
  }, [player, isLooping]);

  useEffect(() => {
    if (player) {
      player.volume = volume;
    }
  }, [player, volume]);

  useEffect(() => {
    if (player) {
      player.playbackSpeed = playbackSpeed;
    }
  }, [player, playbackSpeed]);

  const isCurrentSession = useCallback(
    () => generation !== 0 && generation === activeOnRN.current,
    [generation],
  );
  // The frame on screen went with a lost GPU device. A playing player shows
  // the next one it decodes; a paused one decodes nothing new by itself, so
  // it seeks where it is. That seek is the hook's own: its completion is not
  // reported to onSeekComplete.
  const recoverySeeks = useRef(0);
  const redecodeAfterDeviceLoss = useCallback(() => {
    if (!player || !isCurrentSession()) return;
    if (player.isPlaying) return;
    recoverySeeks.current += 1;
    player.seekTo(player.currentTime);
  }, [player, isCurrentSession]);
  const seekCompleted = useCallback(() => {
    if (recoverySeeks.current > 0) {
      recoverySeeks.current -= 1;
      return;
    }
    onSeekComplete?.();
  }, [onSeekComplete]);
  useEventListener(player, "ready", onReadyToPlay, isCurrentSession);
  useEventListener(
    player,
    "bufferingStart",
    onBufferingStart,
    isCurrentSession,
  );
  useEventListener(player, "bufferingEnd", onBufferingEnd, isCurrentSession);
  useEventListener(
    player,
    "bufferingUpdate",
    onBufferingUpdate,
    isCurrentSession,
  );
  useEventListener(player, "complete", onComplete, isCurrentSession);
  useEventListener(player, "error", errorHandler, isCurrentSession);
  useEventListener(
    player,
    "playingStatusChange",
    onPlayingStatusChange,
    isCurrentSession,
  );
  useEventListener(
    player,
    "seekComplete",
    onSeekComplete ? seekCompleted : undefined,
    isCurrentSession,
  );

  useEffect(() => {
    if (autoPlay) {
      player?.play();
    }
  }, [player, autoPlay]);

  useFrameCallback(() => {
    if (!player || activeGeneration.value !== generation) {
      return;
    }
    // Polled while paused too: decodeNextFrame returns null at almost no cost
    // when nothing new was decoded, and the frame produced by a seek performed
    // while paused only shows up if it gets picked up here.
    let gpu: VideoGpuState | null = null;
    try {
      gpu = getVideoGpuState();
      // Nothing renders on a lost device: wait for its replacement.
      if (gpu.lost) return;
      if (gpuGeneration.value !== gpu.generation) {
        const replaced = gpuGeneration.value !== 0;
        gpuGeneration.value = gpu.generation;
        reclaimPreviewQuarantine();
        if (replaced && frameGeneration.value === generation) {
          // Its image was made on the replaced device and went with the
          // frame import cache (see frameInterop).
          currentFrame.value = null;
          frameGeneration.value = 0;
          scheduleOnRN(redecodeAfterDeviceLoss);
        }
      }
      const nextFrame = player.decodeNextFrame();
      if (nextFrame) {
        const image = imageFromVideoFrame(nextFrame);
        if (image) {
          const previous = currentFrame.value;
          if (previous && previous.producerId !== nextFrame.producerId)
            releaseVideoFrameImage(previous);
          frameGeneration.value = generation;
          currentFrame.value = {
            width: nextFrame.width,
            height: nextFrame.height,
            rotation: nextFrame.rotation,
            crop: nextFrame.crop,
            id: nextFrame.id,
            producerId: nextFrame.producerId,
            texture: { kind: "skia-image", image },
          };
        }
      }
    } catch (error) {
      // The GPU device was lost during this frame: the next frames wait for
      // its replacement, then show again.
      if (gpu && isVideoGpuDeviceGone(gpu)) return;
      activeGeneration.value = 0;
      scheduleOnRN(errorHandler, error);
    }
  }, true);

  return {
    currentFrame,
    player,
  };
};
