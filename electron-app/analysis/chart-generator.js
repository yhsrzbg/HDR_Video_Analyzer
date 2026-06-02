'use strict';

const { createCanvas } = require('canvas');
const { pqInverse } = require('./hdr-analyzer');

// Chart dimensions and layout
const CHART_WIDTH = 1400;
const CHART_HEIGHT = 1300;
const MARGIN = { top: 60, right: 60, bottom: 50, left: 80 };
const PANEL_GAP = 60;

// Colors
const COLORS = {
  background: '#FFFFFF',
  grid: 'rgba(0, 0, 0, 0.1)',
  peakLine: '#FF8C00',
  avgLine: '#1E90FF',
  rec709: '#BBBBBB',
  p3: '#F4D03F',
  rec2020: '#E74C3C',
  histogram: '#32CD32',
  text: '#333333',
  statsBox: 'rgba(255, 255, 255, 0.9)',
  statsBoxBorder: '#CCCCCC'
};

/**
 * Generate a 3-panel chart image from analysis results.
 * @param {Object} analysisData - { results, totalDuration, filename }
 * @returns {Buffer} PNG image buffer
 */
function generateChart(analysisData) {
  const { results, filename } = analysisData;
  const canvas = createCanvas(CHART_WIDTH, CHART_HEIGHT);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, CHART_WIDTH, CHART_HEIGHT);

  // Title
  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 14px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`HDR Analysis: ${filename}`, CHART_WIDTH / 2, 30);

  // Calculate panel dimensions
  const plotWidth = CHART_WIDTH - MARGIN.left - MARGIN.right;
  const totalPlotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom - PANEL_GAP * 2;
  const panelHeight = totalPlotHeight / 3;

  // Extract data arrays
  const times = results.map(r => r.time);
  const peaks = results.map(r => r.peak);
  const avgs = results.map(r => r.avg);
  const r709s = results.map(r => r.r709);
  const rp3s = results.map(r => r.rp3);
  const r2020s = results.map(r => r.r2020);

  const maxTime = Math.max(...times);

  // Panel 1: Brightness over time (PQ space)
  const panel1Y = MARGIN.top;
  drawBrightnessPanel(ctx, MARGIN.left, panel1Y, plotWidth, panelHeight, times, peaks, avgs, maxTime);

  // Panel 2: Gamut ratio stacked area
  const panel2Y = panel1Y + panelHeight + PANEL_GAP;
  drawGamutPanel(ctx, MARGIN.left, panel2Y, plotWidth, panelHeight, times, r709s, rp3s, r2020s, maxTime);

  // Panel 3: APL histogram
  const panel3Y = panel2Y + panelHeight + PANEL_GAP;
  drawAPLHistogramPanel(ctx, MARGIN.left, panel3Y, plotWidth, panelHeight, avgs);

  return canvas.toBuffer('image/png');
}

/**
 * Draw Panel 1: Brightness over time with PQ-space Y-axis
 */
function drawBrightnessPanel(ctx, x, y, width, height, times, peaks, avgs, maxTime) {
  const yTicks = [0, 0.1, 1, 10, 50, 100, 203, 500, 1000, 4000, 10000];

  // Draw panel border and grid
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, height);

  // Y-axis grid lines and labels
  ctx.font = '10px Arial, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.text;

  for (const tick of yTicks) {
    const pqVal = pqInverse(tick);
    const py = y + height - (pqVal * height);
    if (py >= y && py <= y + height) {
      ctx.beginPath();
      ctx.strokeStyle = COLORS.grid;
      ctx.moveTo(x, py);
      ctx.lineTo(x + width, py);
      ctx.stroke();
      ctx.fillText(tick.toString(), x - 5, py + 4);
    }
  }

  // Y-axis label
  ctx.save();
  ctx.translate(x - 55, y + height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.font = '12px Arial, sans-serif';
  ctx.fillText('Brightness (Nits)', 0, 0);
  ctx.restore();

  // Plot peak line
  ctx.beginPath();
  ctx.strokeStyle = COLORS.peakLine;
  ctx.lineWidth = 1;
  for (let i = 0; i < times.length; i++) {
    const px = x + (times[i] / maxTime) * width;
    const pqVal = pqInverse(peaks[i]);
    const py = y + height - (pqVal * height);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Plot avg line
  ctx.beginPath();
  ctx.strokeStyle = COLORS.avgLine;
  ctx.lineWidth = 1;
  for (let i = 0; i < times.length; i++) {
    const px = x + (times[i] / maxTime) * width;
    const pqVal = pqInverse(avgs[i]);
    const py = y + height - (pqVal * height);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Legend
  const legendX = x + width - 150;
  const legendY = y + 15;
  ctx.font = '11px Arial, sans-serif';
  ctx.textAlign = 'left';

  ctx.strokeStyle = COLORS.peakLine;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(legendX, legendY);
  ctx.lineTo(legendX + 20, legendY);
  ctx.stroke();
  ctx.fillStyle = COLORS.text;
  ctx.fillText('Peak (Nits)', legendX + 25, legendY + 4);

  ctx.strokeStyle = COLORS.avgLine;
  ctx.beginPath();
  ctx.moveTo(legendX, legendY + 18);
  ctx.lineTo(legendX + 20, legendY + 18);
  ctx.stroke();
  ctx.fillText('Avg (Nits)', legendX + 25, legendY + 22);

  // Stats box (bottom right)
  const maxCLL = Math.max(...peaks);
  const aveCLL = peaks.reduce((a, b) => a + b, 0) / peaks.length;
  const maxFALL = Math.max(...avgs);
  const aveFALL = avgs.reduce((a, b) => a + b, 0) / avgs.length;

  const statsLines = [
    `MaxCLL: ${Math.round(maxCLL)} nits`,
    `AveCLL: ${Math.round(aveCLL)} nits`,
    `MaxFALL: ${Math.round(maxFALL)} nits`,
    `AveFALL: ${Math.round(aveFALL)} nits`
  ];

  drawStatsBox(ctx, x + width - 10, y + height - 10, statsLines, 'right', 'bottom');
}

/**
 * Draw Panel 2: Color gamut ratio stacked area chart
 */
function drawGamutPanel(ctx, x, y, width, height, times, r709s, rp3s, r2020s, maxTime) {
  // Draw panel border
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, height);

  // Y-axis grid and labels
  ctx.font = '10px Arial, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.text;
  for (let tick = 0; tick <= 1; tick += 0.2) {
    const py = y + height - (tick * height);
    ctx.beginPath();
    ctx.strokeStyle = COLORS.grid;
    ctx.moveTo(x, py);
    ctx.lineTo(x + width, py);
    ctx.stroke();
    ctx.fillText(tick.toFixed(1), x - 5, py + 4);
  }

  // Y-axis label
  ctx.save();
  ctx.translate(x - 55, y + height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.font = '12px Arial, sans-serif';
  ctx.fillText('Gamut Ratio', 0, 0);
  ctx.restore();

  // X-axis label
  ctx.font = '12px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.text;
  ctx.fillText('Time (s)', x + width / 2, y + height + 18);

  // Draw stacked areas (bottom to top: 709, P3, 2020)
  const numPoints = times.length;
  if (numPoints < 2) return;

  // Rec.2020 layer (top) - from (709+p3) to (709+p3+2020)
  ctx.beginPath();
  ctx.moveTo(x, y + height);
  for (let i = 0; i < numPoints; i++) {
    const px = x + (times[i] / maxTime) * width;
    const stackVal = r709s[i] + rp3s[i] + r2020s[i];
    const py = y + height - (stackVal * height);
    ctx.lineTo(px, py);
  }
  for (let i = numPoints - 1; i >= 0; i--) {
    const px = x + (times[i] / maxTime) * width;
    const stackVal = r709s[i] + rp3s[i];
    const py = y + height - (stackVal * height);
    ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = COLORS.rec2020;
  ctx.fill();

  // P3 layer (middle) - from 709 to (709+p3)
  ctx.beginPath();
  ctx.moveTo(x, y + height);
  for (let i = 0; i < numPoints; i++) {
    const px = x + (times[i] / maxTime) * width;
    const stackVal = r709s[i] + rp3s[i];
    const py = y + height - (stackVal * height);
    ctx.lineTo(px, py);
  }
  for (let i = numPoints - 1; i >= 0; i--) {
    const px = x + (times[i] / maxTime) * width;
    const py = y + height - (r709s[i] * height);
    ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = COLORS.p3;
  ctx.fill();

  // Rec.709 layer (bottom)
  ctx.beginPath();
  ctx.moveTo(x, y + height);
  for (let i = 0; i < numPoints; i++) {
    const px = x + (times[i] / maxTime) * width;
    const py = y + height - (r709s[i] * height);
    ctx.lineTo(px, py);
  }
  ctx.lineTo(x + (times[numPoints - 1] / maxTime) * width, y + height);
  ctx.closePath();
  ctx.fillStyle = COLORS.rec709;
  ctx.fill();

  // Legend
  const legendX = x + 10;
  const legendY = y + height - 10;
  ctx.font = '11px Arial, sans-serif';
  ctx.textAlign = 'left';

  // Rec.709
  ctx.fillStyle = COLORS.rec709;
  ctx.fillRect(legendX, legendY - 36, 12, 12);
  ctx.fillStyle = COLORS.text;
  ctx.fillText('Rec.709', legendX + 16, legendY - 26);

  // P3
  ctx.fillStyle = COLORS.p3;
  ctx.fillRect(legendX, legendY - 22, 12, 12);
  ctx.fillStyle = COLORS.text;
  ctx.fillText('P3 (outside 709)', legendX + 16, legendY - 12);

  // Rec.2020
  ctx.fillStyle = COLORS.rec2020;
  ctx.fillRect(legendX, legendY - 8, 12, 12);
  ctx.fillStyle = COLORS.text;
  ctx.fillText('Rec.2020 (outside P3)', legendX + 16, legendY + 2);
}

/**
 * Draw Panel 3: APL histogram
 */
function drawAPLHistogramPanel(ctx, x, y, width, height, avgs) {
  // Calculate APL values: pqInverse(avg_nits) * 100
  const aplData = avgs.map(avg => pqInverse(avg) * 100.0);

  // Build histogram (100 bins, range 0-100)
  const numBins = 100;
  const bins = new Array(numBins).fill(0);
  for (const apl of aplData) {
    const binIdx = Math.min(Math.floor(apl), numBins - 1);
    if (binIdx >= 0) {
      bins[binIdx]++;
    }
  }
  const maxBinCount = Math.max(...bins, 1);

  // Draw panel border
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, height);

  // Y-axis grid and labels
  ctx.font = '10px Arial, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.text;
  const yTickCount = 5;
  for (let i = 0; i <= yTickCount; i++) {
    const val = (maxBinCount / yTickCount) * i;
    const py = y + height - (i / yTickCount) * height;
    ctx.beginPath();
    ctx.strokeStyle = COLORS.grid;
    ctx.moveTo(x, py);
    ctx.lineTo(x + width, py);
    ctx.stroke();
    ctx.fillText(Math.round(val).toString(), x - 5, py + 4);
  }

  // Y-axis label
  ctx.save();
  ctx.translate(x - 55, y + height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.font = '12px Arial, sans-serif';
  ctx.fillText('Frame Count', 0, 0);
  ctx.restore();

  // X-axis label
  ctx.font = '12px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.text;
  ctx.fillText('APL (%)', x + width / 2, y + height + 18);

  // X-axis tick labels
  ctx.font = '10px Arial, sans-serif';
  for (let tick = 0; tick <= 100; tick += 20) {
    const px = x + (tick / 100) * width;
    ctx.fillText(tick.toString(), px, y + height + 14);
  }

  // Draw histogram bars
  const barWidth = width / numBins;
  ctx.fillStyle = COLORS.histogram;
  ctx.globalAlpha = 0.7;
  for (let i = 0; i < numBins; i++) {
    if (bins[i] > 0) {
      const barHeight = (bins[i] / maxBinCount) * height;
      const bx = x + i * barWidth;
      const by = y + height - barHeight;
      ctx.fillRect(bx, by, barWidth - 0.5, barHeight);
    }
  }
  ctx.globalAlpha = 1.0;

  // Bar borders
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = 0.5;
  for (let i = 0; i < numBins; i++) {
    if (bins[i] > 0) {
      const barHeight = (bins[i] / maxBinCount) * height;
      const bx = x + i * barWidth;
      const by = y + height - barHeight;
      ctx.strokeRect(bx, by, barWidth - 0.5, barHeight);
    }
  }

  // Stats box (bottom right)
  const meanAPL = aplData.reduce((a, b) => a + b, 0) / aplData.length;
  const sortedAPL = [...aplData].sort((a, b) => a - b);
  const medianAPL = sortedAPL.length % 2 === 0
    ? (sortedAPL[sortedAPL.length / 2 - 1] + sortedAPL[sortedAPL.length / 2]) / 2
    : sortedAPL[Math.floor(sortedAPL.length / 2)];

  const statsLines = [
    `Average APL: ${meanAPL.toFixed(2)}%`,
    `Median APL: ${medianAPL.toFixed(2)}%`
  ];

  drawStatsBox(ctx, x + width - 10, y + height - 10, statsLines, 'right', 'bottom');
}

/**
 * Draw a stats text box
 */
function drawStatsBox(ctx, anchorX, anchorY, lines, hAlign, vAlign) {
  ctx.font = '11px Arial, sans-serif';
  const lineHeight = 16;
  const padding = 8;
  const maxWidth = Math.max(...lines.map(l => ctx.measureText(l).width));
  const boxWidth = maxWidth + padding * 2;
  const boxHeight = lines.length * lineHeight + padding * 2;

  let bx = hAlign === 'right' ? anchorX - boxWidth : anchorX;
  let by = vAlign === 'bottom' ? anchorY - boxHeight : anchorY;

  // Box background
  ctx.fillStyle = COLORS.statsBox;
  ctx.strokeStyle = COLORS.statsBoxBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  roundRect(ctx, bx, by, boxWidth, boxHeight, 4);
  ctx.fill();
  ctx.stroke();

  // Text
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'left';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], bx + padding, by + padding + (i + 1) * lineHeight - 4);
  }
}

/**
 * Draw a rounded rectangle path
 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

module.exports = { generateChart };
