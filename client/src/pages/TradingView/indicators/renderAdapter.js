import { LineSeries, HistogramSeries, PriceScaleMode } from 'lightweight-charts';
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

function getAdxRoles(params = {}) {
  const roles = [];
  if (params.showADX !== false) roles.push('adx');
  if (params.showDIPlus !== false) roles.push('pdi');
  if (params.showDIMinus !== false) roles.push('mdi');
  return roles;
}

function getSqzmomRoles(params = {}) {
  const roles = ['histogram', 'sqzDots'];
  if (params.showNormalUpper !== false) roles.push('normalUpper');
  if (params.showNormalMiddle === true) roles.push('normalMiddle');
  if (params.showNormalLower !== false) roles.push('normalLower');
  return roles;
}

// Mapa role → índice de serie por tipo de indicador.
// Se usa para resolver `getValuesAt(time)` correctamente: dado un role
// (e.g. 'macd'), sabemos qué `mount.series[idx]` lo dibuja y por tanto qué
// color usa. Para `adx`/`sqzmom` los roles activos varían según params,
// por eso se construye dinámicamente desde `mount.roles`.
function buildRoleMap(type, mountRoles) {
  switch (type) {
    case 'macd': return { macd: 0, signal: 1, histogram: 2 };
    case 'stoch': return { k: 0, d: 1 };
    case 'bollinger':
    case 'keltner': return { upper: 0, middle: 1, lower: 2 };
    case 'volume': return { volume: 0 };
    case 'rsi': return { line: 0, highLevel: 1, lowLevel: 2 };
    case 'adx': {
      const map = {};
      (mountRoles || ['adx', 'pdi', 'mdi']).forEach((r, i) => { map[r] = i; });
      return map;
    }
    case 'sqzmom': {
      const map = {};
      (mountRoles || ['histogram', 'sqzDots']).forEach((r, i) => { map[r] = i; });
      return map;
    }
    // sma / ema / wma / vwap / rsi / atr: única línea con role='line'.
    default: return { line: 0 };
  }
}

// Etiqueta legible para una sub-línea de un indicador, dada su role.
// Se usa en el legend overlay del chart.
function roleLabel(type, role) {
  if (type === 'macd') {
    if (role === 'macd') return 'MACD';
    if (role === 'signal') return 'Signal';
    if (role === 'histogram') return 'Hist';
  }
  if (type === 'stoch') {
    if (role === 'k') return '%K';
    if (role === 'd') return '%D';
  }
  if (type === 'bollinger' || type === 'keltner') {
    if (role === 'upper') return 'Up';
    if (role === 'middle') return 'Mid';
    if (role === 'lower') return 'Lo';
  }
  if (type === 'adx') {
    if (role === 'adx') return 'ADX';
    if (role === 'pdi') return '+DI';
    if (role === 'mdi') return '-DI';
  }
  if (type === 'sqzmom') {
    if (role === 'histogram') return 'Mom';
    if (role === 'sqzDots') return 'Sqz';
    if (role === 'normalUpper') return '+σ';
    if (role === 'normalLower') return '-σ';
    if (role === 'normalMiddle') return 'Media';
  }
  if (type === 'rsi') {
    if (role === 'line') return 'RSI';
    if (role === 'highLevel') return 'Alto';
    if (role === 'lowLevel') return 'Bajo';
  }
  return null;
}

// Crea las series de un indicador en el chart. Devuelve { series[], paneIndex }.
function createIndicatorSeries(chart, entry, paneIndex) {
  const meta = INDICATORS[entry.type];
  if (!meta) return null;
  const series = [];
  let roles = null;

  switch (entry.type) {
    case 'sma':
    case 'ema':
    case 'wma':
    case 'vwap':
      series.push(chart.addSeries(LineSeries, lineOpts(entry.style, { title: meta.label }), paneIndex));
      break;

    case 'rsi':
      series.push(chart.addSeries(LineSeries, lineOpts(entry.style, { title: 'RSI' }), paneIndex));
      series.push(chart.addSeries(LineSeries, lineOpts({ color: '#ef4444', lineWidth: 1, lineStyle: 'dashed' }, { title: 'RSI Alto' }), paneIndex));
      series.push(chart.addSeries(LineSeries, lineOpts({ color: '#22c55e', lineWidth: 1, lineStyle: 'dashed' }, { title: 'RSI Bajo' }), paneIndex));
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
      roles = getAdxRoles(entry.params);
      if (roles.includes('adx')) {
        series.push(chart.addSeries(LineSeries, lineOpts({ color: entry.style?.color || '#a3e635', lineWidth: 2 }, { title: 'ADX' }), paneIndex));
      }
      if (roles.includes('pdi')) {
        series.push(chart.addSeries(LineSeries, lineOpts({ color: '#22c55e', lineWidth: 1 }, { title: '+DI' }), paneIndex));
      }
      if (roles.includes('mdi')) {
        series.push(chart.addSeries(LineSeries, lineOpts({ color: '#ef4444', lineWidth: 1 }, { title: '-DI' }), paneIndex));
      }
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
      roles = getSqzmomRoles(entry.params);
      series.push(chart.addSeries(HistogramSeries, { priceFormat: { type: 'price', precision: 4, minMove: 0.0001 }, priceLineVisible: false, lastValueVisible: true, title: 'SQZMOM' }, paneIndex));
      series.push(chart.addSeries(LineSeries, { color: '#2962ff', lineWidth: 1, lastValueVisible: false, priceLineVisible: false }, paneIndex));
      if (roles.includes('normalUpper')) {
        series.push(chart.addSeries(LineSeries, lineOpts({ color: '#f59e0b', lineWidth: 1, lineStyle: 'dashed' }, { title: 'SQZMOM +σ' }), paneIndex));
      }
      if (roles.includes('normalMiddle')) {
        series.push(chart.addSeries(LineSeries, lineOpts({ color: '#94a3b8', lineWidth: 1, lineStyle: 'dotted' }, { title: 'SQZMOM Media' }), paneIndex));
      }
      if (roles.includes('normalLower')) {
        series.push(chart.addSeries(LineSeries, lineOpts({ color: '#f59e0b', lineWidth: 1, lineStyle: 'dashed' }, { title: 'SQZMOM -σ' }), paneIndex));
      }
      break;

    default:
      return null;
  }

  // Los sub-panes (osciladores: RSI, MACD, SQZMOM, etc.) siempre se visualizan
  // en escala Normal. Si el pane de precio está en log, los osciladores
  // heredarían esa escala al compartir priceScaleId y se deformarían.
  if (meta.pane === 'subpane' && series.length > 0) {
    try { series[0].priceScale().applyOptions({ mode: PriceScaleMode.Normal }); } catch { /* noop */ }
  }

  return { series, paneIndex, roles };
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

  if (entry.type === 'rsi') {
    s0?.setData(data.find((d) => d.role === 'line')?.data || []);
    s1?.setData(data.find((d) => d.role === 'highLevel')?.data || []);
    s2?.setData(data.find((d) => d.role === 'lowLevel')?.data || []);
    return;
  }

  if (entry.type === 'adx') {
    const roles = mountEntry.roles || ['adx', 'pdi', 'mdi'];
    roles.forEach((role, index) => {
      mountEntry.series[index]?.setData(data.find((d) => d.role === role)?.data || []);
    });
    return;
  }

  if (entry.type === 'bollinger' || entry.type === 'keltner') {
    s0?.setData(data.find((d) => d.role === 'upper')?.data || []);
    s1?.setData(data.find((d) => d.role === 'middle')?.data || []);
    s2?.setData(data.find((d) => d.role === 'lower')?.data || []);
    return;
  }

  if (entry.type === 'sqzmom') {
    const roles = mountEntry.roles || ['histogram', 'sqzDots'];
    roles.forEach((role, index) => {
      mountEntry.series[index]?.setData(data.find((d) => d.role === role)?.data || []);
    });
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
      const adxRolesChanged = entry.type === 'adx'
        && (m?.mount.roles || ['adx', 'pdi', 'mdi']).join('|') !== getAdxRoles(entry.params).join('|');
      const sqzmomRolesChanged = entry.type === 'sqzmom'
        && (m?.mount.roles || ['histogram', 'sqzDots']).join('|') !== getSqzmomRoles(entry.params).join('|');

      if (m && (m.entry.type !== entry.type || m.mount.paneIndex !== paneIndex || adxRolesChanged || sqzmomRolesChanged)) {
        removeUid(entry.uid);
        m = null;
      }

      if (!m) {
        const mount = createIndicatorSeries(chart, entry, paneIndex);
        if (!mount) continue;
        mount.roleMap = buildRoleMap(entry.type, mount.roles);
        mounted.set(entry.uid, { entry, mount, computed: null });
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
      if (computed && current) {
        applyDataToSeries(current.mount, computed, entry);
        // Cachear computed permite resolver getValuesAt(time) en O(n) sin
        // recomputar el indicador en cada movimiento del crosshair.
        current.computed = computed;
        // Indexar por time para lookup O(1). data viene en `time` segundos.
        const byTime = new Map();
        for (const s of computed.series) {
          for (const point of s.data) {
            let bucket = byTime.get(point.time);
            if (!bucket) { bucket = {}; byTime.set(point.time, bucket); }
            bucket[s.role] = point.value;
          }
        }
        current.byTime = byTime;
      }
    }

    const subpanesCount = nextSubpane - 1;
    cleanupExtraPanes(subpanesCount);
    setStretchFactors(subpanesCount);
  }

  // Devuelve los valores de cada indicador montado en el timestamp dado
  // (en segundos, formato lightweight-charts). Se usa para alimentar el
  // legend overlay del chart. Si una vela no tiene valor para un role
  // (ej. periodo de warmup), ese role se omite.
  function getValuesAt(timeSec) {
    const out = [];
    for (const [, m] of mounted) {
      const meta = INDICATORS[m.entry.type];
      if (!meta) continue;
      const bucket = m.byTime?.get(timeSec);
      if (!bucket) {
        out.push({
          uid: m.entry.uid,
          type: m.entry.type,
          label: meta.label,
          params: m.entry.params || {},
          pane: meta.pane,
          values: [],
        });
        continue;
      }
      const values = [];
      // Itera por roles conocidos del roleMap para preservar el orden visual
      // (el mismo de creación de series).
      const roleEntries = Object.entries(m.mount.roleMap || {});
      // Orden por índice de serie ascendente para consistencia.
      roleEntries.sort((a, b) => a[1] - b[1]);
      for (const [role, idx] of roleEntries) {
        const v = bucket[role];
        if (v == null || !Number.isFinite(v)) continue;
        const series = m.mount.series[idx];
        let color = '#cbd5e1';
        try {
          const opts = series?.options?.();
          color = opts?.color || color;
        } catch { /* noop */ }
        values.push({
          role,
          label: roleLabel(m.entry.type, role),
          value: v,
          color,
        });
      }
      out.push({
        uid: m.entry.uid,
        type: m.entry.type,
        label: meta.label,
        params: m.entry.params || {},
        pane: meta.pane,
        values,
      });
    }
    return out;
  }

  return { render, removeAll, getValuesAt };
}
