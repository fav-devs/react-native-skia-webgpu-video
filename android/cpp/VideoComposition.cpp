#include "RNSVCheckedSizes.h"
#include <set>
#include "VideoComposition.h"
#include "NativeHardwareBuffer.h"

namespace RNSkiaVideo {

using namespace facebook::jni;

local_ref<VideoCompositionItem>
VideoCompositionItem::create(std::string& id, std::string& path,
                             double compositionStartTime, double startTime,
                             double duration) {
  auto inst = newInstance();
  auto cls = javaClassStatic();
  inst->setFieldValue(cls->getField<JString>("id"), make_jstring(id).get());
  inst->setFieldValue(cls->getField<JString>("path"), make_jstring(path).get());
  inst->setFieldValue(cls->getField<jdouble>("compositionStartTime"),
                      compositionStartTime);
  inst->setFieldValue(cls->getField<jdouble>("startTime"), startTime);
  inst->setFieldValue(cls->getField<jdouble>("duration"), duration);
  return inst;
}

std::string VideoCompositionItem::getId() const {
  static const auto getIdMethod = getClass()->getMethod<jstring()>("getId");
  return getIdMethod(self())->toStdString();
}

std::string VideoCompositionItem::getPath() const {
  static const auto getPathMethod = getClass()->getMethod<jstring()>("getPath");
  return getPathMethod(self())->toStdString();
}

jdouble VideoCompositionItem::getCompositionStartTime() const {
  static const auto getCompositionStartTimeMethod =
      getClass()->getMethod<jdouble()>("getCompositionStartTime");
  return getCompositionStartTimeMethod(self());
}

jdouble VideoCompositionItem::getStartTime() const {
  static const auto getStartTimeMethod =
      getClass()->getMethod<jdouble()>("getStartTime");
  return getStartTimeMethod(self());
}

jdouble VideoCompositionItem::getDuration() const {
  static const auto getDurationMethod =
      getClass()->getMethod<jdouble()>("getDuration");
  return getDurationMethod(self());
}

local_ref<VideoComposition>
VideoComposition::create(jdouble duration,
                         alias_ref<JList<VideoCompositionItem>> items) {
  return newInstance(duration, items);
}

local_ref<VideoComposition>
VideoComposition::fromJSIObject(jsi::Runtime& runtime,
                                jsi::Object& jsComposition) {
  auto duration = checkedMediaSeconds(jsComposition.getProperty(runtime, "duration").asNumber());
  auto jsItems = jsComposition.getProperty(runtime, "items")
                     .asObject(runtime)
                     .asArray(runtime);
  auto size = jsItems.size(runtime);
  local_ref<JList<VideoCompositionItem>> items =
      JArrayList<VideoCompositionItem>::create(size);
  if (size > INT32_MAX) throw jsi::JSError(runtime, "Too many composition items");
  std::set<std::string> ids;
  for (size_t i = 0; i < size; i++) {
    auto jsItem = jsItems.getValueAtIndex(runtime, i).asObject(runtime);
    auto id = jsItem.getProperty(runtime, "id").asString(runtime).utf8(runtime);
    if (id.empty() || !ids.insert(id).second) throw jsi::JSError(runtime, "Composition item IDs must be nonempty and unique");
    auto path =
        jsItem.getProperty(runtime, "path").asString(runtime).utf8(runtime);
    auto compositionStartTime =
        checkedMediaSeconds(jsItem.getProperty(runtime, "compositionStartTime").asNumber());
    auto startTime = checkedMediaSeconds(jsItem.getProperty(runtime, "startTime").asNumber());
    auto duration = checkedMediaSeconds(jsItem.getProperty(runtime, "duration").asNumber());
    double playbackRate = 1;
    if (jsItem.hasProperty(runtime, "playbackRate")) {
      auto rateProp = jsItem.getProperty(runtime, "playbackRate");
      if (!rateProp.isUndefined()) {
        playbackRate = checkedPlaybackRate(
            rateProp.isNumber() ? rateProp.asNumber() : std::numeric_limits<double>::quiet_NaN());
      }
    }
    checkedMediaSeconds(startTime + duration * playbackRate);

    auto item = VideoCompositionItem::create(id, path, compositionStartTime,
                                             startTime, duration);
    auto itemCls = VideoCompositionItem::javaClassStatic();
    if (jsItem.hasProperty(runtime, "resolution")) {
      auto resProp = jsItem.getProperty(runtime, "resolution");
      if (resProp.isObject()) {
        auto res = resProp.asObject(runtime);
        item->setFieldValue(itemCls->getField<jint>("width"),
                            checkedPositiveInt(res.getProperty(runtime, "width").asNumber(), "decode width"));
        item->setFieldValue(itemCls->getField<jint>("height"),
                            checkedPositiveInt(res.getProperty(runtime, "height").asNumber(), "decode height"));
      }
    }
    if (jsItem.hasProperty(runtime, "textureMode")) {
      auto modeProp = jsItem.getProperty(runtime, "textureMode");
      if (modeProp.isString() &&
          modeProp.asString(runtime).utf8(runtime) == "direct") {
        item->setFieldValue(itemCls->getField<jboolean>("directTexture"),
                            (jboolean)JNI_TRUE);
      }
    }
    if (jsItem.hasProperty(runtime, "maxLongSide")) {
      auto capProp = jsItem.getProperty(runtime, "maxLongSide");
      if (capProp.isNumber() && capProp.asNumber() > 0) {
        item->setFieldValue(itemCls->getField<jint>("maxLongSide"),
                            checkedPositiveInt(capProp.asNumber(), "decode maxLongSide"));
      }
    }
    bool isVideo = true;
    if (jsItem.hasProperty(runtime, "kind")) {
      auto kindProp = jsItem.getProperty(runtime, "kind");
      if (kindProp.isString()) {
        isVideo = kindProp.asString(runtime).utf8(runtime) != "audio";
      }
    }
    bool audioEnabled = false;
    double audioVolume = 1.0;
    if (!isVideo) {
      audioEnabled = true;
      if (jsItem.hasProperty(runtime, "volume")) {
        auto volumeProp = jsItem.getProperty(runtime, "volume");
        if (volumeProp.isNumber()) {
          audioVolume = volumeProp.asNumber();
        }
      }
    } else if (jsItem.hasProperty(runtime, "audio")) {
      auto audioProp = jsItem.getProperty(runtime, "audio");
      if (audioProp.isBool()) {
        audioEnabled = audioProp.getBool();
      } else if (audioProp.isObject()) {
        audioEnabled = true;
        auto audio = audioProp.asObject(runtime);
        if (audio.hasProperty(runtime, "volume")) {
          auto volumeProp = audio.getProperty(runtime, "volume");
          if (volumeProp.isNumber()) {
            audioVolume = volumeProp.asNumber();
          }
        }
      }
    }
    item->setFieldValue(itemCls->getField<jboolean>("isVideo"),
                        (jboolean)isVideo);
    item->setFieldValue(itemCls->getField<jboolean>("audioEnabled"),
                        (jboolean)audioEnabled);
    item->setFieldValue(itemCls->getField<jdouble>("audioVolume"), audioVolume);
    // The audio track is still played and mixed at 1×: refused rather than
    // drifting away from its picture.
    if (audioEnabled && playbackRate != 1)
      throw jsi::JSError(runtime, "playbackRate is only supported on silent video items");
    item->setFieldValue(itemCls->getField<jdouble>("playbackRate"), playbackRate);

    items->add(item);
  }
  auto composition = VideoComposition::create(duration, items);
  composition->setFieldValue(VideoComposition::javaClassStatic()->getField<jboolean>(
      "hardwareBufferEnabled"), static_cast<jboolean>(NativeHardwareBuffer::isEnabled()));
  if (jsComposition.hasProperty(runtime, "framePixelFormat")) {
    auto formatProp = jsComposition.getProperty(runtime, "framePixelFormat");
    std::string format = formatProp.isString() ? formatProp.asString(runtime).utf8(runtime) : "";
    if (!formatProp.isUndefined() && format != "auto" && format != "yuv" && format != "rgba")
      throw jsi::JSError(runtime, "framePixelFormat must be 'auto', 'yuv' or 'rgba'");
    // 'auto' and 'yuv' are the same on Android: YUV wherever the track allows.
    if (format == "rgba") {
      composition->setFieldValue(
          VideoComposition::javaClassStatic()->getField<jboolean>("rgbaFrames"),
          (jboolean)JNI_TRUE);
    }
  }
  if (jsComposition.hasProperty(runtime, "lazyDecoders")) {
    auto lazyProp = jsComposition.getProperty(runtime, "lazyDecoders");
    if (lazyProp.isBool() && lazyProp.getBool()) {
      composition->setFieldValue(
          VideoComposition::javaClassStatic()->getField<jboolean>(
              "lazyDecoders"),
          (jboolean)JNI_TRUE);
    }
  }
  return composition;
}

bool VideoComposition::hasDirectTextures() const {
  static const auto hasDirectTexturesMethod =
      getClass()->getMethod<jboolean()>("hasDirectTextures");
  return hasDirectTexturesMethod(self());
}
} // namespace RNSkiaVideo
