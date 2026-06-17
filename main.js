'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { analyze } = require('./src/analyze');
const { buildReportHtml } = require('./src/report');

const VALID_EXT = ['.mkv', '.mp4', '.mov', '.ts'];

let mainWindow = null;
let activeAbort = null;

/**
 * Resolve bundled ffmpeg/ffprobe paths. When packaged, electron-builder copies
 * the binaries into resources/ (see package.json build.extraResources); in dev
 * we fall back to the ffmpeg-static/ffprobe-static packages via analyze().
 */
function resolveBinaries() {
  if (!app.isPackaged) return {};
  const ext = process.platform === 'win32' ? '.exe' : '';
  return {
    ffmpegPath: path.join(process.resourcesPath, `ffmpeg${ext}`),
    ffprobePath: path.join(process.resourcesPath, `ffprobe${ext}`),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#1a1a2e',
    title: 'HDR Video Analyzer',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    if (activeAbort) activeAbort.abort();
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// --- IPC ---

ipcMain.handle('select-video', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select an HDR video file',
    filters: [
      { name: 'Video files', extensions: ['mkv', 'mp4', 'mov', 'ts'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('start-analysis', async (event, videoPath, opts) => {
  if (activeAbort) {
    return { success: false, error: 'An analysis is already in progress.' };
  }
  if (typeof videoPath !== 'string' || !videoPath) {
    return { success: false, error: 'Invalid file path.' };
  }
  if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) {
    return { success: false, error: `File not found: ${videoPath}` };
  }
  const ext = path.extname(videoPath).toLowerCase();
  if (!VALID_EXT.includes(ext)) {
    return { success: false, error: `Unsupported format "${ext}". Supported: ${VALID_EXT.join(', ')}` };
  }

  const useGpu = !!(opts && opts.useGpu);
  const controller = new AbortController();
  activeAbort = controller;

  try {
    const analysisData = await analyze(
      videoPath,
      { useSubsample: true, useGpu, signal: controller.signal, ...resolveBinaries() },
      (percent, time, peak) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('analysis-progress', { percent, time, peak });
        }
      }
    );
    activeAbort = null;
    return { success: true, analysisData };
  } catch (err) {
    activeAbort = null;
    const cancelled = err && err.message === 'CANCELLED';
    return { success: false, error: err.message, cancelled };
  }
});

ipcMain.handle('cancel-analysis', () => {
  if (activeAbort) {
    activeAbort.abort();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('save-png', async (event, dataUrl, defaultName) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    return { success: false, error: 'Invalid image data.' };
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save as PNG',
    defaultPath: `${defaultName || 'hdr-analysis'}.png`,
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return { success: false, cancelled: true };

  try {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(result.filePath, Buffer.from(base64, 'base64'));
    return { success: true, filePath: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-html', async (event, analysisData, defaultName) => {
  if (!analysisData || !Array.isArray(analysisData.results)) {
    return { success: false, error: 'Invalid analysis data.' };
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save as HTML report',
    defaultPath: `${defaultName || 'hdr-analysis'}-hdr-report.html`,
    filters: [{ name: 'HTML report', extensions: ['html'] }],
  });
  if (result.canceled || !result.filePath) return { success: false, cancelled: true };

  try {
    fs.writeFileSync(result.filePath, buildReportHtml(analysisData));
    return { success: true, filePath: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
