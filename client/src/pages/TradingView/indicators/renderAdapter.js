import { LineSeries, HistogramSeries } from 'lightweight-charts';
import { computeIndicator } from './computeAdapter';
import { INDICATORS } from './catalog';

const DASH_STYLE = { solid: 0, dotted: 1, dashed: 2 };

function lineOpts(style = {}, overrides = {}) {
  return {
    color: style.color || '#60a5fa',
    lineWidth: style.lineWidth || 2,
    lineStyle: DASH_STYLE[style.lineStyle] ?? 0,
    priceLineVisible: false,
    lastValueVisible: false,
    ...overrides,
  };
}

// Crea las series de un indicador en el chart. Devuelve { series[], paneIndex }.
function createIndicatorSeries(chart, entry, paneIndex) {
  const meta = INDICATORS[entry.type];
  if (!meta) return null;
  const series = [];

  switch (entry.type) {
    case 'sma':
    case 'ema':
    case 'wma':
    case 'vwap':
      series.push(chart.addSeries(LineSeries, lineOpts(entry.style, { title: meta.label }), paneIndex));
      break;

    case 'rsi':
      series.push(chart.addSeries(LineSeries, lineOpts(entry.style, { title: 'RSI' }), paneIndex));
      break;

    case 'atr':
      series.push(chart.addSeries(LineSeries, lineOpts(entry.style, { title: 'ATR' }), paneIndex));
      break;

    case 'macd':
      series.push(chart.addSeries(LineSeries, lineOpts({ color: entry.style?.color || '#60a5fa', lineWidth: 2 }, { title: 'MACD' }), paneIndex));
      series.push(chart.addSeries(LineSeries, lineOpts({ color: '#f59e0b', lineWidth: 2 }, { title: 'Signal' }), paneIndex));
      series.push(chart.addSeries(HistogramSeries, { priceFormat: { type: 'price', precision: 4, minMove: 0.0001 }, priceLineVisible: false, lastValueVisible: false, title: 'Hist' }, paneIndex));
      break;

    case 'stoch':
      series.push(chart.addSeries(LineSeries, lineOpts({ color: entry.style?.color || '#22d3ee', lineWidth: 2 }, { title: '%K' }), paneIndex));
      series.push(chart.addSeries(LineSeries, lineOpts({ color: '#f59e0b', lineWidth: 2 }, { title: '%D' }), paneIndex));
      break;

    case 'adx':
      series.push(chart.addSeries(LineSeries, lineOpts({ color: entry.style?.color || '#a3e635', lineWidth: 2 }, { title: 'ADX' }), paneIndex));
      series.push(chart.addSeries(LineSeries, lineOpts({ color: '#22c55e', lineWidth: 1 }, { title: '+DI' }), paneIndex));
      series.push(chart.addSeries(LineSeries, lineOpts({ color: '#ef4444', lineWidth: 1 }, { title: '-DI' }), paneIndex));
      break;

    case 'bollinger':
    case 'keltner':
      series.push(chart.addSeries(LineSeries, lineOpts({ color: entry.style?.color || '#a855f7', lineWidth: 1, lineStyle: entry.style?.lineStyle || 'solid' }, { title: `${meta.label} Up` }), paneIndex));
      series.push(chart.addSeries(LineSeries, lineOpts({ color: entry.style?.color || '#a855f7', lineWidth: 1, lineStyle: entry.style?.lineStyle || 'solid' }, { title: `${meta.label} Mid` }), paneIndex));
      series.push(chart.addSeries(LineSeries, lineOpts({ color: entry.style?.color || '#a855f7', lineWidth: 1, lineStyle: entry.style?.lineStyle || 'solid' }, { title: `${meta.label} Lo` }), paneIndex));
      break;

    case 'volume':
      series.push(chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false, title: 'Vol' }, paneIndex));
      break;

    case 'sqzmom':
      series.push(chart.addSeries(HistogramSeries, { priceFormat: { type: 'price', precision: 4, minMove: 0.0001 }, priceLineVisible: false, lastValueVisible: true, title: 'SQZMOM' }, paneIndex));
      series.push(chart.addSeries(LineSeries, { color: '#2962ff', lineWidth: 1, lastValueVisible: false, priceLineVisible: false }, paneIndex));
      break;

    default:
      return null;
  }

  return { series, paneIndex };
}

function applyDataToSeries(mountEntry, computed, entry) {
  if (!computed || !Array.isArray(computed.series)) return;
  const [s0, s1, s2] = mountEntry.series;
  const data = computed.series;

  // Para cada indicador, mapeamos datos por orden de creación.
  // El orden de addSeries en createIndicatorSeries debe coincidir con el
  // orden de `data` retornado por computeIndicator.
  if (entry.type === 'macd') {
    s0?.setData(data.find((d) => d.role === 'macd')?.data || []);
    s1?.setData(data.find((d) => d.role === 'signal')?.data || []);
    const hist = data.find((d) => d.role === 'histogram')?.data || [];
    const colored = hist.map((p) => ({ ...p, color: p.value >= 0 ? '#26a69a' : '#ef5350' }));
    s2?.setData(colored);
    return;
  }

  if (entry.type === 'stoch') {
    s0?.setData(data.find((d) => d.role === 'k')?.data || []);
    s1?.setData(data.find((d) => d.role === 'd')?.data || []);
    return;
  }

  if (entry.type === 'adx') {
    s0?.setData(data.find((d) => d.role === 'adx')?.data || []);
    s1?.setData(data.find((d) => d.role === 'pdi')?.data || []);
    s2?.setData(data.find((d) => d.role === 'mdi')?.data || []);
    return;
  }

  if (entry.type === 'bollinger' || entry.type === 'keltner') {
    s0?.setData(data.find((d) => d.role === 'upper')?.data || []);
    s1?.setData(data.find((d) => d.role === 'middle')?.data || []);
    s2?.setData(data.find((d) => d.role === 'lower')?.data || []);
    return;
  }

  if (entry.type === 'sqzmom') {
    s0?.setData(data.find((d) => d.role === 'histogram')?.data || []);
    s1?.setData(data.find((d) => d.role === 'sqzDots')?.data || []);
    return;
  }

  // Default: un solo array en data[0]
  s0?.setData(data[0]?.data || []);
}

// ------------------------------------------------------------------
// Controlador: gestiona el ciclo de vida de los indicadores activos.
// ------------------------------------------------------------------

export function createIndicatorsController(chart) {
  // Map<uid, { entry, mount: { series[], paneIndex } }>
  const mounted = new Map();

  function removeUid(uid) {
    const m = mounted.get(uid);
    if (!m) return;
    for (const s of m.mount.series) {
      try { chart.removeSeries(s); } catch { /* noop */ }
    }
    mounted.delete(uid);
  }

  function removeAll() {
    for (const uid of [...mounted.keys()]) removeUid(uid);
  }

  // Asigna pane index para sub-panes. Pane 0 = precio.
  // Los sub-panes se asignan en orden: 1, 2, 3, ... (hasta 3 sub-panes prácticos).
  function resolvePaneIndex(entry, subpaneCounter) {
    const meta = INDICATORS[entry.type];
    if (!meta) return 0;
    if (meta.pane === 'overlay') return 0;
    return subpaneCounter.next;
  }

  function setStretchFactors(subpanesCount) {
    try {
      const panes = chart.panes();
      if (!panes?.length) return;
      // Pane 0 más grande, sub-panes comparten el resto.
      panes[0]?.setStretchFactor?.(subpanesCount > 0 ? 0.65 : 1);
      for (let i = 1; i <= subpanesCount; i += 1) {
        panes[i]?.setStretchFactor?.(0.35 / subpanesCount);
      }
    } catch { /* API opcional */ }
  }

  // Elimina sub-panes vacíos que quedaron después de remover series.
  // Sin esto, lightweight-charts conserva el pane como área negra.
  function cleanupExtraPanes(subpanesCount) {
    try {
      const panes = chart.panes();
      const total = panes?.length || 0;
      const desired = 1 + subpanesCount; // pane 0 (precio) + sub-panes activos
      for (let i = total - 1; i >= desired; i -= 1) {
        chart.removePane(i);
      }
    } catch { /* API opcional */ }
  }

  function render(indicators, candles) {
    if (!chart) return;
    const visibleEntries = (indicators || []).filter((e) => e && e.visible !== false && INDICATORS[e.type]);
    const activeUids = new Set(visibleEntries.map((e) => e.uid));

    // Elimina los que ya no están activos
    for (const uid of [...mounted.keys()]) {
      if (!activeUids.has(uid)) removeUid(uid);
    }

    // Asigna panes: sub-panes en orden de aparición entre visibleEntries
    const subpaneIndexByUid = new Map();
    let nextSubpane = 1;
    for (const entry of visibleEntries) {
      if (INDICATORS[entry.type].pane === 'subpane') {
        subpaneIndexByUid.set(entry.uid, nextSubpane);
        nextSubpane += 1;
      }
    }

    // Crea los nuevos y actualiza existentes
    for (const entry of visibleEntries) {
      const paneIndex = INDICATORS[entry.type].pane === 'overlay' ? 0 : subpaneIndexByUid.get(entry.uid);
      let m = mounted.get(entry.uid);

      // Si cambió el tipo (raro) o el paneIndex, recreamos.
      if (m && (m.entry.type !== entry.type || m.mount.paneIndex !== paneIndex)) {
        removeUid(entry.uid);
        m = null;
      }

      if (!m) {
        const mount = createIndicatorSeries(chart, entry, paneIndex);
        if (!mount) continue;
        mounted.set(entry.uid, { entry, mount });
      } else {
        // Actualizar estilo si cambió (color, lineWidth)
        // Para simplicidad, aplicamos options solo a la primera línea.
        const meta = INDICATORS[entry.type];
        if (meta.pane === 'overlay' && entry.style) {
          try {
            m.mount.series[0]?.applyOptions({
              color: entry.style.color || m.entry.style?.color,
              lineWidth: entry.style.lineWidth || m.entry.style?.lineWidth,
              lineStyle: DASH_STYLE[entry.style.lineStyle] ?? DASH_STYLE[m.entry.style?.lineStyle] ?? 0,
            });
          } catch { /* noop */ }
        }
        m.entry = entry;
      }

      const computed = computeIndicator(entry.type, candles, entry.params);
      const current = mounted.get(entry.uid);
      if (computed && current) applyDataToSeries(current.mount, computed, entry);
    }

    const subpanesCount = nextSubpane - 1;
    cleanupExtraPanes(subpanesCount);
    setStretchFactors(subpanesCount);
  }

  return { render, removeAll };
}
