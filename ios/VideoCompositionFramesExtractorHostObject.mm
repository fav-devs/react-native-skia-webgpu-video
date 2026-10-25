#include "VideoCompositionFramesExtractorHostObject.h"

#import "AVAssetTrackUtils.h"
#import "NativeResourceStats.h"
#import "AudioCompositionUtils.h"
#import "RNSVJSIUtils.h"
#include "RNSVCheckedSizes.h"
#include "Shuttle.h"
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

namespace RNSkiaVideo {

VideoCompositionFramesExtractorHostObject::
    VideoCompositionFramesExtractorHostObject(
        jsi::Runtime& runtime, std::shared_ptr<react::CallInvoker> callInvoker,
        std::shared_ptr<VideoComposition> videoComposition)
    : EventEmitter(runtime, callInvoker), composition(videoComposition),
      window(videoComposition->lazyDecoders, true) {
  lock = [[NSObject alloc] init];
}

VideoCompositionFramesExtractorHostObject::
    ~VideoCompositionFramesExtractorHostObject() {
  this->release();
  // The queued blocks hold this, a reader being opened among them: this
  // returns once they have all run.
  if (decoderQueue && dispatch_get_specific(this) != this) {
    dispatch_sync(decoderQueue, ^{
      return;
    });
  }
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
  @synchronized(lock) {
  auto propName = propNameId.utf8(runtime);
  if (propName == "prepare") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          @synchronized(lock) { if (!released.test()) {
            prepare();
          } }
          return jsi::Value::undefined();
        });
  } else if (propName == "play") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          @synchronized(lock) { if (!released.test()) {
            if (initialized) {
              play();
            } else {
              playWhenReady = true;
            }
          } }
          return jsi::Value::undefined();
        });
  } else if (propName == "pause") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          @synchronized(lock) { if (!released.test()) {
            if (initialized) {
              pause();
            } else {
              playWhenReady = false;
            }
          } }
          return jsi::Value::undefined();
        });
  } else if (propName == "seekTo") {
    return getFunction(
        runtime, propName, 1,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          if (count < 1 || !arguments[0].isNumber())
            throw jsi::JSError(runtime, "seekTo expects media seconds");
          auto seconds = checkedMediaSeconds(arguments[0].asNumber());
          if (!released.test()) {
            seekTo(CMTimeMakeWithSeconds(seconds, NSEC_PER_SEC));
          }
          return jsi::Value::undefined();
        });
  } else if (propName == "decodeCompositionFrames") {
    return getFunction(
        runtime, propName, 0,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          scheduleDecode();
          @synchronized(lock) {
            if (released.test()) {
              return jsi::Object(runtime);
            }
            if (initialized && lastAppliedSeekGeneration == seekGeneration) {
              auto currentTime = getCurrentTime();
              framesTime = currentTime;
              framesTimeHost = CACurrentMediaTime();
              bool changed = false;
              for (const auto& entry : itemDecoders) {
                auto itemId = entry.first;
                auto decoder = entry.second;
                auto previousFrame = currentFrames[itemId];
                // Forced after a seek as well as when there is nothing on
                // screen: the frames the new reader hands back start at the
                // keyframe before the target, so waiting for one stamped at
                // or past it holds the pre-seek picture for up to a GOP —
                // the scrub looks stuck, then jumps.
                auto frame = decoder->acquireFrameForTime(
                    currentTime, !previousFrame || seekPending);
                if (frame) {
                  currentFrames[itemId] = frame;
                  changed = true;
                }
              }
              if (changed) {
                framesVersion++;
                seekPending = false;
              }
            }
            // The frames object is only rebuilt when a decoder produced a
            // new frame. On a 120 Hz display most calls see the same frames
            // as the previous one, and rewrapping them would be one JS
            // allocation per item per vsync.
            return getVersionedObject(
                runtime, "frames", (double)framesVersion,
                [&](jsi::Object& frames) {
                  for (const auto& entry : currentFrames) {
                    if (!entry.second) {
                      continue;
                    }
                    frames.setProperty(runtime, entry.first.c_str(),
                                       jsi::Object::createFromHostObject(
                                           runtime, entry.second));
                  }
                });
          }
        });
  } else if (propName == "on") {
    return getFunction(
        runtime, propName, 2,
        [this](jsi::Runtime& runtime, const jsi::Value& thisValue,
               const jsi::Value* arguments, size_t count) -> jsi::Value {
          @synchronized(lock) {
            if (released.test()) {
              // Nothing to listen to anymore: hand out a no-op unsubscribe.
              return jsi::Function::createFromHostFunction(
                  runtime, jsi::PropNameID::forAscii(runtime, "dispose"), 0,
                  [](jsi::Runtime& runtime, const jsi::Value& thisValue,
                     const jsi::Value* arguments, size_t count) -> jsi::Value {
                    return jsi::Value::undefined();
                  });
            }
            if (count < 2 || !arguments[0].isString() || !arguments[1].isObject() ||
                !arguments[1].asObject(runtime).isFunction(runtime))
              throw jsi::JSError(runtime, "on expects an event name and listener");
            auto name = arguments[0].asString(runtime).utf8(runtime);
            auto handler = arguments[1].asObject(runtime).asFunction(runtime);
            return this->on(name, std::move(handler));
          }
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
    return jsi::Value(released.test() ? 0 : CMTimeGetSeconds(getPresentedTime()));
  } else if (propName == "framesVersion") {
    return jsi::Value(released.test() ? 0 : (double)framesVersion);
  } else if (propName == "isLooping") {
    return jsi::Value(!released.test() && isLooping);
  } else if (propName == "isPlaying") {
    return jsi::Value(!released.test() && isPlaying);
  } else if (propName == "playbackRate") {
    return jsi::Value(playbackRate);
  }
  return jsi::Value::undefined();
  }
}

void VideoCompositionFramesExtractorHostObject::set(
    jsi::Runtime& runtime, const jsi::PropNameID& propNameId,
    const jsi::Value& value) {
  @synchronized(lock) {
  if (released.test()) {
    return;
  }
  }
  auto propName = propNameId.utf8(runtime);
  if (propName == "isLooping") {
    isLooping = value.asBool();
  } else if (propName == "playbackRate") {
    if (!value.isNumber())
      throw jsi::JSError(runtime, "playbackRate expects a number");
    double rate;
    try {
      rate = checkedShuttleRate(value.asNumber());
    } catch (const std::invalid_argument& error) {
      throw jsi::JSError(runtime, error.what());
    }
    setPlaybackRate(rate);
  }
}

void VideoCompositionFramesExtractorHostObject::prepare() {
  @synchronized(lock) {
    if (released.test() || decoderQueue) return;
  // User-interactive: the queue feeds the display at every vsync. At utility,
  // a warm iPhone parked it on the efficiency cores: 60 fps clips froze for
  // 300-500 ms at a time while the decoder caught up, and a 4K 60 fps preview
  // showed one frame in six.
  dispatch_queue_attr_t attr = dispatch_queue_attr_make_with_qos_class(
      DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0);
  decoderQueue = dispatch_queue_create("ReactNativeVideoCompositionItemDecoder", attr);
  dispatch_queue_set_specific(decoderQueue, this, this, NULL);
  std::weak_ptr<VideoCompositionFramesExtractorHostObject> weak =
      std::static_pointer_cast<VideoCompositionFramesExtractorHostObject>(shared_from_this());
  dispatch_async(decoderQueue, ^{
    if (auto owner = weak.lock()) owner->init();
  });
  displayLink = [[RNSVDisplayLinkWrapper alloc]
      initWithUpdateBlock:^(CADisplayLink* displayLink) {
        if (auto owner = weak.lock()) owner->scheduleDecode();
      }];
  [displayLink start];
  }
}
// Both display ticks and explicit seeks enter one serial decoder queue.
// A paused/occluded surface must still service a seek even when CADisplayLink
// is throttled. Coalescing bounds outstanding work to one queued tick.
void VideoCompositionFramesExtractorHostObject::scheduleDecode() {
  @synchronized(lock) {
    if (released.test() || !decoderQueue || decoderTickPending.exchange(true)) return;
    std::weak_ptr<VideoCompositionFramesExtractorHostObject> weak =
        std::static_pointer_cast<VideoCompositionFramesExtractorHostObject>(shared_from_this());
    dispatch_async(decoderQueue, ^{
      auto owner = weak.lock();
      if (!owner) return;
      uint64_t scheduledGeneration;
      @synchronized(owner->lock) { scheduledGeneration = owner->seekGeneration; }
      @autoreleasepool {
        struct PendingGuard {
          std::atomic<bool>& flag;
          ~PendingGuard() { flag.store(false); }
        } pendingGuard{owner->decoderTickPending};
        CFTimeInterval tickStart = CACurrentMediaTime();
        owner->decodeTick();
        PreviewStats::decodeTicks++;
        if (CACurrentMediaTime() - tickStart > 0.016) PreviewStats::slowDecodeTicks++;
      }
      // A seek arriving during decoding was coalesced into this task. Queue
      // its latest position after releasing the pending flag, so it cannot
      // be lost when the display link is idle.
      @synchronized(owner->lock) {
        if (!owner->released.test() &&
            scheduledGeneration != owner->seekGeneration) {
          owner->scheduleDecode();
        }
      }
    });
  }
}

void VideoCompositionFramesExtractorHostObject::decodeTick() {
  auto* self = this;
  std::vector<std::shared_ptr<VideoCompositionItemDecoder>> advancing;
  std::vector<std::shared_ptr<VideoCompositionItem>> opening;
  std::vector<std::shared_ptr<VideoCompositionItemDecoder>> closing;
  CMTime currentTime = kCMTimeZero;
  uint64_t generation = 0;
  bool backward = false;
  double rate = 1;
  @synchronized(self->lock) {
    if (self->released.test() || !self->initialized) {
      return;
    }
    currentTime = self->getCurrentTime();
    if (self->isPlaying &&
        Shuttle::reachedStart(CMTimeGetSeconds(currentTime), self->playbackRate)) {
      // Backward to the start: stopped there, on its first frame, which the
      // decoders read forward again below. Not a completion.
      self->pausePosition = kCMTimeZero;
      self->isPlaying = false;
      self->framesTime = kCMTimeInvalid;
      currentTime = kCMTimeZero;
    } else if (CMTimeGetSeconds(currentTime) >= self->composition->duration &&
               !(self->isPlaying && self->playbackRate < 0)) {
      if (!self->completeEmitted) {
        self->completeEmitted = true;
        self->emit("complete", jsi::Value::null());
      }
      if (self->isLooping) {
        currentTime = kCMTimeZero;
        self->anchorClock(0);
        if (self->audioPlayer && self->audioIsClock) {
          [self->audioPlayer seekToTime:kCMTimeZero
                  toleranceBefore:kCMTimeZero
                   toleranceAfter:kCMTimeZero
                completionHandler:^(BOOL){
                }];
        }
      } else {
        // Switching to the paused clock must preserve the completed position;
        // leaving its old value (usually zero) rewinds after completion.
        self->pausePosition = CMTimeMakeWithSeconds(
            self->composition->duration, NSEC_PER_SEC);
        self->isPlaying = false;
        if (self->audioPlayer) {
          [self->audioPlayer pause];
        }
        return;
      }
    } else {
      self->completeEmitted = false;
    }
    generation = self->seekGeneration;
    backward = self->isPlaying &&
               Shuttle::backwardAt(self->playbackRate, self->decodeBackward);
    self->decodeBackward = backward;
    rate = self->isPlaying ? self->playbackRate : 1;
    self->updateWindow(currentTime, opening, closing, backward, std::fabs(rate));
  }
  // Readers are slow to open and close: not while the UI thread waits
  // on the self->lock for its frames.
  for (const auto& decoder : closing) {
    decoder->release();
  }
  closing.clear();
  if (!opening.empty()) {
    self->openDecoders(opening, currentTime, generation);
  }
  @synchronized(self->lock) {
    if (self->released.test() || generation != self->seekGeneration) {
      return;
    }
    // Paused where every decoder has already been advanced to: there
    // is nothing to decode until the position moves or a seek lands.
    if (!self->isPlaying && opening.empty() &&
        generation == self->lastAdvancedGeneration &&
        backward == self->lastAdvancedBackward &&
        CMTimeCompare(currentTime, self->lastAdvancedTime) == 0) {
      return;
    }
    for (const auto& entry : self->itemDecoders) {
      if (entry.second) {
        advancing.push_back(entry.second);
      }
    }
  }
  bool applySeek = generation != self->lastAppliedSeekGeneration;
  // In parallel on GCD's pool, instead of a new thread per decoder
  // per vsync.
  struct DecodeFailure { std::mutex mutex; std::string message; };
  auto failure = std::make_shared<DecodeFailure>();
  dispatch_apply(advancing.size(), DISPATCH_APPLY_AUTO, ^(size_t i) {
    try {
      if (applySeek) advancing[i]->seekTo(currentTime);
      advancing[i]->advanceDecoder(currentTime, backward, rate);
    }
    catch (const std::exception& error) {
      std::lock_guard<std::mutex> guard(failure->mutex);
      if (failure->message.empty()) failure->message = error.what();
    } catch (NSError* error) {
      std::lock_guard<std::mutex> guard(failure->mutex);
      if (failure->message.empty())
        failure->message = [[error localizedDescription] UTF8String];
    }
  });
  if (!failure->message.empty()) {
    @synchronized(self->lock) { self->pause(); }
    auto message = failure->message;
    self->emit("error", [message](jsi::Runtime& runtime) {
      auto error = jsi::Object(runtime);
      error.setProperty(runtime, "message", jsi::String::createFromUtf8(runtime, message));
      return jsi::Value(std::move(error));
    });
  }
  @synchronized(lock) {
    if (!released.test() && generation == seekGeneration) {
      lastAppliedSeekGeneration = generation;
      if (failure->message.empty()) {
        lastAdvancedTime = currentTime;
        lastAdvancedGeneration = generation;
        lastAdvancedBackward = backward;
      }
    }
  }
}

void VideoCompositionFramesExtractorHostObject::init() {
  @synchronized(lock) {
    if (released.test()) {
      return;
    }
    try {
      // Assets are shared between the video decoders and the audio
      // composition so a same file is never opened twice.
      assetCache = [NSMutableDictionary dictionary];
      for (const auto& item : composition->items) {
        if (!item->isVideo || !opensAt(item, CMTimeGetSeconds(pausePosition))) {
          continue;
        }
        itemDecoders[item->id] = std::make_shared<VideoCompositionItemDecoder>(
            item, true, getOrCreateAsset(item->path, assetCache));
      }
      if (composition->hasAudio()) {
        auto audioComposition = buildAudioComposition(composition, assetCache);
        if (audioComposition.composition) {
          AVPlayerItem* playerItem =
              [AVPlayerItem playerItemWithAsset:audioComposition.composition];
          if (audioComposition.audioMix) {
            playerItem.audioMix = audioComposition.audioMix;
          }
          audioPlayer = [AVPlayer playerWithPlayerItem:playerItem];
          audioPlayer.actionAtItemEnd = AVPlayerActionAtItemEndNone;
          audioPlayer.automaticallyWaitsToMinimizeStalling = NO;
          if (CMTimeCompare(pausePosition, kCMTimeZero) > 0) {
            [audioPlayer seekToTime:pausePosition
                    toleranceBefore:kCMTimeZero
                     toleranceAfter:kCMTimeZero];
          }
        }
      }
      // A seek issued before init (a freshly created player positioned right
      // away by the JS side) only reached `pausePosition` and, above, the
      // audio player: the item decoders were still reading from zero and
      // caught up with the clock by decoding every frame in between —
      // visibly, a fast-forward from the start of the clip. Position them
      // where the audio starts.
      if (CMTimeCompare(pausePosition, kCMTimeZero) > 0) {
        for (const auto& entry : itemDecoders) {
          entry.second->seekTo(pausePosition);
        }
      }
    } catch (const std::exception& error) {
      itemDecoders.clear();
      audioPlayer = nil;
      assetCache = nil;
      auto message = std::string(error.what());
      emit("error", [message](jsi::Runtime& runtime) -> jsi::Value {
        auto result = jsi::Object(runtime);
        result.setProperty(runtime, "message", jsi::String::createFromUtf8(runtime, message));
        return result;
      });
      return;
    } catch (NSError* error) {
      itemDecoders.clear();
      audioPlayer = nil;
      assetCache = nil;
      emit("error", [=](jsi::Runtime& runtime) -> jsi::Value {
        return RNSkiaVideo::NSErrorToJSI(runtime, error);
      });
      return;
    }
    lastAppliedSeekGeneration = seekGeneration;
    initialized = true;
    if (playWhenReady) {
      play();
    }
    this->emit("ready", jsi::Value::null());
  }
}

void VideoCompositionFramesExtractorHostObject::play() {
  @synchronized(lock) {
  if (released.test() || isPlaying) return;
  // Backward from the start: nothing to play.
  if (Shuttle::reachedStart(CMTimeGetSeconds(pausePosition), playbackRate)) return;
  framesTime = kCMTimeInvalid;
  // A completed paused clock stays at the end until play explicitly restarts
  // it. Rewind the readers through the same serial seek generation as seekTo.
  // Backward, it plays from the end.
  if (CMTimeGetSeconds(pausePosition) >= composition->duration &&
      playbackRate >= 0) {
    seekTo(kCMTimeZero);
  }
  audioIsClock = playbackRate == 1;
  if (audioPlayer && audioIsClock) {
    if (CMTimeGetSeconds(audioPlayer.currentTime) >= composition->duration) {
      [audioPlayer seekToTime:kCMTimeZero
              toleranceBefore:kCMTimeZero
               toleranceAfter:kCMTimeZero];
    }
    [audioPlayer play];
  }
  anchorClock(CMTimeGetSeconds(pausePosition));
  pausePosition = kCMTimeZero;
  isPlaying = true;
  }
}

void VideoCompositionFramesExtractorHostObject::pause() {
  @synchronized(lock) {
  if (!isPlaying) {
    return;
  }
  pausePosition = getCurrentTime();
  isPlaying = false;
  framesTime = kCMTimeInvalid;
  if (audioPlayer) {
    [audioPlayer pause];
  }
  }
}

void VideoCompositionFramesExtractorHostObject::anchorClock(double time) {
  clockAnchor = time;
  clockAnchorHost = CACurrentMediaTime();
}

// The clock goes on from where it is at the new rate, without a seek: the
// decoders keep reading, and only start over (decodeTick) when the direction
// changes. The audio only plays at 1×.
void VideoCompositionFramesExtractorHostObject::setPlaybackRate(double rate) {
  @synchronized(lock) {
    if (released.test() || rate == playbackRate) return;
    double previous = playbackRate;
    if (isPlaying) {
      anchorClock(CMTimeGetSeconds(getCurrentTime()));
      framesTime = kCMTimeInvalid;
    }
    playbackRate = rate;
    if (audioPlayer && isPlaying) {
      if (previous == 1) {
        audioIsClock = false;
        [audioPlayer pause];
      } else if (rate == 1) {
        [audioPlayer seekToTime:CMTimeMakeWithSeconds(clockAnchor, NSEC_PER_SEC)
                toleranceBefore:kCMTimeZero
                 toleranceAfter:kCMTimeZero];
        [audioPlayer play];
      }
    }
  }
  scheduleDecode();
}

void VideoCompositionFramesExtractorHostObject::seekTo(CMTime time) {
  @synchronized(lock) {
  if (released.test()) return;
  seekPending = true;
  framesTime = kCMTimeInvalid;
  if (isPlaying) {
    anchorClock(CMTimeGetSeconds(time));
  } else {
    pausePosition = time;
  }
  if (audioPlayer) {
    [audioPlayer seekToTime:time
            toleranceBefore:kCMTimeZero
             toleranceAfter:kCMTimeZero];
    // Back at 1× since play: the audio is sought to the clock with it, and is
    // the clock again.
    if (isPlaying && playbackRate == 1 && !audioIsClock) {
      audioIsClock = true;
      [audioPlayer play];
    }
  }
    seekGeneration++;
    // Reader mutation is applied by decodeTick on its serial queue.
    scheduleDecode();
  }
}

bool VideoCompositionFramesExtractorHostObject::opensAt(
    const std::shared_ptr<VideoCompositionItem>& item, double position) const {
  return window.opens(item->compositionStartTime,
                      item->compositionStartTime + item->duration, position,
                      composition->duration, false);
}

// Under the lock. Closed decoders leave the maps here and are released by the
// caller; opened ones are made by openDecoders.
void VideoCompositionFramesExtractorHostObject::updateWindow(
    CMTime time, std::vector<std::shared_ptr<VideoCompositionItem>>& opening,
    std::vector<std::shared_ptr<VideoCompositionItemDecoder>>& closing,
    bool backward, double speed) {
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
      if (!failedItems.count(item->id) &&
          window.opens(start, end, position, composition->duration,
                       isLooping, backward, speed)) {
#if defined(RNSV_TRACE_LIFECYCLE) && RNSV_TRACE_LIFECYCLE
        NSLog(@"[rnskv] open %s at %.3fs", item->id.c_str(), position);
#endif
        opening.push_back(item);
      }
    } else if (!window.keeps(start, end, position, composition->duration,
                             isLooping, backward, speed)) {
#if defined(RNSV_TRACE_LIFECYCLE) && RNSV_TRACE_LIFECYCLE
      NSLog(@"[rnskv] close %s at %.3fs", item->id.c_str(), position);
#endif
      closing.push_back(it->second);
      itemDecoders.erase(it);
      if (currentFrames.erase(item->id) > 0) {
        framesVersion++;
      }
    }
  }
}

// On the decoder queue, outside of the lock.
void VideoCompositionFramesExtractorHostObject::openDecoders(
    const std::vector<std::shared_ptr<VideoCompositionItem>>& items,
    CMTime time, uint64_t generation) {
  for (const auto& item : items) {
    std::shared_ptr<VideoCompositionItemDecoder> decoder;
    NSError* failure = nil;
    NSMutableDictionary<NSString*, AVURLAsset*>* cache;
    @synchronized(lock) {
      if (released.test()) return;
      cache = assetCache;
    }
    try {
      decoder = std::make_shared<VideoCompositionItemDecoder>(
          item, true, getOrCreateAsset(item->path, cache), time);
    } catch (const std::exception& error) {
      failure = [NSError errorWithDomain:@"com.azzapp.rnskv" code:0
          userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithUTF8String:error.what()]}];
    } catch (NSError* error) {
      failure = error;
    }
    if (failure) {
      // Decoder queue only, as updateWindow reads it.
      failedItems.insert(item->id);
      emit("error", [=](jsi::Runtime& runtime) -> jsi::Value {
        return RNSkiaVideo::NSErrorToJSI(runtime, failure);
      });
      continue;
    }
    @synchronized(lock) {
      if (released.test()) {
        decoder->release();
        return;
      }
      if (seekGeneration != generation) {
        decoder->seekTo(getCurrentTime());
      }
      itemDecoders[item->id] = decoder;
    }
  }
}

// The time drawFrame draws at: the clock the frames it gets were picked at,
// rather than the clock when it reads the time, after the frames' import (a
// few milliseconds of GPU work). Read later, the time ran ahead of the frames,
// and at 60 fps a frame's start could fall in between on every frame: the
// time said frame n while the frames held n - 1. The live clock once play,
// pause or a seek has moved it, or without a recent pick (no preview).
CMTime VideoCompositionFramesExtractorHostObject::getPresentedTime() {
  @synchronized(lock) {
    if (isPlaying && CMTIME_IS_VALID(framesTime) &&
        CACurrentMediaTime() - framesTimeHost < 0.1) {
      return framesTime;
    }
    return getCurrentTime();
  }
}

CMTime VideoCompositionFramesExtractorHostObject::getCurrentTime() {
  @synchronized(lock) {
  if (isPlaying) {
    // When the composition has audio, the audio player is the master clock.
    if (audioPlayer && audioIsClock) {
      CMTime time = audioPlayer.currentTime;
      if (CMTIME_IS_NUMERIC(time)) {
        return time;
      }
    }
    // Held to the composition: backward stops at 0, and decodeTick sees it
    // there. Past the end forward, as before: decodeTick completes there.
    double time = clockAnchor + playbackRate * (CACurrentMediaTime() - clockAnchorHost);
    return CMTimeMakeWithSeconds(std::max(time, 0.0), NSEC_PER_SEC);
  } else {
    return pausePosition;
  }
  }
}

void VideoCompositionFramesExtractorHostObject::release() {
  @synchronized(lock) {
    if (released.test_and_set()) {
      return;
    }
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
    assetCache = nil;
    if (audioPlayer) {
      [audioPlayer pause];
      [audioPlayer replaceCurrentItemWithPlayerItem:nil];
      audioPlayer = nil;
    }
  }
  removeAllListeners();
  if (displayLink != nullptr) {
    [displayLink invalidate];
    displayLink = nullptr;
  }
}

} // namespace RNSkiaVideo

@implementation RNSVDisplayLinkWrapper

- (instancetype)initWithUpdateBlock:
    (void (^)(CADisplayLink* displayLink))updateBlock {
  self = [super init];
  if (self) {
    _updateBlock = [updateBlock copy];
    _displayLink =
        [CADisplayLink displayLinkWithTarget:self
                                    selector:@selector(displayLinkFired:)];
  }
  return self;
}

- (void)displayLinkFired:(CADisplayLink*)displayLink {
  if (self.updateBlock) {
    self.updateBlock(displayLink);
  }
}

- (void)start {
  if ([NSThread isMainThread]) {
    [self.displayLink addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
  } else {
    dispatch_async(dispatch_get_main_queue(), ^{ [self start]; });
  }
}

- (void)invalidate {
  if (![NSThread isMainThread]) {
    dispatch_async(dispatch_get_main_queue(), ^{ [self invalidate]; });
    return;
  }
  [self.displayLink invalidate];
  self.displayLink = nil;
  self.updateBlock = nil;
}

@end
