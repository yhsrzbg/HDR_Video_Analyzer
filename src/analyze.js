'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { resolveFfmpegPath, resolveFfprobePath } = require('./ffmpeg-paths');

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

// Pixels with XYZ sum below this are classified as Rec.709 (low chromaticity confidence)
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
 * Check if xy coordinates fall within a triangle gamut (barycentric method).
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
 * Process a single frame of raw 10-bit gbrp10le video data.
 */
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

          if (isInGamut(cx, cy, GAMUT_709)) {
            count709++;
          } else if (isInGamut(cx, cy, GAMUT_P3)) {
            countP3only++;
          } else {
            count2020only++;
          }
        } else {
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
 * Run ffprobe and return parsed JSON, or null on any failure.
 */
function probeJson(args, ffprobePath) {
  return new Promise((resolve) => {
    const proc = spawn(ffprobePath, ['-v', 'error', '-of', 'json', ...args]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
    proc.on('error', () => resolve(null));
  });
}

/**
 * Detect the HDR format of a video and decide whether it's analyzable.
 *
 * This analyzer only supports HDR10 (PQ / SMPTE ST 2084 transfer with Rec.2020
 * primaries and static-only metadata). It deliberately rejects everything else,
 * because their pixel encoding or dynamic metadata would make the PQ-based
 * brightness/gamut math wrong: HLG (different transfer curve), SDR (not PQ),
 * Dolby Vision and HDR10+ (dynamic per-scene metadata the static PQ path
 * ignores). Uses a whitelist — anything we can't positively identify as HDR10
 * is refused.
 *
 * @returns {Promise<{ supported: boolean, format: string }>}
 */
async function detectHdrFormat(videoPath, ffprobePath) {
  const streamInfo = await probeJson(
    ['-select_streams', 'v:0',
     '-show_entries', 'stream=color_transfer,color_primaries,codec_tag_string',
     videoPath],
    ffprobePath
  );
  const stream = streamInfo && streamInfo.streams && streamInfo.streams[0];
  if (!stream) return { supported: false, format: 'Unknown (could not read video stream info)' };

  const transfer = (stream.color_transfer || '').toLowerCase();
  const primaries = (stream.color_primaries || '').toLowerCase();
  const tag = (stream.codec_tag_string || '').toLowerCase();

  // Dolby Vision often carries a dvhe/dvh1/dav1 codec tag.
  if (['dvhe', 'dvh1', 'dav1', 'dvav', 'dva1'].includes(tag)) {
    return { supported: false, format: 'Dolby Vision' };
  }

  // HLG: distinct transfer curve, not PQ.
  if (transfer === 'arib-std-b67') {
    return { supported: false, format: 'HLG' };
  }

  // Anything that isn't PQ is SDR (or unknown) for our purposes.
  if (transfer !== 'smpte2084') {
    return { supported: false, format: 'SDR / non-HDR10' };
  }

  // PQ requires Rec.2020 primaries to be a genuine HDR10 master.
  if (primaries !== 'bt2020') {
    return { supported: false, format: 'SDR / non-standard HDR' };
  }

  // PQ + Rec.2020 confirmed. Now rule out dynamic-metadata formats (Dolby
  // Vision RPU / HDR10+ SMPTE 2094-40) by inspecting the first frame's side
  // data. If side data can't be read (older ffprobe), fall through to HDR10.
  const frameInfo = await probeJson(
    ['-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_frames', videoPath],
    ffprobePath
  );
  const frame = frameInfo && frameInfo.frames && frameInfo.frames[0];
  const sideTypes = (frame && frame.side_data_list || [])
    .map((s) => (s.side_data_type || '').toLowerCase());

  for (const t of sideTypes) {
    if (t.includes('dolby') || t.includes('dovi')) {
      return { supported: false, format: 'Dolby Vision' };
    }
    if (t.includes('2094') || t.includes('dynamic hdr') || t.includes('dynamic metadata')) {
      return { supported: false, format: 'HDR10+' };
    }
  }

  return { supported: true, format: 'HDR10' };
}

/**
 * Get video duration in seconds using ffprobe.
 */
function getVideoDuration(videoPath, ffprobePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', '0', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath];
    const proc = spawn(ffprobePath, args);
    let output = '';
    let errOutput = '';

    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { errOutput += d.toString(); });
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
 * Get the video stream's codec name (e.g. "hevc", "h264") using ffprobe.
 * Returns null if it can't be determined.
 */
function getVideoCodec(videoPath, ffprobePath) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ];
    const proc = spawn(ffprobePath, args);
    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.on('close', () => resolve(output.trim().toLowerCase() || null));
    proc.on('error', () => resolve(null));
  });
}

/**
 * Build the ordered list of decode strategies to try. Each entry is an array of
 * ffmpeg input-side args prepended before "-i". They are attempted in order;
 * the first that yields frames wins, and software decode (empty args) is always
 * the final fallback.
 *
 * Candidates are platform-aware (speed/availability order):
 *   - macOS: VideoToolbox (Apple Silicon & Intel Mac media engine).
 *   - Windows: vendor-native first — *_cuvid (NVIDIA) → QSV (Intel) — then the
 *     generic D3D11VA path (any GPU) as fallback.
 *   - Linux: vendor *_cuvid (NVIDIA) → VAAPI (AMD/Intel).
 */
function buildDecodeCandidates(useGpu, codec, platform = process.platform) {
  const software = { label: 'software', args: [] };
  if (!useGpu) return [software];

  const candidates = [];
  const cuvid = codec ? `${codec}_cuvid` : null;

  if (platform === 'darwin') {
    candidates.push({ label: 'videotoolbox', args: ['-hwaccel', 'videotoolbox'] });
  } else if (platform === 'win32') {
    // Vendor-native decoders first (fastest on their hardware), then the
    // generic D3D11VA path that works on any GPU.
    // hevc/h264/vp9/av1/mpeg2/etc. all have *_cuvid variants in ffmpeg-static.
    if (cuvid) candidates.push({ label: cuvid, args: ['-c:v', cuvid] });
    candidates.push({ label: 'qsv', args: ['-hwaccel', 'qsv'] });
    candidates.push({ label: 'd3d11va', args: ['-hwaccel', 'd3d11va'] });
  } else {
    if (cuvid) candidates.push({ label: cuvid, args: ['-c:v', cuvid] });
    candidates.push({ label: 'vaapi', args: ['-hwaccel', 'vaapi'] });
  }

  candidates.push(software);
  return candidates;
}

/**
 * Run a single ffmpeg decode pass with the given input-side args, processing
 * each frame inline. Resolves with the results array, or rejects. A decode that
 * exits non-zero or produces zero frames rejects with `decodeFailed: true` so
 * the caller can try the next strategy. Abort always rejects with 'CANCELLED'.
 */
function runDecode(decodeArgs, ctx) {
  const { ffmpegPath, videoPath, width, height, frameBytes, tStep,
          useSubsample, totalDuration, signal, onProgress } = ctx;

  const args = [
    ...decodeArgs,
    '-i', videoPath,
    '-vf', `fps=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
    '-pix_fmt', 'gbrp10le',
    '-f', 'rawvideo',
    'pipe:1',
  ];

  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });

  const results = [];
  let frameIndex = 0;
  const frameBuffer = Buffer.allocUnsafe(frameBytes);
  let writeOffset = 0;
  let aborted = false;

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      aborted = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

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

          if (onProgress) {
            const percent = Math.min((timeSeconds / totalDuration) * 100, 100);
            onProgress(percent, timeSeconds, frameResult.peak);
          }

          frameIndex++;
          writeOffset = 0;
        }
      }
    });

    proc.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (aborted) {
        reject(new Error('CANCELLED'));
        return;
      }
      if (code !== 0 || results.length === 0) {
        const err = new Error(`decode failed (exit ${code}, ${results.length} frames)`);
        err.decodeFailed = true;
        reject(err);
        return;
      }
      resolve(results);
    });

    proc.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      const e = new Error(`Failed to start ffmpeg: ${err.message}`);
      e.decodeFailed = true;
      reject(e);
    });
  });
}

/**
 * Run HDR analysis on a video file. Decodes 1 fps via ffmpeg, processes each
 * frame inline, and reports progress through the onProgress callback.
 *
 * When options.useGpu is set, GPU decoders are tried first (vendor cuvid →
 * D3D11VA → QSV) and the analysis transparently falls back to CPU software
 * decode if none work. The per-frame math and output are identical regardless
 * of decode path.
 *
 * @param {string} videoPath
 * @param {Object} options - { useSubsample, useGpu, ffmpegPath, ffprobePath, signal }
 * @param {Function} onProgress - (percent, timeSeconds, peakNits) => void
 * @returns {Promise<{results, totalDuration, filename, decoder}>}
 */
async function analyze(videoPath, options, onProgress) {
  const { useSubsample = true, useGpu = false, signal } = options || {};

  if (signal && signal.aborted) {
    throw new Error('CANCELLED');
  }

  const ffmpegPath = (options && options.ffmpegPath) || resolveFfmpegPath();
  const ffprobePath = (options && options.ffprobePath) || resolveFfprobePath();

  // This analyzer's brightness/gamut math is specific to HDR10 (PQ + Rec.2020).
  // Reject anything else up front with a clear message.
  const fmt = await detectHdrFormat(videoPath, ffprobePath);
  if (!fmt.supported) {
    throw new Error(`Unsupported video format: ${fmt.format}. This tool only supports HDR10 (PQ/ST 2084) video.`);
  }

  const totalDuration = await getVideoDuration(videoPath, ffprobePath);

  const width = 3840;
  const height = 2160;
  const frameBytes = width * height * 3 * 2; // 3 planes, 2 bytes per 10-bit sample
  const tStep = 1.0;

  const codec = useGpu ? await getVideoCodec(videoPath, ffprobePath) : null;
  const candidates = buildDecodeCandidates(useGpu, codec);

  const ctx = {
    ffmpegPath, videoPath, width, height, frameBytes, tStep,
    useSubsample, totalDuration, signal, onProgress,
  };

  let results = null;
  let usedDecoder = null;
  let lastErr = null;

  for (const cand of candidates) {
    if (signal && signal.aborted) throw new Error('CANCELLED');
    try {
      results = await runDecode(cand.args, ctx);
      usedDecoder = cand.label;
      break;
    } catch (err) {
      // A real cancellation aborts the whole analysis; a decode failure just
      // moves on to the next strategy.
      if (err.message === 'CANCELLED') throw err;
      if (!err.decodeFailed) throw err;
      lastErr = err;
    }
  }

  if (!results) {
    throw new Error(
      `No frames were processed. Check that the file is a valid HDR video.` +
      (lastErr ? ` (${lastErr.message})` : '')
    );
  }

  return {
    results,
    totalDuration,
    filename: path.basename(videoPath),
    decoder: usedDecoder,
  };
}

module.exports = {
  analyze,
  pqEotf,
  isInGamut,
  processFrame,
  getVideoDuration
};
