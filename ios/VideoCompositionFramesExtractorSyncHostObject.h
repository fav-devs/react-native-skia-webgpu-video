#pragma once

#import "DecoderWindow.h"
#import "RNSVHostObject.h"
#import "VideoComposition.h"
#import "VideoCompositionItemDecoder.h"
#import "VideoFrame.h"
#import <AVFoundation/AVFoundation.h>
#import <jsi/jsi.h>
#import <map>
#import <set>

namespace RNSkiaVideo {
using namespace facebook;

class JSI_EXPORT VideoCompositionFramesExtractorSyncHostObject
    : public RNSVHostObject {
public:
  VideoCompositionFramesExtractorSyncHostObject(
      std::shared_ptr<VideoComposition> composition);
  ~VideoCompositionFramesExtractorSyncHostObject();
  jsi::Value get(jsi::Runtime&, const jsi::PropNameID& name) override;
  std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime& rt) override;

private:
  NSObject* lock;
  bool disposed = false;
  bool started = false;
  std::shared_ptr<VideoComposition> composition;
  DecoderWindow window;
  std::map<std::string, std::shared_ptr<VideoCompositionItemDecoder>>
      itemDecoders;
  std::map<std::string, std::shared_ptr<VideoFrame>> currentFrames;
  /** The time each open decoder was last asked for. */
  std::map<std::string, double> requestedTimes;
  void release();
  void updateWindow(CMTime time);
  std::set<std::string> seekBack(CMTime time);
};

} // namespace RNSkiaVideo
