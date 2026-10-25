#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <vector>

namespace RNSkiaVideo {

/**
 * Playing a composition at a signed rate (a shuttle): what the preview's
 * decoders do once the player's clock runs backward, or faster than the
 * decoders read. Pure arithmetic, so it is tested on the host
 * (test/native/ShuttleTest.cpp); same rules as android/.../Shuttle.java, in
 * seconds here and microseconds there.
 *
 * A decoder only reads forward. Backward, an item is decoded in windows: the
 * stretch of its file just behind the playhead, read from the sync sample
 * (key frame) at or before the window's start and kept from the start on.
 * The window's frames are shown in reverse as the clock goes back over them,
 * while the next window, earlier in the file, is decoded. All times below are
 * the file's (source) times, after the item's own playbackRate.
 */
namespace Shuttle {

/**
 * Frames an item holds for backward playback at most, over its two windows
 * (the one being shown and the one decoded ahead of it), and the bytes they
 * may take, whichever is lower. Counted against the library's memory budget
 * too, frame by frame, as the forward queue is.
 */
constexpr size_t kMaxFrames = 32;
constexpr size_t kMaxBytes = 64ULL * 1024 * 1024;

/** Windows an item holds at once: the one on screen and the next one. */
constexpr size_t kWindows = 2;

/**
 * Forward, faster than 1×: how far behind the clock (in seconds of wall
 * time) a decoder reading on may fall before it is sought to the clock
 * instead. Reading on never skips a frame, so a decoder slower than the rate
 * would fall further behind for as long as the clock runs.
 */
constexpr double kCatchUpLagSeconds = 0.5;

/** How far past the playhead the first window after a seek or a skip ends. */
constexpr double kEndMargin = 1e-3;

/** Frames an item's backward window holds, given the size of one frame. */
inline size_t windowCapacity(size_t frameBytes) {
  size_t total = kMaxFrames;
  if (frameBytes > 0) total = std::min(total, kMaxBytes / frameBytes);
  return std::max<size_t>(1, total / kWindows);
}

/**
 * Whether the decoders read backward at `rate` while playing. 0 holds the
 * frame without changing direction, so a drag that stops and goes on the same
 * way keeps its decoders.
 */
inline bool backwardAt(double rate, bool previous) {
  return rate < 0 || (rate == 0 && previous);
}

/** A stretch of the file to decode backward, see planWindow. */
struct Window {
  /** Where reading starts: the sync sample at or before `start`, or `start`. */
  double decodeFrom;
  /** The first time kept (and the frame just before it, see admit). */
  double start;
  /** Exclusive: frames from here on belong to the window shown before. */
  double end;
};

/** The latest sync sample at or before `time`, or NaN. */
inline double syncAtOrBefore(const std::vector<double>& syncs, double time) {
  auto it = std::upper_bound(syncs.begin(), syncs.end(), time);
  return it == syncs.begin() ? std::numeric_limits<double>::quiet_NaN()
                             : *std::prev(it);
}

/**
 * Where the next backward window ends: below what earlier windows covered
 * (`coveredFrom`, NaN when nothing yet), and never above the playhead. A
 * clock that has run below the windows (a decoder slower than the rate) skips
 * the stretch in between rather than decoding it late.
 */
inline double nextEnd(double coveredFrom, double position) {
  // Just past the playhead, so the frame at the playhead is in the window and
  // a clock a microsecond past its time (see acquireFrameForTime) is too.
  double end = position + kEndMargin;
  return std::isnan(coveredFrom) ? end : std::min(coveredFrom, end);
}

/**
 * The window that ends at `end`, of at most `capacity` frames of
 * `frameDuration`, for an item whose file starts at `floor`. With the file's
 * sync samples (ascending; empty when unknown), whole groups of pictures
 * that fit are taken so no frame is decoded twice; a group longer than the
 * window is split, each part decoded from the group's sync sample. False
 * when the item has nothing left before `end`.
 */
inline bool planWindow(double end, double floor, double frameDuration,
                       size_t capacity, const std::vector<double>& syncs,
                       Window& out) {
  if (!(end > floor)) return false;
  double duration = frameDuration > 0 ? frameDuration : 1.0 / 30;
  double earliest = end - duration * static_cast<double>(std::max<size_t>(1, capacity));
  double start = earliest;
  double decodeFrom = std::numeric_limits<double>::quiet_NaN();
  if (!syncs.empty()) {
    // The group of the frames just below the end, and whether it fits.
    auto last = std::lower_bound(syncs.begin(), syncs.end(), end);
    if (last != syncs.begin() && *std::prev(last) >= earliest) {
      // The earliest sync sample still inside the window: whole groups.
      start = *std::lower_bound(syncs.begin(), syncs.end(), earliest);
      decodeFrom = start;
    } else {
      decodeFrom = syncAtOrBefore(syncs, start);
    }
  }
  if (start <= floor) {
    start = floor;
    if (!syncs.empty()) decodeFrom = syncAtOrBefore(syncs, floor);
  }
  // Unknown sync samples: the platform reader finds the one before itself.
  if (std::isnan(decodeFrom) || decodeFrom > start) decodeFrom = start;
  out = Window{decodeFrom, start, end};
  return true;
}

/** What a window does with a frame its reader produced, see admit. */
enum class Admit {
  /** At or past the window's end: reading stops, the frame is not kept. */
  Stop,
  /**
   * Before the window's start: kept only until the next frame, so the frame
   * on screen at `start` (the latest at or before it) is in the window.
   */
  Before,
  /** Inside: kept, the oldest frame going if the window is full. */
  Inside,
};

inline Admit admit(double pts, const Window& window) {
  if (pts >= window.end) return Admit::Stop;
  if (pts < window.start) return Admit::Before;
  return Admit::Inside;
}

/** A frame of a decoded window, held for backward playback. */
struct HeldFrame {
  double pts;
  /**
   * Where the frame stops being the one to show: the next frame of its
   * window, or the window's end for its last frame.
   */
  double until;
};

/**
 * Sets `until` on a window's frames (ascending), once it is fully decoded.
 * Also what the window covers from: its first frame, or its start when it
 * produced none.
 */
template <typename Frame>
inline double finishWindow(std::vector<Frame>& frames, const Window& window) {
  for (size_t i = 0; i < frames.size(); i++)
    frames[i].until = i + 1 < frames.size() ? frames[i + 1].pts : window.end;
  return frames.empty() ? window.start : frames.front().pts;
}

/** Which held frame to show next, see pickBackward. */
struct Pick {
  /** The index of the frame to show, or -1 to keep the one on screen. */
  long show;
  /**
   * Frames from this index on are released (but `show`, which is taken):
   * the clock has gone back past them, or they are at or after the frame
   * on screen.
   */
  size_t keep;
};

/**
 * The frame to show for the clock's file time `position`, playing backward,
 * among the frames of fully decoded windows (ascending). `shown` is the time
 * of the frame on screen, NaN when there is none (a seek, a new decoder).
 *
 * The frame whose interval holds the clock when it is decoded. Otherwise the
 * clock has run below what is decoded (a decoder slower than the rate), and
 * the earliest frame still at or after the clock is shown: never a frame
 * ahead of the clock in the playing direction, never one already passed.
 */
template <typename Frame>
inline Pick pickBackward(const std::vector<Frame>& frames, double position,
                         double shown) {
  size_t limit = frames.size();
  if (!std::isnan(shown)) {
    // A frame at or after the one on screen is behind it: backward, the
    // picture never moves forward.
    limit = 0;
    while (limit < frames.size() && frames[limit].pts < shown) limit++;
  }
  // The frames at or before the clock.
  size_t at = 0;
  while (at < limit && frames[at].pts <= position) at++;
  if (at > 0 && position < frames[at - 1].until) {
    return Pick{static_cast<long>(at - 1), at - 1};
  }
  if (at < limit) {
    // Every frame left is after the clock, or the clock is in a stretch no
    // window covers: the nearest one behind it.
    return Pick{static_cast<long>(at), at};
  }
  return Pick{-1, limit};
}

/**
 * Forward: whether a decoder whose latest frame is at `decoded` should be
 * sought to the clock's `position` rather than read on. Only faster than 1×
 * (`rate` is the player's), and not while the previous catch-up seek, to
 * `pendingTarget` (NaN when none), has not produced its frame yet: a
 * decoder restarts at the sync sample before its target, so it is always
 * behind just after a seek.
 */
inline bool catchUp(double decoded, double position, double rate,
                    double pendingTarget) {
  double speed = std::fabs(rate);
  if (!(speed > 1) || std::isnan(decoded)) return false;
  if (!std::isnan(pendingTarget) && decoded < pendingTarget) return false;
  return position - decoded > kCatchUpLagSeconds * speed;
}

/**
 * Whether a clock running at `rate` from `position` has reached the start of
 * the composition: playing backward stops there, holding its first frame.
 */
inline bool reachedStart(double position, double rate) {
  return rate < 0 && position <= 0;
}

/**
 * The player's clock: `anchor` (composition seconds) at host time
 * `anchorHost`, moving `rate` seconds per second. Held to [0, duration].
 */
inline double clockAt(double anchor, double anchorHost, double rate,
                      double now, double duration) {
  double time = anchor + rate * (now - anchorHost);
  return std::min(std::max(time, 0.0), duration);
}

} // namespace Shuttle

} // namespace RNSkiaVideo
