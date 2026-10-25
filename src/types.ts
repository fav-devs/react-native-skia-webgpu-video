import type { SkCanvas } from "react-native-skia";

/** A transient frame. Use makeVideoFrameImage/drawVideoFrame to obtain owned
 * Skia pixels; raw Metal/GL handles are no longer supported by Graphite. */
export type VideoFrame = {
  texture: unknown;
  width: number;
  height: number;
  rotation: number;
  crop?: { x: number; y: number; width: number; height: number };
  /** Stable identity of the native frame, including after its buffer is released. */
  id?: number;
  /** Stable identity of the producer, used to bound imported image caches. */
  producerId?: number;
  /** Release a native source after copying/rendering and waiting for GPU completion. */
  dispose?: () => void;
};

/**
 * Represents the dimensions of a video.
 */
export type VideoDimensions = {
  /**
   * The width in pixels of the video.
   */
  width: number;
  /**
   * The height in pixels of the video.
   */
  height: number;
  /**
   * The rotation in degrees of the video.
   */
  rotation: number;
};

/**
 * Represents a range of buffered data.
 */
export type BufferingRange = { start: number; duration: number };

/** Compatibility preference retained from Skia Video. This reference
 * Graphite backend uses bounded, owned snapshots for both values. Native
 * buffers first pass through a reusable WebGPU upload texture. Neither
 * value exposes the legacy Metal/OpenGL texture lifetime contract. */
export type VideoTextureMode = "copy" | "direct";

/** Compatibility preference; both values use the same transport. iOS draws
 * into the encoder's pool buffers on the GPU, falling back to CPU readback
 * when IOSurface interop is unavailable. Android reads pixels back. */
export type VideoEncoderMode = "copy" | "direct";

/**
 * The video player interface.
 */
export type VideoPlayer = {
  /**
   * Resumes playback of the video.
   */
  play(): void;
  /**
   * Pauses playback.
   */
  pause(): void;
  /**
   * Seeks to a position specified in seconds.
   * Once the seek is complete, the `seekComplete` event will be emitted.
   *
   * @param time The position in seconds to seek to.
   */
  seekTo(time: number): void;
  /**
   * Decodes the next frame of the video.
   * This method should only be called from the ui thread.
   *
   * @returns The next frame of the video.
   */
  decodeNextFrame(): VideoFrame | null;
  /**
   * The current time in seconds of the playback.
   */
  readonly currentTime: number;
  /**
   * The duration in seconds of the video.
   */
  readonly duration: number;
  /**
   * Indicates whether the video is currently playing.
   */
  readonly isPlaying: boolean;
  /**
   * Indicates whether the video is set to loop.
   */
  isLooping: boolean;
  /**
   * The volume of the video.
   * The value should be between 0 and 1.
   */
  volume: number;
  /**
   * The playback speed of the video.
   * The value should be greater than 0. 1.0 is normal speed, 2.0 is double speed, 0.5 is half speed.
   */
  playbackSpeed: number;
  /**
   * Disposes of the video player.
   */
  dispose(): void;
  /**
   * Events dispatched by the video player once the video is ready to play.
   */
  on(
    name: "ready",
    listener: (dimensions: VideoDimensions) => void,
  ): () => void;
  /**
   * Events dispatched by the video player when the video starts buffering.
   */
  on(name: "bufferingStart", listener: () => void): () => void;
  /**
   * Events dispatched by the video player when the video stops buffering.
   */
  on(name: "bufferingEnd", listener: () => void): () => void;
  /**
   * Events dispatched by the video player when the buffered ranges are updated.
   */
  on(
    name: "bufferingUpdate",
    listener: (loadedRanges: BufferingRange[]) => void,
  ): () => void;
  /**
   * Events dispatched by the video player when the video playback completes.
   */
  on(name: "complete", listener: () => void): () => void;
  /**
   * Events dispatched by the video player when a seek operation completes.
   */
  on(name: "seekComplete", listener: () => void): () => void;
  /**
   * Events dispatched by the video player when the playing status changes.
   */
  on(
    name: "playingStatusChange",
    listener: (isPlaying: boolean) => void,
  ): () => void;
  /**
   * Events dispatched by the video player when an error occurs.
   */
  on(name: "error", listener: (error: any) => void): () => void;
};

/**
 * The pixel format decoded frames are handed over in, before they are drawn.
 *
 * - `yuv`: the decoder's own YUV 4:2:0 buffers, converted to RGB on the GPU
 *   when a frame is drawn. A frame takes 1.5 bytes a pixel rather than 4
 *   (12.4 MB rather than 33.2 MB in 4K), so the decoder holds more frames
 *   ahead for the same memory. On Android only 8-bit SDR tracks decoded at
 *   their own size; other tracks stay `rgba`.
 * - `rgba`: frames converted to RGB as they are decoded (iOS: by VideoToolbox,
 *   Android: by an OpenGL pass), which a GPU export samples in place.
 * - `auto`: `yuv`, on both platforms.
 *
 * Camera footage (Rec.709, or HLG tone mapped to Rec.709) renders the same
 * either way: both convert with the frame's YCbCr matrix and range. On iOS,
 * `rgba` also converts a file tagged with other primaries or another SDR
 * transfer function (Display P3, sRGB) to Rec.709; `yuv` takes its samples as
 * Rec.709, as Android does in both formats.
 */
export type VideoFramePixelFormat = "auto" | "yuv" | "rgba";

/**
 * Represents a video composition.
 */
export type VideoComposition = {
  /**
   * The items that make up the composition.
   */
  items: VideoCompositionItem[];
  /**
   * The duration in seconds of the composition.
   */
  duration: number;
  /**
   * Open each video item's decoder shortly before the item starts and close it
   * shortly after it ends, instead of all of them at prepare. For compositions
   * that play their items one after another: decoders and their frames are
   * held for a few items at a time rather than for all of them.
   *
   * An item reached by a seek, rather than by playing up to it, shows no frame
   * until its decoder has opened. The export always waits for it.
   */
  lazyDecoders?: boolean;
  /**
   * The pixel format the video items' frames are decoded into, for the
   * preview and the export, see {@link VideoFramePixelFormat}.
   *
   * @default 'auto'
   */
  framePixelFormat?: VideoFramePixelFormat;
};

type VideoCompositionItemBase = {
  /**
   * The unique identifier of the item.
   */
  id: string;
  /**
   * The path to the media file.
   * only support local file path
   */
  path: string;
  /**
   * The start time in seconds of the item within the composition.
   */
  compositionStartTime: number;
  /**
   * The start time in seconds of the item within the media.
   */
  startTime: number;
  /**
   * The duration in seconds of the item within the composition.
   */
  duration: number;
};

/**
 * A video item of a composition. Produces frames passed to the `drawFrame`
 * function. Video items are silent by default; set `audio` to also play
 * the audio track of the video file.
 */
export type VideoCompositionVideoItem = VideoCompositionItemBase & {
  kind?: "video";
  /**
   * If provided, the resolution to scale the video to.
   * If not provided, the original resolution of the video will be used.
   * Downscaling the video can improve performance.
   *
   * Given in the file's *encoded* orientation, which for a portrait clip is
   * the transpose of what it displays as — prefer `maxLongSide` unless an
   * exact pixel size is needed.
   */
  resolution?: { width: number; height: number };
  /**
   * If provided, the longest side the frames are decoded at, keeping the
   * file's own aspect. Ignored when `resolution` is set, and never upscales.
   *
   * The cap reduces decoder output/staging pixels. Android's hardware
   * decoder can still allocate buffers at the encoded resolution; measure
   * process/GPU memory separately from the library's explicit budget.
   */
  maxLongSide?: number;
  /**
   * How this item's frames reach Skia, see {@link VideoTextureMode}.
   *
   * @default 'copy'
   */
  textureMode?: VideoTextureMode;
  /**
   * If set, the audio track of the video file will be played (during
   * playback) and mixed into the exported video (during export), following
   * the same time mapping as the video frames.
   * Defaults to false (video items are silent).
   */
  audio?: boolean | { volume?: number };
  /**
   * Seconds of the file played per second of the composition, a finite
   * number above 0: 2 plays the clip twice as fast, 0.5 at half speed.
   * `duration` stays the item's length in the composition, so the item reads
   * `[startTime, startTime + duration * playbackRate]` of its file.
   *
   * Every frame of that range is decoded: at 2× the decoder does twice the
   * work of 1×. Only for silent items; an item with `audio` and a rate other
   * than 1 is refused. Native code built before this option ignores it, see
   * {@link getVideoCompositionFeatures}.
   *
   * @default 1
   */
  playbackRate?: number;
};

/**
 * An audio item of a composition. Does not produce frames; its audio track
 * is played during playback and mixed into the exported video during export.
 * The source file can be an audio file or a video file (in which case its
 * audio track is used).
 */
export type VideoCompositionAudioItem = VideoCompositionItemBase & {
  kind: "audio";
  /**
   * The volume of the item, between 0 and 1.
   * Defaults to 1.
   */
  volume?: number;
};

export type VideoCompositionItem =
  VideoCompositionVideoItem | VideoCompositionAudioItem;

/**
 * Function that draws a video composition frame to a canvas.
 */
export type FrameDrawer<T = undefined> = (args: {
  /**
   * The context created by the `before` function in video composition player.
   * or in export video composition.
   */
  context: T;
  /**
   * The canvas to draw the frame to.
   */
  canvas: SkCanvas;
  /**
   * The current composition
   */
  videoComposition: VideoComposition;
  /**
   * The current time in seconds of the drawn frame.
   */
  currentTime: number;
  /**
   * The decoded video frames of the composition items.
   * Only video items produce frames; audio items never appear in this map.
   */
  frames: Record<string, VideoFrame>;
  /**
   * The expected width of the frame in pixels.
   */
  width: number;
  /**
   * The expected height of the frame in pixels.
   */
  height: number;
}) => void;

/**
 * The video composition frames extractor interface.
 */
export type VideoCompositionFramesExtractor = {
  /**
   * Prepares the video composition frames extractor for extracting the frames.
   */
  prepare(): void;
  /**
   * Starts extracting the frames of the video composition.
   */
  play(): void;
  /**
   * Pauses the extraction of the frames.
   */
  pause(): void;
  /**
   * Seeks to a position specified in seconds.
   * @param time The position in seconds to seek to.
   */
  seekTo(time: number): void;
  /**
   * Decodes the frames of the video composition items.
   * This method should only be called from the ui thread.
   *
   * @returns The decoded video frames of the composition items.
   */
  decodeCompositionFrames(): Record<string, VideoFrame>;
  /**
   * Disposes of the video composition frames extractor.
   */
  dispose(): void;
  /**
   * The current time in seconds.
   */
  readonly currentTime: number;
  /**
   * A counter incremented every time `decodeCompositionFrames` returned a new
   * frame for at least one item. Two equal values mean the frames did not
   * change in between.
   */
  readonly framesVersion: number;
  /**
   * Whether the video composition frames extractor is currently playing.
   */
  readonly isPlaying: boolean;
  /**
   * Whether the video composition frames extractor is set to loop.
   */
  isLooping: boolean;
  /**
   * Events dispatched by the video composition frames extractor when the extraction is ready.
   */
  on(name: "ready", listener: () => void): () => void;
  /**
   * Events dispatched by the video composition frames extractor process completes.
   */
  on(name: "complete", listener: () => void): () => void;
  /**
   * Events dispatched by the video composition frames extractor when an error occurs.
   */
  on(name: "error", listener: (error: any) => void): () => void;
};

/**
 * The video composition sync extractor interface.
 */
export type VideoCompositionFramesExtractorSync = {
  /**
   * Starts extracting the frames of the video composition.
   */
  start(): void;
  /**
   * Decodes the frames until reaching the specified time.
   * This method will block the current thread until the frames are decoded.
   *
   * A time earlier than the previous call's is served too: the items whose
   * position went back decode again from the key frame before it, which
   * costs a new reader on iOS and a codec flush on Android. Native code built
   * before this ignores it and returns the previous frames, see
   * {@link getVideoCompositionFeatures}.
   *
   * The returned frames are only valid until the next call: draw them and
   * flush the GPU synchronously (`surface.flush(true)`) before decoding
   * further frames.
   *
   * @returns The decoded video frames of the composition items.
   */
  decodeCompositionFrames(currentTime: number): Record<string, VideoFrame>;
  /**
   * Disposes of the video composition frames extractor.
   */
  dispose(): void;
};

/**
 * The video composition encoder interface.
 */
export type VideoEncoder = {
  /**
   * Prepares the video composition encoder for writing.
   */
  prepare(): void;
  /**
   * Encodes the video frame to the video composition.
   */
  encodeFrame(texture: unknown, time: number): void;
  /**
   * iOS: lends the next pool buffer (a CVPixelBuffer) to draw into on the
   * GPU. Pass it back as a native-buffer frame, or release it. One at a time.
   */
  acquireFrameBuffer?(): bigint;
  /** iOS: returns a lent buffer that will not be encoded. */
  releaseFrameBuffer?(): void;
  /**
   * Android: the codec's input Surface, as an ANativeWindow pointer for a
   * WebGPU canvas context to present to. Each frame is then encoded as
   * `{ kind: "window", present }`: the encoder sets the frame's time on the
   * window and calls `present`, which presents the context.
   */
  acquireInputWindow?(): bigint;
  /*
   * Finish writing the video to the output file.
   */
  finishWriting(): void;
  /**
   * Disposes of the video composition encoder.
   */
  dispose(): void;
};

/**
 * The video codec used to encode an export.
 *
 * `h264` is supported by every device this library runs on, and is what
 * playback and upload pipelines are universally built around. `hevc` produces
 * roughly the same quality at about half the bitrate, but is not available
 * everywhere — see {@link RNSkiaVideoModule.isEncodingSupported}.
 */
export type VideoCodec = "h264" | "hevc";

/**
 * The export options for a video composition.
 */
export type ExportOptions = {
  /**
   * The path to save the exported video.
   */
  outPath: string;
  /**
   * The width of the exported video in pixels.
   */
  width: number;
  /**
   * The height of the exported video in pixels.
   */
  height: number;
  /**
   * The frame rate of the exported video in frames per second.
   */
  frameRate: number;
  /**
   * The bit rate of the exported video in bits per second.
   */
  bitRate: number;
  /**
   * The video codec to encode with.
   *
   * Falls back to `h264` when the requested codec has no encoder on the
   * device, so passing `hevc` can never fail an export that `h264` would have
   * completed. Call {@link RNSkiaVideoModule.isEncodingSupported} first if the
   * choice is surfaced to a user, so the option can be hidden rather than
   * silently ignored.
   *
   * @default 'h264'
   */
  codec?: VideoCodec;
  /**
   * The encoder name to use for the export.
   *
   * Takes precedence over {@link codec}: naming an encoder selects it
   * directly, whatever codec it implements.
   *
   * @platform android
   */
  encoderName?: string | null;
  /**
   * How rendered frames reach the encoder, see {@link VideoEncoderMode}.
   *
   * @default 'copy'
   * @platform ios
   */
  encoderMode?: VideoEncoderMode;
  /**
   * The bit rate of the exported audio track in bits per second.
   * Only used if the composition contains audio.
   * @default 128000
   */
  audioBitRate?: number;
  /**
   * The sample rate of the exported audio track in Hz.
   * Only used if the composition contains audio.
   * @default 44100
   */
  audioSampleRate?: number;
  /**
   * The number of channels of the exported audio track (1 = mono, 2 = stereo).
   * Only used if the composition contains audio.
   * @default 2
   */
  audioChannelCount?: number;
};

/**
 * What the native code says about itself, see `getVideoResourceStats().backend`.
 */
export type VideoBackendInfo = Record<string, string | number | boolean> & {
  /** Set when the native code reads `playbackRate`, see {@link VideoCompositionFeatures}. */
  playbackRate?: boolean;
  /** Set when the sync extractor serves earlier times, see {@link VideoCompositionFeatures}. */
  syncBackwardSeek?: boolean;
};

/**
 * Features of the installed native code that JS shipped on its own (through
 * Metro, an update) cannot assume: an app binary built before them ignores
 * them silently.
 */
export type VideoCompositionFeatures = {
  /** Video items honour {@link VideoCompositionVideoItem.playbackRate}. */
  playbackRate: boolean;
  /**
   * {@link VideoCompositionFramesExtractorSync.decodeCompositionFrames}
   * returns the frames at a time earlier than the previous call's.
   */
  syncBackwardSeek: boolean;
};

export type RNSkiaVideoModule = {
  frameProtocolVersion?: number;
  /** Internal Android capability negotiation, before creating a decoder. */
  configureNativeBufferInterop?: (enabled: boolean) => void;
  reserveMemory?: (bytes: number, label: string) => number;
  releaseMemory?: (reservation: number) => void;
  configureMemoryBudget?: (maxBytes: number) => void;
  getMemoryBudgetStats?: () => {
    currentBytes: number;
    peakBytes: number;
    allocations: number;
    maxBytes: number;
  };
  getResourceStats?: () => Record<string, number>;
  getBackendInfo?: () => VideoBackendInfo;

  /**
   * Creates a video player for the specified video file.
   *
   * @param uri The path to the video file.
   * @param resolution If provided, the resolution to scale the video to.
   * If not provided, the original resolution of the video will be used.
   * Downscaling the video can improve performance.
   * @returns The video player.
   */
  createVideoPlayer: (
    uri: string,
    resolution?: { width: number; height: number } | null,
    options?: { textureMode?: VideoTextureMode } | null,
  ) => VideoPlayer;
  /**
   * Creates a video composition frames extractor for the specified video composition.
   * @param composition The video composition.
   * @returns The video composition frames extractor.
   */
  createVideoCompositionFramesExtractor: (
    /**
     * The video composition to extract frames from.
     */
    composition: VideoComposition,
  ) => VideoCompositionFramesExtractor;
  /**
   * Creates a synchronous video composition frames extractor for the specified video composition.
   * @param composition The video composition.
   * @returns The video composition frames extractor.
   */
  createVideoCompositionFramesExtractorSync: (
    /**
     * The video composition to extract frames from.
     */
    composition: VideoComposition,
  ) => VideoCompositionFramesExtractorSync;

  /**
   * Creates a video composition encoder for the specified export options.
   * @param options The export options for the video composition.
   * @param composition The video composition being exported; used to encode
   * the audio tracks of the composition items (if any).
   * @returns The video composition encoder.
   */
  createVideoEncoder: (
    /**
     * The export options for the video composition.
     */
    options: ExportOptions,
    /**
     * The video composition being exported (used for audio encoding).
     */
    composition?: VideoComposition | null,
  ) => VideoEncoder;
  /**
   * Runs the given function inside an autorelease pool. Worklet runtime
   * threads never drain their autorelease pool, so any per-frame native
   * garbage created by code running there would otherwise accumulate for the
   * lifetime of the app.
   *
   * @platform ios
   */
  runWithAutoreleasePool?: <T>(fn: () => T) => T;
  /**
   * Returns the decoding capabilities of the current platform for the specified mimetype.
   *
   * @platform android
   * @param mimetype The mimetype of the video.
   */
  getDecodingCapabilitiesFor(mimetype: string): {
    /**
     * The maximum number of instances that can be decoded simultaneously.
     */
    maxInstances: number;
    /**
     * The maximum width of the frame that the decoder will produce.
     */
    maxWidth: number;
    /**
     * The maximum height of the frame that the decoder will produce.
     */
    maxHeight: number;
  } | null;

  /**
   * Whether the device can encode with the given codec.
   *
   * `h264` is always true. `hevc` depends on the hardware: an A10 or later on
   * iOS, and a device dependent answer on Android, where HEVC decoding is far
   * more common than HEVC encoding.
   *
   * Exports fall back to `h264` on their own when this returns false, so this
   * is for the UI — hiding or disabling a codec the device cannot honour is
   * better than accepting the choice and quietly ignoring it.
   *
   * @param codec The codec to test.
   */
  isEncodingSupported(codec: VideoCodec): boolean;

  /**
   * Given a set of encoder configurations,
   * returns the closest supported configurations by the platform encoders.
   *
   * @param width The width of the video.
   * @param height The height of the video.
   * @param frameRate The frame rate of the video in frames per second.
   * @param bitRate The bit rate of the video in bits per second.
   * @param codec The codec the export will encode with, defaulting to `h264`.
   * Pass the same value here and to {@link ExportOptions.codec}: the sizes and
   * frame rates an H.264 encoder accepts say nothing about what the HEVC one on
   * the same chip will take. A codec the device cannot encode falls back to
   * `h264`, as an export would.
   */
  getValidEncoderConfigurations(
    width: number,
    height: number,
    frameRate: number,
    bitRate: number,
    codec?: VideoCodec,
  ):
    | {
        /**
         * The name of the encoder.
         * can be reused in the `exportVideoComposition` method.
         */
        encoderName: string;
        /**
         * Wether the encoder supports hardware acceleration.
         */
        hardwareAccelerated: boolean;
        /**
         * The width of the video.
         */
        width: number;
        /**
         * The height of the video.
         */
        height: number;
        /**
         * The frame rate of the video in frames per second.
         */
        frameRate: number;
        /**
         * The bit rate of the video in bits per second.
         */
        bitRate: number;
      }[]
    | null;
};
