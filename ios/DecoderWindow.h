#pragma once

#include <algorithm>

namespace RNSkiaVideo {

/**
 * When an item's decoder is open, for a composition with lazy decoders: from a
 * little before the item starts to a little after it ends. Without lazy
 * decoders every decoder is open for the life of the player. Same numbers as
 * android/.../DecoderWindow.java.
 */
class DecoderWindow {
public:
  DecoderWindow(bool lazy, bool realTime)
      : lazy(lazy), lead(realTime ? kPreviewLead : kExportLead) {}

  bool isLazy() const { return lazy; }

  /**
   * Playing `backward` (see Shuttle.h), the lead is past the item's end, the
   * side the playhead comes from; there is no loop backward. Faster than 1×
   * (`speed`, the rate's magnitude), the lead is as long in wall time as at
   * 1×.
   */
  bool opens(double start, double end, double position, double duration,
             bool looping, bool backward = false, double speed = 1) const {
    if (!lazy) return true;
    double ahead = leadAt(speed);
    if (backward) return within(start, end + ahead, position, duration, false);
    return within(start - ahead, end, position, duration, looping);
  }

  /** Wider than opens, so an item is never closed and reopened at one edge. */
  bool keeps(double start, double end, double position, double duration,
             bool looping, bool backward = false, double speed = 1) const {
    if (!lazy) return true;
    double ahead = leadAt(speed);
    if (backward)
      return within(start - kMargin, end + ahead + kMargin, position, duration,
                    false);
    return within(start - ahead - kMargin, end + kMargin, position, duration,
                  looping);
  }

private:
  // The preview has to open a reader and decode the first frame before the
  // item is on screen; the export waits for it anyway. Chosen, not measured.
  static constexpr double kPreviewLead = 1.5;
  static constexpr double kExportLead = 0.5;
  // Kept a little past both ends, so a scrub across a cut does not reopen it.
  static constexpr double kMargin = 0.5;

  bool lazy;
  double lead;

  double leadAt(double speed) const { return lead * std::max(1.0, speed); }

  static bool within(double from, double to, double position, double duration,
                     bool looping) {
    if (position >= from && position < to) {
      return true;
    }
    // Near the end of a loop, the items at the start come next.
    double wrapped = position - duration;
    return looping && wrapped >= from && wrapped < to;
  }
};

} // namespace RNSkiaVideo
