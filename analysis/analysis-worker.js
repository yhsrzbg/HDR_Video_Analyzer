'use strict';

const { parentPort, workerData } = require('worker_threads');
const { spawn } = require('child_process');
const path = require('path');

// --- Core Color Science Constants ---

// PQ EOTF Constants (ST 2084)
const m1 = 2610.0 / 16384.0;
const m2 = (2523.0 / 4096.0) * 128.0;
const c1 = 3424.0 / 4096.0;
const c2 = (2413.0 / 4096.0) * 32.0;
const c3 = (2392.0 / 4096.0) * 32.0;

// Rec.2020 to XYZ conversion matrix
const M_2020_to_XYZ = [
  [0.636958, 0.144617, 0.168881],
  [0.262700, 0.677998, 0.059302],
  [0.049461, 0.028665, 1.092973]
];

// Rec.2020 Luminance Coefficients
const Y_COEFF = [0.262700, 0.677998, 0.059302];

// Gamut Vertices (CIE xy)
const GAMUT_709 = [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]];
const GAMUT_P3 = [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]];

// Minimum XYZ sum threshold for confidence mask
// Pixels with sum below this are classified as Rec.709 (matching Python behavior)
const MIN_SUM_THRESHOLD = 0.01;

/**
 * PQ EOTF: convert normalized PQ signal (0-1) to linear light (0-1)
 */
function pqEotf(normVal) {
  if (normVal <= 0) return 0;
  const val = Math.pow(normVal, 1.0 / m2);
  const num = Math.max(val - c1, 0);
  const den = c2 - c3 * val;
  if (den <= 0) return 0;
  return Math.pow(num / den, 1.0 / m1);
}

/**
 * Check if xy coordinates fall within a triangle gamut (barycentric method)
 */
function isInGamut(x, y, vertices) {
  const a = vertices[0];
  const b = vertices[1];
  const c = vertices[2];

  const v0x = c[0] - a[0];
  const v0y = c[1] - a[1];
  const v1x = b[0] - a[0];
  const v1y = b[1] - a[1];
  const v2x = x - a[0];
  const v2y = y - a[1];

  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot20 = v2x * v0x + v2y * v0y;
  const dot21 = v2x * v1x + v2y * v1y;

  const invDenom = 1.0 / (dot00 * dot11 - dot01 * dot01);
  const u = (dot11 * dot20 - dot01 * dot21) * invDenom;
  const v = (dot00 * dot21 - dot01 * dot20) * invDenom;

  return (u >= 0) && (v >= 0) && (u + v <= 1);
}

/**
 * Process a single frame of raw 10-bit video data.
 * Uses pre-allocated typed array view for efficiency.
 */
function processFrame(frameData, width, height, useSubsample) {
  const pixelsPerPlane = width * height;
  const raw = new Uint16Array(frameData.buffer, frameData.byteOffset, pixelsPerPlane * 3);

  const gPlane = raw.subarray(0, pixelsPerPlane);
  const bPlane = raw.subarray(pixelsPerPlane, pixelsPerPlane * 2);
  const rPlane = raw.subarray(pixelsPerPlane * 2, pixelsPerPlane * 3);

  const stepX = useSubsample ? 2 : 1;
  const stepY = useSubsample ? 2 : 1;
  const sampledWidth = Math.floor(width / stepX);
  const sampledHeight = Math.floor(height / stepY);
  const totalSampledPixels = sampledWidth * sampledHeight;

  let peakNits = 0;
  let sumNits = 0;
  let count709 = 0;
  let countP3only = 0;
  let count2020only = 0;
  let countDark = 0;

  for (let sy = 0; sy < sampledHeight; sy++) {
    const y = sy * stepY;
    for (let sx = 0; sx < sampledWidth; sx++) {
      const x = sx * stepX;
      const idx = y * width + x;

      const rNorm = rPlane[idx] / 1023.0;
      const gNorm = gPlane[idx] / 1023.0;
      const bNorm = bPlane[idx] / 1023.0;

      const rLin = pqEotf(rNorm);
      const gLin = pqEotf(gNorm);
      const bLin = pqEotf(bNorm);

      const nits = (Y_COEFF[0] * rLin + Y_COEFF[1] * gLin + Y_COEFF[2] * bLin) * 10000.0;

      if (nits > peakNits) peakNits = nits;
      sumNits += nits;

      if (nits >= 1.0) {
        const X = M_2020_to_XYZ[0][0] * rLin + M_2020_to_XYZ[0][1] * gLin + M_2020_to_XYZ[0][2] * bLin;
        const Y = M_2020_to_XYZ[1][0] * rLin + M_2020_to_XYZ[1][1] * gLin + M_2020_to_XYZ[1][2] * bLin;
        const Z = M_2020_to_XYZ[2][0] * rLin + M_2020_to_XYZ[2][1] * gLin + M_2020_to_XYZ[2][2] * bLin;

        const sum = X + Y + Z;
        if (sum > MIN_SUM_THRESHOLD) {
          const cx = X / sum;
          const cy = Y / sum;

          const in709 = isInGamut(cx, cy, GAMUT_709);
          const inP3 = isInGamut(cx, cy, GAMUT_P3);

          if (in709) {
            count709++;
          } else if (inP3) {
            countP3only++;
          } else {
            count2020only++;
          }
        } else {
          // Low confidence chromaticity - default to Rec.709 (matches Python behavior)
          count709++;
        }
      } else {
        countDark++;
      }
    }
  }

  const avgNits = sumNits / totalSampledPixels;

  const r709 = (count709 + countDark) / totalSampledPixels;
  const rp3 = countP3only / totalSampledPixels;
  const r2020 = count2020only / totalSampledPixels;

  return { peak: peakNits, avg: avgNits, r709, rp3, r2020 };
}

/**
 * Get video duration using ffprobe
 */
function getVideoDuration(videoPath, ffprobePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', '0', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath];
    const proc = spawn(ffprobePath, args);
    let output = '';
    let errOutput = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });
    proc.stderr.on('data', (data) => {
      errOutput += data.toString();
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}: ${errOutput}`));
        return;
      }
      const duration = parseFloat(output.trim());
      if (isNaN(duration)) {
        reject(new Error('Could not parse video duration'));
        return;
      }
      resolve(duration);
    });
    proc.on('error', (err) => {
      reject(new Error(`Failed to start ffprobe: ${err.message}`));
    });
  });
}

/**
 * Resolve ffmpeg path
 */
function resolveFfmpegPath() {
  try {
    const ffmpegStatic = require('ffmpeg-static');
    return ffmpegStatic;
  } catch (e) {
    const resourcesPath = process.resourcesPath || path.join(__dirname, '..', '..', 'resources');
    const ext = process.platform === 'win32' ? '.exe' : '';
    return path.join(resourcesPath, `ffmpeg${ext}`);
  }
}

/**
 * Resolve ffprobe path
 */
function resolveFfprobePath() {
  try {
    const ffprobeStatic = require('ffprobe-static');
    return ffprobeStatic.path;
  } catch (e) {
    try {
      const ffmpegStatic = require('ffmpeg-static');
      const dir = path.dirname(ffmpegStatic);
      const ext = process.platform === 'win32' ? '.exe' : '';
      const ffprobePath = path.join(dir, `ffprobe${ext}`);
      if (require('fs').existsSync(ffprobePath)) {
        return ffprobePath;
      }
    } catch (e2) {
      // ignore
    }
    return 'ffprobe';
  }
}

/**
 * Run the analysis in this worker thread.
 * Communicates with the main thread via parentPort messages.
 */
async function runAnalysis() {
  const { videoPath, useSubsample } = workerData;

  try {
    const ffmpegPath = resolveFfmpegPath();
    const ffprobePath = resolveFfprobePath();

    const totalDuration = await getVideoDuration(videoPath, ffprobePath);

    const width = 3840;
    const height = 2160;
    const frameBytes = width * height * 3 * 2; // 3 channels, 2 bytes per sample
    const tStep = 1.0;

    const args = [
      '-i', videoPath,
      '-vf', `fps=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
      '-pix_fmt', 'gbrp10le',
      '-f', 'rawvideo',
      'pipe:1'
    ];

    const proc = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'ignore']
    });

    // Listen for abort signal from parent
    parentPort.on('message', (msg) => {
      if (msg.type === 'abort') {
        proc.kill('SIGKILL');
      }
    });

    const results = [];
    let frameIndex = 0;

    // Pre-allocate frame buffer to avoid O(n^2) Buffer.concat
    let frameBuffer = Buffer.allocUnsafe(frameBytes);
    let writeOffset = 0;

    await new Promise((resolve, reject) => {
      proc.stdout.on('data', (chunk) => {
        let chunkOffset = 0;

        while (chunkOffset < chunk.length) {
          const remaining = frameBytes - writeOffset;
          const available = chunk.length - chunkOffset;
          const toCopy = Math.min(remaining, available);

          chunk.copy(frameBuffer, writeOffset, chunkOffset, chunkOffset + toCopy);
          writeOffset += toCopy;
          chunkOffset += toCopy;

          if (writeOffset >= frameBytes) {
            // Full frame accumulated - process it
            const frameResult = processFrame(frameBuffer, width, height, useSubsample);
            const timeSeconds = frameIndex * tStep;

            results.push({
              time: timeSeconds,
              peak: frameResult.peak,
              avg: frameResult.avg,
              r709: frameResult.r709,
              rp3: frameResult.rp3,
              r2020: frameResult.r2020
            });

            const progress = Math.min((timeSeconds / totalDuration) * 100, 100);
            parentPort.postMessage({
              type: 'progress',
              percent: progress,
              time: timeSeconds,
              peak: frameResult.peak
            });

            frameIndex++;
            writeOffset = 0;
          }
        }
      });

      proc.on('close', (code) => {
        if (results.length === 0) {
          reject(new Error('No frames were processed. Check that the file is a valid HDR video.'));
          return;
        }
        resolve();
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start ffmpeg: ${err.message}`));
      });
    });

    parentPort.postMessage({
      type: 'complete',
      data: {
        results,
        totalDuration,
        filename: path.basename(videoPath)
      }
    });
  } catch (err) {
    parentPort.postMessage({
      type: 'error',
      error: err.message
    });
  }
}

runAnalysis();
