'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

class FrameWorkerPool {
  constructor(size) {
    this.workers = [];
    this.queue = [];
    this.closed = false;
    this.errorHandler = null;

    const workerPath = path.join(__dirname, 'process-frame-worker.js')
      .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

    for (let i = 0; i < size; i++) {
      const state = {
        worker: new Worker(workerPath),
        busy: false,
        task: null,
      };
      state.worker.on('message', (message) => this.handleMessage(state, message));
      state.worker.on('error', (err) => this.handleError(state, err));
      state.worker.on('exit', (code) => {
        if (!this.closed && code !== 0) {
          this.handleError(state, new Error(`worker exited with code ${code}`));
        }
      });
      this.workers.push(state);
    }
  }

  onError(handler) {
    this.errorHandler = handler;
  }

  submit(frame, width, height, useSubsample, onComplete) {
    if (this.closed) return;
    this.queue.push({ frame, width, height, useSubsample, onComplete });
    this.dispatch();
  }

  dispatch() {
    if (this.closed) return;
    for (const state of this.workers) {
      if (state.busy || this.queue.length === 0) continue;
      const task = this.queue.shift();
      state.busy = true;
      state.task = task;
      state.worker.postMessage({
        buffer: task.frame.buffer,
        width: task.width,
        height: task.height,
        useSubsample: task.useSubsample,
      }, [task.frame.buffer]);
    }
  }

  handleMessage(state, result) {
    if (this.closed) return;
    const task = state.task;
    state.busy = false;
    state.task = null;
    task.onComplete(result);
    this.dispatch();
  }

  handleError(state, err) {
    if (this.closed) return;
    state.busy = false;
    state.task = null;
    if (this.errorHandler) this.errorHandler(err);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    for (const state of this.workers) {
      state.worker.terminate();
    }
  }
}

module.exports = { FrameWorkerPool };
