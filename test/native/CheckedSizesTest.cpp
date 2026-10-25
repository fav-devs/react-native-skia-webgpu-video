#include "RNSVCheckedSizes.h"
#include <cassert>
#include <iostream>
#include <limits>
#include <random>

using namespace RNSkiaVideo;
template<class F> static void rejects(F&& operation) {
  bool rejected = false;
  try { operation(); } catch (const std::invalid_argument&) { rejected = true; }
  assert(rejected);
}
int main() {
  for (double invalid : {-1.0, 0.5, std::numeric_limits<double>::infinity(),
                         std::numeric_limits<double>::quiet_NaN(), 9007199254740992.0})
    rejects([&] { checkedStorageInteger(invalid, "test storage"); });
  for (double invalid : {0.0, -1.0, 0.5, 2147483648.0,
                         std::numeric_limits<double>::quiet_NaN()})
    rejects([&] { checkedPositiveInt(invalid, "test dimension"); });
  rejects([] { checkedSizeProduct(std::numeric_limits<size_t>::max(), 2, "test product"); });
  rejects([] { checkedPixelStorage(32, 64, std::numeric_limits<size_t>::max() / 32); });
  rejects([] { checkedSizeProduct(checkedPixelStorage(INT32_MAX, INT32_MAX,
      static_cast<size_t>(INT32_MAX) * 4), 3, "pool capacity"); });
  rejects([] { checkedMediaSeconds(std::numeric_limits<double>::quiet_NaN()); });
  for (double invalid : {0.0, -0.5, std::numeric_limits<double>::infinity(),
                         std::numeric_limits<double>::quiet_NaN()})
    rejects([&] { checkedPlaybackRate(invalid); });
  assert(checkedPlaybackRate(0.5) == 0.5 && checkedPlaybackRate(2) == 2);
  assert(checkedStorageInteger(0, "offset") == 0);
  assert(checkedPositiveInt(2147483647.0, "dimension") == INT32_MAX);
  std::mt19937 random(0x524e5356);
  for (int i = 0; i < 100000; ++i) {
    int width = 1 + random() % 8192, height = 1 + random() % 8192;
    size_t stride = static_cast<size_t>(width) * 4 + random() % 256;
    auto bytes = checkedPixelStorage(width, height, stride);
    assert(bytes / static_cast<size_t>(height) == stride);
    assert(checkedStorageInteger(static_cast<double>(bytes), "layout bytes") == bytes);
  }
  std::cout << "{\"test\":\"checked-native-sizes\",\"randomLayouts\":100000,\"overflowRejected\":true}\n";
}
