'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { analyzeVideo } = require('./analysis/hdr-analyzer');
const { generateChart } = require('./analysis/chart-generator');

let mainWindow = null;
let lastChartBuffer = null;

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
  try {
    const analysisData = await analyzeVideo(videoPath, { useSubsample: true }, (percent, time, peak) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('analysis-progress', { percent, time, peak });
      }
    });

    // Generate chart
    const chartBuffer = generateChart(analysisData);
    lastChartBuffer = chartBuffer;

    // Convert to base64 for display in renderer
    const base64 = chartBuffer.toString('base64');
    return { success: true, imageData: `data:image/png;base64,${base64}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Save chart image
ipcMain.handle('save-image', async () => {
  if (!lastChartBuffer) {
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
    fs.writeFileSync(result.filePath, lastChartBuffer);
    return { success: true, filePath: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
