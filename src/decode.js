'use strict';

const { spawn } = require('node:child_process');
const { processFrame } = require('./color-science');
const { FrameWorkerPool } = require('./frame-worker-pool');

function buildDecodeCandidates(useGpu, codec, platform = process.platform) {
  const software = { label: 'software', args: [] };
  if (!useGpu) return [software];

  const candidates = [];
  const cuvid = codec && codec !== 'vp9' ? `${codec}_cuvid` : null;

  if (platform === 'darwin') {
    candidates.push({ label: 'videotoolbox', args: ['-hwaccel', 'videotoolbox'] });
  } else if (platform === 'win32') {
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

function runDecode(decodeArgs, ctx, workerCount = 0) {
  const {
    ffmpegPath,
    videoPath,
    width,
    height,
    frameBytes,
    tStep,
    fpsFilter,
    useSubsample,
    totalDuration,
    signal,
    onProgress,
  } = ctx;

  const filters = [];
  if (fpsFilter) filters.push(fpsFilter);
  filters.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`);

  const args = [
    ...decodeArgs,
    '-i', videoPath,
    '-vf', filters.join(','),
    '-pix_fmt', 'gbrp10le',
    '-f', 'rawvideo',
    'pipe:1',
  ];
  const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });

  const results = [];
  let frameIndex = 0;
  let frameBuffer = Buffer.allocUnsafe(frameBytes);
  let writeOffset = 0;
  let settled = false;
  let ffmpegClosed = false;
  let ffmpegCode = null;
  let pendingFrames = 0;
  let nextResultIndex = 0;
  const maxInflight = Math.max(workerCount * 2, 1);
  const workerPool = workerCount > 0 ? new FrameWorkerPool(workerCount) : null;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (workerPool) workerPool.close();
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      reject(err);
    };

    const maybeFinish = () => {
      if (settled || !ffmpegClosed || pendingFrames > 0) return;
      if (ffmpegCode !== 0 || results.length === 0) {
        const err = new Error(`decode failed (exit ${ffmpegCode}, ${results.length} frames)`);
        err.decodeFailed = true;
        fail(err);
        return;
      }
      settled = true;
      cleanup();
      resolve(results);
    };

    const appendResult = (index, frameResult) => {
      results[index] = {
        time: index * tStep,
        peak: frameResult.peak,
        avg: frameResult.avg,
        r709: frameResult.r709,
        rp3: frameResult.rp3,
        r2020: frameResult.r2020,
      };

      while (results[nextResultIndex]) {
        if (onProgress) {
          const completed = results[nextResultIndex];
          const percent = Math.min((completed.time / totalDuration) * 100, 100);
          onProgress(percent, completed.time, completed.peak);
        }
        nextResultIndex++;
      }
    };

    const onAbort = () => fail(new Error('CANCELLED'));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    if (workerPool) {
      workerPool.onError((err) => {
        const wrapped = new Error(`Frame worker failed: ${err.message}`);
        wrapped.decodeFailed = false;
        fail(wrapped);
      });
    }

    proc.stdout.on('data', (chunk) => {
      if (settled) return;
      let chunkOffset = 0;
      while (chunkOffset < chunk.length) {
        const toCopy = Math.min(frameBytes - writeOffset, chunk.length - chunkOffset);
        chunk.copy(frameBuffer, writeOffset, chunkOffset, chunkOffset + toCopy);
        writeOffset += toCopy;
        chunkOffset += toCopy;

        if (writeOffset === frameBytes) {
          const currentIndex = frameIndex++;
          writeOffset = 0;

          if (workerPool) {
            const submittedFrame = frameBuffer;
            frameBuffer = Buffer.allocUnsafe(frameBytes);
            pendingFrames++;
            if (pendingFrames >= maxInflight) proc.stdout.pause();

            workerPool.submit(submittedFrame, width, height, useSubsample, (frameResult) => {
              pendingFrames--;
              appendResult(currentIndex, frameResult);
              if (!settled && proc.stdout.isPaused() && pendingFrames < maxInflight) {
                proc.stdout.resume();
              }
              maybeFinish();
            });
          } else {
            appendResult(currentIndex, processFrame(frameBuffer, width, height, useSubsample));
          }
        }
      }
    });

    proc.on('close', (code) => {
      ffmpegClosed = true;
      ffmpegCode = code;
      maybeFinish();
    });

    proc.on('error', (err) => {
      const wrapped = new Error(`Failed to start ffmpeg: ${err.message}`);
      wrapped.decodeFailed = true;
      fail(wrapped);
    });
  });
}

module.exports = { buildDecodeCandidates, runDecode };
