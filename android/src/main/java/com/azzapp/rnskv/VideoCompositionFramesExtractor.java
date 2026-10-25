package com.azzapp.rnskv;

import android.app.Activity;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Message;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import android.view.Choreographer;

import androidx.media3.common.util.UnstableApi;

import com.facebook.react.bridge.ReactApplicationContext;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.microedition.khronos.egl.EGLContext;
import javax.microedition.khronos.egl.EGL10;

/**
 * A class that previews a video composition.
 */
@UnstableApi
public class VideoCompositionFramesExtractor {
  private static final String TAG = "VideoCompositionFramesExtractor";

  private static final int PLAYBACK_PREPARE = 1;
  private static final int PLAYBACK_PLAY = 2;
  private static final int PLAYBACK_PAUSE = 3;
  private static final int PLAYBACK_LOOP = 4;
  private static final int PLAYBACK_SEEK = 5;
  private static final int PLAYBACK_RELEASE = 6;
  private static final int PLAYBACK_VSYNC_RELEASE = 7;
  private static final int PLAYBACK_RATE = 8;

  private final VideoComposition composition;

  private final VideoCompositionDecoder decoder;

  private AudioCompositionPlayer audioPlayer;

  private final PlaybackThread playbackThread;

  private final Handler handler;

  private final NativeEventDispatcher eventDispatcher;

  private boolean playWhenReady = false;

  private boolean prepared;
  private boolean releasing;
  private boolean looping;


  private long pendingSeek = 0;
  // Read on the thread that collects frames (see releaseForNextVsync), written on the playback thread.
  private volatile boolean isPlaying = false;

  // The clock while playing: immutable, so the threads that read it see an
  // anchor and a rate that go together. Re-anchored by play, seeks, loops and
  // rate changes, on the playback thread.
  private volatile Shuttle.Clock clock = new Shuttle.Clock(0, 0, 1);
  // The rate last asked for, held to [-4, 4] by the caller (checkedShuttleRate);
  // the clock takes it on the playback thread.
  private volatile double playbackRate = 1;
  // Whether the decoders read backward. Playback thread only.
  private boolean decodingBackward = false;
  // The position playback last started or was sought to while playing.
  private volatile long playStartPosition = 0;
  private volatile long pausePosition = 0;
  private boolean isEOS = false;
  private boolean completeDispatched = false;

  // Vsync-aligned release, written and read on the thread that collects frames.
  private long lastVsyncNanos = 0;
  private long recordedVsyncNanos = 0;
  private boolean recordingVsync = false;
  /** Notes each vsync's timestamp on the collecting thread, for as long as the preview lives. */
  private final Choreographer.FrameCallback vsyncRecorder = new Choreographer.FrameCallback() {
    @Override
    public void doFrame(long frameTimeNanos) {
      if (releasing) {
        unwatchDisplay();
        frameRateVote.withdraw();
        return;
      }
      recordedVsyncNanos = frameTimeNanos;
      Choreographer.getInstance().postFrameCallback(this);
    }
  };
  // The display the preview is on; null until the first collection, or when unknown.
  private DisplayVsyncPeriod vsyncPeriod;
  // The display's highest refresh rate while playing.
  private final PreviewFrameRateVote frameRateVote = new PreviewFrameRateVote();
  // When that thread last released frames; the playback loop stands back meanwhile.
  private volatile long lastVsyncReleaseNanos = 0;
  // The vsync the frames collected last are shown at; 0 until the first.
  private volatile long collectedVsyncNanos = 0;
  // The release itself runs on the playback thread: the decoder's locks are held
  // there for whole codec flushes on a seek, and the UI thread must never
  // wait on them (measured: 65 ms frames when it did).
  private volatile long vsyncReleasePosition = 0;
  private final AtomicBoolean vsyncReleasePosted = new AtomicBoolean(false);

  private void vsyncReleaseInternal() {
    vsyncReleasePosted.set(false);
    decoder.render(vsyncReleasePosition);
  }
  private static final long VSYNC_RELEASE_TIMEOUT_NANOS = 100_000_000L;

  /**
   * Create a new VideoCompositionFramesExtractor.
   *
   * @param composition the video composition to preview
   */
  public VideoCompositionFramesExtractor(VideoComposition composition, NativeEventDispatcher eventDispatcher) {
    this.eventDispatcher = eventDispatcher;
    this.composition = composition;
    decoder = new VideoCompositionDecoder(composition, true);
    // Only a decoder that cannot open, as on iOS: a codec's passing errors
    // stay quiet, since the player gives up on the first error it reports.
    decoder.setOnOpenErrorListener(
      error -> eventDispatcher.dispatchEvent("error", messageOf(error)));
    playbackThread = new PlaybackThread();
    playbackThread.start();
    handler = new Handler(playbackThread.getLooper(), playbackThread);
  }

  public void prepare() {
    if (prepared) {
      return;
    }
    try {
      decoder.prepare(EGL10.EGL_NO_CONTEXT);
    } catch (RuntimeException error) {
      // A decoder that cannot open, as a lazy one reports it: thrown, it
      // reached the UI thread's worklet uncaught and killed the app.
      eventDispatcher.dispatchEvent("error", messageOf(error));
      return;
    }
    handler.sendEmptyMessage(PLAYBACK_PREPARE);
  }

  /**
   * Start playing the composition.
   */
  public void play() {
    handler.sendEmptyMessage(PLAYBACK_PLAY);
  }

  /**
   * Pause the composition.
   */
  public void pause() {
    handler.sendEmptyMessage(PLAYBACK_PAUSE);
  }

  /**
   * Seek to given position
   */
  public void seekTo(long position) {
    handler.removeMessages(PLAYBACK_SEEK);
    handler.obtainMessage(PLAYBACK_SEEK, position).sendToTarget();
  }

  /**
   * Decode the next frame of each composition item according to the current position of the player.
   *
   * @return an independently retained snapshot map; callers close its frames
   * when finished, without affecting the producer or other snapshots
   */
  public Map<String, VideoFrame> decodeCompositionFrames() {
    Map<String, VideoFrame> frames = decoder.updateVideosFrames();
    releaseForNextVsync();
    return frames;
  }

  /**
   * Releases the decoded frames the next vsync is due to show, from the thread
   * that collects them, right after collecting.
   *
   * The playback loop released them on its 10 ms tick, out of phase with the
   * display, so whether a frame was collected on the vsync after its time or
   * the one after that was chance: 24 fps on a 60 Hz display came out in
   * 17/67 ms steps among the 33/50 ms it implies. Released against the vsync's
   * own timestamp, one vsync ahead, every frame is collected on the first
   * vsync at or after its time. The position is decided here, against the
   * vsync; the release is posted to the playback thread, a vsync ahead of the
   * collection that needs it.
   */
  private void releaseForNextVsync() {
    if (!recordingVsync) {
      try {
        // The collecting thread is a Choreographer thread (the UI thread).
        Choreographer.getInstance().postFrameCallback(vsyncRecorder);
        recordingVsync = true;
      } catch (RuntimeException e) {
        // No looper on this thread: leave the release to the playback loop.
        return;
      }
      watchDisplay();
      return;
    }
    frameRateVote.update(isPlaying);
    long period = vsyncPeriod != null ? vsyncPeriod.getPeriodNanos() : 0;
    if (period == 0 || recordedVsyncNanos == 0) return;
    // This frame's vsync, whether the recorder has run in this frame yet or not.
    long since = Math.max(0, System.nanoTime() - recordedVsyncNanos);
    long vsyncNanos = recordedVsyncNanos + (since / period) * period;
    collectedVsyncNanos = vsyncNanos;
    if (vsyncNanos == lastVsyncNanos) return;
    lastVsyncNanos = vsyncNanos;
    long vsyncPeriodNanos = period;
    long position = isPlaying
      ? clock.at((vsyncNanos + vsyncPeriodNanos) / 1000, durationUs())
      : pausePosition;
    lastVsyncReleaseNanos = System.nanoTime();
    vsyncReleasePosition = position;
    if (vsyncReleasePosted.compareAndSet(false, true)) {
      // A message, not a posted runnable: it goes through handleMessage's
      // releasing check and turns a throw into an error event.
      handler.sendEmptyMessage(PLAYBACK_VSYNC_RELEASE);
    }
  }

  /**
   * Follows the refresh rate of the display the preview is on, from the
   * collecting thread, whose looper then receives its changes. Without a React
   * context (instrumented tests) the period stays unknown and the playback loop
   * releases on its tick.
   */
  private void watchDisplay() {
    ReactApplicationContext context = ReactNativeSkiaVideoModule.currentReactApplicationContext();
    if (context == null) return;
    Activity activity = context.getCurrentActivity();
    vsyncPeriod = DisplayVsyncPeriod.watch(context,
      activity != null ? activity.getWindowManager().getDefaultDisplay() : null);
  }

  private void unwatchDisplay() {
    if (vsyncPeriod != null) {
      vsyncPeriod.release();
      vsyncPeriod = null;
    }
  }

  /**
   * Makes the decoder's GL context current on the calling thread, the one that
   * calls {@link #decodeCompositionFrames}.
   */
  public void makeGLContextCurrent() {
    decoder.makeGLContextCurrent();
  }

  /**
   * @return the current position of the player in microseconds
   */
  public long getCurrentPosition() {
    return isPlaying ? clock.at(microTime(), durationUs()) : pausePosition;
  }

  private long durationUs() {
    return TimeHelpers.secToUs(composition.getDuration());
  }

  /**
   * The position the frames collected in this vsync were released for: the
   * clock at the vsync rather than at the call, a few milliseconds later.
   * drawFrame gets it as its time, so that the time it draws at and the frames
   * it draws agree: read at the call, the time ran up to a frame ahead of the
   * frames, at 60 fps on most vsyncs. Without vsync release (no display, or
   * a stalled collector), the clock at the call.
   *
   * @return the position in microseconds
   */
  public long getPresentedPosition() {
    long vsyncNanos = collectedVsyncNanos;
    if (!isPlaying || vsyncNanos == 0
      || System.nanoTime() - lastVsyncReleaseNanos > VSYNC_RELEASE_TIMEOUT_NANOS) {
      return getCurrentPosition();
    }
    // Never before the play or seek that started this run, in the playing
    // direction: the vsync can precede it by up to a period.
    Shuttle.Clock current = clock;
    long position = current.at(vsyncNanos / 1000, durationUs());
    return current.rate < 0
      ? Math.min(position, playStartPosition)
      : Math.max(position, playStartPosition);
  }

  /**
   * The signed rate the player plays at, see {@link Shuttle}. Taken at once by
   * the clock while playing, without a seek: only a change of direction
   * starts the decoders over.
   *
   * @param rate held to [-4, 4] by the caller
   */
  public void setPlaybackRate(double rate) {
    playbackRate = rate;
    handler.removeMessages(PLAYBACK_RATE);
    handler.sendEmptyMessage(PLAYBACK_RATE);
  }

  public double getPlaybackRate() {
    return playbackRate;
  }

  /**
   * @return the version of the frames returned by {@link #decodeCompositionFrames},
   * see {@link VideoCompositionDecoder#getFramesVersion()}
   */
  public long getFramesVersion() {
    return decoder.getFramesVersion();
  }

  /**
   * @return whether the player is looping
   */
  public boolean getIsLooping() {
    return looping;
  }

  /**
   * Set whether the player should loop.
   */
  public void setIsLooping(boolean value) {
    looping = value;
    if (prepared && isEOS && value) {
      play();
    }
  }

  /**
   * @return whether the player is currently playing
   */
  public boolean getIsPlaying() {
    return isPlaying;
  }

  public void release() {
    if (!playbackThread.isAlive()) {
      decoder.release();
      return;
    }
    isPlaying = false;
    releasing = true;
    handler.sendEmptyMessage(PLAYBACK_RELEASE);
  }

  private void prepareInternal() {
    decoder.start();
    if (composition.hasAudio()) {
      audioPlayer = new AudioCompositionPlayer(composition);
      audioPlayer.setOnErrorListener(
        message -> eventDispatcher.dispatchEvent("error", message));
      audioPlayer.prepare();
    }
    prepared = true;
    eventDispatcher.dispatchEvent("ready", null);
    handler.sendEmptyMessage(PLAYBACK_LOOP);
    if (pendingSeek != 0) {
      seekInternal(pendingSeek);
    }
    if (playWhenReady) {
      playInternal();
    }
  }

  private void playInternal() {
    if (!prepared) {
      playWhenReady = true;
      return;
    }
    double rate = playbackRate;
    // Backward from the start: nothing to play.
    if (isPlaying || Shuttle.reachedStart(pausePosition, rate)) {
      return;
    }
    if (isEOS) {
      isEOS = false;
      // Backward, it plays from the end.
      if (rate >= 0) {
        pausePosition = 0;
        seekInternal(0);
      }
    }
    playStartPosition = pausePosition;
    clock = new Shuttle.Clock(pausePosition, microTime(), rate);
    isPlaying = true;
    pausePosition = 0;
  }

  private void rateInternal() {
    double rate = playbackRate;
    Shuttle.Clock current = clock;
    if (rate == current.rate) {
      return;
    }
    long position = isPlaying ? getCurrentPosition() : pausePosition;
    if (isPlaying) {
      playStartPosition = position;
    }
    clock = new Shuttle.Clock(position, microTime(), rate);
  }

  private void pauseInternal() {
    if (!isPlaying) {
      playWhenReady = false;
      return;
    }
    pausePosition = getCurrentPosition();
    isPlaying = false;
    if (audioPlayer != null) {
      audioPlayer.pause();
    }
  }

  private void loopInternal() throws IOException, InterruptedException {
    long loopStartTime = SystemClock.elapsedRealtime();

    long currentPosition = getCurrentPosition();
    double rate = clock.rate;

    if (isPlaying && Shuttle.reachedStart(currentPosition, rate)) {
      // Backward to the start: stopped there, on its first frame, which the
      // decoders read forward again below. Not a completion.
      isPlaying = false;
      pausePosition = 0;
      currentPosition = 0;
    }
    // Backward from the end is not a completion either.
    isEOS = currentPosition >= durationUs() && !(isPlaying && rate < 0);
    if (isEOS) {
      if (!completeDispatched) {
        completeDispatched = true;
        eventDispatcher.dispatchEvent("complete", null);
      }
      isPlaying = false;
      pausePosition = TimeHelpers.secToUs(composition.getDuration());
      currentPosition = pausePosition;
    } else {
      completeDispatched = false;
    }
    decodingBackward = isPlaying && Shuttle.backwardAt(rate, decodingBackward);
    decoder.setPlayback(decodingBackward, isPlaying ? rate : 1);
    decoder.updateWindow(currentPosition);
    if (System.nanoTime() - lastVsyncReleaseNanos > VSYNC_RELEASE_TIMEOUT_NANOS) {
      // No one collecting at vsync (not yet, or no longer): release on the tick.
      decoder.render(currentPosition);
    }
    if (isEOS && looping) {
      playInternal();
    }
    if (audioPlayer != null) {
      // At 1× only: muted (paused) at any other rate, then sought back to the
      // clock by its drift correction.
      audioPlayer.update(getCurrentPosition(), isPlaying && clock.rate == 1);
    }
    long delay = 10;
    long duration = (SystemClock.elapsedRealtime() - loopStartTime);
    delay = delay - duration;
    if (delay > 0) {
      handler.sendEmptyMessageDelayed(PLAYBACK_LOOP, delay);
    } else {
      handler.sendEmptyMessage(PLAYBACK_LOOP);
    }
  }

  private void seekInternal(long position) {
    if (!prepared) {
      pendingSeek = position;
      return;
    }
    decoder.seekTo(position);
    // After the seek, so a decoder opened for this position is not sought again.
    decoder.updateWindow(position);
    if (audioPlayer != null) {
      audioPlayer.seekTo(position);
    }
    if (isPlaying) {
      playStartPosition = position;
      clock = new Shuttle.Clock(position, microTime(), clock.rate);
    } else {
      pausePosition = position;
    }
  }

  private void releaseInternal() {
    if (audioPlayer != null) {
      try {
        audioPlayer.release();
      } catch (Exception e) {
        Log.w(TAG, "Could not release the audio players", e);
      }
      audioPlayer = null;
    }
    playbackThread.interrupt();
    playbackThread.quit();
    decoder.release();
  }

  private class PlaybackThread extends HandlerThread implements Handler.Callback {
    public PlaybackThread() {
      super(TAG + PlaybackThread.class.getSimpleName(), Process.THREAD_PRIORITY_VIDEO);
    }

    @Override
    public boolean handleMessage(Message msg) {
      try {
        if (releasing) {
          // When the releasing flag is set, just release without processing any more messages
          releaseInternal();
          return true;
        }

        switch (msg.what) {
          case PLAYBACK_PREPARE -> {
            prepareInternal();
            return true;
          }
          case PLAYBACK_PLAY -> {
            playInternal();
            return true;
          }
          case PLAYBACK_PAUSE -> {
            pauseInternal();
            return true;
          }
          case PLAYBACK_LOOP -> {
            loopInternal();
            return true;
          }
          case PLAYBACK_SEEK -> {
            seekInternal((Long) msg.obj);
            return true;
          }
          case PLAYBACK_RELEASE -> {
            releaseInternal();
            return true;
          }
          case PLAYBACK_VSYNC_RELEASE -> {
            vsyncReleaseInternal();
            return true;
          }
          case PLAYBACK_RATE -> {
            rateInternal();
            return true;
          }
          default -> {
            return false;
          }
        }
      } catch (Exception error) {
        eventDispatcher.dispatchEvent("error", messageOf(error));
      }

      // Release after an exception
      releaseInternal();
      return true;
    }
  }

  // Never null: the native side reads the message as a string.
  private static String messageOf(Exception error) {
    return error.getMessage() != null ? error.getMessage() : error.toString();
  }

  private static long microTime() {
    return System.nanoTime() / 1000;
  }
}
