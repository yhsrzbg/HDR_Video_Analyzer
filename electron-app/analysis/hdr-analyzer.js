'use strict';

const { Worker } = require('worker_threads');
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
 * PQ Inverse: convert nits to PQ signal value (for chart axis)
 */
function pqInverse(nits) {
  const y = Math.max(Math.min(nits / 10000.0, 1.0), 1e-10);
  const v = Math.pow(y, m1);
  return Math.pow((c1 + c2 * v) / (1 + c3 * v), m2);
}

/**
 * Check if xy coordinates fall within a triangle gamut (barycentric method)
 * Matches the Python is_in_gamut exactly.
 * @param {number} x - CIE x coordinate
 * @param {number} y - CIE y coordinate
 * @param {Array} vertices - [[x1,y1],[x2,y2],[x3,y3]]
 * @returns {boolean}
 */
function isInGamut(x, y, vertices) {
  const a = vertices[0];
  const b = vertices[1];
  const c = vertices[2];

  // v0 = c - a, v1 = b - a, v2 = point - a
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
 * Resolve ffmpeg/ffprobe paths.
 * In development, uses ffmpeg-static. In packaged app, uses extraResources.
 */
function resolveFfmpegPath() {
  try {
    // Try ffmpeg-static first (development mode)
    const ffmpegStatic = require('ffmpeg-static');
    return ffmpegStatic;
  } catch (e) {
    // Packaged app - look in resources
    const resourcesPath = process.resourcesPath || path.join(__dirname, '..', '..', 'resources');
    const ext = process.platform === 'win32' ? '.exe' : '';
    return path.join(resourcesPath, `ffmpeg${ext}`);
  }
}

function resolveFfprobePath() {
  try {
    // Use ffprobe-static package which provides the ffprobe binary path
    const ffprobeStatic = require('ffprobe-static');
    return ffprobeStatic.path;
  } catch (e) {
    // Fallback: check same directory as ffmpeg-static
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
    // Fallback to system PATH
    return 'ffprobe';
  }
}

/**
 * Process a single frame of raw 10-bit video data.
 * @param {Buffer} frameData - Raw frame bytes (gbrp10le format)
 * @param {number} width - Frame width
 * @param {number} height - Frame height
 * @param {boolean} useSubsample - Whether to subsample (every other pixel)
 * @returns {Object} { peak, avg, r709, rp3, r2020 }
 */
function processFrame(frameData, width, height, useSubsample) {
  // Read raw uint16 data - format is gbrp10le (planar: G plane, B plane, R plane)
  const pixelsPerPlane = width * height;
  const raw = new Uint16Array(frameData.buffer, frameData.byteOffset, pixelsPerPlane * 3);

  // Planes: G=0, B=1, R=2
  const gPlane = raw.subarray(0, pixelsPerPlane);
  const bPlane = raw.subarray(pixelsPerPlane, pixelsPerPlane * 2);
  const rPlane = raw.subarray(pixelsPerPlane * 2, pixelsPerPlane * 3);

  // Determine sampling step
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

      // Get normalized RGB values (reorder from GBR to RGB)
      const rNorm = rPlane[idx] / 1023.0;
      const gNorm = gPlane[idx] / 1023.0;
      const bNorm = bPlane[idx] / 1023.0;

      // PQ EOTF conversion to linear light
      const rLin = pqEotf(rNorm);
      const gLin = pqEotf(gNorm);
      const bLin = pqEotf(bNorm);

      // Brightness (luminance in nits)
      const nits = (Y_COEFF[0] * rLin + Y_COEFF[1] * gLin + Y_COEFF[2] * bLin) * 10000.0;

      if (nits > peakNits) peakNits = nits;
      sumNits += nits;

      // Gamut classification - only for pixels above 1 nit
      if (nits >= 1.0) {
        // Convert to XYZ
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

  // Gamut ratios (dark pixels counted as 709)
  const r709 = (count709 + countDark) / totalSampledPixels;
  const rp3 = countP3only / totalSampledPixels;
  const r2020 = count2020only / totalSampledPixels;

  return { peak: peakNits, avg: avgNits, r709, rp3, r2020 };
}

/**
 * Run the full HDR analysis on a video file using a worker thread.
 * The heavy frame processing is offloaded to a Worker to keep the main thread responsive.
 * @param {string} videoPath - Path to the video file
 * @param {Object} options - { useSubsample: boolean }
 * @param {Function} onProgress - Callback (percent, timeSeconds, peakNits)
 * @returns {Promise<Object>} Analysis results with a terminate() method on the promise
 */
function analyzeVideo(videoPath, options, onProgress) {
  const { useSubsample = true } = options || {};

  const workerPath = path.join(__dirname, 'analysis-worker.js');
  const worker = new Worker(workerPath, {
    workerData: { videoPath, useSubsample }
  });

  const promise = new Promise((resolve, reject) => {
    worker.on('message', (msg) => {
      switch (msg.type) {
        case 'progress':
          if (onProgress) {
            onProgress(msg.percent, msg.time, msg.peak);
          }
          break;
        case 'complete':
          resolve(msg.data);
          break;
        case 'error':
          reject(new Error(msg.error));
          break;
      }
    });

    worker.on('error', (err) => {
      reject(err);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Analysis worker exited with code ${code}`));
      }
    });
  });

  // Attach the worker reference so callers can abort the analysis
  promise.worker = worker;
  return promise;
}

module.exports = {
  analyzeVideo,
  pqEotf,
  pqInverse,
  isInGamut,
  processFrame,
  getVideoDuration,
  resolveFfmpegPath,
  resolveFfprobePath,
  // Export constants for testing
  m1, m2, c1, c2, c3,
  M_2020_to_XYZ,
  Y_COEFF,
  GAMUT_709,
  GAMUT_P3,
  MIN_SUM_THRESHOLD
};
