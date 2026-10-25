#include "RNSVCheckedSizes.h"
#include "VideoCompositionFramesExtractorHostObject.h"
#include "ReturnedVideoFrames.h"
#include "JNIHelpers.h"

namespace RNSkiaVideo {

VideoCompositionFramesExtractorHostObject::
    VideoCompositionFramesExtractorHostObject(jsi::Runtime& runtime,
                                              jsi::Object jsComposition)
    : EventEmitter(runtime, JNIHelpers::getCallInvoker()) {}

void VideoCompositionFramesExtractorHostObject::initialize(
    jsi::Runtime& runtime, jsi::Object jsComposition) {
  auto receiver = std::shared_ptr<JEventReceiver>(shared_from_this(), this);
  jEventDispatcher = make_global(NativeEventDispatcher::create(receiver));
  auto composition = VideoComposition::fromJSIObject(runtime, jsComposition);
  player = make_global(
      VideoCompositionFramesExtractor::create(composition, jEventDispatcher));
}

VideoCompositionFramesExtractorHostObject::
    ~VideoCompositionFramesExtractorHostObject() {
  this->release();
}

std::vector<jsi::PropNameID>
VideoCompositionFramesExtractorHostObject::getPropertyNames(jsi::Runtime& rt) {
  std::vector<jsi::PropNameID> result;
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("prepare")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("play")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("pause")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("seekTo")));
  result.push_back(
      jsi::PropNameID::forUtf8(rt, std::string("decodeCompositionFrames")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("on")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("dispose")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("currentTime")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("framesVersion")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("isLooping")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("isPlaying")));
  result.push_back(jsi::PropNameID::forUtf8(rt, std::string("playbackRate")));
  return result;
}

// The methods are created once per runtime (see RNSVHostObject):
// `decodeCompositionFrames` is read at every vsync of the UI runtime.
jsi::Value VideoCompositionFramesExtractorHostObject::get(
    jsi::Runtime& runtime, const jsi::PropNameID& propNameId) {
  auto propName = propNameId.utf8(runtime);
  if (propName == "prepare") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          std::lock_guard<std::recursive_mutex> lock(playerMutex);
          if (!released.test() && !prepared.test_and_set()) {
            player->prepare();
          }
          return jsi::Value::undefined();
        });
  } else if (propName == "decodeCompositionFrames") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          std::lock_guard<std::recursive_mutex> lock(playerMutex);
          if (released.test() || !prepared.test()) {
            return jsi::Object(runtime);
          }
          auto frames = player->decodeCompositionFrames();
          ReturnedVideoFrames returned(frames);
          auto version = player->getFramesVersion();
          bool hardware = false;
          for (auto& entry : *frames) {
            auto frame = entry.second;
            if (frame->isHardwareBuffer()) { hardware = true; break; }
          }
          if (hardware) {
            // A previous JS frame may already have been disposed after copying
            // into its owned Skia image. New leases keep paused rewrapping valid.
            auto result = jsi::Object(runtime);
            for (auto& entry : *frames) {
              auto frame = entry.second;
              result.setProperty(runtime, entry.first->toStdString().c_str(), frame->toJS(runtime));
            }
            returned.close();
            return result;
          }
          // The frames object is only rebuilt when the decoder produced a
          // new frame. On a 120 Hz display most calls see the same frames as
          // the previous one, and rewrapping them would be several JNI calls
          // and JS allocations per item per vsync.
          auto result = getVersionedObject(
              runtime, "frames", (double)version,
              [&](jsi::Object& result) {
                for (auto& entry : *frames) {
                  auto id = entry.first->toStdString();
                  auto frame = entry.second;
                  result.setProperty(runtime, id.c_str(), frame->toJS(runtime));
                }
              });
          returned.close();
          return result;
        });
  } else if (propName == "play") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          std::lock_guard<std::recursive_mutex> lock(playerMutex);
          if (!released.test()) {
            player->play();
          }
          return jsi::Value::undefined();
        });
  } else if (propName == "pause") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          std::lock_guard<std::recursive_mutex> lock(playerMutex);
          if (!released.test()) {
            player->pause();
          }
          return jsi::Value::undefined();
        });
  } else if (propName == "seekTo") {
    return getFunction(
        runtime, propName, 1,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          std::lock_guard<std::recursive_mutex> lock(playerMutex);
          if (!released.test()) {
            if (count != 1) {
              throw jsi::JSError(
                  runtime,
                  "VideoCompositionFramesExtractorHostObject."
                  "seekTo(..) expects 1 arguments (number)!");
            }
            auto posSec = checkedMediaSeconds(arguments[0].asNumber());
            player->seekTo((long)(posSec * 1000000));
          }
          return jsi::Value::undefined();
        });
  } else if (propName == "on") {
    return getFunction(
        runtime, propName, 2,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          std::lock_guard<std::recursive_mutex> lock(playerMutex);
          if (released.test()) {
            // Nothing to listen to anymore: hand out a no-op unsubscribe.
            return jsi::Function::createFromHostFunction(
                runtime, jsi::PropNameID::forAscii(runtime, "dispose"), 0,
                [](jsi::Runtime& runtime, const jsi::Value& thisValue,
                   const jsi::Value* arguments, size_t count) -> jsi::Value {
                  return jsi::Value::undefined();
                });
          }
          auto name = arguments[0].asString(runtime).utf8(runtime);
          auto handler = arguments[1].asObject(runtime).asFunction(runtime);
          return this->on(name, std::move(handler));
        });
  } else if (propName == "dispose") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          this->release();
          return jsi::Value::undefined();
        });
  } else if (propName == "currentTime") {
    std::lock_guard<std::recursive_mutex> lock(playerMutex);
    return {released.test() ? 0
                            : (double)player->getPresentedPosition() / 1000000.0};
  } else if (propName == "framesVersion") {
    std::lock_guard<std::recursive_mutex> lock(playerMutex);
    return {released.test() || !prepared.test()
                ? 0
                : (double)player->getFramesVersion()};
  } else if (propName == "isLooping") {
    std::lock_guard<std::recursive_mutex> lock(playerMutex);
    return {!released.test() && player->getIsLooping()};
  } else if (propName == "isPlaying") {
    std::lock_guard<std::recursive_mutex> lock(playerMutex);
    return {!released.test() && player->getIsPlaying()};
  } else if (propName == "playbackRate") {
    std::lock_guard<std::recursive_mutex> lock(playerMutex);
    return {released.test() ? 1.0 : (double)player->getPlaybackRate()};
  }
  return jsi::Value::undefined();
}

void VideoCompositionFramesExtractorHostObject::set(
    facebook::jsi::Runtime& runtime,
    const facebook::jsi::PropNameID& propNameId,
    const facebook::jsi::Value& value) {
  std::lock_guard<std::recursive_mutex> lock(playerMutex);
  if (released.test()) {
    return;
  }
  auto propName = propNameId.utf8(runtime);
  if (propName == "isLooping") {
    player->setIsLooping(value.asBool());
  } else if (propName == "playbackRate") {
    if (!value.isNumber())
      throw jsi::JSError(runtime, "playbackRate expects a number");
    double rate;
    try {
      rate = checkedShuttleRate(value.asNumber());
    } catch (const std::invalid_argument& error) {
      throw jsi::JSError(runtime, error.what());
    }
    player->setPlaybackRate(rate);
  }
}

void VideoCompositionFramesExtractorHostObject::handleEvent(
    std::string eventName, alias_ref<jobject> data) {
  if (eventName == "error") {
    auto message = static_ref_cast<JString>(data)->toStdString();
    emit("error", [=](jsi::Runtime& runtime) -> jsi::Value {
      auto dimensions = jsi::Object(runtime);
      dimensions.setProperty(runtime, "message",
                             jsi::String::createFromUtf8(runtime, message));
      return dimensions;
    });
  } else {
    emit(eventName);
  }
}

void VideoCompositionFramesExtractorHostObject::release() {
  std::lock_guard<std::recursive_mutex> lock(playerMutex);
  if (!released.test_and_set()) {
    if (jEventDispatcher) jEventDispatcher->invalidate();
    removeAllListeners();
    if (player) player->release();
    player = nullptr;
    jEventDispatcher = nullptr;
  }
}
} // namespace RNSkiaVideo
