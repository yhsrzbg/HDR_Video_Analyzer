'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { analyze } = require('../src/analyze');

function parseArgs(argv) {
  const options = {
    output: path.join(__dirname, 'reports', 'production-bench.json'),
    inputs: [
      path.join(__dirname, '..', 'test_video', 'Sony_4K_HDR_Camp.mp4'),
      path.join(__dirname, '..', 'test_video', 'Sony_oled.mp4'),
    ],
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output' && argv[i + 1]) {
      options.output = path.resolve(argv[++i]);
    } else {
      throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
    }
  }
  return options;
}

function summarizeResults(results) {
  const totals = results.reduce((acc, item) => {
    acc.peak = Math.max(acc.peak, item.peak);
    acc.avg += item.avg;
    acc.r709 += item.r709;
    acc.rp3 += item.rp3;
    acc.r2020 += item.r2020;
    return acc;
  }, { peak: 0, avg: 0, r709: 0, rp3: 0, r2020: 0 });
  const count = results.length || 1;

  return {
    frameCount: results.length,
    maxPeak: totals.peak,
    meanAvg: totals.avg / count,
    meanR709: totals.r709 / count,
    meanRp3: totals.rp3 / count,
    meanR2020: totals.r2020 / count,
    sha256: crypto.createHash('sha256').update(JSON.stringify(results)).digest('hex'),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      useGpu: true,
      useSubsample: true,
      sampleInterval: 1,
    },
    runs: [],
  };

  for (const input of options.inputs) {
    if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`);
    console.log(`Analyzing ${path.basename(input)}...`);
    let lastPercent = -1;
    const start = performance.now();
    const analysis = await analyze(
      input,
      report.config,
      (percent) => {
        const rounded = Math.floor(percent / 10) * 10;
        if (rounded > lastPercent) {
          lastPercent = rounded;
          process.stdout.write(`${rounded}% `);
        }
      }
    );
    const wallMs = performance.now() - start;
    console.log(`done in ${(wallMs / 1000).toFixed(2)}s`);
    report.runs.push({
      input,
      filename: analysis.filename,
      durationSeconds: analysis.totalDuration,
      decoder: analysis.decoder,
      wallMs,
      sourceSecondsPerWallSecond: analysis.totalDuration / (wallMs / 1000),
      results: summarizeResults(analysis.results),
    });
  }

  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${options.output}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
