#include "VideoCompositionFramesExtractorSyncHostObject.h"

#import "AVAssetTrackUtils.h"
#import "RNSVJSIUtils.h"
#include "RNSVCheckedSizes.h"
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <future>

namespace RNSkiaVideo {

VideoCompositionFramesExtractorSyncHostObject::
    VideoCompositionFramesExtractorSyncHostObject(
        std::shared_ptr<VideoComposition> composition)
    : composition(composition), window(composition->lazyDecoders, false) {
  lock = [[NSObject alloc] init];
}

VideoCompositionFramesExtractorSyncHostObject::
    ~VideoCompositionFramesExtractorSyncHostObject() {
  this->release();
}

std::vector<jsi::PropNameID>
VideoCompositionFramesExtractorSyncHostObject::getPropertyNames(
    jsi::Runtime& rt) {
  std::vector<jsi::PropNameID> result;
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("start")));
  result.push_back(
      jsi::PropNameID::forUtf8(rt, std::string("decodeCompositionFrames")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("dispose")));
  return result;
}

// The methods are created once per runtime (see RNSVHostObject):
// `decodeCompositionFrames` is read for every exported frame.
jsi::Value VideoCompositionFramesExtractorSyncHostObject::get(
    jsi::Runtime& runtime, const jsi::PropNameID& propNameId) {
  auto propName = propNameId.utf8(runtime);
  if (propName == "start") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          return runPooled([&] {
            @synchronized(lock) {
            if (disposed) throw std::runtime_error("Extractor is disposed");
            if (started) return;
            try {
              for (const auto& item : composition->items) {
                if (!item->isVideo ||
                    !window.opens(item->compositionStartTime,
                                  item->compositionStartTime + item->duration,
                                  0, composition->duration, false)) {
                  continue;
                }
                itemDecoders[item->id] =
                    std::make_shared<VideoCompositionItemDecoder>(item, false);
              }
              started = true;
            } catch (...) {
              itemDecoders.clear();
              throw;
            }
            }
          });
        });
  } else if (propName == "decodeCompositionFrames") {
    return getFunction(
        runtime, propName, 1,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          if (count < 1 || !arguments[0].isNumber())
            throw jsi::JSError(runtime, "decodeCompositionFrames expects media seconds");
          auto currentTime = CMTimeMakeWithSeconds(
              checkedMediaSeconds(arguments[0].asNumber()), NSEC_PER_SEC);
          return runPooled([&]() -> jsi::Value {
            @synchronized(lock) {
            if (disposed) throw std::runtime_error("Extractor is disposed");
            auto frames = jsi::Object(runtime);
            updateWindow(currentTime);
            auto seeked = seekBack(currentTime);
            for (const auto& entry : itemDecoders) {
              auto itemId = entry.first;
              auto decoder = entry.second;

              decoder->advanceDecoder(currentTime);

              // After a seek the previous frame is from later on: take the
              // first one decoded, as for an item's first request.
              auto previousFrame = currentFrames[itemId];
              auto frame = decoder->acquireFrameForTime(
                  currentTime, !previousFrame || seeked.count(itemId));
              if (frame) {
                currentFrames[itemId] = frame;
              } else {
                frame = previousFrame;
              }
              if (frame) {
                frames.setProperty(
                    runtime, entry.first.c_str(),
                    jsi::Object::createFromHostObject(runtime, frame));
              }
            }
            return frames;
            }
          });
        });
  } else if (propName == "dispose") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          return runPooled([&] { this->release(); });
        });
  }
  return jsi::Value::undefined();
}

void VideoCompositionFramesExtractorSyncHostObject::release() {
  @synchronized(lock) {
  if (disposed) return;
  disposed = true;
  try {
    for (const auto& entry : itemDecoders) {
      auto decoder = entry.second;
      if (decoder) {
        entry.second->release();
      }
    }
  } catch (...) {
  }
  itemDecoders.clear();
  currentFrames.clear();
  requestedTimes.clear();
  }
}

// A request earlier than an item's last one: its reader has gone past the
// frame to show, and an AVAssetReader only moves forward. Its decoder starts
// a new reader at the key frame before the time, as a preview seek does.
// Items whose position held to their range has not moved keep their reader:
// one past its end or not started yet shows the same frame either way.
std::set<std::string>
VideoCompositionFramesExtractorSyncHostObject::seekBack(CMTime time) {
  std::set<std::string> seeked;
  double target = CMTimeGetSeconds(time);
  for (const auto& item : composition->items) {
    auto decoder = itemDecoders.find(item->id);
    if (decoder == itemDecoders.end()) {
      continue;
    }
    auto last = requestedTimes.find(item->id);
    if (last != requestedTimes.end() &&
        ItemTime::movesBack(item->compositionStartTime, item->duration,
                            last->second, target)) {
      decoder->second->seekTo(time);
      seeked.insert(item->id);
    }
    requestedTimes[item->id] = target;
  }
  return seeked;
}

// Opens the decoders of the items coming up and closes those left behind.
void VideoCompositionFramesExtractorSyncHostObject::updateWindow(CMTime time) {
  if (!window.isLazy()) {
    return;
  }
  double position = CMTimeGetSeconds(time);
  for (const auto& item : composition->items) {
    if (!item->isVideo) {
      continue;
    }
    double start = item->compositionStartTime;
    double end = start + item->duration;
    auto it = itemDecoders.find(item->id);
    if (it == itemDecoders.end()) {
      if (window.opens(start, end, position, composition->duration, false)) {
#if defined(RNSV_TRACE_LIFECYCLE) && RNSV_TRACE_LIFECYCLE
        NSLog(@"[rnskv] export open %s at %.3fs", item->id.c_str(), position);
#endif
        itemDecoders[item->id] = std::make_shared<VideoCompositionItemDecoder>(
            item, false, nil, time);
      }
    } else if (!window.keeps(start, end, position, composition->duration,
                             false)) {
#if defined(RNSV_TRACE_LIFECYCLE) && RNSV_TRACE_LIFECYCLE
      NSLog(@"[rnskv] export close %s at %.3fs", item->id.c_str(), position);
#endif
      it->second->release();
      itemDecoders.erase(it);
      currentFrames.erase(item->id);
      requestedTimes.erase(item->id);
    }
  }
}

} // namespace RNSkiaVideo
