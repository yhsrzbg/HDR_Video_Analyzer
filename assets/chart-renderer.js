'use strict';

(function() {
  const m1 = 2610 / 16384;
  const m2 = (2523 / 4096) * 128;
  const c1 = 3424 / 4096;
  const c2 = (2413 / 4096) * 32;
  const c3 = (2392 / 4096) * 32;

  const COLORS = {
    peak: '#FF8C00',
    avg: '#1E90FF',
    rec709: '#AEB6C2',
    p3: '#F4D03F',
    rec2020: '#E74C3C',
    histogram: '#32CD78',
    text: '#263247',
    muted: '#6B7890',
    grid: '#DCE2EA',
    panel: '#FFFFFF',
  };

  function pqInverse(nits) {
    if (!Number.isFinite(nits) || nits <= 0) return 0;
    const y = Math.min(nits / 10000, 1);
    const v = Math.pow(y, m1);
    return Math.pow((c1 + c2 * v) / (1 + c3 * v), m2);
  }

  function pqToNits(signal) {
    if (!Number.isFinite(signal) || signal <= 0) return 0;
    const p = Math.pow(Math.min(signal, 1), 1 / m2);
    const numerator = Math.max(p - c1, 0);
    const denominator = c2 - c3 * p;
    if (denominator <= 0) return 10000;
    return 10000 * Math.pow(numerator / denominator, 1 / m1);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function formatTime(seconds) {
    const safe = Math.max(0, finite(seconds, 0));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const secs = Math.floor(safe % 60);
    const millis = Math.round((safe - Math.floor(safe)) * 1000);
    const prefix = hours > 0 ? String(hours).padStart(2, '0') + ':' : '';
    return prefix +
      String(minutes).padStart(2, '0') + ':' +
      String(secs).padStart(2, '0') + '.' +
      String(millis).padStart(3, '0');
  }

  function formatAxisTime(seconds) {
    const safe = Math.max(0, finite(seconds, 0));
    if (safe >= 3600) {
      const hours = Math.floor(safe / 3600);
      const minutes = Math.floor((safe % 3600) / 60);
      return hours + ':' + String(minutes).padStart(2, '0') + 'h';
    }
    if (safe >= 60) {
      const minutes = Math.floor(safe / 60);
      const secs = Math.floor(safe % 60);
      return minutes + ':' + String(secs).padStart(2, '0');
    }
    return safe < 10 ? safe.toFixed(1) + 's' : Math.round(safe) + 's';
  }

  function formatNits(value) {
    if (value < 1) return value.toFixed(2);
    if (value < 10) return value.toFixed(1);
    return Math.round(value).toLocaleString();
  }

  function normalizeData(analysisData) {
    const source = analysisData && Array.isArray(analysisData.results)
      ? analysisData.results
      : [];
    return source.map((item, index) => ({
      index,
      time: Math.max(0, finite(item && item.time, index)),
      peak: Math.max(0, finite(item && item.peak, 0)),
      avg: Math.max(0, finite(item && item.avg, 0)),
      r709: Math.max(0, finite(item && item.r709, 0)),
      rp3: Math.max(0, finite(item && item.rp3, 0)),
      r2020: Math.max(0, finite(item && item.r2020, 0)),
    })).sort((a, b) => a.time - b.time);
  }

  function nearestPoint(points, time) {
    if (!points.length) return null;
    let low = 0;
    let high = points.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (points[middle].time < time) low = middle + 1;
      else high = middle;
    }
    if (low === 0) return points[0];
    const before = points[low - 1];
    const after = points[low];
    return Math.abs(before.time - time) <= Math.abs(after.time - time) ? before : after;
  }

  function buildHistogram(points) {
    const bins = new Array(100).fill(0);
    for (const point of points) {
      const apl = Math.max(0, Math.min(100, pqInverse(point.avg) * 100));
      bins[Math.min(99, Math.floor(apl))]++;
    }
    const total = points.length || 1;
    return bins.map((count, index) => [index + 0.5, count, count / total]);
  }

  function calculateStats(points) {
    if (!points.length) {
      return {
        maxCLL: 0,
        aveCLL: 0,
        maxFALL: 0,
        aveFALL: 0,
        meanAPL: 0,
        medianAPL: 0,
      };
    }
    const peaks = points.map(point => point.peak);
    const avgs = points.map(point => point.avg);
    const apl = avgs.map(value => pqInverse(value) * 100).sort((a, b) => a - b);
    const middle = Math.floor(apl.length / 2);
    const medianAPL = apl.length % 2
      ? apl[middle]
      : (apl[middle - 1] + apl[middle]) / 2;
    return {
      maxCLL: peaks.reduce((max, value) => Math.max(max, value), 0),
      aveCLL: peaks.reduce((sum, value) => sum + value, 0) / peaks.length,
      maxFALL: avgs.reduce((max, value) => Math.max(max, value), 0),
      aveFALL: avgs.reduce((sum, value) => sum + value, 0) / avgs.length,
      meanAPL: apl.reduce((sum, value) => sum + value, 0) / apl.length,
      medianAPL,
    };
  }

  function tooltipRow(color, label, value) {
    return '<div class="hdr-tooltip-row">' +
      '<span><i style="background:' + color + '"></i>' + escapeHtml(label) + '</span>' +
      '<strong>' + escapeHtml(value) + '</strong>' +
      '</div>';
  }

  function buildTooltipFormatter(points) {
    return function(params) {
      const list = Array.isArray(params) ? params : [params];
      const first = list[0];
      if (!first) return '';

      if (first.seriesName === 'APL distribution') {
        const bin = first.data || [0, 0, 0];
        const start = Math.max(0, Math.floor(finite(bin[0], 0) - 0.5));
        return '<div class="hdr-tooltip">' +
          '<div class="hdr-tooltip-title">APL ' + start + '%–' + (start + 1) + '%</div>' +
          tooltipRow(COLORS.histogram, 'Samples', String(finite(bin[1], 0))) +
          tooltipRow(COLORS.histogram, 'Share', (finite(bin[2], 0) * 100).toFixed(2) + '%') +
          '</div>';
      }

      const data = first.data;
      const time = Array.isArray(data) ? finite(data[0], 0) : finite(first.axisValue, 0);
      const point = nearestPoint(points, time);
      if (!point) return '';
      return '<div class="hdr-tooltip">' +
        '<div class="hdr-tooltip-title">' + formatTime(point.time) +
          ' <span>Sample #' + (point.index + 1) + '</span></div>' +
        tooltipRow(COLORS.peak, 'Peak', formatNits(point.peak) + ' nits') +
        tooltipRow(COLORS.avg, 'Average', formatNits(point.avg) + ' nits') +
        tooltipRow(COLORS.rec709, 'Rec.709', (point.r709 * 100).toFixed(2) + '%') +
        tooltipRow(COLORS.p3, 'P3 outside 709', (point.rp3 * 100).toFixed(2) + '%') +
        tooltipRow(COLORS.rec2020, 'Rec.2020 outside P3', (point.r2020 * 100).toFixed(2) + '%') +
        '</div>';
    };
  }

  function lineSeries(name, color, data, xAxisIndex, yAxisIndex, extra) {
    return Object.assign({
      name,
      type: 'line',
      xAxisIndex,
      yAxisIndex,
      data,
      showSymbol: data.length <= 1,
      symbol: 'circle',
      symbolSize: 7,
      sampling: 'lttb',
      animation: false,
      connectNulls: true,
      lineStyle: { color, width: 1.5 },
      itemStyle: { color },
      emphasis: { focus: 'series' },
    }, extra || {});
  }

  function buildOption(analysisData, points, exporting) {
    const histogram = buildHistogram(points);
    const stats = calculateStats(points);
    const times = points.map(point => point.time);
    const maxTime = times.reduce(
      (max, value) => Math.max(max, value),
      Math.max(finite(analysisData && analysisData.totalDuration, 0), 1)
    );
    const fileName = analysisData && analysisData.filename ? analysisData.filename : 'HDR analysis';
    const bottom = exporting ? 78 : 92;

    return {
      animation: false,
      backgroundColor: COLORS.panel,
      textStyle: {
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
        color: COLORS.text,
      },
      title: [
        {
          text: 'HDR Analysis: ' + fileName,
          left: 'center',
          top: 10,
          textStyle: { fontSize: 16, fontWeight: 700, color: COLORS.text },
        },
        {
          text: 'Brightness over time',
          left: 72,
          top: 54,
          textStyle: { fontSize: 13, fontWeight: 600, color: COLORS.text },
        },
        {
          text: 'Color gamut over time',
          left: 72,
          top: '39%',
          textStyle: { fontSize: 13, fontWeight: 600, color: COLORS.text },
        },
        {
          text: 'APL distribution',
          left: 72,
          top: '69%',
          textStyle: { fontSize: 13, fontWeight: 600, color: COLORS.text },
        },
      ],
      tooltip: {
        trigger: 'axis',
        triggerOn: 'mousemove|click',
        confine: true,
        enterable: false,
        backgroundColor: 'rgba(18, 27, 52, 0.96)',
        borderColor: '#32466F',
        borderWidth: 1,
        padding: 0,
        textStyle: { color: '#EEF3FF', fontSize: 12 },
        axisPointer: {
          type: 'cross',
          snap: true,
          lineStyle: { color: '#667A9E', type: 'dashed' },
          crossStyle: { color: '#667A9E', type: 'dashed' },
          label: {
            backgroundColor: '#334568',
            formatter: function(params) {
              return params.axisDimension === 'x'
                ? formatTime(params.value)
                : String(params.value);
            },
          },
        },
        formatter: buildTooltipFormatter(points),
      },
      axisPointer: {
        link: [{ xAxisIndex: [0, 1] }],
      },
      legend: [
        {
          top: 52,
          right: 55,
          data: ['Peak', 'Average'],
          textStyle: { color: COLORS.muted },
        },
        {
          top: '39%',
          right: 55,
          data: ['Rec.709', 'P3 outside 709', 'Rec.2020 outside P3'],
          textStyle: { color: COLORS.muted },
        },
      ],
      grid: [
        { left: 72, right: 72, top: 88, height: '24%', containLabel: true },
        { left: 72, right: 72, top: '43%', height: '20%', containLabel: true },
        { left: 72, right: 72, top: '73%', bottom, containLabel: true },
      ],
      xAxis: [
        {
          id: 'brightness-time',
          type: 'value',
          gridIndex: 0,
          min: 0,
          max: maxTime,
          axisLabel: { formatter: formatAxisTime, color: COLORS.muted },
          axisLine: { lineStyle: { color: '#AEB8C8' } },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: COLORS.grid } },
        },
        {
          id: 'gamut-time',
          type: 'value',
          gridIndex: 1,
          min: 0,
          max: maxTime,
          name: 'Time',
          nameLocation: 'middle',
          nameGap: 28,
          axisLabel: { formatter: formatAxisTime, color: COLORS.muted },
          axisLine: { lineStyle: { color: '#AEB8C8' } },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: COLORS.grid } },
        },
        {
          id: 'apl',
          type: 'value',
          gridIndex: 2,
          min: 0,
          max: 100,
          name: 'APL (%)',
          nameLocation: 'middle',
          nameGap: 28,
          axisLabel: { color: COLORS.muted },
          axisLine: { lineStyle: { color: '#AEB8C8' } },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: COLORS.grid } },
        },
      ],
      yAxis: [
        {
          id: 'brightness',
          type: 'value',
          gridIndex: 0,
          min: 0,
          max: 1,
          name: 'Brightness (nits, PQ scale)',
          nameLocation: 'middle',
          nameGap: 54,
          axisLabel: {
            color: COLORS.muted,
            formatter: value => formatNits(pqToNits(value)),
          },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: COLORS.grid } },
        },
        {
          id: 'gamut',
          type: 'value',
          gridIndex: 1,
          min: 0,
          max: 100,
          interval: 20,
          name: 'Gamut ratio',
          nameLocation: 'middle',
          nameGap: 46,
          axisLabel: { formatter: value => value + '%', color: COLORS.muted },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: COLORS.grid } },
        },
        {
          id: 'frames',
          type: 'value',
          gridIndex: 2,
          minInterval: 1,
          name: 'Sample count',
          nameLocation: 'middle',
          nameGap: 46,
          axisLabel: { color: COLORS.muted },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: COLORS.grid } },
        },
      ],
      dataZoom: exporting ? [] : [
        {
          id: 'time-slider',
          type: 'slider',
          xAxisIndex: [0, 1],
          bottom: 42,
          left: 92,
          right: 92,
          height: 20,
          filterMode: 'none',
          showDetail: true,
          labelFormatter: value => formatTime(value),
          brushSelect: false,
        },
        {
          id: 'time-inside',
          type: 'inside',
          xAxisIndex: [0, 1],
          filterMode: 'none',
          zoomOnMouseWheel: true,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
        },
        {
          id: 'brightness-slider',
          type: 'slider',
          yAxisIndex: 0,
          orient: 'vertical',
          right: 15,
          top: 88,
          height: '24%',
          width: 18,
          filterMode: 'none',
          showDetail: true,
          labelFormatter: value => formatNits(pqToNits(value)),
          brushSelect: false,
        },
        {
          id: 'apl-inside',
          type: 'inside',
          xAxisIndex: 2,
          filterMode: 'none',
          zoomOnMouseWheel: true,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
        },
      ],
      graphic: [
        {
          type: 'text',
          right: 84,
          top: 83,
          silent: true,
          style: {
            text: [
              'MaxCLL  ' + Math.round(stats.maxCLL) + ' nits',
              'AveCLL  ' + Math.round(stats.aveCLL) + ' nits',
              'MaxFALL ' + Math.round(stats.maxFALL) + ' nits',
              'AveFALL ' + Math.round(stats.aveFALL) + ' nits',
            ].join('\n'),
            font: '11px Arial',
            lineHeight: 17,
            fill: COLORS.text,
            backgroundColor: 'rgba(255,255,255,0.9)',
            borderColor: '#D6DCE5',
            borderWidth: 1,
            borderRadius: 4,
            padding: [7, 9],
          },
        },
        {
          type: 'text',
          right: 84,
          top: '73%',
          silent: true,
          style: {
            text: 'Average APL  ' + stats.meanAPL.toFixed(2) + '%\n' +
              'Median APL   ' + stats.medianAPL.toFixed(2) + '%',
            font: '11px Arial',
            lineHeight: 17,
            fill: COLORS.text,
            backgroundColor: 'rgba(255,255,255,0.9)',
            borderColor: '#D6DCE5',
            borderWidth: 1,
            borderRadius: 4,
            padding: [7, 9],
          },
        },
      ],
      series: [
        lineSeries(
          'Peak',
          COLORS.peak,
          points.map(point => [point.time, pqInverse(point.peak), point.peak]),
          0,
          0
        ),
        lineSeries(
          'Average',
          COLORS.avg,
          points.map(point => [point.time, pqInverse(point.avg), point.avg]),
          0,
          0
        ),
        lineSeries(
          'Rec.709',
          COLORS.rec709,
          points.map(point => [point.time, point.r709 * 100]),
          1,
          1,
          {
            stack: 'gamut',
            lineStyle: { width: 0 },
            areaStyle: { color: COLORS.rec709, opacity: 0.9 },
          }
        ),
        lineSeries(
          'P3 outside 709',
          COLORS.p3,
          points.map(point => [point.time, point.rp3 * 100]),
          1,
          1,
          {
            stack: 'gamut',
            lineStyle: { width: 0 },
            areaStyle: { color: COLORS.p3, opacity: 0.9 },
          }
        ),
        lineSeries(
          'Rec.2020 outside P3',
          COLORS.rec2020,
          points.map(point => [point.time, point.r2020 * 100]),
          1,
          1,
          {
            stack: 'gamut',
            lineStyle: { width: 0 },
            areaStyle: { color: COLORS.rec2020, opacity: 0.9 },
          }
        ),
        {
          name: 'APL distribution',
          type: 'bar',
          xAxisIndex: 2,
          yAxisIndex: 2,
          data: histogram,
          encode: { x: 0, y: 1 },
          animation: false,
          barWidth: '95%',
          itemStyle: {
            color: COLORS.histogram,
            opacity: 0.78,
            borderColor: '#FFFFFF',
            borderWidth: 0.5,
          },
          emphasis: { itemStyle: { opacity: 1 } },
        },
      ],
    };
  }

  function createExportDataUrl(analysisData, points) {
    const host = document.createElement('div');
    host.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1400px;height:1300px;background:#fff;';
    document.body.appendChild(host);
    const exportChart = window.echarts.init(host, null, {
      renderer: 'canvas',
      width: 1400,
      height: 1300,
      devicePixelRatio: 1,
    });
    exportChart.setOption(buildOption(analysisData, points, true));
    const dataUrl = exportChart.getDataURL({
      type: 'png',
      pixelRatio: 1,
      backgroundColor: '#FFFFFF',
      excludeComponents: ['toolbox'],
    });
    exportChart.dispose();
    host.remove();
    return dataUrl;
  }

  function createHdrChart(container, analysisData) {
    if (!window.echarts) throw new Error('ECharts is not loaded.');
    const existing = window.echarts.getInstanceByDom(container);
    if (existing) existing.dispose();

    const points = normalizeData(analysisData);
    const chart = window.echarts.init(container, null, { renderer: 'canvas' });
    chart.setOption(buildOption(analysisData, points, false));

    return {
      resize: () => chart.resize(),
      dispose: () => chart.dispose(),
      reset: () => chart.dispatchAction({ type: 'restore' }),
      showAll: () => chart.dispatchAction({ type: 'legendAllSelect' }),
      setMode: mode => {
        chart.dispatchAction({
          type: 'takeGlobalCursor',
          key: 'dataZoomSelect',
          dataZoomSelectActive: mode === 'zoom',
        });
      },
      getPngDataUrl: () => createExportDataUrl(analysisData, points),
      getChart: () => chart,
    };
  }

  window.createHdrChart = createHdrChart;
})();
