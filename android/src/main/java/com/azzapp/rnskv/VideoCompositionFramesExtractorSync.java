package com.azzapp.rnskv;

import android.opengl.GLES20;
import android.os.Handler;
import android.os.HandlerThread;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import javax.microedition.khronos.egl.EGLContext;
import javax.microedition.khronos.egl.EGL10;

public class VideoCompositionFramesExtractorSync {
  private final VideoComposition composition;

  private final VideoCompositionDecoder decoder;

  private boolean decoding = false;
  private long decodingTimeUs;

  private final Map<VideoComposition.Item, Long> itemsTimes = new HashMap<>();

  private final Set<VideoComposition.Item> itemsEnded = new HashSet<>();

  /** The composition time each open item was last asked for. */
  private final Map<VideoComposition.Item, Long> requestedTimes = new HashMap<>();

  private final Map<String, Long> renderedTimes = new HashMap<>();

  private HandlerThread exportThread = null;

  private Handler handler;

  private static final long DECODE_TIMEOUT_MS = 30000;
  private final DecodeRequests<Map<String, VideoFrame>> requests =
    new DecodeRequests<>(VideoCompositionDecoder::closeFrames);
  private volatile CompletableFuture<Void> startup;

  public VideoCompositionFramesExtractorSync(VideoComposition composition) {
    this.composition = composition;
    this.decoder = new VideoCompositionDecoder(composition, false);
  }

  public void start() throws Exception {
    final CompletableFuture<Void> initializing;
    synchronized (this) {
      if (requests.isClosed()) throw new IllegalStateException("Video decoder has been released");
      if (startup == null) {
        exportThread = new HandlerThread("ReactNativeSkiaVideo-ExportThread");
        exportThread.start();
        handler = new Handler(exportThread.getLooper());
        startup = new CompletableFuture<>();
        final CompletableFuture<Void> started = startup;
        if (!handler.post(() -> {
          try {
            if (requests.isClosed()) throw new IllegalStateException("Video decoder has been released");
            decoder.prepare(EGL10.EGL_NO_CONTEXT);
            decoder.setOnErrorListener(this::handleError);
            decoder.setOnFrameAvailableListener(this::onFrameAvailable);
            decoder.setOnItemEndReachedListener(this::onItemEndReached);
            decoder.setOnItemImageAvailableListener(this::onItemImageAvailable);
            decoder.start();
            started.complete(null);
          } catch (Exception error) {
            handleError(error);
            started.completeExceptionally(error);
          }
        })) started.completeExceptionally(new IllegalStateException("Export looper rejected startup"));
      }
      initializing = startup;
    }
    try { initializing.get(DECODE_TIMEOUT_MS, TimeUnit.MILLISECONDS); }
    catch (Exception error) { release(); throw error; }
  }

  /**
   * Decode the next frame of each composition item according to the current position of the player.
   *
   * @return a map of item id to video frame
   */
  public Map<String, VideoFrame> decodeCompositionFrames(double time) throws Exception {
    final CompletableFuture<Map<String, VideoFrame>> request;
    final long targetUs = TimeHelpers.secToUs(time);
    synchronized (this) {
      if (handler == null || startup == null || !startup.isDone()) {
        throw new IllegalStateException("Video decoder is not started");
      }
      request = requests.begin();
      if (!handler.post(() -> {
        if (requests.isClosed()) return;
        try {
          decodingTimeUs = targetUs;
          decoder.updateWindow(decodingTimeUs);
          forgetClosedItems();
          seekItemsBack(decodingTimeUs);
          decoding = true;
          renderedTimes.clear();
          checkIfFrameDecoded();
        } catch (Exception error) { handleError(error); }
      })) requests.fail(new IllegalStateException("Export looper rejected decode request"));
    }
    try { return requests.await(request, DECODE_TIMEOUT_MS); }
    catch (Exception error) { release(); throw error; }
  }

  public void release() {
    final Handler ownedHandler;
    final HandlerThread ownedThread;
    synchronized (this) {
      if (requests.isClosed() && handler == null) return;
      requests.close();
      if (startup != null) startup.cancel(true);
      ownedHandler = handler;
      ownedThread = exportThread;
      handler = null;
      exportThread = null;
    }
    if (ownedHandler != null) {
      // The decoder's EGL context and GL resources are bound to the export
      // thread (where they are current); releasing them from another thread
      // would silently fail the GL deletes and defer the EGL context
      // destruction. Release on the export thread, then let the looper
      // drain and quit.
      if (!ownedHandler.post(decoder::release)) decoder.release();
      if (ownedThread != null) ownedThread.quitSafely();
    } else {
      decoder.release();
      if (ownedThread != null) ownedThread.quit();
    }
  }

  /**
   * With lazy decoders, an item reopened later must wait for its own frames.
   */
  private void forgetClosedItems() {
    for (VideoComposition.Item item : composition.getItems()) {
      if (item.isVideo() && !decoder.isOpen(item)) {
        itemsTimes.remove(item);
        itemsEnded.remove(item);
        requestedTimes.remove(item);
      }
    }
  }

  /**
   * A request earlier than an item's last one: its codec has released the
   * frames up to the last one, so it starts again from the key frame before
   * the new time, as a preview seek does. What it had decoded and whether it
   * had ended no longer hold. Items whose position held to their range has not
   * moved keep their codec: one past its end or not started yet shows the
   * same frame either way.
   */
  private void seekItemsBack(long targetUs) {
    for (VideoComposition.Item item : composition.getItems()) {
      if (!item.isVideo() || !decoder.isOpen(item)) {
        continue;
      }
      Long lastUs = requestedTimes.put(item, targetUs);
      if (lastUs != null && ItemTime.movesBack(
        TimeHelpers.secToUs(item.getCompositionStartTime()),
        TimeHelpers.secToUs(item.getDuration()), lastUs, targetUs)) {
        decoder.seekItem(item, targetUs);
        itemsTimes.remove(item);
        itemsEnded.remove(item);
      }
    }
  }

  private void onFrameAvailable(VideoComposition.Item item, long presentationTimeUs) {
    if (requests.isClosed()) return;
    try {
      itemsTimes.put(item, presentationTimeUs);
      if (decoding) checkIfFrameDecoded();
    } catch (Exception error) { handleError(error); }
  }

  private void onItemEndReached(VideoComposition.Item item) {
    if (requests.isClosed()) return;
    try {
      itemsEnded.add(item);
      if (decoding) checkIfFrameDecoded();
    } catch (Exception error) { handleError(error); }
  }

  private void checkIfFrameDecoded() {
    boolean allItemsReady = true;
    for (VideoComposition.Item item : composition.getItems()) {
      if (!item.isVideo() || !decoder.isOpen(item)) {
        continue;
      }
      // Before the frame check: an item that ends without a single frame in
      // its range (a start past the file's end) would otherwise hold the
      // export forever.
      if (itemsEnded.contains(item)) {
        continue;
      }
      if (!itemsTimes.containsKey(item)) {
        allItemsReady = false;
        continue;
      }
      Long itemTime = itemsTimes.get(item);
      if (itemTime == null) {
        allItemsReady = false;
        continue;
      }
      long itemCurrentTimeUs = itemTime;
      if (itemCurrentTimeUs < item.sourceTimeUs(decodingTimeUs)) {
        allItemsReady = false;
      }
    }
    Map<String, Long> renderedTimes = decoder.render(decodingTimeUs);
    renderedTimes.forEach((itemId, time) -> {
      if (time != null) {
        this.renderedTimes.put(itemId, time);
      }
    });
    if (allItemsReady) {
      decoding = false;
      resolveIfReady();
    }
  }

  private void onItemImageAvailable(VideoComposition.Item item) {
    if (requests.isClosed()) return;
    try {
      if (!decoding) resolveIfReady();
    } catch (Exception error) { handleError(error); }
  }

  private void handleError(Exception e) {
    requests.fail(e);
    CompletableFuture<Void> initializing = startup;
    if (initializing != null) initializing.completeExceptionally(e);
  }

  private void resolveIfReady() {
    if (!requests.isPending()) return;
    Map<String, VideoFrame> videoFrames = decoder.updateInternalFrames();
    for (VideoComposition.Item item : composition.getItems()) {
      if (!item.isVideo() || !decoder.isOpen(item)) {
        continue;
      }
      VideoFrame videoFrame = videoFrames.getOrDefault(item.getId(), null);
      if (videoFrame == null) {
        if (itemsEnded.contains(item) && !itemsTimes.containsKey(item)) {
          // Ended without a frame: there will never be one to wait for.
          continue;
        }
        return;
      }
      Long itemFrameTime = renderedTimes.getOrDefault(item.getId(), null);
      if (itemFrameTime == null) {
        continue;
      }
      long videoFrameTime = TimeHelpers.nsecToUs(videoFrame.getTimestampNs());
      if (Math.abs(itemFrameTime - videoFrameTime) > 1000) {
        return;
      }
    }
    // Never publish the producer's owning wrappers. The completed request owns
    // these aliases until await hands them over, or cancellation discards them.
    requests.complete(VideoCompositionDecoder.retainFrames(videoFrames));
  }
}
