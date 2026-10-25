#pragma once

#import "ItemTime.h"
#import "SeekPolicy.h"
#import "VideoComposition.h"
#import "VideoFrame.h"
#import <AVFoundation/AVFoundation.h>
#import <list>
#include <atomic>
#include <mutex>

using namespace facebook;

namespace RNSkiaVideo {

class VideoCompositionItemDecoder {
public:
  VideoCompositionItemDecoder(std::shared_ptr<VideoCompositionItem> item,
                              bool realTime, AVURLAsset* sharedAsset = nil,
                              CMTime initialTime = kCMTimeZero);
  ~VideoCompositionItemDecoder();
  void advanceDecoder(CMTime currentTime);
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

  void setupReader(CMTime initialTime);
  /** The file time the item plays over a span of composition time. */
  CMTime sourceSpan(CMTime compositionSpan) const;
  /** Drops the reader and its decoded frames, keeping the issued ones. */
  void discardReader();
  std::shared_ptr<VideoFrame> makeFrame(CVPixelBufferRef buffer,
                                        uint64_t memoryToken);
};

} // namespace RNSkiaVideo
