#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>

namespace RNSkiaVideo {

inline size_t checkedStorageInteger(double value, const char* label) {
  // The JS boundary must stay in the exactly representable integer range;
  // comparing to SIZE_MAX as a double alone rounds that limit up on 64-bit.
  if (!std::isfinite(value) || value < 0 || std::floor(value) != value ||
      value > 9007199254740991.0 ||
      (sizeof(size_t) < 8 && value > static_cast<double>(std::numeric_limits<size_t>::max()))) {
    throw std::invalid_argument(std::string("Invalid ") + label);
  }
  return static_cast<size_t>(value);
}

inline int checkedPositiveInt(double value, const char* label) {
  if (!std::isfinite(value) || value <= 0 || std::floor(value) != value ||
      value > std::numeric_limits<int>::max()) {
    throw std::invalid_argument(std::string("Invalid ") + label);
  }
  return static_cast<int>(value);
}

inline size_t checkedSizeProduct(size_t left, size_t right, const char* label) {
  if (right && left > std::numeric_limits<size_t>::max() / right) {
    throw std::invalid_argument(std::string("Invalid ") + label + ": size overflow");
  }
  return left * right;
}

inline size_t checkedPixelStorage(int width, int height, size_t rowBytes) {
  if (width <= 0 || height <= 0 ||
      rowBytes < checkedSizeProduct(static_cast<size_t>(width), 4, "pixel stride")) {
    throw std::invalid_argument("Invalid pixel dimensions/stride");
  }
  return checkedSizeProduct(rowBytes, static_cast<size_t>(height), "pixel storage");
}

inline double checkedMediaSeconds(double seconds) {
  // All native decode/encode boundaries use a nanosecond CMTime timescale.
  if (!std::isfinite(seconds) || seconds < 0 ||
      seconds >= static_cast<double>(std::numeric_limits<int64_t>::max()) / 1e9) {
    throw std::invalid_argument("Invalid media seconds");
  }
  return seconds;
}

// An item's playbackRate: source seconds per composition second. Zero would
// hold one frame and needs a reader range of its own; not supported.
inline double checkedPlaybackRate(double rate) {
  if (!std::isfinite(rate) || rate <= 0) {
    throw std::invalid_argument("Invalid playbackRate: expected a finite number above 0");
  }
  return rate;
}

// The composition player's playbackRate is held to [-4, 4]: past that the
// decoders mostly skip frames, and backward windows (ios/Shuttle.h) shrink
// to a frame or two.
constexpr double kMaxShuttleRate = 4;

// The composition player's signed playbackRate: negative plays backward, 0
// holds the frame while playing. Held to the range rather than refused, as
// a drag's velocity overshoots it.
inline double checkedShuttleRate(double rate) {
  if (!std::isfinite(rate)) {
    throw std::invalid_argument("Invalid playbackRate: expected a finite number");
  }
  return std::min(std::max(rate, -kMaxShuttleRate), kMaxShuttleRate);
}
} // namespace RNSkiaVideo
