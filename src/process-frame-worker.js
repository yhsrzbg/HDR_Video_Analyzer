'use strict';

const { parentPort } = require('node:worker_threads');
const { processFrame } = require('./color-science');

parentPort.on('message', ({ buffer, width, height, useSubsample }) => {
  const frame = Buffer.from(buffer);
  const result = processFrame(frame, width, height, useSubsample);
  parentPort.postMessage(result);
});
