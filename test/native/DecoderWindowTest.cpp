// The iOS decoder window, built with the host compiler and run in CI: it is
// plain C++, so it needs neither Xcode nor a simulator.
#include "DecoderWindow.h"

#include <cstdio>
#include <initializer_list>
#include <random>

using RNSkiaVideo::DecoderWindow;

static int failures = 0;

static void expect(const char* name, bool got, bool want) {
  if (got != want) {
    failures++;
  }
  std::printf("%s %s\n", got == want ? "ok  " : "FAIL", name);
}

int main() {
  DecoderWindow eager(false, true);
  DecoderWindow preview(true, true);
  DecoderWindow exportWindow(true, false);
  const double duration = 60;

  expect("eager opens far away", eager.opens(10, 20, 50, duration, false),
         true);
  expect("eager keeps far away", eager.keeps(10, 20, 50, duration, false),
         true);
  expect("preview opens 1.5s ahead",
         preview.opens(10, 20, 8.5, duration, false), true);
  expect("preview not 1.6s ahead", preview.opens(10, 20, 8.4, duration, false),
         false);
  expect("preview does not open at its end",
         preview.opens(10, 20, 20, duration, false), false);
  expect("preview keeps 0.4s past the end",
         preview.keeps(10, 20, 20.4, duration, false), true);
  expect("preview drops 0.5s past the end",
         preview.keeps(10, 20, 20.5, duration, false), false);
  expect("preview drops before the lead and margin",
         preview.keeps(10, 20, 7.99, duration, false), false);
  expect("export opens 0.5s ahead",
         exportWindow.opens(10, 20, 9.5, duration, false), true);
  expect("export not 0.6s ahead",
         exportWindow.opens(10, 20, 9.4, duration, false), false);
  expect("looping opens the first item near the end",
         preview.opens(0, 5, 59, duration, true), true);
  expect("not without looping", preview.opens(0, 5, 59, duration, false),
         false);

  // Playing backward (a shuttle), the lead is past the item's end.
  expect("backward opens within 1.5s past the end",
         preview.opens(10, 20, 21.4, duration, false, true), true);
  expect("backward not 1.5s past the end",
         preview.opens(10, 20, 21.5, duration, false, true), false);
  expect("backward does not open ahead of the start",
         preview.opens(10, 20, 9, duration, false, true), false);
  expect("backward keeps a little before the start",
         preview.keeps(10, 20, 9.6, duration, false, true), true);
  expect("backward drops past the margin before the start",
         preview.keeps(10, 20, 9.4, duration, false, true), false);
  expect("no loop backward", preview.opens(0, 5, 59, duration, true, true),
         false);
  expect("at 4x the lead is 6s", preview.opens(10, 20, 4, duration, false, false, 4),
         true);
  expect("backward at 4x too", preview.opens(10, 20, 25.9, duration, false, true, 4),
         true);
  expect("slower than 1x, the lead stays",
         preview.opens(10, 20, 8.4, duration, false, false, 0.25), false);

  std::mt19937 random(1);
  std::uniform_real_distribution<double> unit(0, 1);
  bool opensImpliesKeeps = true;
  for (int i = 0; i < 200000; i++) {
    double start = unit(random) * 55;
    double end = start + 0.5 + unit(random) * 10;
    double position = unit(random) * 62 - 1;
    bool looping = unit(random) < 0.5;
    bool backward = unit(random) < 0.5;
    double speed = unit(random) * 4;
    for (auto* window : {&preview, &exportWindow}) {
      if (window->opens(start, end, position, duration, looping, backward, speed) &&
          !window->keeps(start, end, position, duration, looping, backward, speed)) {
        opensImpliesKeeps = false;
      }
    }
  }
  expect("opens implies keeps", opensImpliesKeeps, true);
  return failures == 0 ? 0 : 1;
}
