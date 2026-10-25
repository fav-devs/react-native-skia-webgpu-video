package com.azzapp.rnskv;

import android.media.MediaCodec;
import android.media.MediaCodecInfo.CodecProfileLevel;
import android.media.MediaCodecList;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.Surface;

import androidx.annotation.NonNull;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Stack;

/**
 * A class that decodes a video item from a video composition asynchronously.
 */
public class VideoCompositionItemDecoder extends MediaCodec.Callback {

  private final VideoComposition.Item item;

  private MediaExtractor extractor;

  private MediaCodec codec;

  private MediaFormat format;

  private boolean inputEOS = false;

  private boolean hasRenderedFrame = false;

  private boolean itemEndReached = false;

  private int videoWidth;

  private int videoHeight;

  private int rotation;

  private boolean prepared = false;

  private boolean configured = false;

  private boolean started = false;

  private volatile boolean released = false;

  private Surface surface;

  private long initialPositionUs = 0;

  private Handler callbackHandler;

  /**
   * Set by a seek until the codec's thread has run every callback queued
   * before the flush: those name buffers the flush took back, and handling
   * them after it hands out or drops the buffers of the new position.
   */
  private boolean droppingStaleCallbacks = false;

  private long flushGeneration = 0;

  private final Stack<Frame> freeFrames = new Stack<>();

  private final List<Frame> pendingFrames = new ArrayList<>();

  private int trackIndex = -1;

  /** The latest frame the codec put out, forward, for catch-up seeks; -1 after a seek. */
  private long latestOutputUs = -1;

  /** The target of the last catch-up seek (see {@link Shuttle#catchUp}), or -1. */
  private long catchUpTargetUs = -1;

  /** The frame render() last showed, forward. */
  private long lastRenderedUs = -1;

  // Backward playback (see Shuttle). The codec decodes windows of the file
  // behind the playhead into a surface of their own, the capture surface,
  // one frame at a time: the GL thread snapshots each (captured), at the
  // frame's size, and only then is the next one rendered. The capture
  // surface replaces the codec's output while playing backward
  // (setOutputSurface), so the forward surface never sees a backward frame.

  /** Read without the lock by the GL thread. */
  private volatile boolean backward = false;

  /** Backward was asked, but the GL thread has not made the capture surface yet. */
  private volatile boolean wantsCaptureSurface = false;

  private volatile Surface captureSurface;

  /** setOutputSurface failed: backward, the item keeps the frame on screen. */
  private boolean captureUnavailable = false;

  private boolean outputOnCapture = false;

  /** Seeks to sync samples, for window planning. */
  private MediaExtractor syncProbe;

  private boolean syncProbeFailed = false;

  /** The window being decoded, or null. Written under this decoder's lock. */
  private volatile Shuttle.Window window;

  /** The earliest file time the windows decoded so far cover, or -1. */
  private long coveredFromUs = -1;

  private long frameDurationUs = 33_333;

  /**
   * What the codec's thread and the GL thread share. The GL thread never takes
   * this decoder's own lock, which a flush holds for its whole length; a flush
   * clears what is under this one first, so no buffer index from before it is
   * released after it.
   */
  private final Object captureLock = new Object();

  /** Output buffers of the window waiting to be rendered for capture, ascending. Capture lock. */
  private final ArrayDeque<CaptureBuffer> captureQueue = new ArrayDeque<>();

  /** The latest output before the window's start (see Shuttle.admit), held. Capture lock. */
  private CaptureBuffer candidate;

  /** Rendered to the capture surface, waiting for the GL thread. Capture lock. */
  private CaptureBuffer inFlight;

  /** The frame in flight went over the window's capacity: closed once captured. Capture lock. */
  private boolean inFlightDropped;

  /** The codec has put out every frame of the window. Capture lock. */
  private boolean windowDecoded;

  /** The window is whole: its frames are held, see completedCoveredUs. Capture lock. */
  private boolean windowCompleted;

  private long completedCoveredUs = -1;

  private long windowSerial = 0;

  /** The captured frames of the window being decoded, ascending. Capture lock. */
  private final ArrayList<Held> windowFrames = new ArrayList<>();

  /** The frames of fully decoded windows, ascending. Capture lock. */
  private final ArrayList<Held> heldFrames = new ArrayList<>();

  private long[] heldPts = new long[Shuttle.MAX_FRAMES + 2];

  private long[] heldUntil = new long[Shuttle.MAX_FRAMES + 2];

  /** The frame to show backward, its serial, and its time. Capture lock. */
  private VideoFrame selected;

  private long selectedSerial = 0;

  private long shownUs = -1;

  private OnErrorListener onErrorListener;

  private OnEndReachedListener onEndReachedListener;

  private OnFrameAvailableListener onFrameAvailableListener;

  /**
   * Create a new VideoCompositionItemDecoder.
   *
   * @param item the video composition item to decode
   */
  public VideoCompositionItemDecoder(VideoComposition.Item item) {
    this.item = item;
  }

  /**
   * Prepare the decoder.
   *
   * @throws IOException if the decoder cannot be prepared
   */
  synchronized public void prepare() throws IOException {
    if (prepared) {
      return;
    }
    extractor = new MediaExtractor();
    extractor.setDataSource(item.getPath());
    trackIndex = selectTrack(extractor);
    if (trackIndex == -1) {
      throw new RuntimeException("No video track");
    }
    format = extractor.getTrackFormat(trackIndex);
    String mime = format.getString(MediaFormat.KEY_MIME);
    if (mime == null) {
      throw new IOException("Could not determine file mime type");
    }
    mime = playableMime(format, mime);
    codec = MediaCodec.createDecoderByType(mime);
    extractor.selectTrack(trackIndex);
    // Capped at the item's end, as on iOS, then read at the item's rate.
    long offsetUs = ItemTime.sourceSpanUs(
      ItemTime.heldOffsetUs(
        TimeHelpers.secToUs(item.getCompositionStartTime()),
        TimeHelpers.secToUs(item.getDuration()),
        initialPositionUs),
      item.getPlaybackRate());
    if (item.getStartTime() != 0 || offsetUs != 0) {
      extractor.seekTo(
        TimeHelpers.secToUs(item.getStartTime()) + offsetUs,
        MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
    }
    videoWidth = format.getInteger(MediaFormat.KEY_WIDTH);
    videoHeight = format.getInteger(MediaFormat.KEY_HEIGHT);
    rotation = format.containsKey(MediaFormat.KEY_ROTATION) ? format.getInteger(MediaFormat.KEY_ROTATION) : 0;
    if (format.containsKey(MediaFormat.KEY_FRAME_RATE)) {
      try {
        float frameRate = format.getFloat(MediaFormat.KEY_FRAME_RATE);
        if (frameRate > 0) frameDurationUs = Math.round(1e6 / frameRate);
      } catch (ClassCastException integerRate) {
        int frameRate = format.getInteger(MediaFormat.KEY_FRAME_RATE);
        if (frameRate > 0) frameDurationUs = Math.round(1e6 / frameRate);
      }
    }
    prepared = true;
    configure();
  }

  /**
   * Start the decoder
   */
  synchronized public void start() {
    if (!prepared || !configured || started) {
      return;
    }
    codec.start();
    started = true;
  }

  /**
   * Set the surface to render the video to.
   *
   * @param surface the surface to render the video to
   */
  public void setSurface(Surface surface) {
    this.surface = surface;
    configure();
  }


  /**
   * Where decoding starts, as a composition time, for a decoder opened after
   * its item has begun. Must be called before {@link #prepare}.
   */
  public void setInitialPosition(long compositionTimeUs) {
    initialPositionUs = compositionTimeUs;
  }

  /**
   * The thread the codec calls back on, instead of the one that configures it.
   * Must be called before {@link #setSurface}.
   */
  public void setCallbackHandler(Handler callbackHandler) {
    this.callbackHandler = callbackHandler;
  }

  public void setOnErrorListener(OnErrorListener onErrorListener) {
    this.onErrorListener = onErrorListener;
  }

  public void setOnFrameAvailableListener(OnFrameAvailableListener onFrameAvailableListener) {
    this.onFrameAvailableListener = onFrameAvailableListener;
  }

  public void setOnEndReachedListener(OnEndReachedListener onEndReachedListener) {
    this.onEndReachedListener = onEndReachedListener;
  }

  /**
   * @return the video composition item
   */
  public VideoComposition.Item getItem() {
    return item;
  }

  /**
   * @return the width of the decoded video in pixels after rotation
   */
  /**
   * Whether the track decodes to 8-bit SDR pictures: only those go through
   * ImageReader's YUV 4:2:0 buffers; HDR and 10-bit keep the GL path, whose
   * SurfaceTexture handles their formats.
   */
  public synchronized boolean isEightBitSdr() {
    if (format == null) return false;
    if (format.containsKey(MediaFormat.KEY_COLOR_TRANSFER)) {
      int transfer = format.getInteger(MediaFormat.KEY_COLOR_TRANSFER);
      if (transfer == MediaFormat.COLOR_TRANSFER_HLG || transfer == MediaFormat.COLOR_TRANSFER_ST2084)
        return false;
    }
    if (format.containsKey(MediaFormat.KEY_COLOR_STANDARD) &&
        format.getInteger(MediaFormat.KEY_COLOR_STANDARD) == MediaFormat.COLOR_STANDARD_BT2020)
      return false;
    String mime = format.getString(MediaFormat.KEY_MIME);
    if (!MediaFormat.MIMETYPE_VIDEO_AVC.equals(mime) && !MediaFormat.MIMETYPE_VIDEO_HEVC.equals(mime))
      return false;
    if (format.containsKey(MediaFormat.KEY_PROFILE)) {
      int profile = format.getInteger(MediaFormat.KEY_PROFILE);
      if (MediaFormat.MIMETYPE_VIDEO_HEVC.equals(mime))
        return profile == android.media.MediaCodecInfo.CodecProfileLevel.HEVCProfileMain;
      return profile != android.media.MediaCodecInfo.CodecProfileLevel.AVCProfileHigh10 &&
        profile != android.media.MediaCodecInfo.CodecProfileLevel.AVCProfileHigh422 &&
        profile != android.media.MediaCodecInfo.CodecProfileLevel.AVCProfileHigh444;
    }
    return true;
  }

  public int getVideoWidth() {
    return videoWidth;
  }

  /**
   * @return the height of the decoded video in pixels after rotation
   */
  public int getVideoHeight() {
    return videoHeight;
  }

  /**
   * @return the rotation of the decoded video in degrees
   */
  public int getRotation() {
    return rotation;
  }

  @Override
  synchronized public void onInputBufferAvailable(@NonNull MediaCodec codec, int index) {
    if (!prepared || !configured || released || droppingStaleCallbacks) {
      return;
    }
    // Backward between windows: nothing to read; the next window flushes.
    if (backward && window == null) {
      return;
    }

    if (inputEOS || itemEndReached) {
      try {
        this.codec.queueInputBuffer(index, 0, 0, 0,
          MediaCodec.BUFFER_FLAG_END_OF_STREAM);
      } catch (Throwable e) {}
      return;
    }

    ByteBuffer inputBuffer;
    try {
      inputBuffer = this.codec.getInputBuffer(index);
    } catch (Throwable e) {
      return;
    }
    if (inputBuffer == null) {
      return;
    }

    // This runs on the codec's callback thread, where an uncaught exception
    // kills the process: a sample larger than the input buffer (a
    // high-bitrate file) makes readSampleData throw, for one. Failures end
    // the item's input and go to its error listener instead.
    int sampleSize;
    try {
      sampleSize = extractor.readSampleData(inputBuffer, 0);
    } catch (Throwable e) {
      failInput(e);
      return;
    }
    if (sampleSize <= 0) {
      try {
        this.codec.queueInputBuffer(index, 0, 0, 0,
          MediaCodec.BUFFER_FLAG_END_OF_STREAM);
      } catch (Throwable e) {
        failInput(e);
      }
      return;
    }
    try {
      this.codec.queueInputBuffer(
        index,
        0,
        sampleSize,
        extractor.getSampleTime(),
        extractor.getSampleFlags()
      );
    } catch (Throwable e) {
      return;
    }
    try {
      extractor.advance();
      long next = extractor.getSampleTime();
      // Backward, read a little past the window's end: frames come out in
      // presentation order, which reordered ones reach late.
      inputEOS = next == -1
        || (backward && window != null && next >= window.endUs + WINDOW_READ_PAST_US);
    } catch (Throwable e) {
      failInput(e);
    }
  }

  /** How far past a backward window's end its samples are read. */
  private static final long WINDOW_READ_PAST_US = 300_000;

  /** Stops feeding the codec after `error`, and reports it once. */
  private void failInput(Throwable error) {
    inputEOS = true;
    reportError(error);
  }

  private void reportError(Throwable error) {
    if (released || onErrorListener == null) {
      return;
    }
    try {
      onErrorListener.onError(
        error instanceof Exception ? (Exception) error : new RuntimeException(error));
    } catch (Throwable ignored) {
      // A listener's own failure must not take the codec thread down either.
    }
  }

  @Override
  synchronized public void onOutputBufferAvailable(
    @NonNull MediaCodec codec, int index, @NonNull MediaCodec.BufferInfo info) {
    if (released || droppingStaleCallbacks) {
      return;
    }
    if (backward) {
      onBackwardOutput(codec, index, info);
      return;
    }
    boolean outputEOS = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
    boolean sampleOutOfBounds = info.presentationTimeUs > item.sourceEndUs();
    boolean sampleBeforeStartTime =
      info.presentationTimeUs < TimeHelpers.secToUs(item.getStartTime());

    // Surface output has no accessible ByteBuffer: getOutputBuffer returns
    // null by contract. Its callback index and timestamp name the frame to
    // render; probing the buffer would strand it and stall the decoder.
    if (!itemEndReached && SurfaceOutputPolicy.hasFrame(info.size, info.flags)
        && !sampleOutOfBounds && !sampleBeforeStartTime) {
      Frame frame = getFreeFrame();
      frame.outputBufferIndex = index;
      frame.presentationTimeUs = info.presentationTimeUs;
      pendingFrames.add(frame);
      latestOutputUs = Math.max(latestOutputUs, info.presentationTimeUs);
      if (onFrameAvailableListener != null) {
        try {
          onFrameAvailableListener.onFrameAvailable(frame.presentationTimeUs);
        } catch (Throwable e) {
          reportError(e);
        }
      }
    } else {
      try {
        codec.releaseOutputBuffer(index, false);
      } catch (Throwable e) {
        return;
      }
    }

    itemEndReached = outputEOS || sampleOutOfBounds;
    if (itemEndReached) {
      if (onEndReachedListener != null) {
        try {
          onEndReachedListener.onEndReached();
        } catch (Throwable e) {
          reportError(e);
        }
      }
    }
  }

  @Override
  public void onError(@NonNull MediaCodec codec, @NonNull MediaCodec.CodecException e) {
    reportError(e);
  }

  @Override
  public void onOutputFormatChanged(@NonNull MediaCodec codec, @NonNull MediaFormat format) {
    // Do nothing
  }

  synchronized public Long render(long compositionTimeUs) {
    if (pendingFrames.isEmpty()) {
      return null;
    }
    long sourceTimeUs = item.sourceTimeUs(compositionTimeUs);

    List<Frame> framesToRenders = new ArrayList<>();
    for (Frame frame : pendingFrames) {
      if (frame.presentationTimeUs <= sourceTimeUs || !hasRenderedFrame) {
        framesToRenders.add(frame);
        hasRenderedFrame = true;
      }
    }
    if (framesToRenders.isEmpty()) {
      return null;
    }
    // Only the latest is drawn: after a seek the batch runs from the previous
    // key frame, and drawing each one into the surface is GPU work nobody sees.
    int lastIndex = framesToRenders.size() - 1;
    for (int i = 0; i <= lastIndex; i++) {
      try {
        codec.releaseOutputBuffer(framesToRenders.get(i).outputBufferIndex, i == lastIndex);
      } catch (Throwable e) {
        // A codec flushed or released meanwhile: the buffer is gone with it.
      }
    }
    freeFrames.addAll(framesToRenders);
    pendingFrames.removeAll(framesToRenders);

    lastRenderedUs = framesToRenders.get(framesToRenders.size() - 1).presentationTimeUs;
    return lastRenderedUs;
  }

  /**
   * The preview's render: forward as {@link #render(long)}, or backward from
   * the frames of decoded windows (see {@link Shuttle}), planning the next
   * window. Changing direction starts the codec over at the playhead.
   *
   * @param rate the player's signed rate, whose clock a fast forward codec
   *             may be sought to catch up with
   */
  synchronized public Long render(long compositionTimeUs, boolean backward, double rate) {
    if (released || !started) {
      return null;
    }
    if (backward != this.backward && !switchDirection(backward, compositionTimeUs)) {
      backward = this.backward;
    }
    if (!backward) {
      // A codec slower than a fast clock falls further behind it the longer
      // it reads on: sought to the clock, it shows the clock's frame again.
      long sourceUs = item.sourceTimeUs(compositionTimeUs);
      if (sourceUs < item.sourceEndUs()
          && Shuttle.catchUp(latestOutputUs, sourceUs, rate, catchUpTargetUs)) {
        seekTo(compositionTimeUs);
        catchUpTargetUs = sourceUs;
      }
      return render(compositionTimeUs);
    }
    if (!captureUnavailable) {
      renderBackward(compositionTimeUs);
    }
    return null;
  }

  /** Whether the codec decodes backward windows, for the GL thread. */
  public boolean isBackward() {
    return backward;
  }

  /** Whether the GL thread should make the capture surface. */
  public boolean needsCaptureSurface() {
    return wantsCaptureSurface && captureSurface == null;
  }

  /** The surface backward frames are rendered into, made by the GL thread. */
  public void setCaptureSurface(Surface surface) {
    captureSurface = surface;
  }

  /**
   * Whether {@code timestampUs} is the frame rendered for capture. Takes the
   * capture lock only, never this decoder's.
   */
  public boolean expectsCapture(long timestampUs) {
    synchronized (captureLock) {
      return inFlight != null && inFlight.ptsUs == timestampUs;
    }
  }

  /**
   * The GL thread's snapshot of the frame in flight. Takes {@code frame} over
   * and returns true when it is that frame; the caller closes it otherwise.
   * Takes the capture lock only, never this decoder's.
   */
  public boolean captured(VideoFrame frame, long timestampUs) {
    synchronized (captureLock) {
      if (released || inFlight == null || inFlight.ptsUs != timestampUs) {
        return false;
      }
      CaptureBuffer buffer = inFlight;
      inFlight = null;
      if (inFlightDropped) {
        inFlightDropped = false;
        frame.close();
      } else {
        windowFrames.add(new Held(buffer.ptsUs, frame, windowSerial));
      }
      pumpCaptureLocked();
      completeWindowLocked();
      return true;
    }
  }

  /**
   * A new reference to the frame to show backward when it changed since
   * {@code serial}, its serial in {@code serialOut}; null otherwise. Takes
   * the capture lock only, never this decoder's.
   */
  public VideoFrame retainSelectedAfter(long serial, long[] serialOut) {
    synchronized (captureLock) {
      if (selected == null || selectedSerial == serial) {
        return null;
      }
      serialOut[0] = selectedSerial;
      return selected.retain();
    }
  }

  /**
   * Starts the codec over at the playhead in the other direction. Backward
   * needs the capture surface, which the GL thread makes on its next frame:
   * until then, false, and the codec goes on forward.
   */
  private boolean switchDirection(boolean toBackward, long compositionTimeUs) {
    if (toBackward) {
      Surface capture = captureSurface;
      if (capture == null) {
        wantsCaptureSurface = true;
        return false;
      }
      wantsCaptureSurface = false;
      resetBackward();
      flushCodec();
      if (!outputOnCapture && !captureUnavailable) {
        try {
          codec.setOutputSurface(capture);
          outputOnCapture = true;
        } catch (RuntimeException e) {
          // Some codecs refuse a new output surface: that item then holds its
          // frame while the others play backward.
          captureUnavailable = true;
          reportError(e);
        }
      }
      synchronized (captureLock) {
        // Backward shows nothing at or after the frame on screen.
        shownUs = hasRenderedFrame ? lastRenderedUs : -1;
      }
      this.backward = true;
      return true;
    }
    this.backward = false;
    resetBackward();
    flushCodec();
    if (outputOnCapture) {
      try {
        codec.setOutputSurface(surface);
      } catch (RuntimeException e) {
        reportError(e);
      }
      outputOnCapture = false;
    }
    synchronized (captureLock) {
      if (selected != null) {
        // The GL thread holds its own reference to the frame on screen.
        selected.close();
        selected = null;
        selectedSerial++;
      }
    }
    seekTo(compositionTimeUs);
    return true;
  }

  /** The playhead's time in the file, held to the item. */
  private long sourcePositionUs(long compositionTimeUs) {
    return TimeHelpers.secToUs(item.getStartTime()) + ItemTime.sourceSpanUs(
      ItemTime.heldOffsetUs(
        TimeHelpers.secToUs(item.getCompositionStartTime()),
        TimeHelpers.secToUs(item.getDuration()),
        compositionTimeUs),
      item.getPlaybackRate());
  }

  /** Under this decoder's lock. */
  private void renderBackward(long compositionTimeUs) {
    long positionUs = sourcePositionUs(compositionTimeUs);
    long floorUs = TimeHelpers.secToUs(item.getStartTime());
    int windowsHeld = 0;
    synchronized (captureLock) {
      if (windowCompleted) {
        windowCompleted = false;
        window = null;
        coveredFromUs = completedCoveredUs;
      }
      int count = heldFrames.size();
      if (count > heldPts.length) {
        heldPts = new long[count];
        heldUntil = new long[count];
      }
      for (int i = 0; i < count; i++) {
        Held held = heldFrames.get(i);
        heldPts[i] = held.ptsUs;
        heldUntil[i] = held.untilUs;
      }
      // Plus a microsecond, as forward: a time asked at a frame's own is that frame.
      int[] pick = Shuttle.pickBackward(heldPts, heldUntil, count, positionUs + 1, shownUs);
      for (int i = count - 1; i >= pick[1]; i--) {
        Held held = heldFrames.remove(i);
        if (i == pick[0]) {
          VideoFrame previous = selected;
          selected = held.frame;
          selectedSerial++;
          shownUs = held.ptsUs;
          if (previous != null) previous.close();
        } else {
          held.frame.close();
        }
      }
      for (int i = 0; i < heldFrames.size(); i++) {
        if (i == 0 || heldFrames.get(i).window != heldFrames.get(i - 1).window) windowsHeld++;
      }
    }
    if (window == null && windowsHeld < Shuttle.WINDOWS
        && (coveredFromUs < 0 || coveredFromUs > floorUs)) {
      startWindow(positionUs, floorUs);
    }
  }

  /** Under this decoder's lock: flushes the codec and reads the next window. */
  private void startWindow(long positionUs, long floorUs) {
    int[] size = FrameSize.of(item.getWidth(), item.getHeight(), item.getMaxLongSide(),
      videoWidth, videoHeight, rotation);
    int capacity = Shuttle.windowCapacity((long) size[0] * size[1] * 4);
    Shuttle.Window next = Shuttle.planWindow(Shuttle.nextEnd(coveredFromUs, positionUs), floorUs,
      frameDurationUs, capacity, syncIndex());
    if (next == null) {
      coveredFromUs = floorUs;
      return;
    }
    flushCodec();
    synchronized (captureLock) {
      windowDecoded = false;
      windowCompleted = false;
      windowSerial++;
      windowCapacity = capacity;
      for (Held held : windowFrames) held.frame.close();
      windowFrames.clear();
    }
    window = next;
    extractor.seekTo(next.decodeFromUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
    inputEOS = false;
    itemEndReached = false;
    codec.start();
  }

  private int windowCapacity = 1;

  /** On the codec's thread, under this decoder's lock. */
  private void onBackwardOutput(MediaCodec codec, int index, MediaCodec.BufferInfo info) {
    boolean eos = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
    Shuttle.Window current = window;
    synchronized (captureLock) {
      if (current == null || windowDecoded) {
        releaseQuietly(codec, index, false);
        return;
      }
      if (!SurfaceOutputPolicy.hasFrame(info.size, info.flags)) {
        releaseQuietly(codec, index, false);
      } else {
        long pts = info.presentationTimeUs;
        int admitted = pts > item.sourceEndUs() ? Shuttle.STOP : Shuttle.admit(pts, current);
        if (admitted == Shuttle.STOP) {
          releaseQuietly(codec, index, false);
          eos = true;
        } else if (admitted == Shuttle.BEFORE) {
          if (candidate != null) releaseQuietly(codec, candidate.index, false);
          candidate = new CaptureBuffer(index, pts);
        } else {
          if (candidate != null) {
            captureQueue.add(candidate);
            candidate = null;
          }
          captureQueue.add(new CaptureBuffer(index, pts));
          trimWindowLocked(codec);
          pumpCaptureLocked();
        }
      }
      if (eos) {
        windowDecoded = true;
        inputEOS = true;
        if (candidate != null) {
          // No frame inside the window: the one on screen at its start.
          captureQueue.add(candidate);
          candidate = null;
          pumpCaptureLocked();
        }
        completeWindowLocked();
      }
    }
  }

  /** Keeps the window to its latest frames: the oldest goes, never one in between. */
  private void trimWindowLocked(MediaCodec codec) {
    while (windowFrames.size() + captureQueue.size() + (inFlight != null && !inFlightDropped ? 1 : 0)
        > windowCapacity) {
      if (!windowFrames.isEmpty()) {
        windowFrames.remove(0).frame.close();
      } else if (inFlight != null && !inFlightDropped) {
        inFlightDropped = true;
      } else if (!captureQueue.isEmpty()) {
        releaseQuietly(codec, captureQueue.pollFirst().index, false);
      } else {
        break;
      }
    }
  }

  /** Renders the next frame of the window for capture, once the previous one is captured. */
  private void pumpCaptureLocked() {
    MediaCodec current = codec;
    while (inFlight == null && !captureQueue.isEmpty() && current != null && !released) {
      CaptureBuffer next = captureQueue.pollFirst();
      try {
        current.releaseOutputBuffer(next.index, true);
        inFlight = next;
      } catch (Throwable e) {
        // A codec flushed or released meanwhile: the buffer is gone with it.
      }
    }
  }

  /** The window is whole once every frame it kept is captured. */
  private void completeWindowLocked() {
    Shuttle.Window current = window;
    if (!windowDecoded || windowCompleted || inFlight != null || !captureQueue.isEmpty()
        || candidate != null || current == null) {
      return;
    }
    long[] pts = new long[windowFrames.size()];
    for (int i = 0; i < pts.length; i++) pts[i] = windowFrames.get(i).ptsUs;
    long[] until = Shuttle.untilOf(pts, current);
    for (int i = 0; i < pts.length; i++) windowFrames.get(i).untilUs = until[i];
    // Below every frame held: a window ends where what is held begins, or
    // lower once the clock has run below it.
    heldFrames.addAll(0, windowFrames);
    windowFrames.clear();
    completedCoveredUs = Shuttle.coveredFrom(pts, current);
    windowCompleted = true;
  }

  /** Drops the backward windows: the one being decoded and the decoded ones. */
  private void resetBackward() {
    synchronized (captureLock) {
      for (Held held : windowFrames) held.frame.close();
      windowFrames.clear();
      for (Held held : heldFrames) held.frame.close();
      heldFrames.clear();
      windowDecoded = false;
      windowCompleted = false;
      shownUs = -1;
    }
    window = null;
    coveredFromUs = -1;
  }

  /**
   * Flushes the codec, leaving it stopped: the buffers it held for display or
   * capture go with the flush, under the capture lock first.
   */
  private void flushCodec() {
    freeFrames.addAll(pendingFrames);
    pendingFrames.clear();
    synchronized (captureLock) {
      captureQueue.clear();
      candidate = null;
      inFlight = null;
      inFlightDropped = false;
    }
    codec.flush();
    // Queued behind the callbacks from before the flush, and ahead of those
    // start() brings: they run on this handler's thread in order.
    if (callbackHandler != null) {
      droppingStaleCallbacks = true;
      long generation = ++flushGeneration;
      callbackHandler.post(() -> {
        synchronized (this) {
          if (flushGeneration == generation) {
            droppingStaleCallbacks = false;
          }
        }
      });
    }
    latestOutputUs = -1;
  }

  /** The file's sync samples, asked of a second extractor that only seeks. */
  private Shuttle.SyncIndex syncIndex() {
    if (syncProbe == null && !syncProbeFailed) {
      MediaExtractor probe = new MediaExtractor();
      try {
        probe.setDataSource(item.getPath());
        probe.selectTrack(trackIndex);
        syncProbe = probe;
      } catch (IOException | RuntimeException e) {
        syncProbeFailed = true;
        probe.release();
      }
    }
    MediaExtractor probe = syncProbe;
    return new Shuttle.SyncIndex() {
      @Override
      public long previous(long timeUs) {
        if (probe == null || timeUs < 0) return -1;
        probe.seekTo(timeUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
        long sync = probe.getSampleTime();
        return sync >= 0 && sync <= timeUs ? sync : -1;
      }

      @Override
      public long next(long timeUs) {
        if (probe == null) return -1;
        probe.seekTo(Math.max(0, timeUs), MediaExtractor.SEEK_TO_NEXT_SYNC);
        long sync = probe.getSampleTime();
        return sync >= timeUs ? sync : -1;
      }
    };
  }

  private static void releaseQuietly(MediaCodec codec, int index, boolean render) {
    try {
      codec.releaseOutputBuffer(index, render);
    } catch (Throwable e) {
      // Flushed or released meanwhile.
    }
  }

  /**
   * Seek to a specific time in the video.
   *
   * @param time the position in the composition timeline, in microseconds
   */
  synchronized public void seekTo(long time) {
    catchUpTargetUs = -1;
    if (backward) {
      // The windows around the old position go; the next render plans one
      // ending at the new one. The codec stays flushed until then.
      resetBackward();
      flushCodec();
      return;
    }
    flushCodec();
    long itemTime = time - TimeHelpers.secToUs(item.getCompositionStartTime());
    long seekTime = TimeHelpers.secToUs(item.getStartTime())
      + ItemTime.sourceSpanUs(Math.max(itemTime, 0), item.getPlaybackRate());
    extractor.seekTo(seekTime, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
    itemEndReached = false;
    hasRenderedFrame = false;
    inputEOS = false;
    if (started) {
      codec.start();
    }
  }

  /**
   * Release the decoder.
   */
  synchronized public void release() {
    if (!released) {
      released = true;
      resetBackward();
      synchronized (captureLock) {
        captureQueue.clear();
        candidate = null;
        inFlight = null;
        if (selected != null) {
          selected.close();
          selected = null;
        }
      }
      if (syncProbe != null) {
        syncProbe.release();
        syncProbe = null;
      }
      if (extractor != null) {
        extractor.release();
      }
      if (codec != null) {
        codec.release();
        codec = null;
      }
    }
  }

  private synchronized void configure() {
    if (prepared && surface != null && !configured) {
      if (callbackHandler == null) {
        // Where MediaCodec would call back without a handler; seekTo posts to it.
        Looper looper = Looper.myLooper();
        callbackHandler = new Handler(looper != null ? looper : Looper.getMainLooper());
      }
      codec.setCallback(this, callbackHandler);
      codec.configure(format, surface, null, 0);
      configured = true;
    }
  }

  /**
   * The mime type to decode the track as. A Dolby Vision track on a device
   * without a Dolby Vision decoder is decoded as its base layer: HDR clips
   * from an iPhone are profile 8.4, Dolby Vision metadata over an HLG HEVC
   * stream any HEVC decoder plays; profile 9 is over AVC. Sets the format to
   * match.
   */
  private static String playableMime(MediaFormat format, String mime) {
    if (!MediaFormat.MIMETYPE_VIDEO_DOLBY_VISION.equals(mime)
      || new MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(format) != null) {
      return mime;
    }
    int profile = format.containsKey(MediaFormat.KEY_PROFILE)
      ? format.getInteger(MediaFormat.KEY_PROFILE) : -1;
    String base = profile == CodecProfileLevel.DolbyVisionProfileDvavSe
      || profile == CodecProfileLevel.DolbyVisionProfileDvavPer
      || profile == CodecProfileLevel.DolbyVisionProfileDvavPen
      ? MediaFormat.MIMETYPE_VIDEO_AVC
      : MediaFormat.MIMETYPE_VIDEO_HEVC;
    format.setString(MediaFormat.KEY_MIME, base);
    // The Dolby Vision profile and level mean nothing to the base decoder.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      format.removeKey(MediaFormat.KEY_PROFILE);
      format.removeKey(MediaFormat.KEY_LEVEL);
    }
    return base;
  }

  private static int selectTrack(MediaExtractor extractor) {
    int numTracks = extractor.getTrackCount();
    for (int i = 0; i < numTracks; i++) {
      MediaFormat format = extractor.getTrackFormat(i);
      String mime = format.getString(MediaFormat.KEY_MIME);
      if (mime != null && mime.startsWith("video/")) {
        return i;
      }
    }
    return -1;
  }

  private Frame getFreeFrame() {
    return freeFrames.empty() ? new Frame() : freeFrames.pop();
  }

  public interface OnErrorListener {
    void onError(Exception error);
  }

  public interface OnFrameAvailableListener {
    void onFrameAvailable(long presentationTimeUs);
  }

  public interface OnEndReachedListener {
    void onEndReached();
  }

  /** An output buffer of a backward window, before it is rendered for capture. */
  private static final class CaptureBuffer {
    final int index;
    final long ptsUs;

    CaptureBuffer(int index, long ptsUs) {
      this.index = index;
      this.ptsUs = ptsUs;
    }
  }

  /** A captured frame of a backward window. */
  private static final class Held {
    final long ptsUs;
    long untilUs;
    final VideoFrame frame;
    final long window;

    Held(long ptsUs, VideoFrame frame, long window) {
      this.ptsUs = ptsUs;
      this.frame = frame;
      this.window = window;
    }
  }

  /**
   * A frame representing a decoded output buffer sample.
   */
  private static class Frame {
    private int outputBufferIndex;
    private long presentationTimeUs;
  }
}
