## Not yet qualified

- Memory over long sessions (last checked on 3.0.6).
- HDR beyond the HLG to SDR conversion, audible output and A/V synchronization.
- Known Pixel 8a issues, all predating beta.3: a seek while playing a 4K sequence leaves the clock stalled, and a paused seek into a 120-clip lazy montage does not show its frame.
- An iOS export with `yuv` frames (the default) spends 2–4 ms more per frame than with `framePixelFormat: 'rgba'`.
- `playbackRate` and earlier times asked of the sync extractor have host tests only: their XCTest and instrumented cases have not run on a device, and decoding above 2× is not measured.
- The composition player's signed `playbackRate` (backward and fast playback) has host tests only (window planning, frame choice, budget, clock): its native paths and the instrumented cases have not run on a device, and how fast each platform decodes backward is not measured.
