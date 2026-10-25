package com.azzapp.rnskv;

import static com.azzapp.rnskv.Compositions.MONTAGE;
import static com.azzapp.rnskv.Compositions.assertFrameAt;
import static com.azzapp.rnskv.Compositions.clipAt;
import static com.azzapp.rnskv.Compositions.composition;
import static com.azzapp.rnskv.Compositions.openCount;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.azzapp.rnskv.Compositions.Clip;

import org.junit.After;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import javax.microedition.khronos.egl.EGL10;

/**
 * The preview's path: VideoCompositionDecoder in real time, driven as
 * VideoCompositionFramesExtractor drives it. The test thread is the GL thread
 * that asks for frames; a handler thread plays, ticking every 10 ms.
 */
@RunWith(AndroidJUnit4.class)
public class CompositionPreviewTest {

  // Playing: the frame lags the clock by a tick, a latch and a slow emulator.
  private static final long PLAYING_SLACK_US = 250_000;

  // Paused after a seek: the exact frame.
  private static final long PAUSED_SLACK_US = 1_000;

  // Backward: the frame trails the clock by up to a window being captured.
  private static final long BACKWARD_SLACK_US = 600_000;

  private static File video;

  private VideoComposition composition;

  private Clip[] clips;

  private VideoCompositionDecoder decoder;

  private HandlerThread playback;

  private Handler handler;

  private final List<Exception> errors = Collections.synchronizedList(new ArrayList<>());

  private volatile long positionUs = 0;

  private volatile boolean playing = false;

  private volatile long clockStartNs = 0;

  /** The player's signed rate, from clockStartUs at clockStartNs. */
  private volatile double rate = 1;

  private volatile long clockStartUs = 0;

  private final Runnable tick = new Runnable() {
    @Override
    public void run() {
      if (playing && rate == 1) {
        positionUs = (System.nanoTime() - clockStartNs) / 1000;
      } else if (playing) {
        positionUs = Math.max(0,
          clockStartUs + Math.round((System.nanoTime() - clockStartNs) / 1000 * rate));
      }
      decoder.updateWindow(positionUs);
      decoder.render(positionUs);
      handler.postDelayed(this, 10);
    }
  };

  @BeforeClass
  public static void writeVideo() throws Exception {
    File cache = InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir();
    video = TestVideo.write(new File(cache, "preview-test.mp4"), 6);
  }

  @After
  public void stop() throws Exception {
    if (playback != null) {
      handler.removeCallbacksAndMessages(null);
      playback.quitSafely();
      playback.join(2000);
    }
    if (decoder != null) {
      decoder.release();
    }
    assertTrue("decoder errors: " + errors, errors.isEmpty());
  }

  @Test
  public void anEagerMontagePlaysThrough() throws Exception {
    open(false);
    playThrough(MONTAGE.length, true);
  }

  @Test
  public void aLazyMontagePlaysThroughWithFewDecoders() throws Exception {
    open(true);
    // At most the item before, kept past its end, the one on screen, and the
    // one after, opened ahead.
    playThrough(3, false);
  }

  // playbackRate: the codec releases frames rate times as fast, from the same
  // composition clock.
  @Test
  public void aHalfSpeedMontagePlaysThrough() throws Exception {
    open(true,
      new Clip("a", 0, 0, 2, 0.5),
      new Clip("b", 2, 1, 2, 0.5),
      new Clip("c", 4, 2, 2, 0.5));
    playThrough(3, false);
  }

  @Test
  public void aDoubleSpeedMontagePlaysThrough() throws Exception {
    open(true,
      new Clip("a", 0, 0, 2, 2),
      new Clip("b", 2, 1, 2, 2),
      new Clip("c", 4, 2, 2, 2));
    playThrough(3, false);
  }

  @Test
  public void aSeekAtDoubleSpeedShowsItsFrame() throws Exception {
    Clip clip = new Clip("a", 0, 0, 3, 2);
    open(false, clip);
    awaitFrame(clip, 0);
    seek(2.25);
    awaitFrame(clip, 2.25);
    seek(0.5);
    awaitFrame(clip, 0.5);
  }

  // A shuttle: the clock runs backward and the codecs decode windows behind
  // it, captured one frame at a time. The frame shown is never ahead of the
  // clock in the playing direction (an earlier file time), never moves
  // forward within an item, keeps up with the clock, and the start holds the
  // first frame.
  @Test
  public void aBackwardMontagePlaysBackToTheStart() throws Exception {
    open(true);
    double from = composition.getDuration() - 0.2;
    seek(from);
    awaitFrame(MONTAGE[2], from);
    playAt(-1);
    Map<String, Long> lastShownUs = new HashMap<>();
    int checks = 0;
    while (positionUs > 0) {
      Map<String, VideoFrame> frames = pump();
      double time = positionUs / 1e6;
      Clip clip = clipAt(clips, time);
      VideoFrame frame = clip != null ? frames.get(clip.id) : null;
      if (frame != null && time - clip.compositionStart > 0.3 && clip.end() - time > 0.3) {
        long shownUs = TimeHelpers.nsecToUs(frame.getTimestampNs());
        long expectedUs = clip.sourceUs(time);
        assertTrue(clip.id + " at " + time + "s shows " + shownUs + "us, ahead of " + expectedUs,
          shownUs >= expectedUs - TestVideo.FRAME_US - PAUSED_SLACK_US);
        assertTrue(clip.id + " at " + time + "s shows " + shownUs + "us, far behind " + expectedUs,
          shownUs <= expectedUs + BACKWARD_SLACK_US);
        Long last = lastShownUs.put(clip.id, shownUs);
        assertTrue(clip.id + " went forward to " + shownUs, last == null || shownUs <= last);
        checks++;
      }
      SystemClock.sleep(16);
    }
    assertTrue("only " + checks + " frames checked", checks > 50);
    onPlayback(() -> {
      playing = false;
      decoder.setPlayback(false, 1);
    });
    awaitFrame(MONTAGE[0], 0);
  }

  // A drag that turns around: forward, backward, forward again, at speeds
  // that change at every frame, then the exact frame once released.
  @Test
  public void aShuttleTurningAroundSettlesOnTheRightFrame() throws Exception {
    open(true);
    seek(3.0);
    awaitFrame(MONTAGE[1], 3.0);
    Random random = new Random(3);
    for (double[] leg : new double[][]{{1.5, 0.6}, {-2.5, 0.8}, {3.0, 0.4}, {-0.5, 0.5}}) {
      playAt(leg[0]);
      long until = SystemClock.uptimeMillis() + Math.round(leg[1] * 1000);
      while (SystemClock.uptimeMillis() < until) {
        pump();
        double magnitude = Math.abs(leg[0]) * (0.75 + random.nextDouble() / 2);
        playAt(Math.copySign(magnitude, leg[0]));
        SystemClock.sleep(33);
      }
    }
    onPlayback(() -> {
      playing = false;
      decoder.setPlayback(false, 1);
    });
    seek(4.2);
    awaitFrame(MONTAGE[2], 4.2);
  }

  @Test
  public void aSeekIntoAClosedItemShowsItsFrame() throws Exception {
    open(true);
    awaitFrame(MONTAGE[0], 0);
    assertFalse(decoder.isOpen(Compositions.item(composition, "c")));
    seek(5.0);
    awaitFrame(MONTAGE[2], 5.0);
    seek(0.5);
    awaitFrame(MONTAGE[0], 0.5);
    seek(2.5);
    awaitFrame(MONTAGE[1], 2.5);
  }

  @Test
  public void aScrubSettlesOnTheRightFrame() throws Exception {
    open(true);
    Random random = new Random(7);
    for (int i = 0; i < 60; i++) {
      seek(random.nextDouble() * composition.getDuration());
      pump();
      assertTrue(openCount(decoder, composition) <= 3);
      SystemClock.sleep(15);
    }
    seek(4.2);
    awaitFrame(MONTAGE[2], 4.2);
  }

  @Test
  public void releaseStopsTheDecoderThreads() throws Exception {
    open(true);
    play();
    long until = SystemClock.uptimeMillis() + 1000;
    while (SystemClock.uptimeMillis() < until) {
      pump();
      SystemClock.sleep(16);
    }
    handler.removeCallbacksAndMessages(null);
    playback.quitSafely();
    playback.join(2000);
    playback = null;
    decoder.release();
    decoder = null;
    long deadline = SystemClock.uptimeMillis() + 3000;
    while (decoderThreadsAlive() && SystemClock.uptimeMillis() < deadline) {
      SystemClock.sleep(50);
    }
    assertFalse("opener or codec thread still alive after release()", decoderThreadsAlive());
  }

  // Without a handler of their own, eager codecs called back on the looper of
  // the thread that prepared them: the UI thread's, in the app.
  @Test
  public void anEagerDecoderCallsBackOnItsCodecThread() throws Exception {
    List<String> threads = Collections.synchronizedList(new ArrayList<>());
    open(false);
    decoder.setOnFrameAvailableListener((item, presentationTimeUs) ->
      threads.add(Thread.currentThread().getName()));
    play();
    long until = SystemClock.uptimeMillis() + 1000;
    while (SystemClock.uptimeMillis() < until) {
      pump();
      SystemClock.sleep(16);
    }
    assertTrue("no frame decoded", !threads.isEmpty());
    for (String thread : new ArrayList<>(threads)) {
      assertEquals("ReactNativeSkiaVideo-Codecs", thread);
    }
  }

  @Test
  public void releaseStopsAnEagerDecoderCodecThread() throws Exception {
    open(false);
    play();
    long until = SystemClock.uptimeMillis() + 500;
    while (SystemClock.uptimeMillis() < until) {
      pump();
      SystemClock.sleep(16);
    }
    assertTrue("no codec thread", decoderThreadsAlive());
    handler.removeCallbacksAndMessages(null);
    playback.quitSafely();
    playback.join(2000);
    playback = null;
    decoder.release();
    decoder = null;
    long deadline = SystemClock.uptimeMillis() + 3000;
    while (decoderThreadsAlive() && SystemClock.uptimeMillis() < deadline) {
      SystemClock.sleep(50);
    }
    assertFalse("codec thread still alive after release()", decoderThreadsAlive());
  }

  private void open(boolean lazy) throws Exception {
    open(lazy, MONTAGE);
  }

  private void open(boolean lazy, Clip... clips) throws Exception {
    this.clips = clips;
    composition = composition(video, lazy, clips);
    decoder = new VideoCompositionDecoder(composition, true);
    decoder.setOnErrorListener(errors::add);
    decoder.setOnOpenErrorListener(errors::add);
    decoder.prepare(EGL10.EGL_NO_CONTEXT);
    playback = new HandlerThread("test-playback");
    playback.start();
    handler = new Handler(playback.getLooper());
    onPlayback(decoder::start);
    handler.post(tick);
  }

  private void playThrough(int maxOpenAllowed, boolean allOpen) throws Exception {
    play();
    int checks = 0;
    int maxOpen = 0;
    long endUs = TimeHelpers.secToUs(composition.getDuration()) - 100_000;
    while (positionUs < endUs) {
      Map<String, VideoFrame> frames = pump();
      double time = positionUs / 1e6;
      Clip clip = clipAt(clips, time);
      // Clear of the cut, where "on screen" depends on which thread looked.
      if (clip != null && time - clip.compositionStart > 0.3 && clip.end() - time > 0.1) {
        assertFrameAt(frames, clip, time, PLAYING_SLACK_US);
        checks++;
      }
      maxOpen = Math.max(maxOpen, openCount(decoder, composition));
      SystemClock.sleep(16);
    }
    assertTrue("only " + checks + " frames checked", checks > 50);
    assertTrue("up to " + maxOpen + " decoders open", maxOpen <= maxOpenAllowed);
    if (allOpen) {
      assertEquals(clips.length, maxOpen);
    }
  }

  private void awaitFrame(Clip clip, double time) {
    long deadline = SystemClock.uptimeMillis() + 3000;
    AssertionError last = null;
    while (SystemClock.uptimeMillis() < deadline) {
      try {
        assertFrameAt(pump(), clip, time, PAUSED_SLACK_US);
        return;
      } catch (AssertionError e) {
        last = e;
      }
      SystemClock.sleep(10);
    }
    throw last != null ? last : new AssertionError("no frame for " + clip.id);
  }

  private Map<String, VideoFrame> pump() {
    return new HashMap<>(decoder.updateVideosFrames());
  }

  private void play() throws Exception {
    onPlayback(() -> {
      clockStartNs = System.nanoTime() - positionUs * 1000;
      playing = true;
    });
  }

  /** As VideoCompositionFramesExtractor plays at a signed rate. */
  private void playAt(double signedRate) throws Exception {
    onPlayback(() -> {
      clockStartUs = positionUs;
      clockStartNs = System.nanoTime();
      rate = signedRate;
      playing = true;
      decoder.setPlayback(Shuttle.backwardAt(signedRate, signedRate < 0), signedRate);
    });
  }

  /** As VideoCompositionFramesExtractor#seekInternal does it. */
  private void seek(double seconds) throws Exception {
    long position = TimeHelpers.secToUs(seconds);
    onPlayback(() -> {
      decoder.seekTo(position);
      decoder.updateWindow(position);
      positionUs = position;
      clockStartUs = position;
      clockStartNs = rate == 1 ? System.nanoTime() - position * 1000 : System.nanoTime();
    });
  }

  private void onPlayback(Runnable runnable) throws Exception {
    CountDownLatch done = new CountDownLatch(1);
    handler.post(() -> {
      try {
        runnable.run();
      } finally {
        done.countDown();
      }
    });
    if (!done.await(5, TimeUnit.SECONDS)) {
      fail("the playback thread is stuck");
    }
  }

  private static boolean decoderThreadsAlive() {
    for (Thread thread : Thread.getAllStackTraces().keySet()) {
      String name = thread.getName();
      if (thread.isAlive()
        && (name.equals("ReactNativeSkiaVideo-Opener") || name.equals("ReactNativeSkiaVideo-Codecs"))) {
        return true;
      }
    }
    return false;
  }
}
