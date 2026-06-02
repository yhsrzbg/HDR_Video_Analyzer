'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hdrAPI', {
  /**
   * Open a file dialog to select an HDR video file.
   * @returns {Promise<string|null>} File path or null if cancelled
   */
  selectVideo: () => ipcRenderer.invoke('select-video'),

  /**
   * Start HDR analysis on the selected video file.
   * @param {string} videoPath - Path to the video file
   * @returns {Promise<Object>} { success, imageData } or { success, error }
   */
  startAnalysis: (videoPath) => ipcRenderer.invoke('start-analysis', videoPath),

  /**
   * Save the generated chart image to disk.
   * @returns {Promise<Object>} { success, filePath } or { success, error }
   */
  saveImage: () => ipcRenderer.invoke('save-image'),

  /**
   * Register a callback for analysis progress updates.
   * Removes any previously registered listeners before adding the new one
   * to prevent listener accumulation on repeated calls.
   * @param {Function} callback - (data: { percent, time, peak }) => void
   */
  onAnalysisProgress: (callback) => {
    ipcRenderer.removeAllListeners('analysis-progress');
    ipcRenderer.on('analysis-progress', (event, data) => {
      callback(data);
    });
  },

  /**
   * Remove all analysis progress listeners.
   */
  removeProgressListeners: () => {
    ipcRenderer.removeAllListeners('analysis-progress');
  }
});
