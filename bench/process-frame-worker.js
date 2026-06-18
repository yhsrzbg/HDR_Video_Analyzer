'use strict';

const { parentPort } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { processFrame } = require('../src/color-science');

parentPort.on('message', ({ id, buffer, width, height, useSubsample }) => {
  const frame = Buffer.from(buffer);
  const startCpu = process.threadCpuUsage();
  const start = performance.now();
  const result = processFrame(frame, width, height, useSubsample);
  const wallMs = performance.now() - start;
  const cpu = process.threadCpuUsage(startCpu);

  parentPort.postMessage({
    id,
    result,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
  });
});
