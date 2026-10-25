#include "RNSVCheckedSizes.h"
#include "NativeEventDispatcher.h"
#include "NativeRgbaBuffer.h"
#include "NativeHardwareBuffer.h"
#include "RNSVMemoryBudget.h"
#include "VideoCapabilities.h"
#include "VideoCompositionFramesExtractorHostObject.h"
#include "VideoCompositionFramesExtractorSyncHostObject.h"
#include "VideoEncoderHostObject.h"
#include "VideoPlayerHostObject.h"
#include <fbjni/fbjni.h>
#include <jni.h>
#include <jsi/jsi.h>

using namespace facebook;
using namespace RNSkiaVideo;

void install(jsi::Runtime& jsiRuntime) {

  auto RNSVModule = jsi::Object(jsiRuntime);
  MemoryBudget::install(jsiRuntime, RNSVModule);
  RNSVModule.setProperty(jsiRuntime, "configureNativeBufferInterop",
    jsi::Function::createFromHostFunction(jsiRuntime,
      jsi::PropNameID::forAscii(jsiRuntime, "configureNativeBufferInterop"), 1,
      [](jsi::Runtime& runtime, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count != 1 || !args[0].isBool())
          throw jsi::JSError(runtime, "configureNativeBufferInterop requires a boolean");
        try { NativeHardwareBuffer::configure(args[0].getBool()); }
        catch (const std::exception& error) { throw jsi::JSError(runtime, error.what()); }
        return jsi::Value::undefined();
      }));
  RNSVModule.setProperty(jsiRuntime, "getBackendInfo",
    jsi::Function::createFromHostFunction(jsiRuntime,
      jsi::PropNameID::forAscii(jsiRuntime, "getBackendInfo"), 0,
      [](jsi::Runtime& runtime, const jsi::Value&, const jsi::Value*, size_t) -> jsi::Value {
        auto info = jsi::Object(runtime);
        info.setProperty(runtime, "platform", jsi::String::createFromAscii(runtime, "android"));
        const bool hardware = NativeHardwareBuffer::isEnabled();
        info.setProperty(runtime, "decodeTransport", jsi::String::createFromAscii(runtime,
            hardware ? "ahardwarebuffer-rgba-egl" : "cpu-rgba-readback"));
        // Export renders straight into the codec's input Surface through a
        // WebGPU canvas context; the JS export probes it at setup, and CPU
        // readback stays the fallback. Offered with AHardwareBuffer interop,
        // which also samples decoded frames in place: turning interop off
        // selects the readback export, the reference of the pixel checks.
        info.setProperty(runtime, "encodeTransport", jsi::String::createFromAscii(runtime,
            hardware ? "webgpu-native-window" : "cpu-rgba-upload"));
        info.setProperty(runtime, "exportFallback", jsi::String::createFromAscii(runtime, "cpu-rgba-upload"));
        info.setProperty(runtime, "gpuDirectExport", hardware);
        info.setProperty(runtime, "zeroCopyEncode", hardware);
        info.setProperty(runtime, "decodeCpuCopiesBeforeSkia", hardware ? 0 : 1);
        info.setProperty(runtime, "cpuReadbackDecode", !hardware);
        info.setProperty(runtime, "ownedFrameTransport", jsi::String::createFromAscii(runtime,
            hardware ? "immutable-ahardwarebuffer-shared-leases" : "direct-buffer-java-scoped-copy"));
        info.setProperty(runtime, "skiaImportTransport", jsi::String::createFromAscii(runtime,
            hardware ? "native-buffer-webgpu-blit-snapshot" : "cpu-rgba-scoped-copy-webgpu-upload-snapshot"));
        info.setProperty(runtime, "zeroCopyDecode", false);
        // What this native code implements, for JS shipped ahead of a rebuilt
        // app: an older binary has neither and would play every item at 1×.
        // See getVideoCompositionFeatures.
        info.setProperty(runtime, "playbackRate", true);
        info.setProperty(runtime, "syncBackwardSeek", true);
        // The composition player's signed playbackRate (see Shuttle.java).
        info.setProperty(runtime, "signedPlaybackRate", true);
        return info;
      }));
  auto createVideoPlayer = jsi::Function::createFromHostFunction(
      jsiRuntime, jsi::PropNameID::forAscii(jsiRuntime, "createVideoPlayer"), 2,
      [](jsi::Runtime& runtime, const jsi::Value& thisValue,
         const jsi::Value* arguments, size_t count) -> jsi::Value {
        if (count < 1 || !arguments[0].isString()) {
          throw jsi::JSError(runtime,
                             "ReactNativeSkiaVideo.createVideoPlayer(..) "
                             "expects two arguments (string, object)!");
        }

        int width = -1;
        int height = -1;
        if (count >= 2 && arguments[1].isObject()) {
          auto res = arguments[1].asObject(runtime);
          width = checkedPositiveInt(res.getProperty(runtime, "width").asNumber(), "decode width");
          height = checkedPositiveInt(res.getProperty(runtime, "height").asNumber(), "decode height");
        }
        auto instance = std::make_shared<VideoPlayerHostObject>(
            runtime, arguments[0].asString(runtime).utf8(runtime), width,
            height);
        instance->initialize(arguments[0].asString(runtime).utf8(runtime), width, height);

        return jsi::Object::createFromHostObject(runtime, instance);
      });

  RNSVModule.setProperty(jsiRuntime, "createVideoPlayer",
                         std::move(createVideoPlayer));

  auto createVideoCompositionFramesExtractor =
      jsi::Function::createFromHostFunction(
          jsiRuntime,
          jsi::PropNameID::forAscii(jsiRuntime,
                                    "createVideoCompositionFramesExtractor"),
          1,
          [](jsi::Runtime& runtime, const jsi::Value& thisValue,
             const jsi::Value* arguments, size_t count) -> jsi::Value {
            if (count != 1 || !arguments[0].isObject()) {
              throw jsi::JSError(runtime,
                                 "SkiaVideo.createRNSVCompositionPlayer(.."
                                 ") expects one arguments (object)!");
            }

            auto instance =
                std::make_shared<VideoCompositionFramesExtractorHostObject>(
                    runtime, arguments[0].asObject(runtime));
            instance->initialize(runtime, arguments[0].asObject(runtime));

            return jsi::Object::createFromHostObject(runtime, instance);
          });
  RNSVModule.setProperty(jsiRuntime, "createVideoCompositionFramesExtractor",
                         std::move(createVideoCompositionFramesExtractor));

  auto createVideoCompositionFramesExtractorSync =
      jsi::Function::createFromHostFunction(
          jsiRuntime,
          jsi::PropNameID::forAscii(
              jsiRuntime, "createVideoCompositionFramesExtractorSync"),
          1,
          [](jsi::Runtime& runtime, const jsi::Value& thisValue,
             const jsi::Value* arguments, size_t count) -> jsi::Value {
            if (count != 1 || !arguments[0].isObject()) {
              throw jsi::JSError(runtime,
                                 "createVideoCompositionFramesExtractorSync(.."
                                 ") expects one arguments (object)!");
            }

            auto instance =
                std::make_shared<VideoCompositionFramesExtractorSyncHostObject>(
                    runtime, arguments[0].asObject(runtime));
            return jsi::Object::createFromHostObject(runtime, instance);
          });

  RNSVModule.setProperty(jsiRuntime,
                         "createVideoCompositionFramesExtractorSync",
                         std::move(createVideoCompositionFramesExtractorSync));

  auto createVideoEncoder = jsi::Function::createFromHostFunction(
      jsiRuntime, jsi::PropNameID::forAscii(jsiRuntime, "createVideoEncoder"),
      2,
      [](jsi::Runtime& runtime, const jsi::Value& thisValue,
         const jsi::Value* arguments, size_t count) -> jsi::Value {
        if (count < 1 || !arguments[0].isObject()) {
          throw jsi::JSError(runtime, "ReactNativeSkiaVideo."
                                      "createVideoEncoder(.."
                                      ") expects one arguments (object)!");
        }

        auto options = arguments[0].asObject(runtime);
        auto outPath = options.getProperty(runtime, "outPath")
                           .asString(runtime)
                           .utf8(runtime);
        int width = checkedPositiveInt(options.getProperty(runtime, "width").asNumber(), "encoder width");
        int height = checkedPositiveInt(options.getProperty(runtime, "height").asNumber(), "encoder height");
        int frameRate =
            checkedPositiveInt(options.getProperty(runtime, "frameRate").asNumber(), "encoder frame rate");
        int bitRate = checkedPositiveInt(options.getProperty(runtime, "bitRate").asNumber(), "encoder bitrate");
        std::optional<std::string> encoderName = std::nullopt;
        if (options.hasProperty(runtime, "encoderName")) {
          auto value = options.getProperty(runtime, "encoderName");
          if (value.isString()) {
            encoderName = value.asString(runtime).utf8(runtime);
          }
        }
        std::optional<std::string> codec = std::nullopt;
        if (options.hasProperty(runtime, "codec")) {
          auto value = options.getProperty(runtime, "codec");
          if (value.isString()) {
            codec = value.asString(runtime).utf8(runtime);
          }
        }
        int audioSampleRate = 44100;
        int audioChannelCount = 2;
        int audioBitRate = 128000;
        if (options.hasProperty(runtime, "audioSampleRate")) {
          auto value = options.getProperty(runtime, "audioSampleRate");
          if (value.isNumber()) {
            audioSampleRate = checkedPositiveInt(value.asNumber(), "audio sample rate");
          }
        }
        if (options.hasProperty(runtime, "audioChannelCount")) {
          auto value = options.getProperty(runtime, "audioChannelCount");
          if (value.isNumber()) {
            audioChannelCount = checkedPositiveInt(value.asNumber(), "audio channel count");
          }
        }
        if (options.hasProperty(runtime, "audioBitRate")) {
          auto value = options.getProperty(runtime, "audioBitRate");
          if (value.isNumber()) {
            audioBitRate = checkedPositiveInt(value.asNumber(), "audio bitrate");
          }
        }

        local_ref<VideoComposition> composition = nullptr;
        if (count >= 2 && arguments[1].isObject()) {
          auto jsComposition = arguments[1].asObject(runtime);
          composition = VideoComposition::fromJSIObject(runtime, jsComposition);
        }

        auto instance = std::make_shared<VideoEncoderHostObject>(
            outPath, width, height, frameRate, bitRate, encoderName, codec,
            composition, audioSampleRate, audioChannelCount, audioBitRate);
        return jsi::Object::createFromHostObject(runtime, instance);
      });
  RNSVModule.setProperty(jsiRuntime, "createVideoEncoder",
                         std::move(createVideoEncoder));

  auto isEncodingSupported = jsi::Function::createFromHostFunction(
      jsiRuntime, jsi::PropNameID::forAscii(jsiRuntime, "isEncodingSupported"),
      1,
      [](jsi::Runtime& runtime, const jsi::Value& thisValue,
         const jsi::Value* arguments, size_t count) -> jsi::Value {
        if (count < 1 || !arguments[0].isString()) {
          throw jsi::JSError(runtime, "ReactNativeSkiaVideo."
                                      "isEncodingSupported(..) expects a codec "
                                      "name!");
        }
        auto codec = arguments[0].asString(runtime).utf8(runtime);
        return jsi::Value(VideoEncoder::isCodecSupported(codec));
      });
  RNSVModule.setProperty(jsiRuntime, "isEncodingSupported",
                         std::move(isEncodingSupported));

  auto getDecodingCapabilitiesFor = jsi::Function::createFromHostFunction(
      jsiRuntime,
      jsi::PropNameID::forAscii(jsiRuntime, "getDecodingCapabilitiesFor"), 1,
      [](jsi::Runtime& runtime, const jsi::Value& thisValue,
         const jsi::Value* arguments, size_t count) -> jsi::Value {
        if (count < 1 || !arguments[0].isString())
          throw jsi::JSError(runtime, "getDecodingCapabilitiesFor expects a MIME type");
        auto mimetype = arguments[0].asString(runtime).utf8(runtime);

        auto decoderInfo =
            VideoCapabilities::getDecodingCapabilitiesFor(mimetype);
        if (decoderInfo == nullptr) {
          return jsi::Value::null();
        }
        auto result = jsi::Object(runtime);
        result.setProperty(runtime, "maxInstances",
                           jsi::Value(decoderInfo->getMaxInstances()));
        result.setProperty(runtime, "maxWidth",
                           jsi::Value(decoderInfo->getMaxWidth()));
        result.setProperty(runtime, "maxHeight",
                           jsi::Value(decoderInfo->getMaxHeight()));

        return result;
      });

  RNSVModule.setProperty(jsiRuntime, "getDecodingCapabilitiesFor",
                         std::move(getDecodingCapabilitiesFor));

  auto getValidEncoderConfigurations = jsi::Function::createFromHostFunction(
      jsiRuntime,
      jsi::PropNameID::forAscii(jsiRuntime, "getValidEncoderConfigurations"),
      4,
      [](jsi::Runtime& runtime, const jsi::Value& thisValue,
         const jsi::Value* arguments, size_t count) -> jsi::Value {
        if (count < 4) throw jsi::JSError(runtime, "getValidEncoderConfigurations expects dimensions, frame rate and bitrate");
        int width = checkedPositiveInt(arguments[0].asNumber(), "encoder width");
        int height = checkedPositiveInt(arguments[1].asNumber(), "encoder height");
        int framerate = checkedPositiveInt(arguments[2].asNumber(), "encoder frame rate");
        int bitrate = checkedPositiveInt(arguments[3].asNumber(), "encoder bitrate");

        std::optional<std::string> codec = std::nullopt;
        if (count > 4 && arguments[4].isString()) {
          codec = arguments[4].asString(runtime).utf8(runtime);
        }

        auto encoderInfos = VideoCapabilities::getValidEncoderConfigurations(
            width, height, framerate, bitrate, codec);

        if (encoderInfos == nullptr) {
          return jsi::Value::null();
        }
        auto result = jsi::Array(runtime, encoderInfos->size());
        size_t i = 0;
        for (const auto& encoderInfo : *encoderInfos) {
          auto jsObject = jsi::Object(runtime);
          jsObject.setProperty(runtime, "encoderName",
                               jsi::String::createFromUtf8(
                                   runtime, encoderInfo->getEncoderName()));
          jsObject.setProperty(
              runtime, "hardwareAccelerated",
              jsi::Value(encoderInfo->getHardwareAccelerated()));
          jsObject.setProperty(runtime, "width",
                               jsi::Value(encoderInfo->getWidth()));
          jsObject.setProperty(runtime, "height",
                               jsi::Value(encoderInfo->getHeight()));
          jsObject.setProperty(runtime, "frameRate",
                               jsi::Value(encoderInfo->getFrameRate()));
          jsObject.setProperty(runtime, "bitRate",
                               jsi::Value(encoderInfo->getBitrate()));

          result.setValueAtIndex(runtime, i, jsObject);
          i++;
        }
        return result;
      });

  RNSVModule.setProperty(jsiRuntime, "getValidEncoderConfigurations",
                         std::move(getValidEncoderConfigurations));

  jsiRuntime.global().setProperty(jsiRuntime, "RNSkiaVideo",
                                  std::move(RNSVModule));
}

extern "C" JNIEXPORT void JNICALL
Java_com_azzapp_rnskv_ReactNativeSkiaVideoModule_nativeInstall(JNIEnv* env,
                                                               jobject clazz,
                                                               jlong jsiPtr) {
  auto runtime = reinterpret_cast<jsi::Runtime*>(jsiPtr);
  if (runtime) {
    install(*runtime);
  }
}

jint JNI_OnLoad(JavaVM* vm, void*) {
  return facebook::jni::initialize(
      vm, [] { NativeEventDispatcher::registerNatives(); NativeRgbaBuffer::registerNatives();
        NativeHardwareBuffer::registerNatives(); });
}
