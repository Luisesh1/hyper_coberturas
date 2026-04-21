// Catálogo de indicadores disponibles para la gráfica de TradingView.
// Cada entrada describe metadatos UI + defaults; el cómputo y renderizado
// se resuelve por `type` en computeAdapter.js y renderAdapter.js.

export const INDICATOR_CATEGORIES = {
  overlay: 'Sobre el precio',
  momentum: 'Momentum',
  volatility: 'Volatilidad',
  trend: 'Tendencia',
  volume: 'Volumen',
  other: 'Otros',
};

export const INDICATORS = {
  // -------------------- Overlays sobre el precio --------------------
  sma: {
    id: 'sma',
    label: 'SMA',
    fullName: 'Simple Moving Average',
    category: 'overlay',
    pane: 'overlay',
    defaultParams: { length: 20 },
    paramSchema: [
      { key: 'length', type: 'number', label: 'Periodo', min: 2, max: 500, step: 1 },
    ],
    defaultStyle: { color: '#60a5fa', lineWidth: 2, lineStyle: 'solid' },
  },
  ema: {
    id: 'ema',
    label: 'EMA',
    fullName: 'Exponential Moving Average',
    category: 'overlay',
    pane: 'overlay',
    defaultParams: { length: 20 },
    paramSchema: [
      { key: 'length', type: 'number', label: 'Periodo', min: 2, max: 500, step: 1 },
    ],
    defaultStyle: { color: '#f59e0b', lineWidth: 2, lineStyle: 'solid' },
  },
  wma: {
    id: 'wma',
    label: 'WMA',
    fullName: 'Weighted Moving Average',
    category: 'overlay',
    pane: 'overlay',
    defaultParams: { length: 20 },
    paramSchema: [
      { key: 'length', type: 'number', label: 'Periodo', min: 2, max: 500, step: 1 },
    ],
    defaultStyle: { color: '#34d399', lineWidth: 2, lineStyle: 'solid' },
  },
  bollinger: {
    id: 'bollinger',
    label: 'Bollinger Bands',
    fullName: 'Bollinger Bands',
    category: 'volatility',
    pane: 'overlay',
    defaultParams: { length: 20, stdDev: 2 },
    paramSchema: [
      { key: 'length', type: 'number', label: 'Periodo', min: 2, max: 500, step: 1 },
      { key: 'stdDev', type: 'number', label: 'Desv. estándar', min: 0.5, max: 5, step: 0.1 },
    ],
    defaultStyle: { color: '#a855f7', lineWidth: 1, lineStyle: 'solid' },
  },
  keltner: {
    id: 'keltner',
    label: 'Keltner',
    fullName: 'Keltner Channel',
    category: 'volatility',
    pane: 'overlay',
    defaultParams: { length: 20, atrLength: 10, multiplier: 1.5 },
    paramSchema: [
      { key: 'length', type: 'number', label: 'EMA periodo', min: 2, max: 500, step: 1 },
      { key: 'atrLength', type: 'number', label: 'ATR periodo', min: 2, max: 500, step: 1 },
      { key: 'multiplier', type: 'number', label: 'Multiplicador', min: 0.5, max: 5, step: 0.1 },
    ],
    defaultStyle: { color: '#06b6d4', lineWidth: 1, lineStyle: 'dashed' },
  },
  vwap: {
    id: 'vwap',
    label: 'VWAP',
    fullName: 'Volume Weighted Average Price',
    category: 'overlay',
    pane: 'overlay',
    defaultParams: {},
    paramSchema: [],
    defaultStyle: { color: '#facc15', lineWidth: 2, lineStyle: 'solid' },
  },

  // -------------------- Sub-panes --------------------
  rsi: {
    id: 'rsi',
    label: 'RSI',
    fullName: 'Relative Strength Index',
    category: 'momentum',
    pane: 'subpane',
    defaultParams: { length: 14 },
    paramSchema: [
      { key: 'length', type: 'number', label: 'Periodo', min: 2, max: 200, step: 1 },
    ],
    defaultStyle: { color: '#f97316', lineWidth: 2, lineStyle: 'solid' },
    levels: [30, 70], // líneas horizontales de referencia
  },
  macd: {
    id: 'macd',
    label: 'MACD',
    fullName: 'Moving Average Convergence Divergence',
    category: 'momentum',
    pane: 'subpane',
    defaultParams: { fast: 12, slow: 26, signal: 9 },
    paramSchema: [
      { key: 'fast', type: 'number', label: 'Rápida', min: 2, max: 100, step: 1 },
      { key: 'slow', type: 'number', label: 'Lenta', min: 2, max: 200, step: 1 },
      { key: 'signal', type: 'number', label: 'Señal', min: 2, max: 100, step: 1 },
    ],
    defaultStyle: { color: '#60a5fa', lineWidth: 2 },
  },
  stoch: {
    id: 'stoch',
    label: 'Stochastic',
    fullName: 'Stochastic Oscillator',
    category: 'momentum',
    pane: 'subpane',
    defaultParams: { kLength: 14, dLength: 3, smooth: 3 },
    paramSchema: [
      { key: 'kLength', type: 'number', label: '%K periodo', min: 2, max: 100, step: 1 },
      { key: 'dLength', type: 'number', label: '%D periodo', min: 1, max: 50, step: 1 },
      { key: 'smooth', type: 'number', label: 'Suavizado', min: 1, max: 10, step: 1 },
    ],
    defaultStyle: { color: '#22d3ee', lineWidth: 2 },
    levels: [20, 80],
  },
  atr: {
    id: 'atr',
    label: 'ATR',
    fullName: 'Average True Range',
    category: 'volatility',
    pane: 'subpane',
    defaultParams: { length: 14 },
    paramSchema: [
      { key: 'length', type: 'number', label: 'Periodo', min: 2, max: 200, step: 1 },
    ],
    defaultStyle: { color: '#f472b6', lineWidth: 2, lineStyle: 'solid' },
  },
  adx: {
    id: 'adx',
    label: 'ADX + DMI',
    fullName: 'Average Directional Index',
    category: 'trend',
    pane: 'subpane',
    defaultParams: { length: 14 },
    paramSchema: [
      { key: 'length', type: 'number', label: 'Periodo', min: 2, max: 100, step: 1 },
    ],
    defaultStyle: { color: '#a3e635', lineWidth: 2 },
    levels: [20, 40],
  },
  volume: {
    id: 'volume',
    label: 'Volumen',
    fullName: 'Volume',
    category: 'volume',
    pane: 'subpane',
    defaultParams: {},
    paramSchema: [],
    defaultStyle: { color: '#94a3b8' },
  },

  // -------------------- Existente --------------------
  sqzmom: {
    id: 'sqzmom',
    label: 'Squeeze Momentum',
    fullName: 'Squeeze Momentum (LazyBear)',
    category: 'momentum',
    pane: 'subpane',
    defaultParams: { length: 20, mult: 2.0, lengthKC: 20, multKC: 1.5, useTrueRange: true },
    paramSchema: [
      { key: 'length', type: 'number', label: 'BB periodo', min: 2, max: 100, step: 1 },
      { key: 'mult', type: 'number', label: 'BB desv.', min: 0.5, max: 5, step: 0.1 },
      { key: 'lengthKC', type: 'number', label: 'KC periodo', min: 2, max: 100, step: 1 },
      { key: 'multKC', type: 'number', label: 'KC mult.', min: 0.5, max: 5, step: 0.1 },
      { key: 'useTrueRange', type: 'boolean', label: 'Usar True Range' },
    ],
    defaultStyle: {},
  },
};

export function listIndicatorTypes() {
  return Object.keys(INDICATORS);
}

export function getIndicatorMeta(type) {
  return INDICATORS[type] || null;
}

export function makeIndicatorEntry(type) {
  const meta = INDICATORS[type];
  if (!meta) return null;
  return {
    uid: `${type}-${Math.random().toString(36).slice(2, 10)}`,
    type,
    params: { ...meta.defaultParams },
    style: { ...meta.defaultStyle },
    visible: true,
  };
}
