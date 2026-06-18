'use strict';

const path = require('node:path');
const { resolveFfmpegPath, resolveFfprobePath } = require('./ffmpeg-paths');
const { pqEotf, isInGamut, processFrame } = require('./color-science');
const {
  detectHdrFormat,
  getVideoDuration,
  getVideoFrameRate,
  getVideoCodec,
} = require('./video-probe');
const { buildDecodeCandidates, runDecode } = require('./decode');

const TARGET_WIDTH = 3840;
const TARGET_HEIGHT = 2160;
const GPU_WORKER_COUNT = 2;

function normalizeSampleInterval(value) {
  const interval = value === undefined || value === null || value === '' ? 1 : Number(value);
  if (interval === 0 || interval === 1 || interval === 2) return interval;
  return 1;
}

/**
 * Analyze an HDR10 video and return sampled brightness and gamut statistics.
 *
 * GPU decode candidates use two frame-processing workers. Software decode stays
 * synchronous because FFmpeg and workers otherwise compete for the same CPU.
 */
async function analyze(videoPath, options, onProgress) {
  const { useSubsample = true, useGpu = false, signal } = options || {};
  const sampleInterval = normalizeSampleInterval(options && options.sampleInterval);

  if (signal && signal.aborted) throw new Error('CANCELLED');

  const ffmpegPath = (options && options.ffmpegPath) || resolveFfmpegPath();
  const ffprobePath = (options && options.ffprobePath) || resolveFfprobePath();

  const format = await detectHdrFormat(videoPath, ffprobePath);
  if (!format.supported) {
    throw new Error(
      `Unsupported video format: ${format.format}. ` +
      'This tool only supports HDR10 (PQ/ST 2084) video.'
    );
  }

  const totalDuration = await getVideoDuration(videoPath, ffprobePath);
  const frameRate = sampleInterval === 0
    ? await getVideoFrameRate(videoPath, ffprobePath)
    : null;
  const codec = useGpu ? await getVideoCodec(videoPath, ffprobePath) : null;

  const tStep = sampleInterval === 0 ? (1 / frameRate) : sampleInterval;
  const context = {
    ffmpegPath,
    videoPath,
    width: TARGET_WIDTH,
    height: TARGET_HEIGHT,
    frameBytes: TARGET_WIDTH * TARGET_HEIGHT * 3 * 2,
    tStep,
    fpsFilter: sampleInterval === 0 ? null : `fps=${1 / sampleInterval}`,
    useSubsample,
    totalDuration,
    signal,
    onProgress,
  };

  let lastError = null;
  for (const candidate of buildDecodeCandidates(useGpu, codec)) {
    if (signal && signal.aborted) throw new Error('CANCELLED');
    try {
      const workerCount = candidate.label === 'software' ? 0 : GPU_WORKER_COUNT;
      const results = await runDecode(candidate.args, context, workerCount);
      return {
        results,
        totalDuration,
        filename: path.basename(videoPath),
        decoder: candidate.label,
      };
    } catch (err) {
      if (err.message === 'CANCELLED') throw err;
      if (!err.decodeFailed) throw err;
      lastError = err;
    }
  }

  throw new Error(
    'No frames were processed. Check that the file is a valid HDR video.' +
    (lastError ? ` (${lastError.message})` : '')
  );
}

// Keep the existing public surface for benchmarks and external callers.
module.exports = {
  analyze,
  pqEotf,
  isInGamut,
  processFrame,
  getVideoDuration,
};
