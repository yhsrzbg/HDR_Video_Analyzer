'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * Resolve the on-disk path of a dropped/selected File. Newer Electron removed
 * File.path in favor of webUtils.getPathForFile; support both.
 */
function pathForFile(file) {
  try {
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      return webUtils.getPathForFile(file);
    }
  } catch {
    /* fall through */
  }
  return file && file.path ? file.path : '';
}

contextBridge.exposeInMainWorld('hdrAPI', {
  getPathForFile: (file) => pathForFile(file),
  selectVideo: () => ipcRenderer.invoke('select-video'),
  startAnalysis: (videoPath, opts) => ipcRenderer.invoke('start-analysis', videoPath, opts),
  cancelAnalysis: () => ipcRenderer.invoke('cancel-analysis'),
  savePng: (dataUrl, defaultName) => ipcRenderer.invoke('save-png', dataUrl, defaultName),
  saveHtml: (analysisData, defaultName) => ipcRenderer.invoke('save-html', analysisData, defaultName),

  onProgress: (callback) => {
    ipcRenderer.removeAllListeners('analysis-progress');
    ipcRenderer.on('analysis-progress', (event, data) => callback(data));
  },
  offProgress: () => ipcRenderer.removeAllListeners('analysis-progress'),
});
