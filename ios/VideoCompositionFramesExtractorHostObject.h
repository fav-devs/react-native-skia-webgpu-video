#pragma once

#import "DecoderWindow.h"
#import "RNSVEventEmitter.h"
#import "RNSVHostObject.h"
#import "VideoComposition.h"
#import "VideoCompositionItemDecoder.h"
#import "VideoFrame.h"
#import <AVFoundation/AVFoundation.h>
#import <QuartzCore/QuartzCore.h>
#import <atomic>
#import <jsi/jsi.h>
#import <map>
#import <set>
#import <vector>

@interface RNSVDisplayLinkWrapper : NSObject

@property(nonatomic, strong) CADisplayLink* displayLink;
@property(nonatomic, copy) void (^updateBlock)(CADisplayLink* displayLink);

- (instancetype)initWithUpdateBlock:
    (void (^)(CADisplayLink* displayLink))updateBlock;
- (void)start;
- (void)invalidate;

@end

namespace RNSkiaVideo {
using namespace facebook;

class JSI_EXPORT VideoCompositionFramesExtractorHostObject
    : public RNSVHostObject,
      EventEmitter {
public:
  VideoCompositionFramesExtractorHostObject(
      jsi::Runtime& runtime, std::shared_ptr<react::CallInvoker> callInvoker,
      std::shared_ptr<VideoComposition> videoComposition);
  ~VideoCompositionFramesExtractorHostObject();
  jsi::Value get(jsi::Runtime&, const jsi::PropNameID& name) override;
  void set(jsi::Runtime&, const jsi::PropNameID& name,
           const jsi::Value& value) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime& rt) override;

private:
  NSObject* lock;
  std::shared_ptr<VideoComposition> composition;
  DecoderWindow window;
  std::map<std::string, std::shared_ptr<VideoCompositionItemDecoder>>
      itemDecoders;
  // Items whose decoder could not be opened lazily: not tried again.
  std::set<std::string> failedItems;
  // Shared by the decoders and the audio; decoder queue only.
  NSMutableDictionary<NSString*, AVURLAsset*>* assetCache;
  // Tells whether a seek happened while a decoder was being opened.
  uint64_t seekGeneration = 0;
  // What the decoders were last advanced to, so a paused player stops
  // asking them again at every vsync.
  CMTime lastAdvancedTime = kCMTimeInvalid;
  uint64_t lastAdvancedGeneration = 0;
  bool lastAdvancedBackward = false;
  // Seeks and reader advancement share the serial decoder queue. UI calls
  // update the desired clock; they never replace a reader being decoded.
  uint64_t lastAppliedSeekGeneration = 0;
  std::map<std::string, std::shared_ptr<VideoFrame>> currentFrames;
  // Incremented every time decodeCompositionFrames acquires a new frame for
  // at least one item. Exposed to JS as `framesVersion`, so the player can
  // tell an unchanged frame set from a fresh one and skip redrawing it.
  uint64_t framesVersion = 0;
  dispatch_queue_t decoderQueue;
  std::atomic<bool> decoderTickPending{false};
  RNSVDisplayLinkWrapper* displayLink;
  // The clock while playing: `clockAnchor` composition seconds at host time
  // `clockAnchorHost` (CACurrentMediaTime), moving `playbackRate` seconds a
  // second (see Shuttle::clockAt). Re-anchored by play, seeks, loops and rate
  // changes.
  double clockAnchor = 0;
  CFTimeInterval clockAnchorHost = 0;
  // Signed, held to [-4, 4] (see checkedShuttleRate).
  double playbackRate = 1;
  // Whether the decoders read backward: playing at a negative rate, or at 0
  // after one. Paused, they read forward. Decoder queue only.
  bool decodeBackward = false;
  CMTime pausePosition = kCMTimeZero;
  // The clock decodeCompositionFrames last picked the frames at, and when
  // (CACurrentMediaTime); invalid once play, pause or a seek moves the clock.
  CMTime framesTime = kCMTimeInvalid;
  CFTimeInterval framesTimeHost = 0;
  bool playWhenReady = false;
  bool isPlaying = false;
  bool isLooping = false;
  bool initialized = false;
  /** Set by a seek, cleared by the first frame drawn after it. */
  std::atomic<bool> seekPending = false;
  bool completeEmitted = false;
  // Plays the audio of the composition; when present it is also the master
  // clock of the playback, at 1× only: at another rate it is paused (muted)
  // and the clock is the host's. Back at 1× while playing, the audio resumes
  // from the clock but the host's clock stays the master until the next play
  // or seek, so the picture does not jump to wherever the audio starts.
  AVPlayer* audioPlayer;
  bool audioIsClock = true;
  std::atomic_flag released = ATOMIC_FLAG_INIT;

  void prepare();
  void scheduleDecode();
  void decodeTick();
  void init();
  void play();
  void pause();
  void seekTo(CMTime time);
  void setPlaybackRate(double rate);
  /** Starts the playing clock over from `time`, now. Under the lock. */
  void anchorClock(double time);
  CMTime getCurrentTime();
  CMTime getPresentedTime();
  void release();
  bool opensAt(const std::shared_ptr<VideoCompositionItem>& item,
               double position) const;
  void updateWindow(
      CMTime time, std::vector<std::shared_ptr<VideoCompositionItem>>& opening,
      std::vector<std::shared_ptr<VideoCompositionItemDecoder>>& closing,
      bool backward, double speed);
  void
  openDecoders(const std::vector<std::shared_ptr<VideoCompositionItem>>& items,
               CMTime time, uint64_t generation);
};

} // namespace RNSkiaVideo
