# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install deps (Node 18+; CI builds with Node 22)
npm start          # launch the Electron app from source (electron .)
npm run bench      # benchmark analysis stages (requires the default test video or --input)
npm run bench:production # benchmark the production analyzer against test_video fixtures
npm run build      # build the portable executable into dist/ (electron-builder)
npm run build:win  # build for a single platform (also :mac, :linux)
```

There is no automated test runner, linter, or formatter configured. The benchmark options and output stages are documented in `bench/README.md`; benchmark reports are ignored by Git. electron-builder cannot cross-compile, so cross-platform binaries are built per-runner in `.github/workflows/release.yml` (triggered by pushing a `v*` tag). The Windows target is `portable` (a single no-install `.exe`); mac is `dmg`, Linux is `AppImage`.

## Architecture

An Electron desktop app that decodes HDR10 (PQ/ST 2084 + Rec.2020) video, computes per-frame brightness and color-gamut stats, and renders an interactive chart in-window. Three-process layout:

- **`main.js`** (main process) — creates the single `BrowserWindow`, owns all IPC handlers: `select-video` (native open dialog), `start-analysis` (runs the analyzer with an `AbortController`, streams progress via `webContents.send('analysis-progress')`), `cancel-analysis`, `save-png`, `save-html`. Only one analysis runs at a time (`activeAbort` guard).
- **`preload.js`** — `contextBridge` exposes `window.hdrAPI` (contextIsolation on, nodeIntegration off). Resolves dropped-file paths via `webUtils.getPathForFile` with a fallback to `File.path` for older Electron.
- **`renderer.js` + `index.html`** — the UI. Three screens toggled by an `.active` class: drop/pick/settings → progress (bar + cancel) → result (back + save PNG/HTML + chart canvas). `renderer.js` drives transitions, persists analysis settings in `localStorage`, and calls `window.drawChart`.

The analysis core is the part most worth reading before changing analysis behavior:

- **`src/analyze.js`** — coordinates probing, decoder fallback, and result assembly. `analyze(videoPath, options, onProgress)` accepts `options.signal` (AbortSignal — kills the ffmpeg child, rejects with `'CANCELLED'`), `options.useGpu`, `options.useSubsample`, `options.sampleInterval` (`0` = every frame, `1` = 1 second, `2` = 2 seconds), and optional `options.ffmpegPath`/`options.ffprobePath` overrides. It keeps re-exporting selected helpers for benchmarks and external callers.
- **`src/video-probe.js`** — owns ffprobe metadata reads: HDR10 whitelist detection, duration, frame rate, and codec lookup.
- **`src/decode.js`** — builds platform-specific GPU/software candidates, spawns ffmpeg, reassembles raw `gbrp10le` frames (10-bit planar, padded to 3840x2160), applies backpressure, and emits results/progress in frame order.
- **`src/color-science.js`** — pure per-frame analysis: PQ EOTF, Rec.2020→XYZ→CIE xy, luminance, and barycentric gamut classification.
- **`src/frame-worker-pool.js` + `src/process-frame-worker.js`** — bounded Worker Thread processing used only after a GPU decoder succeeds. Frame buffers are transferred rather than cloned. Software decode deliberately processes synchronously because ffmpeg and workers otherwise compete for the same CPU.
- **`src/report.js`** — `buildReportHtml(analysisData)` injects the analysis JSON + `assets/chart-renderer.js` into `src/report-template.html` by string replacement; used both for the in-app HTML export and the standalone report. `generateReport` writes it to disk.
- **`assets/chart-renderer.js`** — defines `window.drawChart(canvas, analysisData)`, the 3-panel Canvas 2D renderer. Loaded as a `<script>` in both `index.html` (live view) and the exported report. No native `canvas` dependency.

### Analysis settings and GPU behavior

- GPU decoding is default-off in the UI because CPU/software decode is the accuracy baseline. The UI warning should remain visible if the default changes.
- Windows GPU candidates prefer codec-specific CUVID decoders except for VP9: `vp9_cuvid` is intentionally skipped because it has produced pixel values that differ from software decode on 10-bit HDR samples. VP9 should fall through to QSV/D3D11VA/software.
- GPU decode candidates use two frame-processing workers; the software fallback uses none. Preserve ordered results/progress and bounded in-flight frames when changing this pipeline.
- Subsampling defaults on and samples every other pixel. Keep the denominator consistent with sampled pixels.
- The color-gamut confidence threshold intentionally matches the Python V8 logic: only `XYZ sum == 0` is treated as low-confidence/Rec.709. Do not restore the old `0.01` threshold without revalidating gamut ratios against the original analyzer.

### FFmpeg binary resolution (important)

ffmpeg/ffprobe come from the `ffmpeg-static` and `@derhuerst/ffprobe-static` npm packages. Two runtime modes:

- **Dev** (`npm start`): `main.js`'s `resolveBinaries()` returns `{}`, so `analyze()` falls back to the package-provided paths (`src/ffmpeg-paths.js`).
- **Packaged**: electron-builder copies the binaries into `process.resourcesPath` (see `build.extraResources` in `package.json`, per-platform). `resolveBinaries()` points `analyze()` at those, and the bundled-but-unused npm copies are excluded from the asar via the `!**/node_modules/ffmpeg-static/...` patterns in `build.files`.

When adding any new bundled binary, update **both** `resolveBinaries()` in `main.js` **and** the per-platform `extraResources` in `package.json`.

The production Worker Thread loads `src/process-frame-worker.js` from `app.asar.unpacked`; its dependency `src/color-science.js` is unpacked too. If worker entry points or their local dependencies change, keep `build.asarUnpack` in `package.json` and the path rewrite in `src/frame-worker-pool.js` synchronized.

`src/ffmpeg-paths.js` still contains SEA-detection logic from the prior single-executable build; it is now only exercised via its package fallback path (the dev mode), since the app is packaged with Electron rather than Node SEA.

## Conventions

- CommonJS (`require`/`module.exports`), `'use strict'`, Node core modules imported with the `node:` prefix.
- User-facing UI strings are in English. The cancellation sentinel is the literal string `'CANCELLED'`, thrown in `analyze()` and matched in `main.js` — keep the two in sync if you rename it.
- The renderer runs under a strict CSP (`index.html` `<meta>` tag) with `script-src 'self'` — keep scripts in external files, no inline `<script>` with logic beyond loading.
