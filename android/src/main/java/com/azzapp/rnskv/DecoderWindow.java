package com.azzapp.rnskv;

/**
 * When an item's decoder is open, for a composition with lazy decoders: from a
 * little before the item starts to a little after it ends. Without lazy
 * decoders every decoder is open for the life of the player.
 *
 * Unlike iOS, no read-ahead over a loop's wrap: the wrap seeks every decoder
 * back to 0, so one opened early would only race through its item meanwhile.
 */
final class DecoderWindow {

  // The preview has to open a codec and decode to the first frame before the
  // item is on screen; the export waits for it anyway. Chosen, not measured.
  private static final long PREVIEW_LEAD_US = 1_500_000;
  private static final long EXPORT_LEAD_US = 500_000;

  // Kept a little past both ends, so a scrub across a cut does not reopen it.
  private static final long MARGIN_US = 500_000;

  private final boolean lazy;

  private final long leadUs;

  private DecoderWindow(boolean lazy, long leadUs) {
    this.lazy = lazy;
    this.leadUs = leadUs;
  }

  static DecoderWindow of(boolean lazy, boolean realTime) {
    return new DecoderWindow(lazy, realTime ? PREVIEW_LEAD_US : EXPORT_LEAD_US);
  }

  boolean isLazy() {
    return lazy;
  }

  /**
   * @param startUs    the item's start in the composition
   * @param endUs      the item's end in the composition
   * @param positionUs the composition time
   */
  boolean opens(long startUs, long endUs, long positionUs) {
    return opens(startUs, endUs, positionUs, false, 1);
  }

  /**
   * Wider than {@link #opens}, so an item is never closed and reopened on
   * either side of the same edge.
   */
  boolean keeps(long startUs, long endUs, long positionUs) {
    return keeps(startUs, endUs, positionUs, false, 1);
  }

  /**
   * Playing {@code backward} (see {@link Shuttle}), the lead is past the
   * item's end, the side the playhead comes from. Faster than 1×
   * ({@code speed}, the rate's magnitude), the lead is as long in wall time as
   * at 1×.
   */
  boolean opens(long startUs, long endUs, long positionUs, boolean backward, double speed) {
    if (!lazy) return true;
    long ahead = leadAt(speed);
    if (backward) return positionUs >= startUs && positionUs < endUs + ahead;
    return positionUs >= startUs - ahead && positionUs < endUs;
  }

  boolean keeps(long startUs, long endUs, long positionUs, boolean backward, double speed) {
    if (!lazy) return true;
    long ahead = leadAt(speed);
    if (backward) {
      return positionUs >= startUs - MARGIN_US && positionUs < endUs + ahead + MARGIN_US;
    }
    return positionUs >= startUs - ahead - MARGIN_US && positionUs < endUs + MARGIN_US;
  }

  private long leadAt(double speed) {
    return speed > 1 ? Math.round(leadUs * speed) : leadUs;
  }
}
