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
  const chartCanvas = document.getElementById('chart-canvas');
  const dataUrl = chartCanvas.toDataURL('image/png');
  const result = await window.hdrAPI.saveImage(dataUrl);
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
  placeholder.style.display = 'none';
  const chartCanvas = document.getElementById('chart-canvas');
  chartCanvas.style.display = 'none';
  setStatus(`Analyzing: ${getFilename(videoPath)}`);

  try {
    const result = await window.hdrAPI.startAnalysis(videoPath);

    if (result.success) {
      // Draw chart on canvas
      placeholder.style.display = 'none';
      chartCanvas.style.display = 'block';
      drawChart(chartCanvas, result.analysisData);

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
  const chartCanvas = document.getElementById('chart-canvas');
  chartCanvas.style.display = 'none';
  placeholder.style.display = 'none';
  // Remove any previous error message
  const existingError = content.querySelector('.error-message');
  if (existingError) existingError.remove();
  const errorDiv = document.createElement('div');
  errorDiv.className = 'error-message';
  errorDiv.textContent = message;
  content.appendChild(errorDiv);
}

function getFilename(filePath) {
  return filePath.split(/[/\\]/).pop();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
