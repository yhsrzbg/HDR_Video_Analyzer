'use strict';

const api = window.hdrAPI;

const screens = {
  drop: document.getElementById('screen-drop'),
  progress: document.getElementById('screen-progress'),
  result: document.getElementById('screen-result'),
};

const els = {
  dropzone: document.getElementById('dropzone'),
  dropErr: document.getElementById('drop-err'),
  progFname: document.getElementById('prog-fname'),
  progPct: document.getElementById('prog-pct'),
  progBar: document.getElementById('prog-bar'),
  progTime: document.getElementById('prog-time'),
  progPeak: document.getElementById('prog-peak'),
  btnCancel: document.getElementById('btn-cancel'),
  btnBack: document.getElementById('btn-back'),
  btnSavePng: document.getElementById('btn-save-png'),
  btnSaveHtml: document.getElementById('btn-save-html'),
  resultTitle: document.getElementById('result-title'),
  savedMsg: document.getElementById('saved-msg'),
  canvas: document.getElementById('chart-canvas'),
  gpuCheckbox: document.getElementById('gpu-checkbox'),
};

// Restore the GPU toggle from last session (default on).
const savedGpu = localStorage.getItem('useGpu');
if (savedGpu !== null) els.gpuCheckbox.checked = savedGpu === '1';
els.gpuCheckbox.addEventListener('change', () => {
  localStorage.setItem('useGpu', els.gpuCheckbox.checked ? '1' : '0');
});

const VALID_EXT = ['.mkv', '.mp4', '.mov', '.ts'];
let currentData = null;
let savedMsgTimer = null;

function show(name) {
  for (const key of Object.keys(screens)) {
    screens[key].classList.toggle('active', key === name);
  }
}

function baseName(p) {
  return (p || '').split(/[\\/]/).pop() || 'video';
}

function stripExt(name) {
  return name.replace(/\.[^.]+$/, '');
}

function flashSaved(msg) {
  els.savedMsg.textContent = msg;
  if (savedMsgTimer) clearTimeout(savedMsgTimer);
  savedMsgTimer = setTimeout(() => { els.savedMsg.textContent = ''; }, 4000);
}

async function beginAnalysis(videoPath) {
  els.dropErr.textContent = '';
  const ext = '.' + baseName(videoPath).split('.').pop().toLowerCase();
  if (!VALID_EXT.includes(ext)) {
    els.dropErr.textContent = `不支持的格式 "${ext}"。支持: ${VALID_EXT.join(', ')}`;
    return;
  }

  // Reset progress UI
  els.progFname.textContent = baseName(videoPath);
  els.progPct.textContent = '0.0%';
  els.progBar.style.width = '0%';
  els.progTime.textContent = '时间: 0.0s';
  els.progPeak.textContent = 'Peak: 0 nits';
  show('progress');

  api.onProgress(({ percent, time, peak }) => {
    els.progPct.textContent = percent.toFixed(1) + '%';
    els.progBar.style.width = Math.min(percent, 100) + '%';
    els.progTime.textContent = '时间: ' + time.toFixed(1) + 's';
    els.progPeak.textContent = 'Peak: ' + Math.round(peak) + ' nits';
  });

  const res = await api.startAnalysis(videoPath, { useGpu: els.gpuCheckbox.checked });
  api.offProgress();

  if (!res.success) {
    show('drop');
    els.dropErr.textContent = res.cancelled ? '' : ('分析失败: ' + (res.error || '未知错误'));
    return;
  }

  currentData = res.analysisData;
  els.resultTitle.textContent = currentData.filename || '';
  els.savedMsg.textContent = '';
  window.drawChart(els.canvas, currentData);
  show('result');
}

// --- Drop screen interactions ---
els.dropzone.addEventListener('click', async () => {
  const p = await api.selectVideo();
  if (p) beginAnalysis(p);
});

// Prevent the window from navigating when a file is dropped anywhere.
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', (e) => { e.preventDefault(); });

els.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.dropzone.classList.add('dragover');
});
els.dropzone.addEventListener('dragleave', () => {
  els.dropzone.classList.remove('dragover');
});
els.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  els.dropzone.classList.remove('dragover');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  const p = api.getPathForFile(file);
  if (p) beginAnalysis(p);
  else els.dropErr.textContent = '无法读取文件路径，请改用点击选择。';
});

// --- Progress screen ---
els.btnCancel.addEventListener('click', async () => {
  els.btnCancel.disabled = true;
  await api.cancelAnalysis();
  els.btnCancel.disabled = false;
});

// --- Result screen ---
els.btnBack.addEventListener('click', () => {
  currentData = null;
  els.dropErr.textContent = '';
  show('drop');
});

els.btnSavePng.addEventListener('click', async () => {
  if (!currentData) return;
  const dataUrl = els.canvas.toDataURL('image/png');
  const res = await api.savePng(dataUrl, stripExt(currentData.filename || 'hdr-analysis'));
  if (res.success) flashSaved('已保存: ' + baseName(res.filePath));
  else if (!res.cancelled) flashSaved('保存失败');
});

els.btnSaveHtml.addEventListener('click', async () => {
  if (!currentData) return;
  const res = await api.saveHtml(currentData, stripExt(currentData.filename || 'hdr-analysis'));
  if (res.success) flashSaved('已保存: ' + baseName(res.filePath));
  else if (!res.cancelled) flashSaved('保存失败');
});
