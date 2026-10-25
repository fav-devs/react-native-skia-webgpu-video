#pragma once

#include <algorithm>

namespace RNSkiaVideo {

/**
 * How an item's composition time maps to its file's time. An item plays
 * `playbackRate` source seconds per composition second: composition time t
 * shows the file at
 *
 *   startTime + (t - compositionStartTime) * playbackRate
 *
 * and the item reads [startTime, startTime + duration * playbackRate] of the
 * file. `duration`, and every decoder window, stay in composition time. Same
 * rules as android/.../ItemTime.java.
 */
namespace ItemTime {

/** The file seconds the item plays over `compositionSeconds` of it. */
inline double sourceSpan(double compositionSeconds, double playbackRate) {
  return compositionSeconds * playbackRate;
}

/** The file time shown at composition time `t`, not held to the item. */
inline double sourceAt(double startTime, double compositionStartTime,
                       double playbackRate, double t) {
  return startTime + sourceSpan(t - compositionStartTime, playbackRate);
}

/** Where the item's file range ends. */
inline double sourceEnd(double startTime, double duration,
                        double playbackRate) {
  return startTime + sourceSpan(duration, playbackRate);
}

/** The composition time into the item, held to [0, duration]. */
inline double heldOffset(double compositionStartTime, double duration,
                         double t) {
  return std::min(std::max(t - compositionStartTime, 0.0), duration);
}

/**
 * Whether a request at `target`, after one at `last`, needs a frame the
 * item's decoder has already gone past: its position, held to the item, went
 * back. Before the item both show its first frame, past it both its last.
 */
inline bool movesBack(double compositionStartTime, double duration,
                      double last, double target) {
  return heldOffset(compositionStartTime, duration, target) <
         heldOffset(compositionStartTime, duration, last);
}

} // namespace ItemTime

} // namespace RNSkiaVideo
