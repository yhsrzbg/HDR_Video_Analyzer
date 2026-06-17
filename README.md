# HDR Lumex

> See HDR clearly.

A desktop HDR video analyzer for brightness, gamut, APL, MaxCLL and MaxFALL. Drop in a video (or click to choose one) and it decodes frames with FFmpeg, performs PQ EOTF conversion, classifies brightness and color gamut, and renders an interactive 3-panel chart right in the window — no browser, no command line.

No installation step. The released builds are portable: download, unzip, and run. FFmpeg is bundled inside.

## Features

- **Single-window flow**: drop or pick a file → live progress with a cancel button → results in the same window
- **Brightness Analysis**: Peak and average brightness over time (PQ/nits scale)
- **Color Gamut Classification**: Frame-by-frame breakdown of Rec.709, DCI-P3, and Rec.2020 content
- **APL Histogram**: Average Picture Level distribution across analyzed frames
- **Statistics**: MaxCLL, AveCLL, MaxFALL, AveFALL, Average APL, Median APL
- **Export**: save the chart as PNG, or a self-contained HTML report, from the results screen

## Download & Run (end users)

Grab the file for your platform from the [Releases](../../releases) page:

- **Windows**: download `HDR-Lumex-win-x64.exe` and double-click it. It runs directly — no installer.
- **macOS**: download the `.dmg`, open it, drag the app to Applications (or run it from the mounted disk). First launch may be blocked by Gatekeeper — right-click → Open.
- **Linux**: download the `.AppImage`, mark it executable (`chmod +x`), and run it.

Then drag a video onto the window or click to choose one. Analysis starts immediately. Supported formats: MKV, MP4, MOV, TS.

## Usage

1. Launch the app.
2. Drag a video file onto the window, or click the drop zone to open a file picker.
3. Watch the progress bar; press **取消分析** (Cancel) to stop.
4. When analysis finishes, the chart appears. Use **← 返回** (top-left) to analyze another file, or **保存 PNG / 保存 HTML** (top-right) to export.

## Development

```bash
# Node.js 18+ (CI builds with 22)
npm install
npm start          # launch the Electron app from source
npm run build      # build the portable executable into dist/
```

`npm run build` uses electron-builder. It bundles the app and copies the platform's FFmpeg/FFprobe binaries into the app's resources. electron-builder cannot cross-compile, so each platform's binary is built on its own CI runner (see `.github/workflows/release.yml`, triggered by pushing a `v*` tag).

## How It Works

1. **FFprobe** extracts the video duration
2. **FFmpeg** decodes the video at 1 fps to raw 10-bit planar format (gbrp10le), padded to 3840x2160
3. Per-pixel analysis: PQ EOTF (ST 2084) → linear light → Rec.2020 luminance → CIE xy chromaticity for gamut classification
4. Results are drawn into a `<canvas>` in the window via the Canvas 2D API (no native canvas dependency). The same renderer produces the exported HTML report.

## License

MIT
