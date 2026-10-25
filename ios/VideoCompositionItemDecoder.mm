#include "VideoCompositionItemDecoder.h"

#import "AVAssetTrackUtils.h"
#import "NativeResourceStats.h"
#include "RNSVMemoryBudget.h"
#import "RNSVColorSpace.h"
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#include <unordered_map>
#include <mutex>

namespace RNSkiaVideo {

// Accounting follows each owned CMSampleBuffer through queue moves and swaps.
// The codec's internal allocations remain outside these counters.
static std::mutex decodedAccountingMutex;
struct DecodedAllocation { size_t bytes; uint64_t token; };
static std::unordered_map<CMSampleBufferRef, DecodedAllocation> decodedAccounting;
static void trackDecodedSample(CMSampleBufferRef sample) {
  size_t bytes = pixelBufferBytes(CMSampleBufferGetImageBuffer(sample));
  std::lock_guard<std::mutex> guard(decodedAccountingMutex);
  auto token = MemoryBudget::instance().reserve(bytes, "iOS decoder queue");
  try { decodedAccounting.emplace(sample, DecodedAllocation{bytes, token}); }
  catch (...) { MemoryBudget::instance().release(token); throw; }
  NativeResourceStats::decoderBuffers.add(1);
  NativeResourceStats::decoderBytes.add(bytes);
}
static uint64_t takeDecodedAllocation(CMSampleBufferRef sample) {
  std::lock_guard<std::mutex> guard(decodedAccountingMutex);
  auto found = decodedAccounting.find(sample);
  if (found == decodedAccounting.end()) return 0;
  uint64_t token = found->second.token;
  found->second.token = 0;
  return token;
}
static void releaseDecodedSample(CMSampleBufferRef sample) {
  {
    std::lock_guard<std::mutex> guard(decodedAccountingMutex);
    auto found = decodedAccounting.find(sample);
    if (found != decodedAccounting.end()) {
      NativeResourceStats::decoderBuffers.remove(1);
      NativeResourceStats::decoderBytes.remove(found->second.bytes);
      MemoryBudget::instance().release(found->second.token);
      decodedAccounting.erase(found);
    }
  }
  CFRelease(sample);
}

VideoCompositionItemDecoder::VideoCompositionItemDecoder(
    std::shared_ptr<VideoCompositionItem> item, bool realTime,
    AVURLAsset* sharedAsset, CMTime initialTime)
    : frameRing(2) {
  this->item = item;
  this->realTime = realTime;
  lock = [[NSObject alloc] init];
  NSString* path =
      [NSString stringWithCString:item->path.c_str()
                         encoding:[NSString defaultCStringEncoding]];
  asset = sharedAsset
              ?: [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path]
                                     options:nil];
  videoTrack = [[asset tracksWithMediaType:AVMediaTypeVideo] firstObject];
  if (!videoTrack) {
    throw [NSError
        errorWithDomain:@"com.azzapp.rnskv"
                   code:0
               userInfo:@{
                 NSLocalizedDescriptionKey : [NSString
                     stringWithFormat:@"No video track for path: %@", path]
               }];
  }
  width = videoTrack.naturalSize.width;
  height = videoTrack.naturalSize.height;
  rotation = AVAssetTrackUtils::GetTrackRotationInDegree(videoTrack);
  currentFrame = nullptr;
  this->setupReader(initialTime);
  NativeResourceStats::decoders.add(1);
  counted = true;
}

void VideoCompositionItemDecoder::setupReader(CMTime initialTime) {
  readerGeneration++;
  NSError* error = nil;
  assetReader = [AVAssetReader assetReaderWithAsset:asset error:&error];
  if (error) {
    throw error;
  }

  auto startTime = CMTimeMakeWithSeconds(item->startTime, NSEC_PER_SEC);
  // Capped at the item's end: a seek past it would otherwise ask the reader
  // for a negative duration. Held in composition time, then read in the
  // file's: the item reads duration * playbackRate seconds of it.
  auto position = sourceSpan(CMTimeMakeWithSeconds(
      ItemTime::heldOffset(item->compositionStartTime, item->duration,
                           CMTimeGetSeconds(initialTime)),
      NSEC_PER_SEC));
  // The start in the track's own timescale, rounded down. Given in
  // nanoseconds, a start on a frame's exact time (1.2 s, frame 36 at 30 fps)
  // can land a hair before that frame once AVAssetReader applies the track's
  // edit offset, which is not a whole number of nanoseconds (1/30 s for a
  // file with reordered frames): the reader then hands over the previous
  // frame stamped with the requested time and never the one asked for.
  CMTime endTime = CMTimeAdd(
      startTime, sourceSpan(CMTimeMakeWithSeconds(item->duration, NSEC_PER_SEC)));
  CMTime readStart = CMTimeAdd(startTime, position);
  if (videoTrack.naturalTimeScale > 0) {
    readStart = CMTimeMinimum(
        CMTimeConvertScale(readStart, videoTrack.naturalTimeScale,
                           kCMTimeRoundingMethod_RoundTowardNegativeInfinity),
        endTime);
  }
  CMTime trackEnd = CMTimeRangeGetEnd(videoTrack.timeRange);
  if (CMTIME_IS_NUMERIC(trackEnd)) endTime = CMTimeMinimum(endTime, trackEnd);
  if (CMTimeCompare(readStart, endTime) >= 0) {
    // An empty item/range is valid, including a seek past the clip. Do not
    // start AVAssetReader with an empty/negative range and treat that as a
    // decoder initialization error. A later seek can create a new reader.
    assetReader = nil;
    return;
  }
  assetReader.timeRange = CMTimeRangeFromTimeToTime(readStart, endTime);

  // AVAssetReaderTrackOutput takes pixel buffer attributes and video settings
  // in the same dictionary, so the color properties travel with them: an HDR
  // track is tone-mapped to Rec.709 by AVFoundation before we ever see it
  // (see RNSVColorSpace.h), in either format.
  //
  // NV12 is the decoder's own format, 1.5 bytes a pixel against BGRA's 4: the
  // queue's byte budget then holds five 4K frames ahead rather than one or
  // two. The GPU converts it to RGB when the frame is drawn (yuvBlit.ts),
  // with the matrix each buffer carries; only HDR needs AVFoundation's
  // conversion first (see TrackNeedsSDRConversion). BGRA is converted by
  // VideoToolbox, and a GPU export samples it in place.
  NSMutableDictionary* pixBuffAttributes = [@{
    (id)kCVPixelBufferPixelFormatTypeKey :
        @(item->yuvFrames ? kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
                          : kCVPixelFormatType_32BGRA),
    (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
    (id)kCVPixelBufferMetalCompatibilityKey : @YES,
  } mutableCopy];
  if (!item->yuvFrames || TrackNeedsSDRConversion(videoTrack)) {
    pixBuffAttributes[AVVideoColorPropertiesKey] = SDRColorProperties();
  }
  CGSize resolution = item->resolution;
  /*
   * No explicit size asked for, but a cap on the longest side: scale the
   * track's own dimensions to fit it.
   *
   * This is the size the frames are *decoded* at, so it is what the preview's
   * four-deep frame ring costs. Left uncapped, a 4K clip is 33 MB a frame in
   * BGRA — 133 MB of ring to fill a stage a few hundred points wide, which the
   * OS watchdog terminates the app over.
   *
   * `naturalSize` is the encoded size, before the display matrix, which is why
   * the cap is resolved here: a caller holding only display dimensions cannot
   * tell a portrait clip from a rotated landscape one, and asking for the
   * transpose would hand back a squashed picture. Even dimensions because
   * hardware scalers dislike odd ones.
   */
  if (!(resolution.width > 0 && resolution.height > 0) && item->maxLongSide > 0) {
    CGSize natural = videoTrack.naturalSize;
    CGFloat longest = MAX(natural.width, natural.height);
    if (longest > item->maxLongSide) {
      CGFloat scale = item->maxLongSide / longest;
      resolution = CGSizeMake(MAX(2, round(natural.width * scale / 2) * 2),
                              MAX(2, round(natural.height * scale / 2) * 2));
    }
  }
  if (resolution.width > 0 && resolution.height > 0) {
    [pixBuffAttributes setValue:@(resolution.width)
                         forKey:(id)kCVPixelBufferWidthKey];
    [pixBuffAttributes setValue:@(resolution.height)
                         forKey:(id)kCVPixelBufferHeightKey];
    width = resolution.width;
    height = resolution.height;
  }

  AVAssetReaderOutput* assetReaderOutput =
      [[AVAssetReaderTrackOutput alloc] initWithTrack:videoTrack
                                       outputSettings:pixBuffAttributes];
  // Frames are only ever read (GPU import, read-only locks): skip the copy
  // AVFoundation otherwise makes of every decoded buffer before vending it.
  assetReaderOutput.alwaysCopiesSampleData = NO;
  if (!assetReaderOutput || ![assetReader canAddOutput:assetReaderOutput]) {
    throw [NSError errorWithDomain:@"com.azzapp.rnskv" code:0
        userInfo:@{NSLocalizedDescriptionKey : @"Video reader cannot add its decoded output"}];
  }
  [assetReader addOutput:assetReaderOutput];
  if (![assetReader startReading]) {
    throw assetReader.error ?: [NSError errorWithDomain:@"com.azzapp.rnskv" code:0
        userInfo:@{NSLocalizedDescriptionKey : @"Video reader cannot start decoding"}];
  }
}

// In composition seconds: the preview reads playbackRate times as much of the
// file ahead of the displayed frame.
#define DECODER_INPUT_TIME_ADVANCE 0.1

// A 1× item keeps its CMTime as it is, so it maps exactly as it did before
// playbackRate; another rate goes through seconds, to the nanosecond.
CMTime VideoCompositionItemDecoder::sourceSpan(CMTime compositionSpan) const {
  if (item->playbackRate == 1) return compositionSpan;
  return CMTimeMakeWithSeconds(
      ItemTime::sourceSpan(CMTimeGetSeconds(compositionSpan), item->playbackRate),
      NSEC_PER_SEC);
}


using FrameQueue = std::list<std::pair<double, CMSampleBufferRef>>;

static constexpr size_t kMaxQueuedSamples = 8;
static constexpr size_t kMaxQueuedSampleBytes = 64ULL * 1024 * 1024;
static size_t queueBytes(const FrameQueue& queue) {
  size_t bytes = 0;
  for (const auto& frame : queue)
    bytes += pixelBufferBytes(CMSampleBufferGetImageBuffer(frame.second));
  return bytes;
}
// Keep the latest candidate at/before the requested position, plus bounded
// future samples. A large seek never stores all intermediate decoded frames.
static void prunePastSamples(FrameQueue& queue, CMTime position) {
  while (queue.size() > 1) {
    auto following = std::next(queue.begin());
    if (CMTimeCompare(CMTimeMakeWithSeconds(following->first, NSEC_PER_SEC),
                      position) > 0) break;
    releaseDecodedSample(queue.front().second);
    queue.pop_front();
  }
}
static void readSamples(AVAssetReader* reader, CMTime latest, CMTime until,
                        CMTime endTime, FrameQueue& out, CMTime position,
                        size_t maximumSamples, size_t maximumBytes,
                        const std::atomic<bool>& closed) {
  if (!maximumSamples || !maximumBytes) return;
  CMTime latestSampleTime = latest;
  while (!CMTIME_IS_VALID(latestSampleTime) ||
         (CMTimeCompare(latestSampleTime, until) < 0 &&
          CMTimeCompare(endTime, until) >= 0)) {
    bool futureQueued = !out.empty() &&
        CMTimeCompare(CMTimeMakeWithSeconds(out.back().first, NSEC_PER_SEC),
                      position) > 0;
    if (futureQueued && (out.size() >= maximumSamples ||
                         queueBytes(out) >= maximumBytes)) break;
    if (closed.load() || !reader || reader.status != AVAssetReaderStatusReading) break;
    AVAssetReaderOutput* output = [reader.outputs firstObject];
    CMSampleBufferRef sample = [output copyNextSampleBuffer];
    if (!sample) break;
    if (CMSampleBufferGetNumSamples(sample) == 0 ||
        !CMSampleBufferGetImageBuffer(sample)) {
      CFRelease(sample);
      continue;
    }
    // Already in presentation time: do not reapply track edits/slow motion.
    auto timestamp = CMSampleBufferGetPresentationTimeStamp(sample);
    double seconds = CMTimeGetSeconds(timestamp);
    try { trackDecodedSample(sample); }
    catch (...) { CFRelease(sample); throw; }
    try { out.emplace_back(seconds, sample); }
    catch (...) { releaseDecodedSample(sample); throw; }
    prunePastSamples(out, position);
    latestSampleTime = CMTimeMakeWithSeconds(seconds, NSEC_PER_SEC);
    // At most one transient newly decoded sample can exceed the queue byte
    // target while replacing the previous candidate; no live pixels recycled.
  }
}

static CMTime lastSampleTime(const FrameQueue& queue) {
  return queue.empty() ? kCMTimeInvalid
                       : CMTimeMakeWithSeconds(queue.back().first, NSEC_PER_SEC);
}

void VideoCompositionItemDecoder::advanceDecoder(CMTime currentTime) {
  std::lock_guard<std::mutex> readerGuard(readerMutex);
  AVAssetReader* reader = nil;
  CMTime latest = kCMTimeInvalid;
  CMTime inputPosition;
  CMTime position;
  size_t maximumSamples = kMaxQueuedSamples;
  size_t maximumBytes = kMaxQueuedSampleBytes;
  CMTime endTime;
  bool intoNextLoop = false;
  uint64_t batch = 0;
  @synchronized(lock) {
    if (released) return;
    CMTime startTime = CMTimeMakeWithSeconds(item->startTime, NSEC_PER_SEC);
    CMTime compositionStartTime =
        CMTimeMakeWithSeconds(item->compositionStartTime, NSEC_PER_SEC);
    // From here on every time is the file's: the position, the read-ahead,
    // the item's end and the wrap below.
    position = CMTimeAdd(
        startTime, sourceSpan(CMTimeSubtract(currentTime, compositionStartTime)));
    inputPosition =
        realTime
            ? CMTimeAdd(position, sourceSpan(CMTimeMakeWithSeconds(
                                      DECODER_INPUT_TIME_ADVANCE, NSEC_PER_SEC)))
            : position;
    CMTime duration =
        sourceSpan(CMTimeMakeWithSeconds(item->duration, NSEC_PER_SEC));
    endTime = CMTimeAdd(startTime, duration);

    if (realTime && CMTimeCompare(endTime, inputPosition) < 0 && !hasLooped) {
      // This pass is read to the item's end before the reader restarts for
      // the next loop: the frames between the last position decoded and the
      // end are still to be shown, and a seek into the last tenth of a second
      // of the item lands on one of them. Dropping them left the frame from
      // before such a seek on screen. Under the lock: it replaces the reader,
      // once per loop.
      prunePastSamples(decodedFrames, position);
      readSamples(assetReader, lastSampleTime(decodedFrames), endTime, endTime,
                  decodedFrames, position, kMaxQueuedSamples,
                  kMaxQueuedSampleBytes, released);
      setupReader(kCMTimeZero);
      hasLooped = true;
    }
    // Once looped, the first frames of the next loop.
    intoNextLoop = hasLooped;
    reader = assetReader;
    latest = lastSampleTime(intoNextLoop ? nextLoopFrames : decodedFrames);
    batch = readerGeneration;
    prunePastSamples(decodedFrames, position);
    prunePastSamples(nextLoopFrames, position);
    size_t queued = decodedFrames.size() + nextLoopFrames.size();
    size_t bytes = queueBytes(decodedFrames) + queueBytes(nextLoopFrames);
    maximumSamples = queued < kMaxQueuedSamples ? kMaxQueuedSamples - queued : 0;
    maximumBytes = bytes < kMaxQueuedSampleBytes ? kMaxQueuedSampleBytes - bytes : 0;
  }

  // Decoded outside the lock: acquireFrameForTime takes it on the UI thread at
  // every vsync, and a batch held it for the whole read (longer since frames
  // are tone-mapped to Rec.709).
  FrameQueue fresh;
  try {
    readSamples(reader, latest, inputPosition, endTime, fresh, position,
                maximumSamples, maximumBytes, released);
  } catch (...) {
    for (const auto& frame : fresh) releaseDecodedSample(frame.second);
    throw;
  }

  @synchronized(lock) {
    if (released.load() || batch != readerGeneration || reader != assetReader) {
      // A seek or a release replaced what this batch was read for.
      for (const auto& frame : fresh) {
        releaseDecodedSample(frame.second);
      }
    } else if (intoNextLoop && hasLooped) {
      nextLoopFrames.splice(nextLoopFrames.end(), fresh);
    } else {
      // Or the loop wrapped meanwhile and the next loop's frames are current.
      decodedFrames.splice(decodedFrames.end(), fresh);
    }
    prunePastSamples(decodedFrames, position);
  }
}

std::shared_ptr<VideoFrame>
VideoCompositionItemDecoder::acquireFrameForTime(CMTime currentTime,
                                                 bool force) {
  if (!frameRing.canAcquire()) {
    PreviewStats::ringRefusals++;
    return nullptr;
  }
  CMSampleBufferRef nextFrame = nil;
  // advanceDecoder appends to the frame lists from a decoding thread while
  // this runs on the UI thread: every access to the lists goes through the
  // decoder lock. The texture upload below happens outside of it so the
  // decoding thread is not held back by the GPU.
  @synchronized(lock) {
    if (released) return nullptr;
    if (hasLooped && CMTIME_IS_VALID(lastRequestedTime) &&
        CMTimeCompare(currentTime, lastRequestedTime) < 0) {
      hasLooped = false;
      for (const auto& frame : decodedFrames) {
        releaseDecodedSample(frame.second);
      }
      decodedFrames = nextLoopFrames;
      nextLoopFrames.clear();
    }
    lastRequestedTime = currentTime;

    // Plus a microsecond: a time asked for at exactly a frame's timestamp
    // (the export asks for i / fps) lands a fraction of a nanosecond before
    // it once rounded to nanoseconds, and was given the previous frame — an
    // export at the file's frame rate duplicated and skipped frames. Added in
    // the file's time, after the rate.
    double offset =
        MAX(CMTimeGetSeconds(currentTime) - item->compositionStartTime, 0);
    CMTime start = CMTimeMakeWithSeconds(item->startTime, NSEC_PER_SEC);
    CMTime position = CMTimeAdd(
        CMTimeAdd(start, sourceSpan(CMTimeMakeWithSeconds(offset, NSEC_PER_SEC))),
        CMTimeMake(1, 1000000));

    auto it = decodedFrames.begin();
    while (it != decodedFrames.end()) {
      auto timestamp = CMTimeMakeWithSeconds(it->first, NSEC_PER_SEC);
      if (CMTimeCompare(timestamp, position) <= 0 ||
          (force && nextFrame == nullptr)) {
        if (nextFrame != nullptr) {
          releaseDecodedSample(nextFrame);
        }
        nextFrame = it->second;
        it = decodedFrames.erase(it);
      } else {
        break;
      }
    }
    if (!nextFrame && decodedFrames.empty()) PreviewStats::emptyQueues++;
  }
  if (nextFrame) {
    CVPixelBufferRef buffer = CMSampleBufferGetImageBuffer(nextFrame);
    uint64_t memoryToken = takeDecodedAllocation(nextFrame);
    try {
      @synchronized(lock) {
      if (released) {
        MemoryBudget::instance().release(memoryToken);
        releaseDecodedSample(nextFrame);
        return nullptr;
      }
      auto frame = makeFrame(buffer, memoryToken);
      releaseDecodedSample(nextFrame);
      return frame;
      }
    } catch (...) {
      MemoryBudget::instance().release(memoryToken);
      releaseDecodedSample(nextFrame);
      throw;
    }
  }
  return nullptr;
}

std::shared_ptr<VideoFrame>
VideoCompositionItemDecoder::makeFrame(CVPixelBufferRef buffer,
                                        uint64_t memoryToken) {
  // Both texture modes now use immutable, scoped pixel buffers. The helper
  // controls the copy/import and explicitly closes this lease after its barrier.
  auto frame = std::make_shared<VideoFrame>(buffer, width, height, rotation,
                                           producerId, memoryToken);
  frameRing.push(frame);
  return frame;
}

void VideoCompositionItemDecoder::seekTo(CMTime currentTime) {
  std::lock_guard<std::mutex> readerGuard(readerMutex);
  @synchronized(lock) {
    if (released) return;
    // A seek the reader can simply read up to: a scrub is a run of small
    // forward steps, and rebuilding an AVAssetReader for each one is what
    // makes dragging the playhead stutter. Reading on costs the frames in
    // between, which is cheaper than a new reader for anything this short.
    // Measured in the file's time: at 2× a second of composition is two of
    // decoding.
    if (!hasLooped && seekReadsOn(assetReader &&
                        assetReader.status == AVAssetReaderStatusReading,
                    CMTIME_IS_VALID(lastRequestedTime),
                    ItemTime::sourceSpan(CMTimeGetSeconds(lastRequestedTime),
                                         item->playbackRate),
                    ItemTime::sourceSpan(CMTimeGetSeconds(currentTime),
                                         item->playbackRate))) {
      // The reader is already ahead of the displayed frame. Keep its queued
      // samples: throwing them away loses a nearby seek's target permanently.
      // Keep its generation too, so an in-flight batch from this same reader
      // can still publish the samples needed by the forward seek.
      return;
    }
    // Not release(): that drops the frame ring too, and in direct mode the
    // frame on screen loses its texture — the preview goes black for as long
    // as the new reader takes to decode. The picture a seek replaces stays
    // alive until its replacement arrives.
    discardReader();
    setupReader(currentTime);
  }
}

void VideoCompositionItemDecoder::discardReader() {
  @synchronized(lock) {
    if (assetReader) {
      [assetReader cancelReading];
      assetReader = nullptr;
    }
    for (const auto& frame : decodedFrames) {
      releaseDecodedSample(frame.second);
    }
    decodedFrames.clear();
    for (const auto& frame : nextLoopFrames) {
      releaseDecodedSample(frame.second);
    }
    nextLoopFrames.clear();
    hasLooped = false;
    lastRequestedTime = kCMTimeInvalid;
    readerGeneration++;
  }
}

void VideoCompositionItemDecoder::release() {
  // Stop a long read-on batch between samples before waiting for its current
  // copy to return. cancelReading only runs after that copy has completed.
  if (released.exchange(true)) return;
  std::lock_guard<std::mutex> readerGuard(readerMutex);
  @synchronized(lock) {
    discardReader();
    frameRing.releaseAll();
    currentFrame = nullptr;
  }
}

VideoCompositionItemDecoder::~VideoCompositionItemDecoder() {
  release();
  if (counted) NativeResourceStats::decoders.remove(1);
}

} // namespace RNSkiaVideo
