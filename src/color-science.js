'use strict';

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

const Y_COEFF = [0.262700, 0.677998, 0.059302];
const GAMUT_709 = [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]];
const GAMUT_P3 = [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]];

// Match the original Python analyzer: only a truly zero XYZ sum lacks
// chromaticity confidence.
const MIN_SUM_THRESHOLD = 0;

function pqEotf(normVal) {
  if (normVal <= 0) return 0;
  const val = Math.pow(normVal, 1.0 / m2);
  const num = Math.max(val - c1, 0);
  const den = c2 - c3 * val;
  if (den <= 0) return 0;
  return Math.pow(num / den, 1.0 / m1);
}

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

function processFrame(frameData, width, height, useSubsample) {
  const pixelsPerPlane = width * height;
  const raw = new Uint16Array(frameData.buffer, frameData.byteOffset, pixelsPerPlane * 3);

  // Planes: G=0, B=1, R=2
  const gPlane = raw.subarray(0, pixelsPerPlane);
  const bPlane = raw.subarray(pixelsPerPlane, pixelsPerPlane * 2);
  const rPlane = raw.subarray(pixelsPerPlane * 2, pixelsPerPlane * 3);

  const step = useSubsample ? 2 : 1;
  const sampledWidth = Math.floor(width / step);
  const sampledHeight = Math.floor(height / step);
  const totalSampledPixels = sampledWidth * sampledHeight;

  let peakNits = 0;
  let sumNits = 0;
  let count709 = 0;
  let countP3only = 0;
  let count2020only = 0;
  let countDark = 0;

  for (let sy = 0; sy < sampledHeight; sy++) {
    const y = sy * step;
    for (let sx = 0; sx < sampledWidth; sx++) {
      const x = sx * step;
      const idx = y * width + x;

      const rLin = pqEotf(rPlane[idx] / 1023.0);
      const gLin = pqEotf(gPlane[idx] / 1023.0);
      const bLin = pqEotf(bPlane[idx] / 1023.0);
      const nits = (
        Y_COEFF[0] * rLin +
        Y_COEFF[1] * gLin +
        Y_COEFF[2] * bLin
      ) * 10000.0;

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
          if (isInGamut(cx, cy, GAMUT_709)) count709++;
          else if (isInGamut(cx, cy, GAMUT_P3)) countP3only++;
          else count2020only++;
        } else {
          count709++;
        }
      } else {
        countDark++;
      }
    }
  }

  return {
    peak: peakNits,
    avg: sumNits / totalSampledPixels,
    r709: (count709 + countDark) / totalSampledPixels,
    rp3: countP3only / totalSampledPixels,
    r2020: count2020only / totalSampledPixels,
  };
}

module.exports = { pqEotf, isInGamut, processFrame };
