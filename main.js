'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { analyzeVideo } = require('./analysis/hdr-analyzer');

let mainWindow = null;
let activeAnalysisWorker = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'HDR Video Analyzer'
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    // Kill any running analysis worker when the window closes
    if (activeAnalysisWorker) {
      activeAnalysisWorker.postMessage({ type: 'abort' });
      activeAnalysisWorker.terminate();
      activeAnalysisWorker = null;
    }
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// --- IPC Handlers ---

// Open file dialog for video selection
ipcMain.handle('select-video', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select HDR Video File',
    filters: [
      { name: 'Video Files', extensions: ['mkv', 'mp4', 'mov', 'ts'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// Start analysis
ipcMain.handle('start-analysis', async (event, videoPath) => {
  // Guard against starting a second analysis while one is running
  if (activeAnalysisWorker) {
    return { success: false, error: 'An analysis is already in progress. Please wait for it to finish.' };
  }

  try {
    const analysisPromise = analyzeVideo(videoPath, { useSubsample: true }, (percent, time, peak) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('analysis-progress', { percent, time, peak });
      }
    });

    // Store the worker reference for lifecycle management
    activeAnalysisWorker = analysisPromise.worker;

    const analysisData = await analysisPromise;

    // Clear the worker reference now that analysis is complete
    activeAnalysisWorker = null;

    return { success: true, analysisData: analysisData };
  } catch (err) {
    activeAnalysisWorker = null;
    return { success: false, error: err.message };
  }
});

// Save chart image
ipcMain.handle('save-image', async (event, dataUrl) => {
  if (!dataUrl) {
    return { success: false, error: 'No chart image to save' };
  }

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Chart Image',
    defaultPath: 'hdr-analysis.png',
    filters: [
      { name: 'PNG Image', extensions: ['png'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return { success: false, error: 'Save cancelled' };
  }

  try {
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(result.filePath, buffer);
    return { success: true, filePath: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
