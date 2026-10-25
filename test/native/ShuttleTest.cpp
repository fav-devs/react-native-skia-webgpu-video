// Backward and fast playback of the preview (window planning, the frame shown
// for a clock time, the memory budget, catch-up seeks): plain C++, so it
// needs neither Xcode nor a simulator. Same cases as
// android/src/test/java/com/azzapp/rnskv/ShuttleTest.java.
#include "Shuttle.h"
#include "RNSVCheckedSizes.h"

#include <cmath>
#include <cstdio>
#include <limits>
#include <random>
#include <stdexcept>
#include <vector>

using namespace RNSkiaVideo;

static int failures = 0;

static void expect(const char* name, bool got) {
  if (!got) {
    failures++;
  }
  std::printf("%s %s\n", got ? "ok  " : "FAIL", name);
}

static bool near(double got, double want) { return std::fabs(got - want) < 1e-9; }

static const double kNaN = std::numeric_limits<double>::quiet_NaN();

static bool rejectsRate(double rate) {
  try {
    checkedShuttleRate(rate);
  } catch (const std::invalid_argument&) {
    return true;
  }
  return false;
}

// A 30 fps file, frame i at i / 30.
static double frameTime(int i) { return i / 30.0; }

// The frames a reader produces from `window.decodeFrom` (from the frame on
// screen at that time, as a reader started there does), kept as a window does
// (see Shuttle::admit): what the platform decoders do with real frames.
static std::vector<Shuttle::HeldFrame>
decodeWindow(const Shuttle::Window& window, size_t capacity, int frames,
             int* decoded = nullptr) {
  std::vector<Shuttle::HeldFrame> kept;
  bool candidate = false;
  int count = 0;
  for (int i = 0; i < frames; i++) {
    double pts = frameTime(i);
    if (frameTime(i + 1) <= window.decodeFrom + 1e-9) continue;
    count++;
    auto admitted = Shuttle::admit(pts, window);
    if (admitted == Shuttle::Admit::Stop) break;
    if (admitted == Shuttle::Admit::Before) {
      if (candidate) kept.pop_back();
      kept.push_back({pts, 0});
      candidate = true;
      continue;
    }
    candidate = false;
    kept.push_back({pts, 0});
    if (kept.size() > capacity) kept.erase(kept.begin());
  }
  if (decoded) *decoded = count;
  Shuttle::finishWindow(kept, window);
  return kept;
}

int main() {
  // The rate a player accepts.
  expect("1x is kept", checkedShuttleRate(1) == 1);
  expect("backward is kept", checkedShuttleRate(-2.5) == -2.5);
  expect("0 holds", checkedShuttleRate(0) == 0);
  expect("held to 4x forward", checkedShuttleRate(9) == kMaxShuttleRate);
  expect("held to 4x backward", checkedShuttleRate(-100) == -kMaxShuttleRate);
  expect("4 is the documented bound", kMaxShuttleRate == 4);
  for (double rate : {kNaN, std::numeric_limits<double>::infinity(),
                      -std::numeric_limits<double>::infinity()})
    expect("a rate that is not a finite number is refused", rejectsRate(rate));

  // Direction: 0 keeps the decoders reading the way they were.
  expect("negative reads backward", Shuttle::backwardAt(-0.1, false));
  expect("positive reads forward", !Shuttle::backwardAt(0.1, true));
  expect("0 after backward stays backward", Shuttle::backwardAt(0, true));
  expect("0 after forward stays forward", !Shuttle::backwardAt(0, false));

  // The clock.
  expect("forward at 2x", near(Shuttle::clockAt(3, 10, 2, 11, 60), 5));
  expect("backward at 1x", near(Shuttle::clockAt(3, 10, -1, 11, 60), 2));
  expect("0 holds the clock", near(Shuttle::clockAt(3, 10, 0, 50, 60), 3));
  expect("backward stops at 0", Shuttle::clockAt(3, 10, -4, 11, 60) == 0);
  expect("forward stops at the end", Shuttle::clockAt(3, 10, 4, 100, 60) == 60);
  expect("backward reaches the start at 0", Shuttle::reachedStart(0, -1));
  expect("backward not yet at the start", !Shuttle::reachedStart(0.01, -1));
  expect("forward at 0 has not reached anything", !Shuttle::reachedStart(0, 1));
  expect("a hold at 0 is not a stop", !Shuttle::reachedStart(0, 0));

  // The budget: two windows, 32 frames or 64 MB per item.
  expect("small frames: 16 a window", Shuttle::windowCapacity(1280 * 720 * 3 / 2) == 16);
  expect("1080p NV12: 10 a window", Shuttle::windowCapacity(1920 * 1080 * 3 / 2) == 10);
  expect("4K NV12: 2 a window", Shuttle::windowCapacity(3840 * 2160 * 3 / 2) == 2);
  expect("4K BGRA: still one frame", Shuttle::windowCapacity(3840 * 2160 * 4) == 1);
  expect("unknown size: the frame cap", Shuttle::windowCapacity(0) == 16);
  bool bounded = true;
  for (size_t bytes = 1; bytes < 200'000'000; bytes = bytes * 3 / 2 + 1) {
    size_t total = Shuttle::windowCapacity(bytes) * Shuttle::kWindows;
    if (total > Shuttle::kMaxFrames) bounded = false;
    // One frame a window is the least a window holds, whatever its size.
    if (Shuttle::windowCapacity(bytes) > 1 && total * bytes > Shuttle::kMaxBytes)
      bounded = false;
  }
  expect("never more than the frame or byte budget", bounded);

  // Where the next window ends.
  expect("the first window ends at the playhead",
         near(Shuttle::nextEnd(kNaN, 2), 2 + Shuttle::kEndMargin));
  expect("then where the previous one starts", near(Shuttle::nextEnd(1.5, 2), 1.5));
  expect("a clock below the windows skips ahead",
         near(Shuttle::nextEnd(1.5, 1), 1 + Shuttle::kEndMargin));

  // Window planning with sync samples every second (30 frames a group).
  std::vector<double> syncs;
  for (int i = 0; i <= 10; i++) syncs.push_back(i);
  Shuttle::Window window{};
  expect("plans a window", Shuttle::planWindow(5.9, 0, 1 / 30.0, 16, syncs, window));
  expect("a group longer than the window: split", near(window.start, 5.9 - 16 / 30.0));
  expect("decoded from the group's sync sample", near(window.decodeFrom, 5));
  expect("ends where asked", near(window.end, 5.9));
  Shuttle::planWindow(5.5, 0, 1 / 30.0, 16, syncs, window);
  expect("the group's start inside the window: from there",
         near(window.start, 5) && near(window.decodeFrom, 5));
  Shuttle::planWindow(5.2, 0, 1 / 30.0, 16, syncs, window);
  expect("a group that fits is taken whole", near(window.start, 5) && near(window.decodeFrom, 5));
  std::vector<double> shortGroups;
  for (int i = 0; i <= 100; i++) shortGroups.push_back(i * 0.25);
  Shuttle::planWindow(5, 0, 1 / 30.0, 16, shortGroups, window);
  expect("short groups: as many whole groups as fit", near(window.start, 4.5) && near(window.decodeFrom, 4.5));
  expect("nothing before the item's start", !Shuttle::planWindow(3, 3, 1 / 30.0, 16, syncs, window));
  Shuttle::planWindow(3.2, 3.05, 1 / 30.0, 16, syncs, window);
  expect("held to the item's start", near(window.start, 3.05) && near(window.decodeFrom, 3));
  Shuttle::planWindow(5.5, 0, 1 / 30.0, 16, {}, window);
  expect("unknown sync samples: the reader seeks itself",
         near(window.start, 5.5 - 16 / 30.0) && near(window.decodeFrom, window.start));
  Shuttle::planWindow(0.3, 0, 1 / 30.0, 16, {}, window);
  expect("down to the file's start", window.start == 0 && window.decodeFrom == 0);

  // A window keeps the frame on screen at its start, and its last `capacity`.
  Shuttle::planWindow(frameTime(40) + 1e-6, frameTime(25) + 0.001, 1 / 30.0, 32, {}, window);
  auto kept = decodeWindow(window, 32, 300);
  expect("the frame on screen at the item's start is kept", near(kept.front().pts, frameTime(25)));
  expect("up to the playhead's frame", near(kept.back().pts, frameTime(40)));
  expect("its until is the window's end", near(kept.back().until, window.end));
  expect("each frame lasts until the next", near(kept[0].until, frameTime(26)));
  Shuttle::Window narrow{0, frameTime(10), frameTime(30)};
  kept = decodeWindow(narrow, 4, 300);
  expect("a full window keeps its latest frames", kept.size() == 4 && near(kept.front().pts, frameTime(26)));
  expect("it covers from its first kept frame",
         near(Shuttle::finishWindow(kept, narrow), frameTime(26)));
  std::vector<Shuttle::HeldFrame> none;
  expect("an empty window covers from its start", near(Shuttle::finishWindow(none, narrow), frameTime(10)));

  // The frame shown for a clock time, backward.
  std::vector<Shuttle::HeldFrame> frames;
  for (int i = 10; i < 20; i++) frames.push_back({frameTime(i), frameTime(i + 1)});
  auto pick = Shuttle::pickBackward(frames, frameTime(15) + 0.01, kNaN);
  expect("the frame whose interval holds the clock", pick.show == 5);
  expect("the frames after it are released", pick.keep == 5);
  pick = Shuttle::pickBackward(frames, frameTime(15) + 0.01, frameTime(16));
  expect("the next frame back after the one on screen", pick.show == 5);
  pick = Shuttle::pickBackward(frames, frameTime(15) + 0.01, frameTime(15));
  expect("the frame on screen is not shown again", pick.show == -1 && pick.keep == 5);
  pick = Shuttle::pickBackward(frames, frameTime(25), frameTime(30));
  expect("held frames below the clock wait (the clock is coming)",
         pick.show == -1 && pick.keep == 10);
  pick = Shuttle::pickBackward(frames, frameTime(5), frameTime(30));
  expect("a clock below everything decoded: the nearest frame behind it",
         pick.show == 0 && pick.keep == 0);
  std::vector<Shuttle::HeldFrame> gap = {{frameTime(2), frameTime(3)},
                                         {frameTime(8), frameTime(9)}};
  pick = Shuttle::pickBackward(gap, frameTime(5), kNaN);
  expect("in a stretch no window covers: the frame behind, not the one ahead",
         pick.show == 1);
  pick = Shuttle::pickBackward(none, 1, kNaN);
  expect("nothing decoded: nothing shown", pick.show == -1 && pick.keep == 0);

  // A random backward run over windows: the frame shown is never ahead of the
  // clock in the playing direction, never goes forward, and the exact frame
  // whenever it was decoded in time.
  std::mt19937 random(11);
  std::uniform_real_distribution<double> unit(0, 1);
  bool neverAhead = true;
  bool neverForward = true;
  bool exactWhenDecoded = true;
  bool reachesTheStart = true;
  bool neverStalls = true;
  for (int run = 0; run < 400; run++) {
    const int count = 600;
    double floor = frameTime(static_cast<int>(unit(random) * 60));
    double rate = 0.2 + unit(random) * 4;
    double decodePerTick = 0.5 + unit(random) * 8; // frames a tick decodes
    size_t capacity = 1 + static_cast<size_t>(unit(random) * 16);
    std::vector<double> runSyncs;
    double group = 0.2 + unit(random) * 3;
    for (double t = 0; t < count / 30.0; t += group) runSyncs.push_back(t);
    double position = frameTime(count - 1) - unit(random) * 2;
    std::vector<Shuttle::HeldFrame> held;
    std::vector<int> heldWindow;
    double covered = kNaN;
    double shown = kNaN;
    double work = 0;
    bool decoding = false;
    Shuttle::Window pending{};
    int pendingCost = 0;
    int windowId = 0;
    int sinceShown = 0;
    for (int tick = 0; tick < 100000 && position > floor; tick++) {
      // Plan and decode, at most two windows held.
      size_t windows = 0;
      for (size_t i = 0; i < heldWindow.size(); i++)
        if (i == 0 || heldWindow[i] != heldWindow[i - 1]) windows++;
      if (!decoding && windows < Shuttle::kWindows &&
          (std::isnan(covered) || covered > floor) &&
          Shuttle::planWindow(Shuttle::nextEnd(covered, position), floor,
                              1 / 30.0, capacity, runSyncs, pending)) {
        decoding = true;
        decodeWindow(pending, capacity, count, &pendingCost);
        work = 0;
      }
      if (decoding && (work += decodePerTick) >= pendingCost) {
        auto decoded = decodeWindow(pending, capacity, count);
        covered = Shuttle::finishWindow(decoded, pending);
        held.insert(held.begin(), decoded.begin(), decoded.end());
        heldWindow.insert(heldWindow.begin(), decoded.size(), ++windowId);
        decoding = false;
      }
      // Show.
      double clock = position + 1e-6;
      auto chosen = Shuttle::pickBackward(held, clock, shown);
      if (chosen.show >= 0) {
        double pts = held[chosen.show].pts;
        double until = held[chosen.show].until;
        if (until <= position - 1e-9 && pts <= position) neverAhead = false;
        if (!std::isnan(shown) && pts >= shown) neverForward = false;
        shown = pts;
        sinceShown = 0;
      } else if (++sinceShown > 240 && position > floor + 2) {
        // Four seconds at 60 Hz without a new frame, far from the start:
        // the slowest decoder here does a group in under two.
        neverStalls = false;
      }
      size_t from = chosen.keep;
      held.erase(held.begin() + from, held.end());
      heldWindow.erase(heldWindow.begin() + from, heldWindow.end());
      // Every frame at or before the clock that is still held: if one
      // holds the clock, it should have been the one shown.
      for (const auto& frame : held)
        if (frame.pts <= clock && clock < frame.until) exactWhenDecoded = false;
      position = std::max(floor, position - rate / 60);
    }
    // At the item's start, the frame shown at it ends up on screen, once the
    // window being decoded and the ones after it are.
    if (decoding) {
      auto decoded = decodeWindow(pending, capacity, count);
      covered = Shuttle::finishWindow(decoded, pending);
      held.insert(held.begin(), decoded.begin(), decoded.end());
      decoding = false;
    }
    for (int tick = 0; tick < 2000; tick++) {
      size_t windows = held.empty() ? 0 : 1;
      if (!decoding && windows < Shuttle::kWindows &&
          (std::isnan(covered) || covered > floor) &&
          Shuttle::planWindow(Shuttle::nextEnd(covered, floor), floor, 1 / 30.0,
                              capacity, runSyncs, pending)) {
        auto decoded = decodeWindow(pending, capacity, count);
        covered = Shuttle::finishWindow(decoded, pending);
        held.insert(held.begin(), decoded.begin(), decoded.end());
      }
      auto chosen = Shuttle::pickBackward(held, floor + 1e-6, shown);
      if (chosen.show >= 0) shown = held[chosen.show].pts;
      held.erase(held.begin() + chosen.keep, held.end());
    }
    double first = std::floor(floor * 30 + 1e-6) / 30;
    if (!near(shown, first)) reachesTheStart = false;
  }
  expect("never a frame ahead of the clock", neverAhead);
  expect("the picture never moves forward", neverForward);
  expect("the exact frame whenever it is decoded", exactWhenDecoded);
  expect("ends on the item's first frame", reachesTheStart);
  expect("the picture keeps moving however slow the decoder", neverStalls);

  // Catch-up seeks, forward faster than 1x.
  expect("not at 1x", !Shuttle::catchUp(0, 10, 1, kNaN));
  expect("not backward", !Shuttle::catchUp(0, 10, -1, kNaN));
  expect("a little behind at 4x reads on", !Shuttle::catchUp(9, 10, 4, kNaN));
  expect("far behind at 4x seeks", Shuttle::catchUp(7, 10, 4, kNaN));
  expect("not before the last catch-up's frame", !Shuttle::catchUp(5, 10, 4, 6));
  expect("again once it has arrived", Shuttle::catchUp(6, 10, 4, 6));
  expect("nothing decoded yet: no catch-up", !Shuttle::catchUp(kNaN, 10, 4, kNaN));

  std::printf("%s\n", failures == 0 ? "all passed" : "FAILURES");
  return failures == 0 ? 0 : 1;
}
