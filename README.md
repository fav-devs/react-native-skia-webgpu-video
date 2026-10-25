<p align="center">
  <img src="docs/assets/banner.svg" alt="React Native Skia WebGPU Video — Play. Compose. Export." width="100%" />
</p>

<p align="center">
  <a href="https://github.com/batical/react-native-skia-webgpu-video/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/batical/react-native-skia-webgpu-video/actions/workflows/ci.yml/badge.svg?branch=main" /></a>
  <a href="https://www.npmjs.com/package/react-native-skia-webgpu-video"><img alt="npm" src="https://img.shields.io/npm/v/react-native-skia-webgpu-video/beta" /></a>
  <a href="#status"><img alt="Status: beta" src="https://img.shields.io/badge/status-beta-f59e0b" /></a>
  <img alt="React Native Skia 3.8.0" src="https://img.shields.io/badge/Skia-3.8.0-38bdf8" />
  <img alt="React Native WebGPU 0.19.1" src="https://img.shields.io/badge/WebGPU-0.19.1-a78bfa" />
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-34d399" /></a>
</p>

# React Native Skia WebGPU Video

**Video playback, composition and export for React Native Skia 3 / Graphite.** Draw video frames with Skia, add your own overlays, and reuse your composition when exporting a file.

A new Skia 3 / WebGPU frame-interop layer, written from scratch with explicit resource ownership and configurable video memory reservations, while keeping a familiar Skia Video API.

**[Get started](#installation) · [Example](#one-composition-preview-and-export) · [Migration](docs/MIGRATION.md) · [Status](#status) · [Credits](#credits)**

## What you can build

- **Video players and editors** with play, pause, seek, looping, and frame drawing callbacks.
- **Compositions and overlays** driven by a timeline in seconds, using the same drawing function for preview and export.
- **H.264 / HEVC exports**, subject to device capabilities, with cancellation and bounded export queues.
- **Audio compositions** with clip audio, separate tracks, and per-item volume.
- **Custom GPU processing** through an export frame processor and an optional WebGPU resource scope.

> **Beta.** The Skia 3.7.4 / WebGPU 0.19.0 build has run on an iPhone 15 Pro and a Pixel 8a (export speed, pixel checks, native and instrumented tests, smoke runs). The move to Skia 3.8.0 / WebGPU 0.19.1, which renames Skia factory methods and follows GPU device loss, has only run on the host so far ([3.8.0 verification](migration/skia-3.8.0/verification.md)). Not yet qualified: memory over long sessions (last checked on 3.0.6), HDR, audible output and A/V synchronization; two 4K cases have known issues. See [status](#status) before adopting this in production.

## Installation

### Requirements

| Dependency | Current configuration |
| --- | --- |
| React Native | `0.86.2` tested; declared peer range `>=0.83 <0.87` |
| React | `19.2.3` tested |
| React Native Skia | **`react-native-skia@3.8.0`** |
| React Native WebGPU | **`react-native-webgpu@0.19.1`** (both resolve `react-native-webgpu-dawn@157.0.0`) |
| Reanimated / Worklets | **`4.5.3` / `0.11.3`** |
| Native runtime | New Architecture and Hermes |
| Android | API **28+**, Vulkan 1.1 (declared as a required feature by Skia) |

A native rebuild is required. Expo Go cannot load this module. Skia and WebGPU now share Dawn through the `react-native-webgpu-dawn` npm package: `node` must be on the `PATH` during `pod install` and Gradle builds, and both packages must resolve the same version of it. For iOS, use the deployment target required by your React Native and Skia versions; the example targets iOS 16.4 or later.

On ProMotion iPhones, add `CADisableMinimumFrameDurationOnPhone` (Boolean, `YES`) to your app's `Info.plist`: without it, iOS holds every frame callback of the app, the preview's included, at 60 Hz. On Android 15 and later, a playing preview asks the display for its highest refresh rate itself.

### Install

The beta is published on npm under the `beta` tag:

```sh
npm install --save-exact react-native-skia@3.8.0 react-native-webgpu@0.19.1 react-native-reanimated@4.5.3 react-native-worklets@0.11.3
npm install --save-exact react-native-skia-webgpu-video@beta
```

Each version requires exact Skia and WebGPU versions (its peer dependencies). The [GitHub releases](https://github.com/batical/react-native-skia-webgpu-video/releases) attach the same package archive, installable by URL. To build it from source instead, run `npm ci`, `npm run build` and `npm pack` in a clone, then `npm install` the resulting `.tgz`.

Keep these versions pinned. If migrating an existing app, remove `@shopify/react-native-skia` and the previous Skia Video package before rebuilding. Follow the [migration guide](docs/MIGRATION.md) to avoid loading both generations in one native application.

Add `react-native-worklets/plugin` **last** in your Babel plugins:

```js
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: ['react-native-worklets/plugin'],
};
```

### Apply the required Skia patch

This package includes a version-checked Skia patch for checked GPU submissions, cleanup of the dedicated export recorder cache and a query of the GPU device in use that any runtime can make. Apply it in the **application**, before compiling native code:

```sh
npx --no-install skia-video-patch-canvas
cd ios
pod install
```

Add `skia-video-patch-canvas` to your application's existing `postinstall` process so it runs after clean dependency installs. The script checks every target file before changing anything and is safe to run again. An unknown version or conflicting patch stops with an error. Review the [patch and upstream notes](docs/UPSTREAM_NOTES.md) when upgrading Skia, then rebuild the native app.

After an export closes its consumers, the library releases unused resources from its private export recorder. It preserves the shared Skia context cache and the preview/UI recorder cache. This reduces retained export resources without adding per-frame purges; it does not impose a limit on total process memory. Upgrading an already-patched application also requires rebuilding its native binary.

## One composition, preview and export

Use an app-accessible **absolute local file path** for each composition item. This example needs a source at least five seconds long; composition paths are not HTTP or `file://` URLs.

```tsx
import { useMemo } from 'react';
import { Button, View } from 'react-native';
import { Canvas, Image } from 'react-native-skia';
import {
  drawVideoFrame,
  exportVideoComposition,
  useVideoComposition,
} from 'react-native-skia-webgpu-video';
import type {
  FrameDrawer,
  VideoComposition,
} from 'react-native-skia-webgpu-video';

const drawFrame: FrameDrawer = ({ canvas, frames, width, height }) => {
  'worklet';
  const frame = frames.clip;
  if (frame) {
    drawVideoFrame(canvas, frame, { x: 0, y: 0, width, height }, {
      fit: 'contain',
    });
  }
  // Draw your Skia text, shapes, or overlays here.
};

export function VideoEditor({ inputPath, outputPath }: {
  inputPath: string;
  outputPath: string;
}) {
  const composition = useMemo<VideoComposition>(() => ({
    duration: 5,
    items: [{
      id: 'clip',
      path: inputPath,
      compositionStartTime: 0,
      startTime: 0,
      duration: 5,
      audio: true,
    }],
  }), [inputPath]);

  const { currentFrame } = useVideoComposition({
    composition,
    drawFrame,
    width: 320,
    height: 180,
    autoPlay: true,
  });

  const save = async () => {
    await exportVideoComposition({
      videoComposition: composition,
      drawFrame,
      outPath: outputPath,
      width: 1280,
      height: 720,
      frameRate: 30,
      bitRate: 5_000_000,
    });
  };

  return (
    <View>
      <Canvas style={{ width: 320, height: 180 }}>
        <Image image={currentFrame} x={0} y={0} width={320} height={180} />
      </Canvas>
      <Button title="Export video" onPress={() => {
        void save().catch(console.error);
      }} />
    </View>
  );
}
```

Choose a writable output path. Preview dimensions are layout points; drawing callbacks receive physical pixel dimensions. Export dimensions are pixels. The [`useVideoPlayback`](src/videoPlayer.ts) hook is also available for single-video playback.

### GPU device loss

React Native Skia replaces a lost GPU device (a driver reset, the GPU out of memory, GPU work refused while the app is in the background on iOS) with a new one, and everything made on the lost device draws nothing from then on. The library follows the replacement on its own:

- **Previews** (`useVideoComposition`, `useVideoPlayback`) skip their frames while the device is lost, then make their surface and frames again on the new device. A paused player seeks to its current time to decode its picture again; that seek is the hook's own and is not reported through `onSeekComplete`.
- **Exports** in progress reject with an error whose message starts with `Video export failed: the GPU device was lost`: the export stops at the next frame and the file is not finished. Export again; the next export uses the new device.
- **GPU scopes** (`createVideoGpuScope`) belong to the device they were made on: once `scope.device !== getVideoGpuDevice()`, dispose the scope and make another.

Images and surfaces the app makes itself with Skia are its own to remake, with Skia's `useGpu()` hook or `Skia.gpu.lost` on the RN runtime. Do not read `Skia.gpu` in a worklet: its `lost` promise settles on the RN runtime only. See the [migration guide](docs/MIGRATION.md#gpu-device-loss).

### Export speed

- **Static images drawn on every frame** (logos, stickers, rasterized text): convert them once with `image.makeTextureImage()` (Skia 3.4+). A raster image drawn directly is uploaded once per recorder and kept in a cache of up to 256 images.
- **Finding the slow stage:** pass `onProfile` to `exportVideoComposition`. It receives cumulative milliseconds per stage (`decodeMs`, `importMs`, `prepareMs`, `targetMs`, `drawMs`, `gpuMs`, `encodeMs`, `yieldMs`), measured on the export runtime, once before the export resolves:

```ts
await exportVideoComposition({
  /* ... */
  onProfile: (profile) => console.log(profile),
});
```

### Audio

Composition clips are **silent by default**. Set `audio: true` to include the source track in playback and export, or `audio: { volume: 0.8 }` to set its volume. Add music or voice-over using a composition item with `kind: 'audio'` and `volume`.

Audio implementations are retained on iOS and Android, including AAC export. The latest device performance campaign did **not** validate audible output or audio/video synchronization. See the [typed API](src/types.ts) for the complete options.

## Migrating from Skia Video

Use `useVideoComposition` for timelines and `useVideoPlayback` for single videos. Rename the previous hook imports and calls; the old names are no longer exported. Composition structure, timeline units, drawing callbacks, and player/export controls are retained. Texture interop changes: replace `MakeImageFromNativeTextureUnstable(frame.texture)` with `drawVideoFrame` or `makeVideoFrameImage`.

**[Read the migration guide →](docs/MIGRATION.md)**

The `copy` and `direct` options remain available for compatibility and use the same transport: exports draw on the GPU into the encoder's buffers on both platforms, falling back to CPU readback where the interop is unavailable. Inspect `getVideoResourceStats().backend` for the transport actually used.

## Memory and GPU extensions

Configure the library's tracked reservations before creating players or export sessions:

```ts
import { configureVideoMemory } from 'react-native-skia-webgpu-video';

configureVideoMemory({ maxBytes: 256 * 1024 * 1024 });
```

This budget covers **tracked video resources**, not all memory held by codecs, Skia, or GPU drivers. Use lazy decoders for sequential compositions, keep preview resolution appropriate, and measure process memory on your target device. Images returned by the frame helpers belong to the library; do not dispose them independently.

### How frames move

| Step | iOS | Android |
| --- | --- | --- |
| Decode | AVFoundation, IOSurface-backed buffers, no extra copy (`alwaysCopiesSampleData = NO`): the decoder's NV12 (`framePixelFormat: 'yuv'`, the default), or BGRA converted by VideoToolbox (`'rgba'`) | API 29+, 8-bit SDR H.264/HEVC: `ImageReader` YUV buffers (the default), at any frame size, capped or explicit sizes included. Otherwise, or with `'rgba'`: EGL render into an RGBA AHardwareBuffer (or a CPU scoped-copy fallback) |
| Into Skia, preview | NV12: a YUV→RGB render pass into a reusable texture. BGRA: a WebGPU blit into it. Then an owned Graphite snapshot | WebGPU blit (YUV→RGB, crop, rotation and scaling to the frame's size in one pass), then an owned Graphite snapshot |
| Into Skia, export | NV12: converted into a per-clip texture, as on Android. BGRA: sampled in place through the frame's IOSurface, no copy | Same as preview |
| Export output | Skia draws into the encoder's CVPixelBuffer (IOSurface) | Skia draws into one of two textures of the library's, which a GPU copy puts into the codec's input Surface, through a WebGPU canvas context on it (Vulkan swapchain): no EGL. Before each present, the frame time is set on the window and its dataspace reset, so the codec writes Rec.709 limited range as it did with EGL |
| Fallback | CPU readback, with a warning | CPU readback, with a warning |

Every path waits for checked GPU completion before releasing source frames. Android's export waits for a frame's GPU work once it has decoded the next frame, so the GPU draws one frame while the CPU decodes the next, and it reports each frame's duration to Android's performance hints (ADPF, Android 13 and later), which raise the CPU and, from Android 15, the GPU capacity the export gets. On Android, OpenGL remains in two places: the CPU readback fallback draws into the codec Surface through EGL, and HDR and 10-bit sources (or `framePixelFormat: 'rgba'`) keep the EGL decode path.

### Frame pixel format

`framePixelFormat` chooses how a composition's frames are decoded, for its preview and its export:

```ts
const composition = { duration, items, framePixelFormat: 'yuv' }; // 'auto' (default) | 'yuv' | 'rgba'
```

- `yuv`: the decoder's own YUV 4:2:0 buffers, converted to RGB on the GPU when a frame is drawn. A decoded frame takes 1.5 bytes a pixel instead of 4 (12.4 MB instead of 33.2 MB in 4K), so the decoder keeps more frames ahead in the same memory.
- `rgba`: frames converted to RGB as they are decoded (iOS: by VideoToolbox; Android: by an OpenGL pass), which an iOS GPU export samples in place.
- `auto`: `yuv`, on both platforms.

Both convert with the frame's own YCbCr matrix and range, HDR tone mapped to Rec.709 by the platform. One difference: on iOS, `rgba` also converts a file tagged with other primaries or another SDR transfer function (Display P3, sRGB) to Rec.709, as AVFoundation does; `yuv`, like Android in both formats, takes its samples as Rec.709. Camera footage (Rec.709 or HLG) renders the same in both. See the [measurements](docs/FRAME_PIXEL_FORMAT.md) before choosing.

For advanced exports, `createFrameProcessor` supports asynchronous preparation at each composition timestamp. The optional `react-native-skia-webgpu-video/gpu` entry point provides a resource scope whose asynchronous disposal waits for tracked work. See the [WebGPU cube example](examples/webgpu-overlay.ts).

These are integration building blocks. Three.js adapters, Core ML models, and automatic Neural Engine acceleration are not included. Browser video support is not provided by this native library.

## Benchmarks

Release builds, 3 repetitions per case, deterministic workloads from catalog `2026-10-07.1` (plus two 4K → 4K exports added for beta.4), median export wall time. Protocol, raw results and Perfetto analysis in the [3.7.4 verification report](migration/skia-3.7.4/verification.md). Earlier campaigns: [3.7.0](migration/skia-3.7.0/verification.md), [3.6.1](migration/skia-3.6.1/verification.md), [3.4.4](migration/skia-3.4.4/verification.md).

Beta.4 (Skia 3.7.4 / WebGPU 0.19.0) exports a third faster on Android, up to 45% on 4K sources, and leaves iOS unchanged.

**Pixel 8a (Android 17)**, thermal state nominal, medians of 9 repetitions for beta.3 and 6 for beta.4:

| Export case | beta.3 (Skia 3.7.1) | beta.4 (Skia 3.7.4) |
| --- | --- | --- |
| 8 × 4K clips at native size, 1080 output, 360 frames | 9.8 s | **7.0 s** (−29%) |
| 8 × 4K clips scaled to 1280 | 12.7 s | **7.0 s** (−45%) |
| 3 simultaneous 4K clips, 150 frames | 5.6 s | **3.5 s** (−39%) |
| H.264 720p, rotated, 180 frames | 3.07 s | **1.82 s** (−41%) |
| HEVC 1080p, rotated, 180 frames | 3.12 s | **2.08 s** (−33%) |
| H.264 / HEVC 640×360, 60 frames | 1.25 / 1.27 s | **0.85 / 0.85 s** (−32 / −33%) |
| One 4K clip exported at 4K, H.264 / HEVC, 900 frames | 25.3 / 25.8 s | **23.0 / 22.3 s** (−9 / −13%) |

Where the time went:
- **Export renders straight into the codec's input Surface through WebGPU**: no EGL and no lent buffer. Exports of 1080p and below gain 10–17% on their own.
- **The GPU draws a frame while the CPU decodes the next one.** The export used to wait for the GPU after every frame, then leave it idle while decoding. Mali's frequency governor then kept the GPU at its lowest clock, which made the first 3.7.4 build 24% *slower* than 3.7.1 on 8 native 4K clips.
- **The export thread reports its frames to Android's performance hints (ADPF)**: it gets faster cores and, from Android 15, more GPU capacity. 15–29% on most cases.
- **`maxLongSide` and `resolution` keep the codec's YUV buffers**, scaled by the WebGPU conversion instead of an OpenGL render pass. Decoding 8 × 4K clips capped at 1280 takes 8.7 ms per frame instead of 17.
- A 4K → 4K export is now limited by the hardware encoder.

**iPhone 15 Pro (iOS 27.0.1)**: unchanged, since these changes are Android-only. Three alternating series, Skia 3.7.1 against 3.7.4, off the charger, with the same output bytes:

| Export case | Skia 3.7.1 | Skia 3.7.4 |
| --- | --- | --- |
| HEVC 1080p, rotated, 180 frames | 730 ms | 737–749 ms |
| H.264 640×360, 60 frames | 177 ms | 185–217 ms |
| 8 × 4K clips scaled to 1280, 360 frames | 2.69 s | 2.68–2.74 s |

**Smoother canvases on Android 10.** Dawn 157 asks for three swapchain images instead of two on Android. On Android 10, a canvas no longer makes the main thread wait for the previous frame's buffer: upstream measured 407 → 65 ms of `dequeueBuffer` wait per ~1.9 s trace for one opaque canvas on a Mi MIX 3. Skia 3.6.3 also keeps the render pool one frame ahead of the display: on a 120 Hz Pixel 8, an opaque `SurfaceView` canvas went from 66 to 110 presented frames per second. The swapchain change applies to every Skia and WebGPU canvas and the render pool change to Skia canvases, video previews included, with no code change. We did not measure them ourselves (no Android 10 device); see the [audit](migration/skia-3.7.0/upstream-audit.md#canvas-plus-fluide-sur-android-10).

Pass `onProfile` to an export to see where the time goes on your own compositions. On the Pixel, a native-size HEVC 1080p frame spends about 2.5 ms decoding, 1.9 ms importing, 0.8 ms waiting for the GPU and 3.7 ms encoding (beta.3: 2.8, 3.3, 1.7 and 3.8 ms); on the iPhone the whole frame takes under 4 ms.

Reproduce on your devices with the example app: `node scripts/test-ios-device-ab-run.mjs` (iPhone) and `node scripts/test-android-device-run.mjs` (Android); see the [benchmark guide](docs/BENCHMARKS.md).

## Status

| Area | Current evidence |
| --- | --- |
| Frame accuracy | At 60 Hz, the preview draws the frame due at 99–100% of vsyncs in 30, 24 and 60 fps on both phones, and 97–100% in 4K with `yuv` frames on the Pixel 8a. On a warm iPhone at 120 Hz: 73–95% in 1080p, 77–90% in 4K 60 fps. Every exported frame holds the right source frame, in both frame pixel formats ([beta.3 verification](docs/VERIFICATION_0.1.0-beta.3.md)). |
| iOS | iPhone 15 Pro: 61/61 benchmark cases pass with `yuv` frames, including the three that stopped on the video memory budget with BGRA ([beta.3 verification](docs/VERIFICATION_0.1.0-beta.3.md)). With Skia 3.7.4: 56/58 native XCTests pass, the other two being opt-in diagnostics, and the smoke profile passes in 8 of 9 runs. The one failure, a preview frame import refused right after a launch on a locked phone, did not come back ([3.7.4 verification](migration/skia-3.7.4/verification.md#reste-à-faire)). |
| Android | Pixel 8a, beta.4: CPU vs GPU decode comparison 10/10 cases (max channel error 1, including rotation, portrait and 4K); export checks of a color pattern and of a decoded rotated clip match CPU readback. The EGL-free export writes the same bytes as beta.3's (Rec.709, limited range) ([3.7.4 verification](migration/skia-3.7.4/verification.md)). Instrumented tests: 126/127; the failure, a 4K preview throughput test, fails the same way on beta.3. |
| JavaScript / types | 260 tests in 11 suites, typecheck, package tests and 122 benchmark-harness tests pass (one of them skips without generated sync fixtures); CI runs them on every pull request. |
| Image / audio fidelity | Sampled SDR pixels and an exported color pattern are checked on Android; iOS exported files have the same byte size as with 3.0.6. Whole-image fidelity, HDR, audible output and A/V synchronization remain unqualified. |
| Known issues | On Pixel 8a: a seek while playing a 4K sequence leaves the clock stalled, a paused seek into a 120-clip lazy montage does not show its frame, and Android 17 reports a missing file in words the harness does not recognize; all three predate beta.3. An iOS export with `yuv` frames spends 2–4 ms more per frame than with `rgba`. With `ImageReader`, 1:1 exports are 5–16% larger files for matching sampled pixels. |
| Long sessions | Not yet re-run since 3.0.6; the 3.0.6 results below are the latest. |

### Earlier results (Skia 3.0.6)

These were measured on the previous Skia 3.0.6 / WebGPU 0.12.1 builds and have not been repeated since.

- **Lifecycle:** 6/6 consecutive iPhone montages and 4/4 Android montages passed (240 and 160 remounts), with late memory readings flattening or decreasing.
- **Android AHardwareBuffer playback:** 24/24 focused Release attempts on Pixel 8a passed, including H.264/HEVC 4K and export, with tracked cleanup at zero at a 512 MiB budget ([device diagnostics](docs/ANDROID_DEVICE_306.md)).

On one iPhone 15 Pro, an earlier **3.0.6 before/after optimization** comparison observed roughly **11% less peak physical footprint during 4K playback**, with similar RSS. Small exports took **3.5–6% longer**. The phone was warm and used for tethering; these are descriptive results, not a general speed claim. [Protocol, measurements, and limitations](docs/PERFORMANCE_IPHONE_306_OPTIMIZATION.md).

The Android report preserves the earlier CPU checkpoints: **0/24 strict passes** in the original campaign, then **8/8 operations completed without OOM but 0/8 strict cleanup passes** with scoped-copy. That latter reference has one attempt per case and does not establish an A/B speed gain. The current AHB results cover the selected scenarios; zero tracked reservations do not prove zero driver memory or absence of leaks in longer use.

The eight-clip 4K lifecycle case remained memory intensive: sampled peaks reached **800 MiB RSS / 1,038 MiB PSS**, and RSS remained around **786 MiB after cleanup**, despite zero tracked reservations. RSS and PSS are separate process metrics; their sampled peaks occur independently. The [Android report](docs/ANDROID_DEVICE_306.md) retains these results and the limits of seek/pixel validation.

A subsequent export-worklet fix reduces repeated-session allocation overhead. In matched two-montage Release runs, memory after 60 seconds idle fell from **426 to 258 MiB physical footprint on iPhone 15 Pro**, and from **738 to 577 MiB PSS on Pixel 8a**. These are different platform metrics, not a cross-device comparison. Six consecutive iPhone workloads and four Android workloads passed with flatter or decreasing late-run readings; bounded tests do not prove zero leaks. See the [native memory investigation](docs/NATIVE_MEMORY_INVESTIGATION_306.md) for checkpoints and limits.

## Built with it

No projects listed yet. Using this library in an app or an open-source project? [Share it in Show and tell](https://github.com/batical/react-native-skia-webgpu-video/discussions/22) and it may be featured here.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run test:package
npm run benchmark:test
npm run build
npm run check-package
```

Native validation: [iPhone](docs/IOS_DEVICE_TESTS.md), [iOS simulator](docs/IOS_SIMULATOR_TESTS.md), [Android](android/BUILD_VALIDATION.md). The [benchmark guide](docs/BENCHMARKS.md) explains workloads and measured versus unavailable metrics. Upgrading Skia or WebGPU: follow the [upstream notes](docs/UPSTREAM_NOTES.md) and the [3.7.0 migration audit](migration/skia-3.7.0/upstream-audit.md), and re-run the Pixel `interop` pixel check, which caught a color regression in WebGPU 0.15. Before building an Android APK after a dependency bump, delete `example/android/app/build/generated/assets/react`: Gradle does not see root `node_modules` changes and can reuse the previous JS bundle.

Contributions are welcome through pull requests. Read the [contribution guide](.github/CONTRIBUTING.md) for the checks and native validation expected for a change.

## Credits

The **Skia 3 / WebGPU frame-interop layer was written from scratch** for this project. Its API takes inspiration from **[batical/react-native-skia-video](https://github.com/batical/react-native-skia-video)**, Sebastien Hecart's fork extending Skia Video with additional capabilities, including HDR source handling, HEVC export, and the `direct` frame mode.

That fork originated from **[AzzappApp/react-native-skia-video](https://github.com/AzzappApp/react-native-skia-video)**.

Maintained by **[Sebastien Hecart (@batical)](https://github.com/batical)**, who contributed to the initial development of the original library's iOS implementation.

Thanks to the original Skia Video authors and contributors, and to the teams behind [React Native Skia](https://github.com/Shopify/react-native-skia) and [React Native WebGPU](https://github.com/wcandillon/react-native-webgpu).

## License

[MIT](LICENSE). Copyright (c) 2026 Sebastien Hecart. See the license for notices applicable to portions originating in earlier work.
