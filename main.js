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
    title: '选择 HDR 视频文件',
    filters: [
      { name: '视频文件', extensions: ['mkv', 'mp4', 'mov', 'ts'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('start-analysis', async (event, videoPath, opts) => {
  if (activeAbort) {
    return { success: false, error: '已有分析正在进行中。' };
  }
  if (typeof videoPath !== 'string' || !videoPath) {
    return { success: false, error: '无效的文件路径。' };
  }
  if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) {
    return { success: false, error: `找不到文件: ${videoPath}` };
  }
  const ext = path.extname(videoPath).toLowerCase();
  if (!VALID_EXT.includes(ext)) {
    return { success: false, error: `不支持的格式 "${ext}"。支持: ${VALID_EXT.join(', ')}` };
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
    const cancelled = err && err.message === '已取消';
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
    return { success: false, error: '无效的图片数据。' };
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存为 PNG',
    defaultPath: `${defaultName || 'hdr-analysis'}.png`,
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
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
    return { success: false, error: '无效的分析数据。' };
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存为 HTML 报告',
    defaultPath: `${defaultName || 'hdr-analysis'}-hdr-report.html`,
    filters: [{ name: 'HTML 报告', extensions: ['html'] }],
  });
  if (result.canceled || !result.filePath) return { success: false, cancelled: true };

  try {
    fs.writeFileSync(result.filePath, buildReportHtml(analysisData));
    return { success: true, filePath: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
