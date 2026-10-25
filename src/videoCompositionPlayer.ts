import { getVideoCanvas } from "./canvas";
import type { SkCanvas, SkImage, SkSurface } from "react-native-skia";
import { BlendMode, Skia } from "react-native-skia";
import {
  useSharedValue,
  useFrameCallback,
  runOnUI,
  type DerivedValue,
  type SharedValue,
} from "react-native-reanimated";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FrameDrawer,
  VideoFrame,
  VideoComposition,
  VideoCompositionFramesExtractor,
} from "./types";
import RNSkiaVideoModule from "./RNSkiaVideoModule";
import useEventListener from "./utils/useEventListener";
import { PixelRatio } from "react-native";
import { scheduleOnRN } from "react-native-worklets";
import { ownVideoFrames, releaseVideoFrameImage } from "./frameInterop";
import {
  getVideoGpuState,
  isVideoGpuDeviceGone,
  type VideoGpuState,
} from "./gpuDevice";
import { frameByteSize, reserveVideoMemory } from "./memory";
import {
  disposePreviewResources,
  reclaimPreviewQuarantine,
} from "./previewLifecycle";

type UseVideoCompositionPlayerOptions<T = undefined> = {
  /**
   * The video composition to play.
   * if null, the composition player won't be created.
   */
  composition: VideoComposition | null;
  /**
   * The function used to draw the composition frames.
   */
  drawFrame: FrameDrawer<T>;
  /**
   * A function that is called before drawing each frame.
   * the return value will be passed to the drawFrame function as context.
   */
  beforeDrawFrame?: () => T;
  /**
   * A function that is called after drawing each frame.
   * the context returned by the beforeDrawFrame function will be passed to this function.
   * This function can be used to clean up resources allocated during the drawFrame function.
   */
  afterDrawFrame?: (context: T) => void;
  /**
   * The width of rendered frames.
   */
  width: number;
  /**
   * The height of rendered frames.
   */
  height: number;
  /**
   * Whether the composition should start playing automatically.
   */
  autoPlay?: boolean;
  /**
   * Weather the composition should loop.
   */
  isLooping?: boolean;
  /**
   * Whether to keep calling `drawFrame` at every vsync while playback is
   * paused. By default a paused player only redraws when the composition time
   * or the decoded frames change (a seek, the frame that follows it), which
   * saves GPU time and battery. Enable it if `drawFrame` depends on values
   * that change while paused, an overlay being dragged for instance.
   *
   * Or the shared values `drawFrame` reads: a paused player then redraws only
   * when one of them is replaced, besides the time, the frames, the size or
   * `drawFrame` itself. An idle editor stops redrawing at every vsync.
   * @default false
   */
  drawWhenPaused?: boolean | SharedValue<unknown>[];
  /**
   * Whether `drawFrame` can draw something different at `currentTime` than it
   * drew at `previousTime` from the same decoded frames. By default every time
   * change redraws, so a playing player draws at every vsync even though the
   * video only changes at its own frame rate. A drawer whose picture depends on
   * time only through the frames (or only at known moments, a transition say)
   * returns false elsewhere, and the player then redraws when a new frame is
   * decoded instead. Ignored when `drawWhenPaused` is `true`, which redraws at
   * every vsync. Must be a worklet.
   */
  redrawOnTime?: (previousTime: number, currentTime: number) => boolean;
  /**
   * Import a newly decoded frame in one vsync and draw it in the next, instead
   * of both in the same one. On Android the import (YUV blit and its checked
   * GPU wait) and the draw (snapshot and its checked GPU wait) cost about as
   * much as each other, and together they overrun a 90–120 Hz frame budget on
   * the UI thread. The option applies on iOS too. The picture then trails the
   * clock by one vsync. The first frame of a session is still drawn as soon
   * as it is imported.
   * @default false
   */
  splitImportAndDraw?: boolean;
  /**
   * Callback that is called when the composition is ready to play.
   */
  onReadyToPlay?: () => void;
  /**
   * Callback that is called when the composition playback completes.
   */
  onComplete?: () => void;
  /**
   * Callback that is called when an error occurs.
   * @param error the error that occurred.
   * @param retry a function that can be called to retry the operation.
   */
  onError?: (error: any, retry: () => void) => void;
};

type VideoCompositionPlayerController = Pick<
  VideoCompositionFramesExtractor,
  "currentTime" | "play" | "pause" | "seekTo" | "isPlaying"
>;

type UseVideoCompositionPlayerReturnType = {
  /**
   * The current drawn frame of the video composition.
   */
  currentFrame: DerivedValue<SkImage | null>;
  /**
   * The video player controller.
   */
  player: VideoCompositionPlayerController | null;
};

/**
 * A hook that creates a video composition player.
 */
export const useVideoComposition = <T = undefined>({
  composition,
  drawFrame,
  beforeDrawFrame,
  afterDrawFrame,
  width,
  height,
  autoPlay = false,
  isLooping = false,
  drawWhenPaused = false,
  redrawOnTime,
  splitImportAndDraw = false,
  onReadyToPlay,
  onComplete,
  onError,
}: UseVideoCompositionPlayerOptions<T>): UseVideoCompositionPlayerReturnType => {
  const [failedComposition, setFailedComposition] =
    useState<VideoComposition | null>(null);
  const isErrored = composition !== null && failedComposition === composition;
  const [session, setSession] = useState<{
    extractor: VideoCompositionFramesExtractor;
    generation: number;
    composition: VideoComposition;
  } | null>(null);
  const framesExtractor = session?.extractor ?? null;
  const generation = session?.generation ?? 0;
  const nextGeneration = useRef(0);
  const activeOnRN = useRef(0);
  // HostObject JS wrappers are recreated across runtimes; compare numbers.
  const activeGeneration = useSharedValue(0);
  const frameGeneration = useSharedValue(0);
  const sourcesGeneration = useSharedValue(0);
  const currentFrame = useSharedValue<SkImage | null>(null);
  const pendingSnapshot = useSharedValue<SkImage | null>(null);
  // Reanimated interprets a function assigned to `.value` as an animation
  // factory. Keep the teardown callback inside an ordinary value instead.
  const pendingAfterDraw = useSharedValue<{ run: () => void } | null>(null);
  const previousSources = useSharedValue<Record<string, VideoFrame>>({});
  // The GPU device generation of the surface and frames (see getVideoGpuState).
  const gpuGeneration = useSharedValue(0);
  const onCreationError = useRef(onError);
  onCreationError.current = onError;
  useEffect(() => {
    if (!composition || isErrored) {
      setSession(null);
      return;
    }
    let created: VideoCompositionFramesExtractor;
    try {
      created =
        RNSkiaVideoModule.createVideoCompositionFramesExtractor(composition);
    } catch (error) {
      setFailedComposition(composition);
      onCreationError.current?.(error, () => setFailedComposition(null));
      return;
    }
    const createdGeneration = ++nextGeneration.current;
    activeOnRN.current = createdGeneration;
    activeGeneration.value = createdGeneration;
    setSession({
      extractor: created,
      generation: createdGeneration,
      composition,
    });
    return () => {
      if (activeOnRN.current === createdGeneration) {
        activeOnRN.current = 0;
        activeGeneration.value = 0;
      }
      runOnUI(() => {
        "worklet";
        if (
          frameGeneration.value === createdGeneration ||
          sourcesGeneration.value === createdGeneration
        )
          releasePreview(created);
        else {
          const failure = disposePreviewResources({ native: created });
          if (failure.failed)
            console.warn(
              "Video preview cleanup failed; resources remain accounted until native runtime teardown",
              failure.error,
            );
        }
      })();
    };
  }, [
    composition,
    isErrored,
    activeGeneration,
    currentFrame,
    previousSources,
    frameGeneration,
    sourcesGeneration,
    pendingSnapshot,
    pendingAfterDraw,
    gpuGeneration,
  ]);

  const retry = useCallback(() => {
    setFailedComposition(null);
  }, []);

  const errorHandler = useCallback(
    (error: any) => {
      if (generation !== activeOnRN.current) return;
      activeOnRN.current = 0;
      activeGeneration.value = 0;
      setFailedComposition(session!.composition);
      onCreationError.current?.(error, retry);
    },
    [retry, generation, activeGeneration, session],
  );

  useEffect(() => {
    if (framesExtractor) {
      framesExtractor.isLooping = isLooping;
    }
  }, [framesExtractor, isLooping]);

  const isCurrentSession = useCallback(
    () => generation !== 0 && generation === activeOnRN.current,
    [generation],
  );
  // The frames on screen went with a lost GPU device. A playing player draws
  // the next ones it decodes; a paused one decodes nothing new by itself.
  const redecodeAfterDeviceLoss = useCallback(() => {
    if (!framesExtractor || !isCurrentSession()) return;
    if (!framesExtractor.isPlaying)
      framesExtractor.seekTo(framesExtractor.currentTime);
  }, [framesExtractor, isCurrentSession]);
  useEventListener(framesExtractor, "ready", onReadyToPlay, isCurrentSession);
  useEventListener(framesExtractor, "complete", onComplete, isCurrentSession);
  useEventListener(framesExtractor, "error", errorHandler, isCurrentSession);
  useEffect(() => {
    if (!framesExtractor) return;
    runOnUI(() => {
      "worklet";
      if (activeGeneration.value !== generation) return;
      try {
        framesExtractor.prepare();
      } catch (error) {
        activeGeneration.value = 0;
        scheduleOnRN(errorHandler, error);
      }
    })();
  }, [framesExtractor, activeGeneration, generation, errorHandler]);

  useEffect(() => {
    if (autoPlay) {
      framesExtractor?.play();
    }
  }, [framesExtractor, autoPlay]);

  const surfaceSharedValue = useSharedValue<SkSurface | null>(null);
  const canvasSharedValue = useSharedValue<SkCanvas | null>(null);
  const surfaceReservation = useSharedValue(0);
  const surfaceWidth = useSharedValue(0);
  const surfaceHeight = useSharedValue(0);
  const releasePreview = (native?: { dispose: () => void }) => {
    "worklet";
    const resources = {
      surface: surfaceSharedValue.value,
      canvas: canvasSharedValue.value,
      images: [currentFrame.value, pendingSnapshot.value],
      frames: Object.values(previousSources.value),
      reservation: surfaceReservation.value,
      afterDraw: pendingAfterDraw.value?.run,
      native,
      generation: gpuGeneration.value || undefined,
    };
    // Remove consumers before attempting a drain. A thrown drain must never
    // leave teardown callbacks able to recycle these same resources later.
    currentFrame.value = null;
    pendingSnapshot.value = null;
    pendingAfterDraw.value = null;
    frameGeneration.value = 0;
    previousSources.value = {};
    sourcesGeneration.value = 0;
    surfaceSharedValue.value = null;
    canvasSharedValue.value = null;
    surfaceReservation.value = 0;
    surfaceWidth.value = 0;
    surfaceHeight.value = 0;
    const failure = disposePreviewResources(resources);
    if (failure.failed)
      console.warn(
        "Video preview cleanup failed; resources remain accounted until native runtime teardown",
        failure.error,
      );
  };
  // Frames version and composition time of the last drawn image, to skip
  // redrawing an unchanged picture while paused.
  const lastDrawnFramesVersion = useSharedValue(-1);
  const lastDrawnTime = useSharedValue(-1);
  const lastDrawnInputs = useSharedValue<unknown[] | null>(null);
  // Frames version whose new frames the previous vsyncs already imported.
  const lastImportedVersion = useSharedValue(-1);
  // Whether the previous vsync imported and left its draw to this one.
  const drawDeferred = useSharedValue(false);
  // Whether the previous vsync brought new frames.
  const importedLastVsync = useSharedValue(false);
  // A new drawFrame can draw something else from the same time and frames.
  useEffect(() => {
    lastDrawnTime.value = -1;
  }, [drawFrame, lastDrawnTime]);
  const pixelRatio = PixelRatio.get();

  // Release the offscreen surface with the hook that made it. Without this a
  // caller that mounts and unmounts the player repeatedly — a player inside a
  // modal, say — leaks a full size texture per cycle. runOnUI because this
  // effect is declared before the frame callback below, and so its cleanup runs
  // before the callback is unregistered.
  useEffect(
    () => () => {
      runOnUI(() => {
        "worklet";
        releasePreview();
      })();
    },
    [
      surfaceSharedValue,
      canvasSharedValue,
      surfaceReservation,
      surfaceWidth,
      surfaceHeight,
      currentFrame,
      pendingSnapshot,
      pendingAfterDraw,
      frameGeneration,
      previousSources,
      sourcesGeneration,
      gpuGeneration,
    ],
  );

  /** React Native Skia replaced its lost GPU device: the surface, images and
   * imported frames of the preview were made on that device, which runs
   * nothing, so they go without a drain; the frame callback makes them again.
   * Whether this session had drawn anything. */
  const retireLostDevicePreview = (lostGeneration: number) => {
    "worklet";
    const drawn = frameGeneration.value === generation;
    const retired = {
      images: [currentFrame.value, pendingSnapshot.value],
      surface: surfaceSharedValue.value,
      canvas: canvasSharedValue.value,
      reservation: surfaceReservation.value,
      afterDraw: pendingAfterDraw.value?.run,
      generation: lostGeneration,
    };
    currentFrame.value = null;
    pendingSnapshot.value = null;
    pendingAfterDraw.value = null;
    frameGeneration.value = 0;
    // Their images went with the frame import cache (see frameInterop).
    previousSources.value = {};
    sourcesGeneration.value = 0;
    canvasSharedValue.value = null;
    surfaceSharedValue.value = null;
    surfaceReservation.value = 0;
    surfaceWidth.value = 0;
    surfaceHeight.value = 0;
    lastDrawnFramesVersion.value = -1;
    lastImportedVersion.value = -1;
    drawDeferred.value = false;
    importedLastVsync.value = false;
    const failure = disposePreviewResources(retired);
    if (failure.failed)
      console.warn(
        "Video preview cleanup failed after a GPU device replacement; resources remain accounted until native runtime teardown",
        failure.error,
      );
    reclaimPreviewQuarantine();
    return drawn;
  };

  useFrameCallback(() => {
    "worklet";
    if (!framesExtractor || activeGeneration.value !== generation) {
      return;
    }
    let gpu: VideoGpuState | null = null;
    try {
      gpu = getVideoGpuState();
      // Nothing renders on a lost device: the preview keeps its last image
      // and decodes nothing until React Native Skia has replaced it.
      if (gpu.lost) return;
      const previousGpu = gpuGeneration.value;
      if (previousGpu !== gpu.generation) {
        gpuGeneration.value = gpu.generation;
        if (previousGpu !== 0 && retireLostDevicePreview(previousGpu))
          scheduleOnRN(redecodeAfterDeviceLoss);
      }
      const pixelWidth = Math.floor(width * pixelRatio);
      const pixelHeight = Math.floor(height * pixelRatio);

      // Layout can report zero or NaN before the player is measured. Avoid
      // native surface allocation until the dimensions are valid.
      if (
        !(pixelWidth > 0) ||
        !(pixelHeight > 0) ||
        !isFinite(pixelWidth) ||
        !isFinite(pixelHeight)
      ) {
        return;
      }

      // Pull the frames decoded since the last vsync first: it is cheap when
      // nothing new arrived, and it is what lets a paused player pick up the
      // frame of a seek.
      const frames = ownVideoFrames(framesExtractor.decodeCompositionFrames());
      for (const [key, previous] of Object.entries(previousSources.value)) {
        if (!frames[key] || frames[key]!.producerId !== previous.producerId)
          releaseVideoFrameImage(previous);
      }
      previousSources.value = frames;
      sourcesGeneration.value = generation;
      const currentTime = framesExtractor.currentTime;
      const framesVersion = framesExtractor.framesVersion;
      const imported =
        splitImportAndDraw && framesVersion !== lastImportedVersion.value;
      const importedBefore = importedLastVsync.value;
      // Version 0: no frame decoded yet.
      importedLastVsync.value = imported && framesVersion > 0;
      if (imported) {
        // ownVideoFrames above has just imported the new frames: leave the
        // draw to the next vsync, which finds them in the import cache. Not
        // when the previous vsync brought new frames too: frames arriving at
        // every vsync (60 fps, or a display gone down to 30 Hz) leave no vsync
        // free for the draw, and the next frame would replace this one before
        // it is shown. Never twice running either, for the same reason.
        lastImportedVersion.value = framesVersion;
        if (
          !drawDeferred.value &&
          !importedBefore &&
          currentFrame.value !== null &&
          frameGeneration.value === generation
        ) {
          drawDeferred.value = true;
          return;
        }
      }
      drawDeferred.value = false;
      const inputs = Array.isArray(drawWhenPaused) ? drawWhenPaused : null;
      let inputsSame = true;
      if (inputs) {
        const last = lastDrawnInputs.value;
        if (!last || last.length !== inputs.length) inputsSame = false;
        else {
          for (let i = 0; i < inputs.length; i++) {
            if (inputs[i]!.value !== last[i]) {
              inputsSame = false;
              break;
            }
          }
        }
      }
      // A negative last time means a redraw was requested (a new drawFrame).
      const timeSame =
        currentTime === lastDrawnTime.value ||
        (redrawOnTime !== undefined &&
          lastDrawnTime.value >= 0 &&
          !redrawOnTime(lastDrawnTime.value, currentTime));
      if (
        drawWhenPaused !== true &&
        inputsSame &&
        (!framesExtractor.isPlaying || redrawOnTime !== undefined) &&
        currentFrame.value !== null &&
        frameGeneration.value === generation &&
        framesVersion === lastDrawnFramesVersion.value &&
        timeSame &&
        surfaceWidth.value === pixelWidth &&
        surfaceHeight.value === pixelHeight
      ) {
        // Nothing new to show: the image on screen is still exact, and
        // redrawing it at every vsync would only burn GPU time and battery.
        return;
      }

      let surface: SkSurface | null = surfaceSharedValue.value;

      if (
        !surface ||
        surfaceWidth.value !== pixelWidth ||
        surfaceHeight.value !== pixelHeight
      ) {
        // width and height can change while the player stays mounted — laying the
        // stage out for a different aspect ratio calls the hook with new
        // dimensions and the same surface. Drawing the new size into the old
        // texture and then declaring the result to be the new size stretches the
        // picture by the ratio between them, so the surface is re-keyed on its
        // dimensions the way exportVideoComposition already re-keys its own.
        const retired = {
          images: [currentFrame.value, pendingSnapshot.value],
          surface,
          canvas: canvasSharedValue.value,
          reservation: surfaceReservation.value,
          afterDraw: pendingAfterDraw.value?.run,
          generation: gpu.generation,
        };
        currentFrame.value = null;
        pendingSnapshot.value = null;
        pendingAfterDraw.value = null;
        canvasSharedValue.value = null;
        surfaceSharedValue.value = null;
        surfaceReservation.value = 0;
        const retiredFailure = disposePreviewResources(retired);
        if (retiredFailure.failed) throw retiredFailure.error;
        // Surface + immutable snapshot/COW backing while replacing the preview.
        const reservation = reserveVideoMemory(
          frameByteSize(pixelWidth, pixelHeight) * 2,
          "composition preview",
        );
        surfaceReservation.value = reservation;
        try {
          surface = Skia.Surface.MakeOffscreen(pixelWidth, pixelHeight);
          surfaceSharedValue.value = surface;
          if (!surface) throw new Error("Cannot allocate preview surface");
          canvasSharedValue.value = getVideoCanvas(surface);
          surfaceWidth.value = pixelWidth;
          surfaceHeight.value = pixelHeight;
        } catch (error) {
          // The ordinary session cleanup owns partial allocation state too.
          // Preserve the setup error and keep its reservation reachable.
          throw error;
        }
      }
      if (!surface) {
        console.warn("Failed to create surface");
        return;
      }

      const canvas = canvasSharedValue.value!;
      // Cleared as the export clears it: a drawFrame that leaves part of the
      // canvas alone showed the previous frames there, and not in the export.
      canvas.drawColor(Skia.Color("#00000000"), BlendMode.Clear);
      const context = beforeDrawFrame?.() as T;
      const drawn = {
        submitted: false,
        failed: false,
        error: undefined as unknown,
      };
      const releaseContext = () => {
        "worklet";
        afterDrawFrame?.(context);
      };
      pendingAfterDraw.value = { run: releaseContext };
      try {
        drawFrame({
          canvas,
          context,
          videoComposition: composition!,
          currentTime,
          frames,
          width: pixelWidth,
          height: pixelHeight,
        });
        const previous = currentFrame.value;
        const next = surface.makeImageSnapshot(
          undefined,
          previous ?? undefined,
        );
        if (next !== previous) pendingSnapshot.value = next;
        surface.flush(true);
        drawn.submitted = true;
        frameGeneration.value = generation;
        if (next === previous) currentFrame.modify(undefined, true);
        else {
          currentFrame.value = next;
          previous?.dispose();
        }
        pendingSnapshot.value = null;
      } catch (error) {
        drawn.failed = true;
        drawn.error = error;
      } finally {
        // A drawer can throw after recording commands that sample resources
        // from context. Submit and wait before the caller releases them.
        if (!drawn.submitted) {
          try {
            surface.flush(true);
            drawn.submitted = true;
          } catch (error) {
            if (!drawn.failed) drawn.error = error;
            drawn.failed = true;
          }
        }
        if (drawn.submitted) {
          pendingAfterDraw.value = null;
          try {
            releaseContext();
          } catch (error) {
            if (!drawn.failed) drawn.error = error;
            drawn.failed = true;
          }
        }
      }
      if (drawn.failed) throw drawn.error;
      lastDrawnFramesVersion.value = framesVersion;
      lastDrawnTime.value = currentTime;
      if (inputs) lastDrawnInputs.value = inputs.map((input) => input.value);
    } catch (error) {
      // The GPU device was lost during this frame: the next frames wait for
      // its replacement, then draw again.
      if (gpu && isVideoGpuDeviceGone(gpu)) return;
      activeGeneration.value = 0;
      scheduleOnRN(errorHandler, error);
    }
  }, true);

  return {
    currentFrame,
    player: framesExtractor,
  };
};
