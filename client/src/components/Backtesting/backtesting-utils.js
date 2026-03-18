import { safeJsonParse, stringifyJson } from '../../utils/json';

export { stringifyJson };

export const STORAGE_KEY = 'hl_backtesting_config';
export const TIMEFRAMES = ['1m', '5m', '15m', '1h'];
export const RANGE_OPTIONS = ['250', '500', '1000', 'custom'];
export const BUILTIN_OVERLAYS = ['sma', 'ema', 'rsi', 'macd', 'atr', 'bollinger'];
export const TRADE_FILTERS = ['all', 'long', 'short', 'win', 'loss'];

export function parseJsonObject(value, fallback = {}) {
  const parsed = safeJsonParse(value, fallback);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
}

export function toDatetimeLocal(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const pad = (v) => String(v).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function blankOverlay(kind = 'builtin') {
  return {
    id: `overlay-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    slug: kind === 'builtin' ? 'ema' : '',
    params: stringifyJson(kind === 'builtin' ? { period: 9 } : {}),
    pane: 'price',
  };
}

export function defaultForm(strategyId = '') {
  return {
    strategyId: strategyId ? String(strategyId) : '',
    asset: 'BTC',
    timeframe: '15m',
    params: stringifyJson({ fastPeriod: 9, slowPeriod: 21 }),
    sizeUsd: '100',
    leverage: '10',
    marginMode: 'cross',
    stopLossPct: '',
    takeProfitPct: '',
    feeBps: '0',
    slippageBps: '0',
    rangeMode: '500',
    from: '',
    to: '',
    overlays: [
      { ...blankOverlay('builtin'), slug: 'ema', params: stringifyJson({ period: 9 }), pane: 'price' },
      { ...blankOverlay('builtin'), slug: 'ema', params: stringifyJson({ period: 21 }), pane: 'price' },
      { ...blankOverlay('builtin'), slug: 'rsi', params: stringifyJson({ period: 14 }), pane: 'separate' },
    ],
  };
}

export function loadStoredForm() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function buildPayload(form) {
  return {
    strategyId: Number(form.strategyId),
    asset: form.asset,
    timeframe: form.timeframe,
    params: parseJsonObject(form.params, {}),
    sizeUsd: Number(form.sizeUsd),
    leverage: Number(form.leverage),
    marginMode: form.marginMode,
    stopLossPct: form.stopLossPct === '' ? null : Number(form.stopLossPct),
    takeProfitPct: form.takeProfitPct === '' ? null : Number(form.takeProfitPct),
    feeBps: Number(form.feeBps || 0),
    slippageBps: Number(form.slippageBps || 0),
    limit: form.rangeMode === 'custom' ? undefined : Number(form.rangeMode),
    from: form.rangeMode === 'custom' && form.from ? new Date(form.from).toISOString() : null,
    to: form.rangeMode === 'custom' && form.to ? new Date(form.to).toISOString() : null,
    overlayRequests: form.overlays.map((overlay) => ({
      id: overlay.id,
      kind: overlay.kind,
      slug: overlay.slug,
      params: parseJsonObject(overlay.params, {}),
      pane: overlay.pane,
    })),
  };
}

export function matchTradeFilter(trade, filter) {
  if (filter === 'all') return true;
  if (filter === 'long' || filter === 'short') return trade.side === filter;
  if (filter === 'win') return Number(trade.pnl) >= 0;
  if (filter === 'loss') return Number(trade.pnl) < 0;
  return true;
}

export const PRESETS = {
  rapido: {
    rangeMode: '250',
    stopLossPct: '',
    takeProfitPct: '',
    feeBps: '0',
    slippageBps: '0',
  },
  completo: {
    rangeMode: '1000',
    stopLossPct: '1.5',
    takeProfitPct: '3',
    feeBps: '4',
    slippageBps: '2',
  },
};

export const INDICATOR_PARAM_SCHEMAS = {
  sma: [{ key: 'period', label: 'Periodo', type: 'number', default: 20 }],
  ema: [{ key: 'period', label: 'Periodo', type: 'number', default: 9 }],
  rsi: [{ key: 'period', label: 'Periodo', type: 'number', default: 14 }],
  macd: [
    { key: 'fastPeriod', label: 'Fast', type: 'number', default: 12 },
    { key: 'slowPeriod', label: 'Slow', type: 'number', default: 26 },
    { key: 'signalPeriod', label: 'Signal', type: 'number', default: 9 },
  ],
  atr: [{ key: 'period', label: 'Periodo', type: 'number', default: 14 }],
  bollinger: [
    { key: 'period', label: 'Periodo', type: 'number', default: 20 },
    { key: 'multiplier', label: 'Multiplicador', type: 'number', default: 2 },
  ],
};

export function defaultOverlayParams(slug) {
  const schema = INDICATOR_PARAM_SCHEMAS[slug];
  if (!schema) return {};
  return Object.fromEntries(schema.map((f) => [f.key, f.default]));
}
