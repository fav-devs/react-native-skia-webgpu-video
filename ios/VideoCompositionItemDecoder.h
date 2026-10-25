#pragma once

#import "ItemTime.h"
#import "SeekPolicy.h"
#import "Shuttle.h"
#import "VideoComposition.h"
#import "VideoFrame.h"
#import <AVFoundation/AVFoundation.h>
#import <list>
#include <atomic>
#include <cmath>
#include <mutex>
#include <vector>

using namespace facebook;

namespace RNSkiaVideo {

class VideoCompositionItemDecoder {
public:
  VideoCompositionItemDecoder(std::shared_ptr<VideoCompositionItem> item,
                              bool realTime, AVURLAsset* sharedAsset = nil,
                              CMTime initialTime = kCMTimeZero);
  ~VideoCompositionItemDecoder();
  /**
   * Decodes ahead of `currentTime`, or behind it with `backward` (see
   * Shuttle.h): the preview's player plays backward. `rate` is the player's,
   * whose clock a fast forward decoder may be sought to catch up with.
   */
  void advanceDecoder(CMTime currentTime, bool backward = false,
                      double rate = 1);
  void seekTo(CMTime currentTime);
  std::shared_ptr<VideoFrame> acquireFrameForTime(CMTime currentTime,
                                                  bool force);
  void release();

private:
  NSObject* lock;
  // AVAssetReader cancelReading tears down its internal decode context.
  // It must never race a copyNextSampleBuffer call on that same reader.
  std::mutex readerMutex;
  bool realTime = false;
  bool hasLooped = false;
  // Bumped when the reader is replaced/released; reading a forward seek on
  // keeps its queued samples and outstanding batch in the same generation.
  uint64_t readerGeneration = 0;
  std::shared_ptr<VideoCompositionItem> item;
  double width;
  double height;
  int rotation;
  AVURLAsset* asset;
  AVAssetTrack* videoTrack;
  AVAssetReader* assetReader;
  std::list<std::pair<double, CMSampleBufferRef>> decodedFrames;
  std::list<std::pair<double, CMSampleBufferRef>> nextLoopFrames;
  CMTime lastRequestedTime = kCMTimeInvalid;
  std::shared_ptr<VideoFrame> currentFrame;
  VideoFrameRing frameRing;
  uint64_t producerId = allocateVideoProducerId();
  bool counted = false;
  std::atomic<bool> released{false};

  // The time of the frame acquired last, the one on screen; NaN after a
  // seek. Under the lock.
  double shownTime = NAN;
  // The latest file time the forward reader produced, and the target of the
  // last catch-up seek (see Shuttle::catchUp). Decoder queue only.
  double lastReadTime = NAN;
  double catchUpTarget = NAN;

  // Backward playback (see Shuttle.h). Decoders read backward between two
  // advanceDecoder calls that say so; the forward reader is gone meanwhile.
  bool backward = false;
  struct HeldSample {
    double pts;
    double until;
    CMSampleBufferRef sample;
    uint64_t window;
  };
  // The frames of fully decoded windows, ascending. Under the lock.
  std::vector<HeldSample> heldSamples;
  // The earliest file time the windows decoded so far cover, NaN for none.
  // Decoder queue only, as is everything about the window being read.
  double coveredFrom = NAN;
  AVAssetReader* windowReader = nil;
  Shuttle::Window window{};
  std::vector<HeldSample> windowSamples;
  // Whether windowSamples ends with a frame from before the window's start.
  bool windowCandidate = false;
  uint64_t windowSerial = 0;
  // The track's sync samples, in the reader's timeline; empty when unknown.
  std::vector<double> syncTimes;
  bool syncTimesLoaded = false;

  void setupReader(CMTime initialTime);
  /**
   * A reader started over [readStart, endTime) of the file, at the decode
   * size; nil for an empty range.
   */
  AVAssetReader* makeReader(CMTime readStart, CMTime endTime);
  void advanceBackward(CMTime currentTime);
  /** Drops the backward windows: the one being read and the decoded ones. */
  void discardWindows();
  void loadSyncTimes();
  size_t backwardCapacity() const;
  /** The file time the item plays over a span of composition time. */
  CMTime sourceSpan(CMTime compositionSpan) const;
  /**
   * Drops the reader and its decoded frames, the backward windows too,
   * keeping the issued ones.
   */
  void discardReader();
  std::shared_ptr<VideoFrame> makeFrame(CVPixelBufferRef buffer,
                                        uint64_t memoryToken);
};

} // namespace RNSkiaVideo
