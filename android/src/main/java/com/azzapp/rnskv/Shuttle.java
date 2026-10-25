package com.azzapp.rnskv;

import java.util.Arrays;

/**
 * Playing a composition at a signed rate (a shuttle): what the preview's
 * decoders do once the player's clock runs backward, or faster than the
 * decoders read. Pure arithmetic, tested on the host (ShuttleTest); same rules
 * as ios/Shuttle.h, in microseconds here and seconds there.
 *
 * A codec only reads forward. Backward, an item is decoded in windows: the
 * stretch of its file just behind the playhead, read from the sync sample
 * (key frame) at or before the window's start and kept from the start on.
 * The window's frames are shown in reverse as the clock goes back over them,
 * while the next window, earlier in the file, is decoded. All times below are
 * the file's (source) times, after the item's own playbackRate.
 */
final class Shuttle {

  private Shuttle() {
  }

  /**
   * Frames an item holds for backward playback at most, over its two windows
   * (the one being shown and the one decoded ahead of it), and the bytes they
   * may take, whichever is lower. Counted against the library's memory budget
   * too, as every frame the decoder snapshots is.
   */
  static final int MAX_FRAMES = 32;
  static final long MAX_BYTES = 64L * 1024 * 1024;

  /** Windows an item holds at once: the one on screen and the next one. */
  static final int WINDOWS = 2;

  /**
   * Forward, faster than 1×: how far behind the clock (in microseconds of
   * wall time) a codec reading on may fall before it is sought to the clock
   * instead. Reading on never skips a frame, so a codec slower than the rate
   * would fall further behind for as long as the clock runs.
   */
  static final long CATCH_UP_LAG_US = 500_000;

  /** How far past the playhead the first window after a seek or a skip ends. */
  static final long END_MARGIN_US = 1_000;

  /** Frames an item's backward window holds, given the size of one frame. */
  static int windowCapacity(long frameBytes) {
    long total = MAX_FRAMES;
    if (frameBytes > 0) total = Math.min(total, MAX_BYTES / frameBytes);
    return (int) Math.max(1, total / WINDOWS);
  }

  /**
   * Whether the codecs read backward at {@code rate} while playing. 0 holds
   * the frame without changing direction, so a drag that stops and goes on the
   * same way keeps its codecs.
   */
  static boolean backwardAt(double rate, boolean previous) {
    return rate < 0 || (rate == 0 && previous);
  }

  /** A stretch of the file to decode backward, see {@link #planWindow}. */
  static final class Window {
    /** Where reading starts: the sync sample at or before start, or start. */
    final long decodeFromUs;
    /** The first time kept (and the frame just before it, see {@link #admit}). */
    final long startUs;
    /** Exclusive: frames from here on belong to the window shown before. */
    final long endUs;

    Window(long decodeFromUs, long startUs, long endUs) {
      this.decodeFromUs = decodeFromUs;
      this.startUs = startUs;
      this.endUs = endUs;
    }
  }

  /** The latest sync sample at or before {@code timeUs}, or -1. */
  static long syncAtOrBefore(long[] syncsUs, long timeUs) {
    int index = upperBound(syncsUs, timeUs);
    return index == 0 ? -1 : syncsUs[index - 1];
  }

  /**
   * Where the next backward window ends: below what earlier windows covered
   * ({@code coveredFromUs}, -1 when nothing yet), and never above the
   * playhead. A clock that has run below the windows (a codec slower than the
   * rate) skips the stretch in between rather than decoding it late.
   */
  static long nextEnd(long coveredFromUs, long positionUs) {
    long end = positionUs + END_MARGIN_US;
    return coveredFromUs < 0 ? end : Math.min(coveredFromUs, end);
  }

  /**
   * The window that ends at {@code endUs}, of at most {@code capacity} frames
   * of {@code frameDurationUs}, for an item whose file starts at
   * {@code floorUs}. With the file's sync samples (ascending; empty when
   * unknown), whole groups of pictures that fit are taken so no frame is
   * decoded twice; a group longer than the window is split, each part decoded
   * from the group's sync sample. Null when the item has nothing left before
   * the end.
   */
  static Window planWindow(long endUs, long floorUs, long frameDurationUs, int capacity,
      long[] syncsUs) {
    if (endUs <= floorUs) return null;
    long duration = frameDurationUs > 0 ? frameDurationUs : 33_333;
    long earliest = endUs - duration * Math.max(1, capacity);
    long start = earliest;
    long decodeFrom = -1;
    if (syncsUs.length > 0) {
      // The group of the frames just below the end, and whether it fits.
      int last = lowerBound(syncsUs, endUs);
      if (last > 0 && syncsUs[last - 1] >= earliest) {
        // The earliest sync sample still inside the window: whole groups.
        start = syncsUs[lowerBound(syncsUs, earliest)];
        decodeFrom = start;
      } else {
        decodeFrom = syncAtOrBefore(syncsUs, start);
      }
    }
    if (start <= floorUs) {
      start = floorUs;
      if (syncsUs.length > 0) decodeFrom = syncAtOrBefore(syncsUs, floorUs);
    }
    // Unknown sync samples: the extractor finds the one before by itself.
    if (decodeFrom < 0 || decodeFrom > start) decodeFrom = start;
    return new Window(decodeFrom, start, endUs);
  }

  /**
   * The file's sync samples, asked one at a time: MediaExtractor has no table
   * of them, but seeks to them (SEEK_TO_PREVIOUS_SYNC, SEEK_TO_NEXT_SYNC).
   */
  interface SyncIndex {
    /** The latest sync sample at or before {@code timeUs}, or -1. */
    long previous(long timeUs);

    /** The earliest sync sample at or after {@code timeUs}, or -1. */
    long next(long timeUs);
  }

  /**
   * {@link #planWindow(long, long, long, int, long[])} from the four sync
   * samples it looks at, asked of {@code index}: the same window as with the
   * file's whole table.
   */
  static Window planWindow(long endUs, long floorUs, long frameDurationUs, int capacity,
      SyncIndex index) {
    if (endUs <= floorUs) return null;
    long duration = frameDurationUs > 0 ? frameDurationUs : 33_333;
    long earliest = endUs - duration * Math.max(1, capacity);
    long[] probes = {
      index.previous(earliest), index.next(earliest), index.previous(endUs - 1),
      index.previous(floorUs),
    };
    long[] syncs = Arrays.stream(probes).filter(time -> time >= 0).sorted().distinct().toArray();
    return planWindow(endUs, floorUs, frameDurationUs, capacity, syncs);
  }

  /** At or past the window's end: reading stops, the frame is not kept. */
  static final int STOP = 0;
  /**
   * Before the window's start: kept only until the next frame, so the frame on
   * screen at the start (the latest at or before it) is in the window.
   */
  static final int BEFORE = 1;
  /** Inside: kept, the oldest frame going if the window is full. */
  static final int INSIDE = 2;

  /** What a window does with a frame its codec produced: STOP, BEFORE or INSIDE. */
  static int admit(long ptsUs, Window window) {
    if (ptsUs >= window.endUs) return STOP;
    if (ptsUs < window.startUs) return BEFORE;
    return INSIDE;
  }

  /**
   * Where each frame of a fully decoded window (ascending) stops being the one
   * to show: the next frame, or the window's end for its last one.
   */
  static long[] untilOf(long[] ptsUs, Window window) {
    long[] until = new long[ptsUs.length];
    for (int i = 0; i < ptsUs.length; i++) {
      until[i] = i + 1 < ptsUs.length ? ptsUs[i + 1] : window.endUs;
    }
    return until;
  }

  /** What a decoded window covers from: its first frame, or its start when it produced none. */
  static long coveredFrom(long[] ptsUs, Window window) {
    return ptsUs.length == 0 ? window.startUs : ptsUs[0];
  }

  /**
   * Which held frame to show for the clock's file time {@code positionUs},
   * playing backward, among the frames of fully decoded windows: their times
   * ({@code ptsUs}, ascending) and where each stops ({@code untilUs}).
   * {@code shownUs} is the time of the frame on screen, or -1 when there is
   * none (a seek, a new codec).
   *
   * The frame whose interval holds the clock when it is decoded. Otherwise the
   * clock has run below what is decoded (a codec slower than the rate), and the
   * earliest frame still at or after the clock is shown: never a frame ahead
   * of the clock in the playing direction, never one already passed.
   *
   * @return {show, keep}: the index of the frame to show, or -1 to keep the one
   * on screen; frames from {@code keep} on are released (but show, which is
   * taken): the clock has gone back past them, or they are at or after the
   * frame on screen
   */
  static int[] pickBackward(long[] ptsUs, long[] untilUs, int count, long positionUs,
      long shownUs) {
    int limit = count;
    if (shownUs >= 0) {
      // A frame at or after the one on screen is behind it: backward, the
      // picture never moves forward.
      limit = 0;
      while (limit < count && ptsUs[limit] < shownUs) limit++;
    }
    int at = 0;
    while (at < limit && ptsUs[at] <= positionUs) at++;
    if (at > 0 && positionUs < untilUs[at - 1]) {
      return new int[]{at - 1, at - 1};
    }
    if (at < limit) {
      // Every frame left is after the clock, or the clock is in a stretch no
      // window covers: the nearest one behind it.
      return new int[]{at, at};
    }
    return new int[]{-1, limit};
  }

  /**
   * Forward: whether a codec whose latest frame is at {@code decodedUs} should
   * be sought to the clock's {@code positionUs} rather than read on. Only
   * faster than 1× ({@code rate} is the player's), and not while the previous
   * catch-up seek, to {@code pendingTargetUs} (-1 when none), has not produced
   * its frame yet: a codec restarts at the sync sample before its target, so
   * it is always behind just after a seek.
   */
  static boolean catchUp(long decodedUs, long positionUs, double rate, long pendingTargetUs) {
    double speed = Math.abs(rate);
    if (!(speed > 1) || decodedUs < 0) return false;
    if (pendingTargetUs >= 0 && decodedUs < pendingTargetUs) return false;
    return positionUs - decodedUs > CATCH_UP_LAG_US * speed;
  }

  /**
   * Whether a clock running at {@code rate} has reached the start of the
   * composition: playing backward stops there, holding its first frame.
   */
  static boolean reachedStart(long positionUs, double rate) {
    return rate < 0 && positionUs <= 0;
  }

  /**
   * The player's clock: {@code anchorUs} of composition time at
   * {@code anchorMicros} of {@code System.nanoTime() / 1000}, moving
   * {@code rate} microseconds per microsecond. Immutable, so the threads that
   * read it see a rate and an anchor that go together.
   */
  static final class Clock {
    final long anchorUs;
    final long anchorMicros;
    final double rate;

    Clock(long anchorUs, long anchorMicros, double rate) {
      this.anchorUs = anchorUs;
      this.anchorMicros = anchorMicros;
      this.rate = rate;
    }

    /** The composition time at {@code micros}, held to [0, durationUs]. */
    long at(long micros, long durationUs) {
      long elapsed = micros - anchorMicros;
      long time = anchorUs + (rate == 1 ? elapsed : Math.round(elapsed * rate));
      return Math.min(Math.max(time, 0), durationUs);
    }
  }

  private static int lowerBound(long[] values, long value) {
    int low = 0;
    int high = values.length;
    while (low < high) {
      int mid = (low + high) >>> 1;
      if (values[mid] < value) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private static int upperBound(long[] values, long value) {
    int low = 0;
    int high = values.length;
    while (low < high) {
      int mid = (low + high) >>> 1;
      if (values[mid] <= value) low = mid + 1;
      else high = mid;
    }
    return low;
  }
}
