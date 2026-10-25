package com.azzapp.rnskv;

/**
 * How an item's composition time maps to its file's time. An item plays
 * {@code playbackRate} source seconds per composition second: composition
 * time t shows the file at
 *
 * <pre>startTime + (t - compositionStartTime) * playbackRate</pre>
 *
 * and the item reads [startTime, startTime + duration * playbackRate] of the
 * file. The duration, and every decoder window, stay in composition time.
 * Same rules as ios/ItemTime.h.
 */
final class ItemTime {

  private ItemTime() {
  }

  /**
   * The file microseconds the item plays over {@code compositionUs} of it:
   * exactly {@code compositionUs} at 1×.
   */
  static long sourceSpanUs(long compositionUs, double playbackRate) {
    return Math.round(compositionUs * playbackRate);
  }

  /** The composition time into the item, held to [0, duration]. */
  static long heldOffsetUs(long compositionStartUs, long durationUs, long timeUs) {
    return Math.min(Math.max(timeUs - compositionStartUs, 0), durationUs);
  }

  /**
   * Whether a request at {@code targetUs}, after one at {@code lastUs}, needs
   * a frame the item's codec has already released: its position, held to the
   * item, went back. Before the item both show its first frame, past it both
   * its last.
   */
  static boolean movesBack(long compositionStartUs, long durationUs, long lastUs, long targetUs) {
    return heldOffsetUs(compositionStartUs, durationUs, targetUs)
      < heldOffsetUs(compositionStartUs, durationUs, lastUs);
  }
}
