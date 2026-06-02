# HDR Video Analyzer - Electron App

A desktop application for analyzing HDR video files. It decodes video frames using FFmpeg, performs PQ EOTF conversion, calculates brightness and color gamut classification, and generates a detailed 3-panel analysis chart.

## Features

- **Brightness Analysis**: Peak and average brightness over time (displayed in PQ/nits scale)
- **Color Gamut Classification**: Frame-by-frame breakdown of Rec.709, DCI-P3, and Rec.2020 content
- **APL Histogram**: Average Picture Level distribution across all analyzed frames
- **Statistics**: MaxCLL, AveCLL, MaxFALL, AveFALL, Average APL, Median APL

## Prerequisites

- Node.js 18+ (recommended: 20+)
- npm 9+

FFmpeg is bundled automatically via `ffmpeg-static` - no separate installation needed.

## Setup

```bash
# Install dependencies
npm install

# Start the application
npm start
```

## Usage

1. Click **"Select Video"** to choose an HDR video file (MKV, MP4, MOV, TS)
2. Wait for the analysis to complete (progress is shown in the progress bar)
3. View the generated 3-panel chart
4. Click **"Save As"** to export the chart as a PNG image

## How It Works

### Analysis Pipeline

1. **FFprobe** extracts the video duration
2. **FFmpeg** decodes the video at 1 fps to raw 10-bit planar format (gbrp10le)
3. Each frame is padded to 3840x2160 (4K) resolution
4. Per-pixel analysis:
   - PQ EOTF (ST 2084) converts signal values to linear light
   - Luminance is calculated using Rec.2020 coefficients
   - CIE xy chromaticity is computed for gamut classification
5. Results are aggregated and rendered as a chart

### Chart Panels

1. **Brightness Over Time** - Y-axis in PQ space with nit labels (0 to 10000), showing peak (orange) and average (blue) brightness
2. **Gamut Ratio** - Stacked area chart showing proportion of pixels in Rec.709 (gray), DCI-P3 (yellow), and Rec.2020 (red)
3. **APL Histogram** - Distribution of Average Picture Level values across frames

## Building for Distribution

```bash
# Build for current platform
npm run build

# Build for specific platform
npm run build:win
npm run build:mac
npm run build:linux
```

Built packages will be output to the `dist/` directory.

## Technical Details

- Electron with context isolation and secure IPC
- Analysis runs in the main process (CPU-intensive work)
- Chart generation uses node-canvas (Canvas 2D API)
- FFmpeg binary bundled via ffmpeg-static and electron-builder extraResources

## License

MIT
