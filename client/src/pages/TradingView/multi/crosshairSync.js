// STUB de contrato (Tarea 0). La Tarea 1 lo reemplaza por la implementación real.
// Ver docs/superpowers/specs/2026-10-20-tradingview-multi-timeframe-design.md §A.

export const SYNC_COLORS = { exact: '#3ddc84', near: '#b8860b', out: '#8690a0' };
export const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
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

export function resolveSyncedTime(_tSec, _candles, _tfSec, _visibleRange) {
  return { status: 'out', candleTimeSec: null, offsetSec: 0, side: null };
}

export function formatOffset(_sec) { return ''; }
export function formatSyncTime(_sec) { return ''; }
export function statusLabel(_resolution, _opts) { return ''; }

export function loadMultiPrefs() {
  return {
    layout: DEFAULT_DESKTOP.layout,
    timeframes: [...DEFAULT_DESKTOP.timeframes],
    mobileTimeframes: [...DEFAULT_MOBILE_TIMEFRAMES],
    sync: DEFAULT_SYNC,
  };
}

export function saveMultiPrefs(_prefs) {}
