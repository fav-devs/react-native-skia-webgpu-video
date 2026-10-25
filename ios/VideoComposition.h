#pragma once

#import <CoreGraphics/CoreGraphics.h>

#include <jsi/jsi.h>
#include "RNSVCheckedSizes.h"
#include <set>

namespace RNSkiaVideo {
using namespace facebook;

class VideoCompositionItem {
public:
  std::string id;
  std::string path;
  double compositionStartTime;
  double startTime;
  double duration;
  /**
   * Source seconds played per composition second, see ItemTime.h. `duration`
   * stays the composition duration; the item reads `duration * playbackRate`
   * seconds of its file.
   */
  double playbackRate = 1;
  CGSize resolution;
  /**
   * Cap for the longest side of the decoded frames, or 0 for the file's own
   * size. Applied here rather than by the caller because only the decoder knows
   * the track's encoded orientation: a portrait clip is a landscape frame plus a
   * rotation, so a caller passing a portrait size for one gets a squashed
   * picture. See VideoCompositionItemDecoder#setupReader.
   */
  double maxLongSide = 0;
  /**
   * `textureMode: 'direct'` hands Skia the decoder's own pixel buffers,
   * without the per-frame copy into a persistent texture that `'copy'` (the
   * default) does. iOS only.
   */
  bool directTexture = false;
  /**
   * The composition's `framePixelFormat: 'yuv'`: frames decoded to NV12, the
   * decoder's own format, rather than BGRA. See setupReader.
   */
  bool yuvFrames = false;
  bool isVideo = true;
  bool audioEnabled = false;
  double audioVolume = 1.0;
};

class VideoComposition {
public:
  double duration;
  std::vector<std::shared_ptr<VideoCompositionItem>> items;
  /** Decoders opened around their item's time, see DecoderWindow. */
  bool lazyDecoders = false;

  bool hasAudio() const {
    for (const auto& item : items) {
      if (item->audioEnabled) {
        return true;
      }
    }
    return false;
  }

  static std::shared_ptr<VideoComposition> fromJS(jsi::Runtime& runtime,
                                                  jsi::Object& jsComposition) {
    auto composition = std::make_shared<VideoComposition>();
    composition->duration =
        checkedMediaSeconds(jsComposition.getProperty(runtime, "duration").asNumber());
    if (jsComposition.hasProperty(runtime, "lazyDecoders")) {
      auto lazyProp = jsComposition.getProperty(runtime, "lazyDecoders");
      composition->lazyDecoders = lazyProp.isBool() && lazyProp.getBool();
    }
    // 'auto' is NV12 on iOS, as on Android: a third of BGRA's memory, and the
    // same picture for camera footage (docs/FRAME_PIXEL_FORMAT.md).
    bool yuvFrames = true;
    if (jsComposition.hasProperty(runtime, "framePixelFormat")) {
      auto formatProp = jsComposition.getProperty(runtime, "framePixelFormat");
      if (formatProp.isString()) {
        auto format = formatProp.asString(runtime).utf8(runtime);
        if (format != "auto" && format != "yuv" && format != "rgba")
          throw jsi::JSError(runtime, "framePixelFormat must be 'auto', 'yuv' or 'rgba'");
        yuvFrames = format != "rgba";
      } else if (!formatProp.isUndefined()) {
        throw jsi::JSError(runtime, "framePixelFormat must be 'auto', 'yuv' or 'rgba'");
      }
    }
    auto jsItems = jsComposition.getProperty(runtime, "items")
                       .asObject(runtime)
                       .asArray(runtime);
    auto size = jsItems.size(runtime);
    std::set<std::string> ids;
    for (size_t i = 0; i < size; i++) {
      auto jsItem = jsItems.getValueAtIndex(runtime, i).asObject(runtime);
      auto item = std::make_shared<VideoCompositionItem>();
      item->id =
          jsItem.getProperty(runtime, "id").asString(runtime).utf8(runtime);
      if (item->id.empty() || !ids.insert(item->id).second)
        throw jsi::JSError(runtime, "Composition item IDs must be nonempty and unique");
      item->path =
          jsItem.getProperty(runtime, "path").asString(runtime).utf8(runtime);
      item->compositionStartTime =
          checkedMediaSeconds(jsItem.getProperty(runtime, "compositionStartTime").asNumber());
      item->startTime = checkedMediaSeconds(jsItem.getProperty(runtime, "startTime").asNumber());
      item->duration = checkedMediaSeconds(jsItem.getProperty(runtime, "duration").asNumber());
      checkedMediaSeconds(item->compositionStartTime + item->duration);
      if (jsItem.hasProperty(runtime, "playbackRate")) {
        auto rateProp = jsItem.getProperty(runtime, "playbackRate");
        if (!rateProp.isUndefined()) {
          item->playbackRate = checkedPlaybackRate(
              rateProp.isNumber() ? rateProp.asNumber()
                                  : std::numeric_limits<double>::quiet_NaN());
        }
      }
      checkedMediaSeconds(item->startTime + item->duration * item->playbackRate);
      item->yuvFrames = yuvFrames;
      item->resolution = CGSize();
      if (jsItem.hasProperty(runtime, "resolution")) {
        auto resProp = jsItem.getProperty(runtime, "resolution");
        if (resProp.isObject()) {
          auto res = resProp.asObject(runtime);
          item->resolution.width = checkedPositiveInt(res.getProperty(runtime, "width").asNumber(), "decode width");
          item->resolution.height =
              checkedPositiveInt(res.getProperty(runtime, "height").asNumber(), "decode height");
        }
      }

      if (jsItem.hasProperty(runtime, "maxLongSide")) {
        auto capProp = jsItem.getProperty(runtime, "maxLongSide");
        if (capProp.isNumber()) {
          item->maxLongSide = checkedStorageInteger(capProp.asNumber(), "decode maxLongSide");
          if (item->maxLongSide > std::numeric_limits<int>::max())
            throw jsi::JSError(runtime, "Invalid decode maxLongSide");
        }
      }

      if (jsItem.hasProperty(runtime, "textureMode")) {
        auto modeProp = jsItem.getProperty(runtime, "textureMode");
        if (modeProp.isString()) {
          item->directTexture =
              modeProp.asString(runtime).utf8(runtime) == "direct";
        }
      }

      if (jsItem.hasProperty(runtime, "kind")) {
        auto kindProp = jsItem.getProperty(runtime, "kind");
        if (kindProp.isString()) {
          item->isVideo = kindProp.asString(runtime).utf8(runtime) != "audio";
        }
      }
      if (!item->isVideo) {
        item->audioEnabled = true;
        if (jsItem.hasProperty(runtime, "volume")) {
          auto volumeProp = jsItem.getProperty(runtime, "volume");
          if (volumeProp.isNumber()) {
            item->audioVolume = volumeProp.asNumber();
          }
        }
      } else if (jsItem.hasProperty(runtime, "audio")) {
        auto audioProp = jsItem.getProperty(runtime, "audio");
        if (audioProp.isBool()) {
          item->audioEnabled = audioProp.getBool();
        } else if (audioProp.isObject()) {
          item->audioEnabled = true;
          auto audio = audioProp.asObject(runtime);
          if (audio.hasProperty(runtime, "volume")) {
            auto volumeProp = audio.getProperty(runtime, "volume");
            if (volumeProp.isNumber()) {
              item->audioVolume = volumeProp.asNumber();
            }
          }
        }
      }

      // The audio track is still played and mixed at 1×: refused rather than
      // drifting away from its picture.
      if (item->audioEnabled && item->playbackRate != 1)
        throw jsi::JSError(runtime, "playbackRate is only supported on silent video items");

      composition->items.push_back(item);
    }
    return composition;
  }
};

} // namespace RNSkiaVideo
