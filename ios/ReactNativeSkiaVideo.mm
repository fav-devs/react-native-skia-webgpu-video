#import "ReactNativeSkiaVideo.h"

#import <React/RCTBridge+Private.h>
#import <React/RCTBridge.h>
#import <React/RCTCallInvoker.h>
#import <React/RCTUtils.h>
#import <ReactCommon/RCTTurboModule.h>
#import <jsi/jsi.h>

#import "RNSVJSIUtils.h"
#import "NativeResourceStats.h"
#include "RNSVMemoryBudget.h"
#import "VideoComposition.h"
#import "VideoCompositionFramesExtractorHostObject.h"
#import "VideoCompositionFramesExtractorSyncHostObject.h"
#import "VideoEncoderHostObject.h"
#include "RNSVCheckedSizes.h"
#import "VideoPlayerHostObject.h"

// In bridgeless mode `self.bridge` is an RCTBridgeProxy; its `runtime`
// accessor is not declared in public headers.
@interface RCTBridge (JSIRuntime)
- (void*)runtime;
@end

@implementation ReactNativeSkiaVideo

@synthesize bridge = _bridge;
@synthesize callInvoker = _callInvoker;

RCT_EXPORT_MODULE()
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(install) {
  using namespace facebook;
  using namespace RNSkiaVideo;

  auto jsiRuntime = reinterpret_cast<jsi::Runtime*>(self.bridge.runtime);
  if (jsiRuntime == nullptr) {
    return @false;
  }
  std::shared_ptr<react::CallInvoker> jsCallInvoker =
      self.callInvoker.callInvoker;
  if (jsCallInvoker == nullptr) {
    return @false;
  }
  auto& runtime = *jsiRuntime;
  auto RNSVModule = jsi::Object(runtime);

  auto createVideoPlayer = jsi::Function::createFromHostFunction(
      runtime, jsi::PropNameID::forAscii(runtime, "createVideoPlayer"), 3,
      [jsCallInvoker](jsi::Runtime& runtime, const jsi::Value& thisValue,
                      const jsi::Value* arguments, size_t count) -> jsi::Value {
        if (count < 1 || !arguments[0].isString()) {
          throw jsi::JSError(runtime,
                             "ReactNativeSkiaVideo.createVideoPlayer(."
                             ".) expects two arguments (string, object)!");
        }

        NSString* urlStr;
        try {
          urlStr = [NSString stringWithUTF8String:arguments[0]
                                                      .asString(runtime)
                                                      .utf8(runtime)
                                                      .c_str()];
        } catch (NSError* error) {
          throw jsi::JSError(
              runtime, "SkiaVideo.createRNSVPlayer(..) could not parse url");
        }
        CGSize resolution = CGSize();
        if (count >= 2 && arguments[1].isObject()) {
          auto res = arguments[1].asObject(runtime);
          resolution.width = checkedPositiveInt(res.getProperty(runtime, "width").asNumber(), "decode width");
          resolution.height = checkedPositiveInt(res.getProperty(runtime, "height").asNumber(), "decode height");
        }

        // { textureMode?: 'copy' | 'direct' } — copy is the default.
        bool directTexture = false;
        if (count >= 3 && arguments[2].isObject()) {
          auto options = arguments[2].asObject(runtime);
          if (options.hasProperty(runtime, "textureMode")) {
            auto mode = options.getProperty(runtime, "textureMode");
            if (mode.isString()) {
              directTexture = mode.asString(runtime).utf8(runtime) == "direct";
            }
          }
        }

        NSURL* url = [NSURL URLWithString:urlStr];

        auto instance = std::make_shared<VideoPlayerHostObject>(
            runtime, jsCallInvoker, url, resolution, directTexture);
        instance->initialize(url, resolution);
        return jsi::Object::createFromHostObject(runtime, instance);
      });
  RNSVModule.setProperty(runtime, "createVideoPlayer",
                         std::move(createVideoPlayer));

  runtime.global().setProperty(runtime, "RNSkiaVideo", RNSVModule);

  auto createVideoCompositionFramesExtractor =
      jsi::Function::createFromHostFunction(
          runtime,
          jsi::PropNameID::forAscii(runtime,
                                    "createVideoCompositionFramesExtractor"),
          1,
          [jsCallInvoker](jsi::Runtime& runtime, const jsi::Value& thisValue,
                          const jsi::Value* arguments,
                          size_t count) -> jsi::Value {
            if (count != 1 || !arguments[0].isObject()) {
              throw jsi::JSError(runtime,
                                 "ReactNativeSkiaVideo."
                                 "createVideoCompositionFramesExtractor(.."
                                 ") expects one arguments (object)!");
            }

            jsi::Object jsObject = arguments[0].asObject(runtime);
            auto videoComposition = VideoComposition::fromJS(runtime, jsObject);
            auto instance =
                std::make_shared<VideoCompositionFramesExtractorHostObject>(
                    runtime, jsCallInvoker, videoComposition);
            return jsi::Object::createFromHostObject(runtime, instance);
          });
  RNSVModule.setProperty(runtime, "createVideoCompositionFramesExtractor",
                         std::move(createVideoCompositionFramesExtractor));

  auto createVideoCompositionFramesExtractorSync =
      jsi::Function::createFromHostFunction(
          runtime,
          jsi::PropNameID::forAscii(
              runtime, "createVideoCompositionFramesExtractorSync"),
          1,
          [](jsi::Runtime& runtime, const jsi::Value& thisValue,
             const jsi::Value* arguments, size_t count) -> jsi::Value {
            if (count != 1 || !arguments[0].isObject()) {
              throw jsi::JSError(runtime,
                                 "ReactNativeSkiaVideo."
                                 "createVideoCompositionFramesExtractorSync(..)"
                                 " expects one arguments (object)!");
            }

            jsi::Object jsObject = arguments[0].asObject(runtime);
            auto videoComposition = VideoComposition::fromJS(runtime, jsObject);
            auto instance =
                std::make_shared<VideoCompositionFramesExtractorSyncHostObject>(
                    videoComposition);
            return jsi::Object::createFromHostObject(runtime, instance);
          });

  RNSVModule.setProperty(runtime, "createVideoCompositionFramesExtractorSync",
                         std::move(createVideoCompositionFramesExtractorSync));

  auto createVideoEncoder = jsi::Function::createFromHostFunction(
      runtime, jsi::PropNameID::forAscii(runtime, "createVideoEncoder"), 2,
      [](jsi::Runtime& runtime, const jsi::Value& thisValue,
         const jsi::Value* arguments, size_t count) -> jsi::Value {
        if (count < 1 || !arguments[0].isObject()) {
          throw jsi::JSError(
              runtime,
              "ReactNativeSkiaVideo.createVideoEncoder(..) expects an options "
              "object and an optional composition object!");
        }

        auto options = arguments[0].asObject(runtime);
        auto outPath = options.getProperty(runtime, "outPath")
                           .asString(runtime)
                           .utf8(runtime);
        int width = checkedPositiveInt(options.getProperty(runtime, "width").asNumber(), "encoder width");
        int height = checkedPositiveInt(options.getProperty(runtime, "height").asNumber(), "encoder height");
        int frameRate = checkedPositiveInt(options.getProperty(runtime, "frameRate").asNumber(), "encoder frame rate");
        int bitRate = checkedPositiveInt(options.getProperty(runtime, "bitRate").asNumber(), "encoder bitrate");
        std::string codec = "h264";
        if (options.hasProperty(runtime, "codec")) {
          auto value = options.getProperty(runtime, "codec");
          if (value.isString()) {
            codec = value.asString(runtime).utf8(runtime);
          }
        }
        int audioBitRate = 128000;
        int audioSampleRate = 44100;
        int audioChannelCount = 2;
        if (options.hasProperty(runtime, "audioBitRate")) {
          auto value = options.getProperty(runtime, "audioBitRate");
          if (value.isNumber()) {
            audioBitRate = checkedPositiveInt(value.asNumber(), "audio bitrate");
          }
        }
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

        std::shared_ptr<VideoComposition> composition = nullptr;
        if (count >= 2 && arguments[1].isObject()) {
          auto jsComposition = arguments[1].asObject(runtime);
          composition = VideoComposition::fromJS(runtime, jsComposition);
        }

        // encoderMode: 'copy' (default) | 'direct'
        bool directEncoder = false;
        if (options.hasProperty(runtime, "encoderMode")) {
          auto value = options.getProperty(runtime, "encoderMode");
          if (value.isString()) {
            directEncoder = value.asString(runtime).utf8(runtime) == "direct";
          }
        }

        auto instance = std::make_shared<VideoEncoderHostObject>(
            outPath, width, height, frameRate, bitRate, codec, audioBitRate,
            audioSampleRate, audioChannelCount, composition, directEncoder);
        return jsi::Object::createFromHostObject(runtime, instance);
      });
  RNSVModule.setProperty(runtime, "createVideoEncoder",
                         std::move(createVideoEncoder));

  auto isEncodingSupported = jsi::Function::createFromHostFunction(
      runtime, jsi::PropNameID::forAscii(runtime, "isEncodingSupported"), 1,
      [](jsi::Runtime& runtime, const jsi::Value& thisValue,
         const jsi::Value* arguments, size_t count) -> jsi::Value {
        if (count < 1 || !arguments[0].isString()) {
          throw jsi::JSError(runtime,
                             "ReactNativeSkiaVideo.isEncodingSupported(..) "
                             "expects a codec name!");
        }
        auto codec = arguments[0].asString(runtime).utf8(runtime);
        return jsi::Value(VideoEncoderHostObject::isCodecSupported(codec));
      });
  RNSVModule.setProperty(runtime, "isEncodingSupported",
                         std::move(isEncodingSupported));

  // Worklet runtime threads never drain their autorelease pool, so any
  // per-frame ObjC garbage created by JS code running there (e.g. the Metal
  // command buffers autoreleased by Skia's surface.flush) accumulates for the
  // lifetime of the app. This lets JS run a block of work inside a pool.
  auto runWithAutoreleasePool = jsi::Function::createFromHostFunction(
      runtime, jsi::PropNameID::forAscii(runtime, "runWithAutoreleasePool"), 1,
      [](jsi::Runtime& runtime, const jsi::Value& thisValue,
         const jsi::Value* arguments, size_t count) -> jsi::Value {
        if (count < 1 || !arguments[0].isObject() ||
            !arguments[0].asObject(runtime).isFunction(runtime)) {
          throw jsi::JSError(runtime,
                             "ReactNativeSkiaVideo.runWithAutoreleasePool(..) "
                             "expects a function!");
        }
        auto fn = arguments[0].asObject(runtime).asFunction(runtime);
        @autoreleasepool {
          return fn.call(runtime);
        }
      });
  RNSVModule.setProperty(runtime, "runWithAutoreleasePool",
                         std::move(runWithAutoreleasePool));

  MemoryBudget::install(runtime, RNSVModule);
  RNSVModule.setProperty(runtime, "getResourceStats",
      jsi::Function::createFromHostFunction(
          runtime, jsi::PropNameID::forAscii(runtime, "getResourceStats"), 0,
          [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t) {
            auto result = jsi::Object(rt);
            auto add = [&](const char* name, const ResourceCounter& counter) {
              result.setProperty(rt, (std::string(name) + "Current").c_str(),
                                 static_cast<double>(counter.current.load()));
              result.setProperty(rt, (std::string(name) + "Peak").c_str(),
                                 static_cast<double>(counter.peak.load()));
            };
            add("frameBuffers", NativeResourceStats::frameBuffers);
            add("frameBytes", NativeResourceStats::frameBytes);
            add("decoderBuffers", NativeResourceStats::decoderBuffers);
            add("decoderBytes", NativeResourceStats::decoderBytes);
            add("decoders", NativeResourceStats::decoders);
            add("encoders", NativeResourceStats::encoders);
            add("encoderSubmittingBuffers", NativeResourceStats::encoderSubmittingBuffers);
            add("encoderSubmittingBytes", NativeResourceStats::encoderSubmittingBytes);
            result.setProperty(rt, "previewRingRefusals", static_cast<double>(PreviewStats::ringRefusals.load()));
            result.setProperty(rt, "previewEmptyQueues", static_cast<double>(PreviewStats::emptyQueues.load()));
            result.setProperty(rt, "previewDecodeTicks", static_cast<double>(PreviewStats::decodeTicks.load()));
            result.setProperty(rt, "previewSlowDecodeTicks", static_cast<double>(PreviewStats::slowDecodeTicks.load()));
            return jsi::Value(std::move(result));
          }));
  RNSVModule.setProperty(runtime, "getBackendInfo",
      jsi::Function::createFromHostFunction(
          runtime, jsi::PropNameID::forAscii(runtime, "getBackendInfo"), 0,
          [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t) {
            auto result = jsi::Object(rt);
            result.setProperty(rt, "platform", "ios");
            result.setProperty(rt, "frameTransport", "cvpixelbuffer-bgra");
            result.setProperty(rt, "preview", "webgpu-native-blit+gpu-owned-snapshot");
            result.setProperty(rt, "gpuUploadScratchCapacityPerRuntime", 1);
            // The export probes the GPU path at setup and warns when it falls back.
            result.setProperty(rt, "export", "gpu-iosurface-bounded-pixelbuffer-pool");
            result.setProperty(rt, "exportFallback", "cpu-readback-bounded-pixelbuffer-pool");
            // Decoded frames are sampled through their IOSurface during a GPU
            // export, copied into owned snapshots only if that import fails.
            result.setProperty(rt, "exportSource", "iosurface-in-place");
            result.setProperty(rt, "nativeFrameCapacity", 2);
            result.setProperty(rt, "encoderPoolCapacity", 3);
            result.setProperty(rt, "gpuDirectExport", true);
            // What this native code implements, for JS shipped ahead of a
            // rebuilt app: an older binary has neither and would play every
            // item at 1×. See getVideoCompositionFeatures.
            result.setProperty(rt, "playbackRate", true);
            result.setProperty(rt, "syncBackwardSeek", true);
            return jsi::Value(std::move(result));
          }));
  runtime.global().setProperty(runtime, "RNSkiaVideo", RNSVModule);
  return @true;
}
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams&)params {
  return std::make_shared<facebook::react::NativeReactNativeSkiaVideoSpecJSI>(
      params);
}

@end
