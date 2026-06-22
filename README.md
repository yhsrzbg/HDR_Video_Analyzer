# HDR Lumex

> See HDR clearly.

A desktop HDR video analyzer for brightness, gamut, APL, MaxCLL and MaxFALL. Drop in a video (or click to choose one) and it decodes frames with FFmpeg, performs PQ EOTF conversion, classifies brightness and color gamut, and renders an interactive 3-panel chart right in the window — no browser, no command line.

No installation step. The released builds are portable: download, unzip, and run. FFmpeg is bundled inside.

HDR Lumex is designed for HDR10 video: PQ/ST 2084 transfer with Rec.2020 primaries. SDR, HLG, Dolby Vision, and HDR10+ dynamic-metadata workflows are rejected or intentionally out of scope because they need different analysis rules.

## Features

- **Single-window flow**: drop or pick a file → live progress with a cancel button → results in the same window
- **Brightness Analysis**: Peak and average brightness over time (PQ/nits scale)
- **Color Gamut Classification**: Frame-by-frame breakdown of Rec.709, DCI-P3, and Rec.2020 content
- **APL Histogram**: Average Picture Level distribution across analyzed frames
- **Statistics**: MaxCLL, AveCLL, MaxFALL, AveFALL, Average APL, Median APL
- **Analysis controls**: choose every-frame, 1-second, or 2-second sampling; enable or disable pixel subsampling
- **Optional GPU decoding**: off by default for accuracy; can be enabled when speed matters
- **Interactive charts**: hover for exact sample details, zoom or pan the shared timeline, zoom the brightness axis, and toggle individual series
- **Export**: save a full-range PNG or a self-contained interactive HTML report from the results screen

## Download & Run (end users)

Grab the file for your platform from the [Releases](../../releases) page:

- **Windows**: download `HDR-Lumex-win-x64.exe` and double-click it. It runs directly — no installer.
- **macOS**: download the `.dmg`, open it, drag the app to Applications (or run it from the mounted disk). First launch may be blocked by Gatekeeper — right-click → Open.
- **Linux**: download the `.AppImage`, mark it executable (`chmod +x`), and run it.

Then drag a video onto the window or click to choose one. Analysis starts immediately. Supported formats: MKV, MP4, MOV, TS.

## Usage

1. Launch the app.
2. Drag a video file onto the window, or click the drop zone to open a file picker.
3. Adjust analysis settings if needed:
   - **Sampling interval**: every frame, every 1 second, or every 2 seconds.
   - **Subsampling**: samples every other pixel for faster 4K analysis; enabled by default.
   - **GPU decoding**: disabled by default. Enabling it can be faster, but hardware decoder output may differ from CPU decoding on some codecs or drivers.
4. Watch the progress bar; press **Cancel** to stop.
5. When analysis finishes, the chart appears. Use **Back** to analyze another file, or **Save PNG / Save HTML** to export.

On the results screen, use the mouse wheel to zoom the timeline, drag to pan,
or switch to **Zoom area** to select a range. The brightness chart has a
separate vertical zoom control. **Reset view** restores the full range and
**Show all** restores every hidden series.

The result chart has three panels:

1. **Brightness over time**: peak and average brightness on a PQ/nits axis.
2. **Color gamut ratio over time**: Rec.709, P3 outside 709, and Rec.2020 outside P3.
3. **APL histogram**: distribution of per-frame Average Picture Level values.

## GPU decoding note

GPU decoding is a speed option, not the accuracy baseline. CPU/software decoding is the default and recommended path for repeatable analysis.

On Windows, VP9 avoids the codec-specific `vp9_cuvid` decoder because it has been observed to produce different pixel values from CPU decode for 10-bit HDR samples. Other codec-specific CUVID decoders may still be used when GPU decoding is enabled, with automatic fallback to generic hardware decode or CPU decode if a path fails.

## Development

```bash
# Node.js 18+ (CI builds with 22)
npm install
npm start          # launch the Electron app from source
npm run build      # build the portable executable into dist/
npm run build:win  # build for Windows only; also build:mac and build:linux
```

`npm run build` uses electron-builder. It bundles the app and copies the platform's FFmpeg/FFprobe binaries into the app's resources. electron-builder cannot cross-compile, so each platform's binary is built on its own CI runner (see `.github/workflows/release.yml`, triggered by pushing a `v*` tag).

## How It Works

1. **FFprobe** extracts the video duration
2. **FFmpeg** decodes the selected samples to raw 10-bit planar format (`gbrp10le`), padded to 3840x2160
3. Per-pixel analysis: PQ EOTF (ST 2084) → linear light → Rec.2020 luminance → CIE xy chromaticity for gamut classification
4. Results are rendered with the bundled Apache ECharts runtime. The app and exported HTML share the same interactive chart module, and exported reports remain fully self-contained and offline.

## Credits

HDR Lumex is forked from [HiBluey/HDR_Video_Analyzer](https://github.com/HiBluey/HDR_Video_Analyzer), which is licensed under the MIT License.

This repository maintains the Electron app packaging, UI, GPU decode controls, and related modifications on top of that original HDR analysis work. The upstream MIT copyright and license notice are preserved in [NOTICE](NOTICE).

## License

This fork is licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE).
