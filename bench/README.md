# Analysis benchmark

Run the default benchmark against `test_video/Sony_4K_HDR_Camp.mp4`:

```bash
npm run bench
```

Useful options:

```bash
npm run bench -- --duration 20 --sample-interval 1
npm run bench -- --duration 20 --sample-interval 2
npm run bench -- --worker-counts 1,2,4
npm run bench -- --decoder hevc_cuvid --worker-counts 1,2,4
npm run bench -- --no-subsample
npm run bench -- --input path/to/video.mp4 --output bench/reports/custom.json
npm run bench:production -- --output bench/reports/production-before.json
```

The JSON report separates the current analysis pipeline into:

1. `probe`: ffprobe metadata startup and parsing.
2. `nativeDecode`: software decode without RGB conversion or raw frame output.
3. `decodeDiscard`: decode, sampling filter, padding, and `gbrp10le` conversion.
4. `rawPipe`: the same FFmpeg work plus transfer and frame assembly in Node.
5. `fullPipeline`: raw-pipe work plus the production `processFrame` function.
6. `workerPipelines`: the same full pipeline with `processFrame` dispatched to
   bounded Worker Thread pools. Frames are transferred rather than cloned.
7. `processFrame`: a CPU microbenchmark using a decoded frame from the middle
   of the selected source window.

Run benchmarks on an otherwise idle machine. The stages are sequential and
short runs are sensitive to OS file cache, CPU boost, and background activity.
