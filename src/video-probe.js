'use strict';

const { spawn } = require('node:child_process');

function probeJson(args, ffprobePath) {
  return new Promise((resolve) => {
    const proc = spawn(ffprobePath, ['-v', 'error', '-of', 'json', ...args]);
    let out = '';
    proc.stdout.on('data', (data) => { out += data.toString(); });
    proc.on('close', () => {
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
    proc.on('error', () => resolve(null));
  });
}

async function detectHdrFormat(videoPath, ffprobePath) {
  const streamInfo = await probeJson(
    [
      '-select_streams', 'v:0',
      '-show_entries', 'stream=color_transfer,color_primaries,codec_tag_string',
      videoPath,
    ],
    ffprobePath
  );
  const stream = streamInfo && streamInfo.streams && streamInfo.streams[0];
  if (!stream) return { supported: false, format: 'Unknown (could not read video stream info)' };

  const transfer = (stream.color_transfer || '').toLowerCase();
  const primaries = (stream.color_primaries || '').toLowerCase();
  const tag = (stream.codec_tag_string || '').toLowerCase();

  if (['dvhe', 'dvh1', 'dav1', 'dvav', 'dva1'].includes(tag)) {
    return { supported: false, format: 'Dolby Vision' };
  }
  if (transfer === 'arib-std-b67') {
    return { supported: false, format: 'HLG' };
  }
  if (transfer !== 'smpte2084') {
    return { supported: false, format: 'SDR / non-HDR10' };
  }
  if (primaries !== 'bt2020') {
    return { supported: false, format: 'SDR / non-standard HDR' };
  }

  const frameInfo = await probeJson(
    ['-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_frames', videoPath],
    ffprobePath
  );
  const frame = frameInfo && frameInfo.frames && frameInfo.frames[0];
  const sideTypes = (frame && frame.side_data_list || [])
    .map((item) => (item.side_data_type || '').toLowerCase());

  for (const type of sideTypes) {
    if (type.includes('dolby') || type.includes('dovi')) {
      return { supported: false, format: 'Dolby Vision' };
    }
    if (type.includes('2094') || type.includes('dynamic hdr') || type.includes('dynamic metadata')) {
      return { supported: false, format: 'HDR10+' };
    }
  }

  return { supported: true, format: 'HDR10' };
}

function getVideoDuration(videoPath, ffprobePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', '0', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath];
    const proc = spawn(ffprobePath, args);
    let output = '';
    let errOutput = '';

    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.stderr.on('data', (data) => { errOutput += data.toString(); });
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

function getVideoFrameRate(videoPath, ffprobePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=avg_frame_rate,r_frame_rate',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ];
    const proc = spawn(ffprobePath, args);
    let output = '';
    let errOutput = '';
    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.stderr.on('data', (data) => { errOutput += data.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}: ${errOutput}`));
        return;
      }
      for (const line of output.trim().split(/\r?\n/)) {
        const rate = parseFrameRate(line);
        if (rate > 0) {
          resolve(rate);
          return;
        }
      }
      reject(new Error('Could not parse video frame rate'));
    });
    proc.on('error', reject);
  });
}

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
    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.on('close', () => resolve(output.trim().toLowerCase() || null));
    proc.on('error', () => resolve(null));
  });
}

function parseFrameRate(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  if (text.includes('/')) {
    const [num, den] = text.split('/').map(Number);
    return Number.isFinite(num) && Number.isFinite(den) && den !== 0 ? num / den : 0;
  }
  const rate = Number(text);
  return Number.isFinite(rate) ? rate : 0;
}

module.exports = {
  detectHdrFormat,
  getVideoDuration,
  getVideoFrameRate,
  getVideoCodec,
  parseFrameRate,
};
