# Migrating from React Native Skia Video

This library builds on the API of `@azzapp/react-native-skia-video` and its `batical` fork. Most composition and drawing concepts remain, while frame ownership and Skia texture interop change.

## Dependencies and native rebuild

Follow the [installation instructions](../README.md#installation) with the exact tested Skia, WebGPU, Reanimated, and Worklets versions. Remove the old Skia and Skia Video packages from the application before installing their replacements. Two native modules with the old and new video implementations must not coexist.

Replace imports:

| Previous package | New package |
| --- | --- |
| `@shopify/react-native-skia` | `react-native-skia` |
| `@azzapp/react-native-skia-video` or your fork's package name | `react-native-skia-webgpu-video` |

Apply the required Skia patch in the consuming app, install pods on iOS, and rebuild native binaries. A JavaScript-only update cannot apply the native changes. See [upstream notes](UPSTREAM_NOTES.md) before changing the pinned Skia version.

## Frame drawing

Replace the hook names in your imports and call sites. The old names are not exported as compatibility aliases:

| Previous hook | Required replacement |
| --- | --- |
| `useVideoCompositionPlayer` | `useVideoComposition` |
| `useVideoPlayer` | `useVideoPlayback` |

Use `useVideoComposition` for a timeline and `useVideoPlayback` for a single video. Their composition options, playback controls and return values retain the same shape; migrating the hook names and frame drawing is required.

A native Metal or OpenGL texture handle is not a Dawn texture. Replace calls to `Skia.Image.MakeImageFromNativeTextureUnstable(frame.texture, ...)` with the library helper:

```ts
import { drawVideoFrame } from 'react-native-skia-webgpu-video';
import type { FrameDrawer } from 'react-native-skia-webgpu-video';

const drawFrame: FrameDrawer = ({ canvas, frames, width, height }) => {
  'worklet';
  const frame = frames.clip;
  if (frame) {
    drawVideoFrame(canvas, frame, { x: 0, y: 0, width, height }, {
      fit: 'contain',
    });
  }
};
```

Use `makeVideoFrameImage(frame)` if you need the image for another Skia operation. The library owns the returned image: do not independently call `dispose()` on it, change its native descriptor, or keep using it after its producer releases it. Application-owned synthetic frames need their own explicit ownership and cleanup.

The hooks still expose familiar play, pause, seek, looping, and readiness/error events. Compositions use seconds. `beforeDrawFrame` and `afterDrawFrame` run **per frame**; they are not session initialization/finalization callbacks.

## Preview and export

`useVideoComposition` renders a composition to a shared current image. Reuse the composition and `drawFrame` in `exportVideoComposition`. The [README example](../README.md#one-composition-preview-and-export) shows both.

- Composition sources use app-accessible local filesystem paths.
- Preview width/height are layout points; the drawing callback receives pixel dimensions. Export width/height are pixels.
- Use `lazyDecoders` for sequential timelines. A preview decode limit such as `maxLongSide` also limits source detail if reused during export; use separate settings when necessary.
- `copy` and `direct` remain API options with the same transport. iOS exports by drawing into the encoder's IOSurface-backed pool buffers; Android draws into AHardwareBuffers lent by the encoder when its AHardwareBuffer interop is available. Both fall back to CPU readback after a failed setup probe. Inspect `getVideoResourceStats().backend` for the transport instead of inferring it from the requested mode.
- Review application code that calls internal extractors or directly consumes native textures. Its frames must follow the new ownership protocol; the renamed hooks do not preserve the old texture representation.

## Audio

Audio options retain their existing meaning. A video composition item is silent by default; use `audio: true` or `audio: { volume: 0.8 }` to include its audio during playback and export. Separate `kind: 'audio'` items support music or voice-over. `useVideoPlayback` has its own `volume` option.

Audio is implemented on both native platforms, but the device runs so far (3.0.6, 3.4.4, 3.6.1 and 3.7.0) did not exercise audible output or validate audio synchronization. Test these paths with your application's actual sources before shipping.

## Memory and extensions

Set `configureVideoMemory({ maxBytes })` before allocating sessions. The budget covers tracked resources only; codecs and drivers can retain additional memory. A budget rejection does not silently reduce export dimensions.

On Android with the AHardwareBuffer interop (API 29+, 8-bit SDR H.264/HEVC), the codec writes into an `ImageReader`; WebGPU converts, crops, rotates and scales each YUV buffer, imported once, to the frame's size (a `maxLongSide` cap or an explicit `resolution` included) in an independent Graphite snapshot after a checked GPU fence. Exports skip that snapshot: each clip's frame is converted into a texture of its own and sampled in place, as on iOS. Other sources render through the decoder's private EGL context into an RGBA AHardwareBuffer, or, without the interop, read owned RGBA pixels on the CPU and upload them. All of these avoid Skia's image-count raster-upload cache. CPU Java/JSI backing buffers remain accounted until their aliases and ART/Hermes owners are collected. See the [upstream cache notes](UPSTREAM_NOTES.md#android--éviter-le-cache-dimages-raster-du-provider) and the [3.6.1 verification](../migration/skia-3.6.1/verification.md).

The optional `createFrameProcessor` export factory creates a processor once per export. Its asynchronous `prepareFrame` runs at the requested composition timestamp and its `dispose` must finish all frame readers. Drive animated effects from that timestamp, not an independent display animation loop.

For GPU work, create `createVideoGpuScope` on the runtime that uses it. The Skia device is shared: do not destroy it or pass command encoders across runtimes. Track asynchronous work before starting it, remove images from consumers, and await `scope.dispose()`. CPU/ML inference needs its own tracked completion; a graphics fence does not finish unrelated inference. A scope belongs to one GPU device: see [GPU device loss](#gpu-device-loss).

If completion cannot be established after an error, the library can retain the affected state and reject later work to avoid releasing resources still in use. Zero tracked reservations alone is not proof that all process or GPU memory has been returned.

## GPU device loss

React Native Skia (since 3.7.3) replaces a lost GPU device with a new one: a driver reset, the GPU out of memory, or GPU work refused while the app is in the background on iOS. Everything made on the lost device stays safe to use but draws nothing: offscreen surfaces and their snapshots, texture images, and the device `Skia.getNativeDevice()` returned. Before this release, the library imported that device once, at load: after a loss its previews stayed blank until the app restarted.

The library now follows the replacement on every runtime it uses (RN, Reanimated UI, its export runtime):

- `getVideoGpuDevice()` returns the device in use, imported again on each runtime once it was replaced. While the device is lost and not replaced yet, it is still the lost one.
- `useVideoComposition` and `useVideoPlayback` draw nothing while the device is lost and do not report the frames that failed because of it through `onError`. Once it is replaced they make their surface and frames again. A paused player seeks to its current time, since its decoded frames went with the lost device; `useVideoPlayback` does not report that seek through `onSeekComplete` (a listener added with `player.on("seekComplete")` still hears it). A playing player draws the next frames it decodes. `currentFrame` of `useVideoPlayback` reads `null` until then.
- `exportVideoComposition` rejects an export during which the device was lost or replaced. The message starts with `Video export failed: the GPU device was lost`, and `error.cause` holds the native error when there was one. The export stops at the next frame and does not finish the file: delete it and export again. The export runtime stays usable.
- A `createVideoGpuScope` scope keeps the device it was made on. Once `scope.device !== getVideoGpuDevice()`, its resources draw nothing: dispose it (it no longer waits for the lost device) and create another. Until then it refuses new resources, and `drain()` rejects.
- On Android, the AHardwareBuffer interop is negotiated again with the new device's features. Decoders opened before keep their transport.

What the app must still do:

- Remake its own Skia objects that live on the GPU (`makeTextureImage()` images, offscreen surfaces, `Skia.Image.MakeFromGPUTexture` images, its own WebGPU device imports) when Skia's `useGpu()` hook re-renders or `Skia.gpu.lost` resolves.
- Read `Skia.gpu` on the RN runtime only. Its `lost` promise is created for the runtime that reads it first and settles on the RN runtime; a worklet reading it would share that promise across runtimes.
- Retry an export that failed with the message above, once the app is back in the foreground on iOS.

The device generation the library follows comes from a query the Skia patch adds (`Skia.__rnskvGpuGeneration`): apply the 3.8.0 patch and rebuild, or `getVideoGpuDevice()` throws that the GPU recovery patch is missing.

## Application validation

Check orientation, seek/loop behavior, source audio and added tracks, export dimensions and timestamps, cancellation, and repeated mount/export/unmount cycles on both platforms. Existing Skia patches, custom texture loaders, Skottie integrations, and application-specific effects require their own migration review.

See the [benchmark guide](BENCHMARKS.md) and [current iPhone comparison](PERFORMANCE_IPHONE_306_OPTIMIZATION.md) for what has actually been measured. Performance results are specific to their workloads and conditions.
