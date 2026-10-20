// Lógica pura de la vista multi-temporalidad: resolución del instante
// señalado en cada gráfico, formato de textos y preferencias persistidas.

export const SYNC_COLORS = { exact: '#3ddc84', near: '#b8860b', out: '#8690a0' };
export const TF_SECONDS = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
};
export const MULTI_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
export const LAYOUTS = [
  { id: '1x2', label: '1×2', count: 2, cols: 2, rows: 1 },
  { id: '1x3', label: '1×3', count: 3, cols: 3, rows: 1 },
  { id: '2x2', label: '2×2', count: 4, cols: 2, rows: 2 },
];
export const DEFAULT_DESKTOP = { layout: '2x2', timeframes: ['5m', '15m', '1h', '4h'] };
export const DEFAULT_MOBILE_TIMEFRAMES = ['5m', '1h', '4h'];
export const DEFAULT_SYNC = true;
export const MULTI_PREFS_KEY = 'tv_multi_prefs_v1';

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// candles: [{ time(ms), ... }] ascendentes. visibleRange: { from, to } en
// segundos, o null (todo visible).
export function resolveSyncedTime(tSec, candles, tfSec, visibleRange) {
  const out = (side, candleTimeSec = null) => ({ status: 'out', candleTimeSec, offsetSec: 0, side });
  if (!Array.isArray(candles) || candles.length === 0) return out(null);

  // Última vela con apertura <= tSec (búsqueda binaria).
  let lo = 0;
  let hi = candles.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time / 1000 <= tSec) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (idx === -1) return out('left');

  const openSec = candles[idx].time / 1000;
  if (tSec >= openSec + tfSec) return out('right');

  if (visibleRange) {
    const { from, to } = visibleRange;
    if (openSec + tfSec <= from) return out('left', openSec);
    if (openSec > to) return out('right', openSec);
  }

  const offsetSec = tSec - openSec;
  return {
    status: offsetSec === 0 ? 'exact' : 'near',
    candleTimeSec: openSec,
    offsetSec,
    side: null,
  };
}

export function formatOffset(sec) {
  const total = Math.max(0, Math.floor(sec));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m && d === 0) parts.push(`${m}m`);
  if (parts.length === 0) return `${total % 60}s`;
  return parts.slice(0, 2).join(' ');
}

export function formatSyncTime(sec) {
  const d = new Date(sec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm}`;
}

export function statusLabel(resolution, { isSource } = {}) {
  if (isSource) return 'Origen';
  if (resolution?.status === 'exact') return 'Coincide exacto';
  if (resolution?.status === 'near') {
    return `Dentro de la vela ${formatSyncTime(resolution.candleTimeSec)} (+${formatOffset(resolution.offsetSec)})`;
  }
  return 'Fuera de vista';
}

// Versión corta para la cabecera compacta (móvil): "≈20:00 +45m" con la hora
// UTC de apertura de la vela contenedora. El texto completo va en title/aria.
export function compactStatusLabel(resolution, { isSource } = {}) {
  if (!isSource && resolution?.status === 'near') {
    const d = new Date(resolution.candleTimeSec * 1000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `≈${hh}:${mm} +${formatOffset(resolution.offsetSec)}`;
  }
  return statusLabel(resolution, { isSource });
}

function validTfList(value, length, fallback) {
  if (!Array.isArray(value) || value.length !== length) return [...fallback];
  if (!value.every((tf) => MULTI_TIMEFRAMES.includes(tf))) return [...fallback];
  return [...value];
}

function defaultPrefs() {
  return {
    layout: DEFAULT_DESKTOP.layout,
    timeframes: [...DEFAULT_DESKTOP.timeframes],
    mobileTimeframes: [...DEFAULT_MOBILE_TIMEFRAMES],
    sync: DEFAULT_SYNC,
  };
}

export function loadMultiPrefs() {
  try {
    const raw = localStorage.getItem(MULTI_PREFS_KEY);
    if (!raw) return defaultPrefs();
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return defaultPrefs();
    const def = defaultPrefs();
    return {
      layout: LAYOUTS.some((l) => l.id === p.layout) ? p.layout : def.layout,
      timeframes: validTfList(p.timeframes, 4, def.timeframes),
      mobileTimeframes: validTfList(p.mobileTimeframes, 3, def.mobileTimeframes),
      sync: typeof p.sync === 'boolean' ? p.sync : def.sync,
    };
  } catch {
    return defaultPrefs();
  }
}

export function saveMultiPrefs(prefs) {
  try {
    localStorage.setItem(MULTI_PREFS_KEY, JSON.stringify(prefs));
  } catch { /* noop */ }
}

// ── Modo Multi‑activo (pantalla dividida) ─────────────────────
export const SPLIT_PREFS_KEY = 'tv_split_prefs_v1';
export const MULTI_MODE_KEY = 'tv_multi_mode_v1';
export const MULTI_MODES = ['tf', 'assets'];
const hlPanel = (symbol) => ({ symbol, datasource: 'hyperliquid', timeframe: '15m' });
export const DEFAULT_SPLIT = {
  layout: '2x2',
  panels: [hlPanel('BTC'), hlPanel('ETH'), hlPanel('SOL'), hlPanel('HYPE')],
  mobilePanels: [hlPanel('BTC'), hlPanel('ETH')],
  sync: false,
};

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

function validPanel(p, fallback) {
  if (!p || typeof p !== 'object') return { ...fallback };
  if (!isNonEmptyString(p.symbol) || !isNonEmptyString(p.datasource)) return { ...fallback };
  if (!MULTI_TIMEFRAMES.includes(p.timeframe)) return { ...fallback };
  return { symbol: p.symbol, datasource: p.datasource, timeframe: p.timeframe };
}

// Cada posición se valida por separado: un panel roto vuelve al default de
// su posición sin arrastrar a los demás.
function validPanelList(value, fallback) {
  const list = Array.isArray(value) ? value : [];
  return fallback.map((def, i) => validPanel(list[i], def));
}

function defaultSplit() {
  return {
    layout: DEFAULT_SPLIT.layout,
    panels: DEFAULT_SPLIT.panels.map((p) => ({ ...p })),
    mobilePanels: DEFAULT_SPLIT.mobilePanels.map((p) => ({ ...p })),
    sync: DEFAULT_SPLIT.sync,
  };
}

export function loadSplitPrefs() {
  try {
    const raw = localStorage.getItem(SPLIT_PREFS_KEY);
    if (!raw) return defaultSplit();
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return defaultSplit();
    const def = defaultSplit();
    return {
      layout: LAYOUTS.some((l) => l.id === p.layout) ? p.layout : def.layout,
      panels: validPanelList(p.panels, def.panels),
      mobilePanels: validPanelList(p.mobilePanels, def.mobilePanels),
      sync: typeof p.sync === 'boolean' ? p.sync : def.sync,
    };
  } catch {
    return defaultSplit();
  }
}

export function saveSplitPrefs(prefs) {
  try {
    localStorage.setItem(SPLIT_PREFS_KEY, JSON.stringify(prefs));
  } catch { /* noop */ }
}

export function loadMultiMode() {
  try {
    const raw = localStorage.getItem(MULTI_MODE_KEY);
    return MULTI_MODES.includes(raw) ? raw : 'tf';
  } catch {
    return 'tf';
  }
}

export function saveMultiMode(mode) {
  try {
    localStorage.setItem(MULTI_MODE_KEY, mode);
  } catch { /* noop */ }
}
