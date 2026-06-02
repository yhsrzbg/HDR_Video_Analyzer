'use strict';

// UI Elements
const btnSelect = document.getElementById('btn-select');
const btnSave = document.getElementById('btn-save');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const content = document.getElementById('content');
const placeholder = document.getElementById('placeholder');
const statusBar = document.getElementById('status-bar');

let isAnalyzing = false;

// --- Event Listeners ---

btnSelect.addEventListener('click', async () => {
  if (isAnalyzing) return;

  const videoPath = await window.hdrAPI.selectVideo();
  if (!videoPath) return;

  startAnalysis(videoPath);
});

btnSave.addEventListener('click', async () => {
  const result = await window.hdrAPI.saveImage();
  if (result.success) {
    setStatus(`Chart saved to: ${result.filePath}`);
  } else if (result.error !== 'Save cancelled') {
    setStatus(`Save failed: ${result.error}`);
  }
});

// --- Progress Listener ---

window.hdrAPI.onAnalysisProgress((data) => {
  const { percent, time, peak } = data;
  progressBar.style.width = `${Math.min(percent, 100)}%`;
  progressText.textContent = `Analyzing: ${percent.toFixed(1)}% | Time: ${time.toFixed(1)}s | Peak: ${Math.round(peak)} nits`;
});

// --- Analysis Flow ---

async function startAnalysis(videoPath) {
  isAnalyzing = true;
  btnSelect.disabled = true;
  btnSave.disabled = true;

  // Show progress
  progressContainer.classList.add('visible');
  progressBar.style.width = '0%';
  progressText.textContent = 'Starting analysis...';

  // Clear previous content
  content.innerHTML = '';
  setStatus(`Analyzing: ${getFilename(videoPath)}`);

  try {
    const result = await window.hdrAPI.startAnalysis(videoPath);

    if (result.success) {
      // Display chart image
      const img = document.createElement('img');
      img.className = 'chart-image';
      img.src = result.imageData;
      img.alt = 'HDR Analysis Chart';
      content.innerHTML = '';
      content.appendChild(img);

      btnSave.disabled = false;
      setStatus(`Analysis complete: ${getFilename(videoPath)}`);
    } else {
      showError(result.error);
      setStatus('Analysis failed');
    }
  } catch (err) {
    showError(err.message || 'An unexpected error occurred');
    setStatus('Analysis failed');
  } finally {
    isAnalyzing = false;
    btnSelect.disabled = false;
    progressContainer.classList.remove('visible');
  }
}

// --- Helpers ---

function setStatus(text) {
  statusBar.textContent = text;
}

function showError(message) {
  content.innerHTML = `<div class="error-message">${escapeHtml(message)}</div>`;
}

function getFilename(filePath) {
  return filePath.split(/[/\\]/).pop();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
