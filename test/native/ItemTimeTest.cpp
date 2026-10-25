// How an item maps composition time to its file's time, at any playbackRate:
// plain C++, so it needs neither Xcode nor a simulator. Same cases as
// android/src/test/java/com/azzapp/rnskv/ItemTimeTest.java.
#include "ItemTime.h"
#include "RNSVCheckedSizes.h"

#include <cmath>
#include <cstdio>
#include <limits>
#include <random>
#include <stdexcept>

namespace ItemTime = RNSkiaVideo::ItemTime;

static int failures = 0;

static void expect(const char* name, bool got) {
  if (!got) {
    failures++;
  }
  std::printf("%s %s\n", got ? "ok  " : "FAIL", name);
}

static bool near(double got, double want) { return std::fabs(got - want) < 1e-9; }

static bool rejectsRate(double rate) {
  try {
    RNSkiaVideo::checkedPlaybackRate(rate);
  } catch (const std::invalid_argument&) {
    return true;
  }
  return false;
}

int main() {
  // An item at 10 s in the composition, reading the file from 3 s.
  expect("1x is the file's own time", near(ItemTime::sourceAt(3, 10, 1, 12), 5));
  expect("2x reads twice as far", near(ItemTime::sourceAt(3, 10, 2, 12), 7));
  expect("0.5x reads half as far", near(ItemTime::sourceAt(3, 10, 0.5, 12), 4));
  expect("the item's start is its startTime at any rate",
         near(ItemTime::sourceAt(3, 10, 4, 10), 3));
  expect("before the item, not held",
         near(ItemTime::sourceAt(3, 10, 2, 9.5), 2));

  expect("1x ends duration on", near(ItemTime::sourceEnd(3, 4, 1), 7));
  expect("2x ends twice the duration on", near(ItemTime::sourceEnd(3, 4, 2), 11));
  expect("0.5x ends half the duration on", near(ItemTime::sourceEnd(3, 4, 0.5), 5));

  // The preview's read-ahead and the seek read-on threshold scale with it.
  expect("a tenth ahead at 1x", near(ItemTime::sourceSpan(0.1, 1), 0.1));
  expect("a fifth ahead at 2x", near(ItemTime::sourceSpan(0.1, 2), 0.2));
  expect("1x is exact", ItemTime::sourceSpan(0.1, 1) == 0.1);

  expect("held to the item's start", ItemTime::heldOffset(10, 4, 9) == 0);
  expect("held to the item's end", ItemTime::heldOffset(10, 4, 20) == 4);
  expect("inside the item", near(ItemTime::heldOffset(10, 4, 11.5), 1.5));

  // The sync extractor seeks a decoder only when its item went back.
  expect("back within the item", ItemTime::movesBack(10, 4, 12, 11));
  expect("forward is never back", !ItemTime::movesBack(10, 4, 11, 12));
  expect("the same time is not back", !ItemTime::movesBack(10, 4, 12, 12));
  expect("from past the end into the item", ItemTime::movesBack(10, 4, 20, 13));
  expect("from inside to before the item", ItemTime::movesBack(10, 4, 12, 5));
  expect("both before the item", !ItemTime::movesBack(10, 4, 9.5, 9));
  expect("both past the end", !ItemTime::movesBack(10, 4, 20, 15));

  std::mt19937 random(7);
  std::uniform_real_distribution<double> unit(0, 1);
  bool monotonic = true;
  bool forwardNeverBack = true;
  for (int i = 0; i < 200000; i++) {
    double start = unit(random) * 20;
    double compositionStart = unit(random) * 20;
    double duration = 0.1 + unit(random) * 10;
    double rate = 0.05 + unit(random) * 8;
    double a = unit(random) * 40;
    double b = a + unit(random) * 5;
    if (ItemTime::sourceAt(start, compositionStart, rate, b) <
        ItemTime::sourceAt(start, compositionStart, rate, a)) {
      monotonic = false;
    }
    if (ItemTime::movesBack(compositionStart, duration, a, b)) {
      forwardNeverBack = false;
    }
  }
  expect("later composition times show later file times", monotonic);
  expect("a later request never seeks back", forwardNeverBack);

  for (double rate : {0.0, -1.0, std::numeric_limits<double>::infinity(),
                      std::numeric_limits<double>::quiet_NaN()}) {
    expect("an invalid rate is refused", rejectsRate(rate));
  }
  expect("a small rate is kept", RNSkiaVideo::checkedPlaybackRate(0.01) == 0.01);
  expect("a large rate is kept", RNSkiaVideo::checkedPlaybackRate(16) == 16);

  std::printf("%s\n", failures == 0 ? "all passed" : "FAILURES");
  return failures == 0 ? 0 : 1;
}
