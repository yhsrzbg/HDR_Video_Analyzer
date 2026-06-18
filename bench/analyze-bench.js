'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');
const { processFrame } = require('../src/color-science');
const { resolveFfmpegPath, resolveFfprobePath } = require('../src/ffmpeg-paths');

const TARGET_WIDTH = 3840;
const TARGET_HEIGHT = 2160;
const FRAME_BYTES = TARGET_WIDTH * TARGET_HEIGHT * 3 * 2;

function parseArgs(argv) {
  const defaults = {
    input: path.join(__dirname, '..', 'test_video', 'Sony_4K_HDR_Camp.mp4'),
    output: path.join(__dirname, 'reports', `analysis-bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    duration: 20,
    sampleInterval: 1,
    useSubsample: true,
    processIterations: 5,
    workerCounts: [1, 2, 4],
    decoder: 'software',
  };

  const options = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--input' && value) options.input = path.resolve(value), i++;
    else if (arg === '--output' && value) options.output = path.resolve(value), i++;
    else if (arg === '--duration' && value) options.duration = Number(value), i++;
    else if (arg === '--sample-interval' && value) options.sampleInterval = Number(value), i++;
    else if (arg === '--process-iterations' && value) options.processIterations = Number(value), i++;
    else if (arg === '--worker-counts' && value) {
      options.workerCounts = value.split(',').map(Number);
      i++;
    }
    else if (arg === '--decoder' && value) options.decoder = value, i++;
    else if (arg === '--no-subsample') options.useSubsample = false;
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  if (!(options.duration > 0)) throw new Error('--duration must be greater than 0');
  if (![1, 2].includes(options.sampleInterval)) throw new Error('--sample-interval must be 1 or 2');
  if (!(options.processIterations >= 1)) throw new Error('--process-iterations must be at least 1');
  if (options.workerCounts.some((count) => !Number.isInteger(count) || count < 1)) {
    throw new Error('--worker-counts must be a comma-separated list of positive integers');
  }
  if (!['software', 'hevc_cuvid'].includes(options.decoder)) {
    throw new Error('--decoder must be software or hevc_cuvid');
  }
  return options;
}

function printHelp() {
  console.log(`Usage: npm run bench -- [options]

Options:
  --input <path>               Video file to benchmark
  --output <path>              JSON report path
  --duration <seconds>         Source duration to process (default: 20)
  --sample-interval <1|2>      Match the app's sampling interval (default: 1)
  --process-iterations <count> Reprocess one source frame for a CPU microbench
  --worker-counts <list>       Worker pool sizes to test (default: 1,2,4)
  --decoder <name>             software or hevc_cuvid (default: software)
  --no-subsample               Process every pixel instead of every other pixel
  --help                       Show this help`);
}

function runProcess(command, args, stdio, onStdout) {
  return new Promise((resolve, reject) => {
    const startCpu = process.cpuUsage();
    const start = performance.now();
    const child = spawn(command, args, { stdio });
    let stderr = '';

    if (child.stdout && onStdout) child.stdout.on('data', onStdout);
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      const wallMs = performance.now() - start;
      const cpu = process.cpuUsage(startCpu);
      if (code !== 0) {
        reject(new Error(`${path.basename(command)} exited with code ${code}: ${stderr.slice(-2000)}`));
        return;
      }
      resolve({
        wallMs,
        parentCpuMs: (cpu.user + cpu.system) / 1000,
      });
    });
  });
}

async function probeVideo(input, ffprobePath) {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries',
    'format=duration,size,bit_rate:stream=codec_name,width,height,pix_fmt,avg_frame_rate,color_transfer,color_primaries',
    '-of', 'json',
    input,
  ];
  let output = '';
  const timing = await runProcess(ffprobePath, args, ['ignore', 'pipe', 'pipe'], (chunk) => {
    output += chunk.toString();
  });
  return { timing, data: JSON.parse(output) };
}

function decoderArgs(decoder) {
  return decoder === 'hevc_cuvid' ? ['-c:v', 'hevc_cuvid'] : [];
}

function buildDecodeArgs(input, duration, sampleInterval, decoder) {
  return [
    '-v', 'error',
    ...decoderArgs(decoder),
    '-i', input,
    '-t', String(duration),
    '-vf', `fps=${1 / sampleInterval},pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
    '-pix_fmt', 'gbrp10le',
    '-f', 'rawvideo',
    'pipe:1',
  ];
}

async function benchmarkNativeDecode(input, ffmpegPath, duration, decoder) {
  const args = [
    '-v', 'error',
    ...decoderArgs(decoder),
    '-i', input,
    '-t', String(duration),
    '-an', '-sn',
    '-f', 'null',
    '-',
  ];
  const timing = await runProcess(ffmpegPath, args, ['ignore', 'ignore', 'pipe']);
  return {
    ...timing,
    sourceSecondsPerWallSecond: duration / (timing.wallMs / 1000),
  };
}

async function benchmarkDecodeDiscard(input, ffmpegPath, duration, sampleInterval, decoder) {
  const args = buildDecodeArgs(input, duration, sampleInterval, decoder);
  const timing = await runProcess(ffmpegPath, args, ['ignore', 'ignore', 'pipe']);
  const expectedFrames = Math.ceil(duration / sampleInterval);
  return {
    ...timing,
    expectedFrames,
    msPerExpectedFrame: timing.wallMs / expectedFrames,
  };
}

async function benchmarkRawPipeline(
  input,
  ffmpegPath,
  duration,
  sampleInterval,
  useSubsample,
  processFrames,
  decoder
) {
  const args = buildDecodeArgs(input, duration, sampleInterval, decoder);
  const frameBuffer = Buffer.allocUnsafe(FRAME_BYTES);
  let writeOffset = 0;
  let bytes = 0;
  let frames = 0;
  let checksum = 0;

  const timing = await runProcess(ffmpegPath, args, ['ignore', 'pipe', 'pipe'], (chunk) => {
    bytes += chunk.length;
    let chunkOffset = 0;
    while (chunkOffset < chunk.length) {
      const toCopy = Math.min(FRAME_BYTES - writeOffset, chunk.length - chunkOffset);
      chunk.copy(frameBuffer, writeOffset, chunkOffset, chunkOffset + toCopy);
      writeOffset += toCopy;
      chunkOffset += toCopy;

      if (writeOffset === FRAME_BYTES) {
        if (processFrames) {
          const result = processFrame(frameBuffer, TARGET_WIDTH, TARGET_HEIGHT, useSubsample);
          checksum += result.peak + result.avg + result.r709 + result.rp3 + result.r2020;
        }
        frames++;
        writeOffset = 0;
      }
    }
  });

  return {
    ...timing,
    bytes,
    frames,
    incompleteFrameBytes: writeOffset,
    msPerFrame: frames ? timing.wallMs / frames : null,
    throughputMiBPerSecond: bytes / 1024 / 1024 / (timing.wallMs / 1000),
    checksum: processFrames ? checksum : undefined,
  };
}

class FrameWorkerPool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.nextTaskId = 0;
    this.workerCpuMs = 0;
    this.workerProcessingMs = 0;
  }

  async start() {
    const workerPath = path.join(__dirname, 'process-frame-worker.js');
    const start = performance.now();
    await Promise.all(Array.from({ length: this.size }, () => new Promise((resolve, reject) => {
      const state = {
        worker: new Worker(workerPath),
        busy: false,
        task: null,
      };
      state.worker.once('online', resolve);
      state.worker.on('message', (message) => this.onMessage(state, message));
      state.worker.on('error', (err) => {
        if (state.task) state.task.reject(err);
        reject(err);
      });
      this.workers.push(state);
    })));
    return performance.now() - start;
  }

  submit(frame, useSubsample) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: this.nextTaskId++,
        frame,
        useSubsample,
        resolve,
        reject,
      });
      this.dispatch();
    });
  }

  dispatch() {
    for (const state of this.workers) {
      if (state.busy || this.queue.length === 0) continue;
      const task = this.queue.shift();
      state.busy = true;
      state.task = task;
      state.worker.postMessage({
        id: task.id,
        buffer: task.frame.buffer,
        width: TARGET_WIDTH,
        height: TARGET_HEIGHT,
        useSubsample: task.useSubsample,
      }, [task.frame.buffer]);
    }
  }

  onMessage(state, message) {
    const task = state.task;
    state.busy = false;
    state.task = null;
    this.workerCpuMs += message.cpuMs;
    this.workerProcessingMs += message.wallMs;
    task.resolve(message.result);
    this.dispatch();
  }

  async close() {
    await Promise.all(this.workers.map(({ worker }) => worker.terminate()));
  }
}

async function benchmarkWorkerPipeline(
  input,
  ffmpegPath,
  duration,
  sampleInterval,
  useSubsample,
  workerCount,
  decoder
) {
  const pool = new FrameWorkerPool(workerCount);
  const workerStartupMs = await pool.start();
  const args = buildDecodeArgs(input, duration, sampleInterval, decoder);
  const maxInflight = workerCount * 2;
  let frameBuffer = Buffer.allocUnsafe(FRAME_BYTES);
  let writeOffset = 0;
  let bytes = 0;
  let frames = 0;
  let inflight = 0;
  let maxObservedInflight = 0;
  let checksum = 0;
  let stderr = '';
  let stdout = null;
  const tasks = [];
  const startCpu = process.cpuUsage();
  const start = performance.now();

  try {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    stdout = child.stdout;
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const childClosed = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`${path.basename(ffmpegPath)} exited with code ${code}: ${stderr.slice(-2000)}`));
          return;
        }
        resolve();
      });
    });

    stdout.on('data', (chunk) => {
      bytes += chunk.length;
      let chunkOffset = 0;
      while (chunkOffset < chunk.length) {
        const toCopy = Math.min(FRAME_BYTES - writeOffset, chunk.length - chunkOffset);
        chunk.copy(frameBuffer, writeOffset, chunkOffset, chunkOffset + toCopy);
        writeOffset += toCopy;
        chunkOffset += toCopy;

        if (writeOffset === FRAME_BYTES) {
          const submittedFrame = frameBuffer;
          frameBuffer = Buffer.allocUnsafe(FRAME_BYTES);
          writeOffset = 0;
          frames++;
          inflight++;
          maxObservedInflight = Math.max(maxObservedInflight, inflight);
          if (inflight >= maxInflight) stdout.pause();

          const task = pool.submit(submittedFrame, useSubsample).then((result) => {
            checksum += result.peak + result.avg + result.r709 + result.rp3 + result.r2020;
            inflight--;
            if (stdout.isPaused() && inflight < maxInflight) stdout.resume();
          });
          tasks.push(task);
        }
      }
    });

    await childClosed;
    await Promise.all(tasks);
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(startCpu);
    return {
      wallMs,
      parentCpuMs: (cpu.user + cpu.system) / 1000,
      workerStartupMs,
      workerCount,
      workerCpuMs: pool.workerCpuMs,
      workerProcessingMs: pool.workerProcessingMs,
      bytes,
      frames,
      incompleteFrameBytes: writeOffset,
      maxInflight,
      maxObservedInflight,
      msPerFrame: frames ? wallMs / frames : null,
      throughputMiBPerSecond: bytes / 1024 / 1024 / (wallMs / 1000),
      checksum,
    };
  } finally {
    await pool.close();
  }
}

async function captureSourceFrame(input, ffmpegPath, seekSeconds) {
  const args = [
    '-v', 'error',
    '-ss', String(seekSeconds),
    '-i', input,
    '-frames:v', '1',
    '-vf', `pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
    '-pix_fmt', 'gbrp10le',
    '-f', 'rawvideo',
    'pipe:1',
  ];
  const chunks = [];
  let bytes = 0;
  await runProcess(ffmpegPath, args, ['ignore', 'pipe', 'pipe'], (chunk) => {
    if (bytes < FRAME_BYTES) {
      chunks.push(chunk);
      bytes += chunk.length;
    }
  });
  const frame = Buffer.concat(chunks);
  if (frame.length < FRAME_BYTES) throw new Error('Could not capture a complete decoded frame');
  return frame.subarray(0, FRAME_BYTES);
}

function benchmarkProcessFrame(frame, useSubsample, iterations) {
  const samplesMs = [];
  let checksum = 0;
  processFrame(frame, TARGET_WIDTH, TARGET_HEIGHT, useSubsample);

  const startCpu = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const iterationStart = performance.now();
    const result = processFrame(frame, TARGET_WIDTH, TARGET_HEIGHT, useSubsample);
    samplesMs.push(performance.now() - iterationStart);
    checksum += result.peak + result.avg + result.r709 + result.rp3 + result.r2020;
  }
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(startCpu);

  return {
    iterations,
    wallMs,
    parentCpuMs: (cpu.user + cpu.system) / 1000,
    averageMsPerFrame: wallMs / iterations,
    minMsPerFrame: Math.min(...samplesMs),
    maxMsPerFrame: Math.max(...samplesMs),
    sampledPixelsPerFrame: (TARGET_WIDTH / (useSubsample ? 2 : 1)) *
      (TARGET_HEIGHT / (useSubsample ? 2 : 1)),
    checksum,
  };
}

function summarize(stages) {
  const nativeDecodeMs = stages.nativeDecode.wallMs;
  const decodeMs = stages.decodeDiscard.msPerExpectedFrame;
  const pipeMs = stages.rawPipe.msPerFrame;
  const fullMs = stages.fullPipeline.msPerFrame;
  const processMs = stages.processFrame.averageMsPerFrame;
  const pipelineFrames = stages.fullPipeline.frames;
  const processCpuEstimate = (
    stages.fullPipeline.parentCpuMs - stages.rawPipe.parentCpuMs
  ) / pipelineFrames;
  const workerComparisons = Object.fromEntries(
    Object.entries(stages.workerPipelines || {}).map(([workerCount, stage]) => [
      workerCount,
      {
        wallMs: stage.wallMs,
        speedupVsSynchronous: stages.fullPipeline.wallMs / stage.wallMs,
        wallTimeSavedMs: stages.fullPipeline.wallMs - stage.wallMs,
        workerCpuMs: stage.workerCpuMs,
      },
    ])
  );
  const bestWorker = Object.entries(workerComparisons).reduce((best, [workerCount, result]) => {
    if (!best || result.wallMs < best.wallMs) {
      return { workerCount: Number(workerCount), ...result };
    }
    return best;
  }, null);
  const dominant = processCpuEstimate >= decodeMs * 0.5
    ? 'mixed-ffmpeg-and-javascript'
    : 'ffmpeg-decode-filter-conversion';

  return {
    dominantBottleneck: dominant,
    nativeDecodeWallMs: nativeDecodeMs,
    nativeDecodeSpeedX: stages.nativeDecode.sourceSecondsPerWallSecond,
    conversionAndSamplingOverheadMs: stages.decodeDiscard.wallMs - nativeDecodeMs,
    decodeMsPerFrame: decodeMs,
    rawPipeMsPerFrame: pipeMs,
    fullPipelineMsPerFrame: fullMs,
    processFrameMsPerFrame: processMs,
    processCpuEstimateMsPerFrame: processCpuEstimate,
    processVsDecodeRatio: processMs / decodeMs,
    pipeOverheadMsPerFrame: pipeMs - decodeMs,
    estimatedFramesPerSecond: 1000 / fullMs,
    workerComparisons,
    bestWorker,
    note: 'Stages run sequentially. Differences are diagnostic estimates; OS cache and ffmpeg startup can affect short runs.',
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!fs.existsSync(options.input)) throw new Error(`Input file not found: ${options.input}`);

  const ffmpegPath = resolveFfmpegPath();
  const ffprobePath = resolveFfprobePath();
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    input: {
      path: options.input,
      sizeBytes: fs.statSync(options.input).size,
    },
    config: {
      durationSeconds: options.duration,
      sampleIntervalSeconds: options.sampleInterval,
      useSubsample: options.useSubsample,
      targetWidth: TARGET_WIDTH,
      targetHeight: TARGET_HEIGHT,
      frameBytes: FRAME_BYTES,
      processIterations: options.processIterations,
      workerCounts: options.workerCounts,
      decoder: options.decoder,
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: os.cpus()[0] && os.cpus()[0].model,
      logicalCpuCount: os.cpus().length,
      memoryBytes: os.totalmem(),
      ffmpegPath,
      ffprobePath,
    },
    stages: {},
  };

  console.log(`Benchmarking ${options.input}`);
  console.log(
    `Window: ${options.duration}s, sample interval: ${options.sampleInterval}s, ` +
    `subsample: ${options.useSubsample}, decoder: ${options.decoder}`
  );

  report.stages.probe = await probeVideo(options.input, ffprobePath);
  const totalStages = 5 + options.workerCounts.length;
  console.log(`1/${totalStages} ffprobe complete`);
  report.stages.nativeDecode = await benchmarkNativeDecode(
    options.input, ffmpegPath, options.duration, options.decoder
  );
  console.log(`2/${totalStages} native decode complete`);
  report.stages.decodeDiscard = await benchmarkDecodeDiscard(
    options.input, ffmpegPath, options.duration, options.sampleInterval, options.decoder
  );
  console.log(`3/${totalStages} decode/convert-to-null complete`);
  report.stages.rawPipe = await benchmarkRawPipeline(
    options.input,
    ffmpegPath,
    options.duration,
    options.sampleInterval,
    options.useSubsample,
    false,
    options.decoder
  );
  console.log(`4/${totalStages} raw pipe complete`);
  report.stages.fullPipeline = await benchmarkRawPipeline(
    options.input,
    ffmpegPath,
    options.duration,
    options.sampleInterval,
    options.useSubsample,
    true,
    options.decoder
  );
  console.log(`5/${totalStages} synchronous full pipeline complete`);

  report.stages.workerPipelines = {};
  for (let i = 0; i < options.workerCounts.length; i++) {
    const workerCount = options.workerCounts[i];
    report.stages.workerPipelines[workerCount] = await benchmarkWorkerPipeline(
      options.input,
      ffmpegPath,
      options.duration,
      options.sampleInterval,
      options.useSubsample,
      workerCount,
      options.decoder
    );
    console.log(`${6 + i}/${totalStages} ${workerCount}-worker pipeline complete`);
  }

  const sourceDuration = Number(report.stages.probe.data.format.duration);
  const sourceFrame = await captureSourceFrame(
    options.input, ffmpegPath, Math.min(options.duration / 2, sourceDuration / 2)
  );
  report.stages.processFrame = benchmarkProcessFrame(
    sourceFrame, options.useSubsample, options.processIterations
  );
  report.summary = summarize(report.stages);

  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${options.output}`);
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
