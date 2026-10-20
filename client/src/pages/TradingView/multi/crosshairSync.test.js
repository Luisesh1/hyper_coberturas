import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SYNC_COLORS, MULTI_PREFS_KEY, DEFAULT_SYNC,
  resolveSyncedTime, formatOffset, formatSyncTime, statusLabel, compactStatusLabel,
  loadMultiPrefs, saveMultiPrefs,
  SPLIT_PREFS_KEY, MULTI_MODE_KEY, DEFAULT_SPLIT,
  loadSplitPrefs, saveSplitPrefs, loadMultiMode, saveMultiMode,
} from './crosshairSync.js';

const T0 = Date.UTC(2026, 9, 19, 0, 0) / 1000;
const mk = (n, stepSec) => Array.from({ length: n }, (_, i) => ({
  time: (T0 + i * stepSec) * 1000, open: 1, high: 2, low: 0.5, close: 1.5,
}));
const c1h = mk(24, 3600);

describe('constantes', () => {
  it('colores exactos', () => {
    expect(SYNC_COLORS).toEqual({ exact: '#3ddc84', near: '#b8860b', out: '#8690a0' });
    expect(MULTI_PREFS_KEY).toBe('tv_multi_prefs_v1');
    expect(DEFAULT_SYNC).toBe(true);
  });
});

describe('resolveSyncedTime', () => {
  it('exacto', () => {
    expect(resolveSyncedTime(T0 + 3600, c1h, 3600, null))
      .toEqual({ status: 'exact', candleTimeSec: T0 + 3600, offsetSec: 0, side: null });
  });
  it('near dentro de la vela', () => {
    expect(resolveSyncedTime(T0 + 3600 + 2700, c1h, 3600, null))
      .toEqual({ status: 'near', candleTimeSec: T0 + 3600, offsetSec: 2700, side: null });
  });
  it('mismo tf en origen y destino es exact', () => {
    const c15 = mk(50, 900);
    expect(resolveSyncedTime(T0 + 900 * 7, c15, 900, null).status).toBe('exact');
  });
  it('no compara duracion: instante de apertura de una vela 4h es exact en 4h', () => {
    const c4h = mk(6, 14400);
    expect(resolveSyncedTime(T0 + 14400, c4h, 14400, null).status).toBe('exact');
  });
  it('anterior a la primera vela', () => {
    expect(resolveSyncedTime(T0 - 1, c1h, 3600, null))
      .toEqual({ status: 'out', candleTimeSec: null, offsetSec: 0, side: 'left' });
  });
  it('posterior a la ultima vela', () => {
    const last = T0 + 23 * 3600;
    expect(resolveSyncedTime(last + 3599, c1h, 3600, null).status).toBe('near');
    const r = resolveSyncedTime(last + 3600, c1h, 3600, null);
    expect(r.status).toBe('out');
    expect(r.side).toBe('right');
  });
  it('fuera del rango visible por la izquierda', () => {
    const r = resolveSyncedTime(T0, c1h, 3600, { from: T0 + 7200, to: T0 + 14400 });
    expect(r).toMatchObject({ status: 'out', side: 'left', candleTimeSec: T0 });
  });
  it('fuera del rango visible por la derecha', () => {
    const r = resolveSyncedTime(T0 + 20 * 3600, c1h, 3600, { from: T0 + 7200, to: T0 + 14400 });
    expect(r).toMatchObject({ status: 'out', side: 'right', candleTimeSec: T0 + 20 * 3600 });
  });
  it('bordes del rango visible', () => {
    const range = { from: T0 + 7200, to: T0 + 14400 };
    // vela de T0+3600 termina en T0+7200 == from: no visible
    expect(resolveSyncedTime(T0 + 3600, c1h, 3600, range).side).toBe('left');
    // vela de T0+7200 empieza en from: visible
    expect(resolveSyncedTime(T0 + 7200, c1h, 3600, range).status).toBe('exact');
    // vela que empieza exactamente en to: visible
    expect(resolveSyncedTime(T0 + 14400, c1h, 3600, range).status).toBe('exact');
    // vela posterior a to: no visible
    expect(resolveSyncedTime(T0 + 18000, c1h, 3600, range).side).toBe('right');
  });
  it('velas vacias no lanza', () => {
    expect(resolveSyncedTime(T0, [], 3600, null).status).toBe('out');
    expect(resolveSyncedTime(T0, null, 3600, null).status).toBe('out');
  });
  it('2000 velas (binaria)', () => {
    const big = mk(2000, 900);
    const r = resolveSyncedTime(T0 + 900 * 1234 + 400, big, 900, null);
    expect(r).toEqual({ status: 'near', candleTimeSec: T0 + 900 * 1234, offsetSec: 400, side: null });
    expect(resolveSyncedTime(T0 + 900 * 1999, big, 900, null).status).toBe('exact');
    expect(resolveSyncedTime(T0, big, 900, null).status).toBe('exact');
  });
});

describe('formato', () => {
  it('formatOffset', () => {
    expect(formatOffset(2700)).toBe('45m');
    expect(formatOffset(6300)).toBe('1h 45m');
    expect(formatOffset(90000)).toBe('1d 1h');
    expect(formatOffset(3600)).toBe('1h');
  });
  it('formatSyncTime', () => {
    expect(formatSyncTime(Date.UTC(2026, 9, 19, 20, 45) / 1000)).toBe('19 oct 20:45');
    expect(formatSyncTime(Date.UTC(2026, 0, 5, 3, 7) / 1000)).toBe('5 ene 03:07');
  });
  it('statusLabel', () => {
    expect(statusLabel({ status: 'exact' }, { isSource: true })).toBe('Origen');
    expect(statusLabel({ status: 'exact' }, { isSource: false })).toBe('Coincide exacto');
    expect(statusLabel({
      status: 'near', candleTimeSec: Date.UTC(2026, 9, 19, 20, 0) / 1000, offsetSec: 2700,
    }, { isSource: false })).toBe('Dentro de la vela 19 oct 20:00 (+45m)');
    expect(statusLabel({ status: 'out' }, { isSource: false })).toBe('Fuera de vista');
  });
  it('compactStatusLabel: near corto "≈HH:MM +offset", el resto igual', () => {
    expect(compactStatusLabel({
      status: 'near', candleTimeSec: Date.UTC(2026, 9, 19, 20, 0) / 1000, offsetSec: 2700,
    }, { isSource: false })).toBe('≈20:00 +45m');
    expect(compactStatusLabel({
      status: 'near', candleTimeSec: Date.UTC(2026, 9, 19, 8, 0) / 1000, offsetSec: 6300,
    }, { isSource: false })).toBe('≈08:00 +1h 45m');
    expect(compactStatusLabel({ status: 'near', candleTimeSec: 0, offsetSec: 60 }, { isSource: true })).toBe('Origen');
    expect(compactStatusLabel({ status: 'exact' }, { isSource: false })).toBe('Coincide exacto');
    expect(compactStatusLabel({ status: 'out' }, { isSource: false })).toBe('Fuera de vista');
  });
});

describe('prefs', () => {
  const DEFAULTS = {
    layout: '2x2', timeframes: ['5m', '15m', '1h', '4h'],
    mobileTimeframes: ['5m', '1h', '4h'], sync: true,
  };
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('defaults con storage vacio', () => {
    expect(loadMultiPrefs()).toEqual(DEFAULTS);
  });
  it('JSON corrupto', () => {
    localStorage.setItem(MULTI_PREFS_KEY, '{nope');
    expect(loadMultiPrefs()).toEqual(DEFAULTS);
  });
  it('campos invalidos vuelven a default, los validos se conservan', () => {
    localStorage.setItem(MULTI_PREFS_KEY, JSON.stringify({
      layout: '1x3', timeframes: ['7m', '15m', '1h', '4h'], mobileTimeframes: ['1m', '5m', '15m'], sync: 'x',
    }));
    expect(loadMultiPrefs()).toEqual({ ...DEFAULTS, layout: '1x3', mobileTimeframes: ['1m', '5m', '15m'] });
  });
  it('ida y vuelta', () => {
    const p = { layout: '1x2', timeframes: ['1m', '5m', '1d', '1w'], mobileTimeframes: ['1h', '4h', '1d'], sync: false };
    saveMultiPrefs(p);
    expect(loadMultiPrefs()).toEqual(p);
  });
  it('getItem que lanza', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('x'); });
    expect(loadMultiPrefs()).toEqual(DEFAULTS);
  });
  it('setItem que lanza no propaga', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('x'); });
    expect(() => saveMultiPrefs(DEFAULTS)).not.toThrow();
  });
});

describe('prefs multi-activo', () => {
  const hl = (symbol) => ({ symbol, datasource: 'hyperliquid', timeframe: '15m' });
  const DEFAULTS = {
    layout: '2x2',
    panels: [hl('BTC'), hl('ETH'), hl('SOL'), hl('HYPE')],
    mobilePanels: [hl('BTC'), hl('ETH')],
    sync: false,
  };
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('claves y defaults', () => {
    expect(SPLIT_PREFS_KEY).toBe('tv_split_prefs_v1');
    expect(MULTI_MODE_KEY).toBe('tv_multi_mode_v1');
    expect(DEFAULT_SPLIT).toEqual(DEFAULTS);
    expect(loadSplitPrefs()).toEqual(DEFAULTS);
  });
  it('los defaults devueltos son copias (mutarlos no afecta a DEFAULT_SPLIT)', () => {
    const p = loadSplitPrefs();
    p.panels[0].symbol = 'X';
    expect(DEFAULT_SPLIT.panels[0].symbol).toBe('BTC');
  });
  it('JSON corrupto → defaults', () => {
    localStorage.setItem(SPLIT_PREFS_KEY, '{nope');
    expect(loadSplitPrefs()).toEqual(DEFAULTS);
    localStorage.setItem(SPLIT_PREFS_KEY, '42');
    expect(loadSplitPrefs()).toEqual(DEFAULTS);
  });
  it('panel inválido (sin symbol, tf desconocido) → default de esa posición', () => {
    localStorage.setItem(SPLIT_PREFS_KEY, JSON.stringify({
      layout: '1x3',
      panels: [
        { symbol: 'DOGE', datasource: 'binance', timeframe: '1h' },
        { datasource: 'binance', timeframe: '1h' },
        { symbol: 'XRP', datasource: 'binance', timeframe: '7m' },
        null,
      ],
      mobilePanels: [{ symbol: 'AVAX', datasource: 'hyperliquid', timeframe: '4h' }, { symbol: '', datasource: 'x', timeframe: '1h' }],
      sync: true,
    }));
    expect(loadSplitPrefs()).toEqual({
      layout: '1x3',
      panels: [{ symbol: 'DOGE', datasource: 'binance', timeframe: '1h' }, hl('ETH'), hl('SOL'), hl('HYPE')],
      mobilePanels: [{ symbol: 'AVAX', datasource: 'hyperliquid', timeframe: '4h' }, hl('ETH')],
      sync: true,
    });
  });
  it('campos no válidos de nivel superior → defaults', () => {
    localStorage.setItem(SPLIT_PREFS_KEY, JSON.stringify({ layout: '9x9', panels: 'x', mobilePanels: null, sync: 'si' }));
    expect(loadSplitPrefs()).toEqual(DEFAULTS);
  });
  it('ida y vuelta', () => {
    const p = {
      layout: '1x2',
      panels: [hl('DOGE'), { symbol: 'AAPL', datasource: 'yahoo', timeframe: '1d' }, hl('SOL'), hl('HYPE')],
      mobilePanels: [hl('SOL'), { symbol: 'BTC', datasource: 'binance', timeframe: '1w' }],
      sync: true,
    };
    saveSplitPrefs(p);
    expect(loadSplitPrefs()).toEqual(p);
  });
  it('storage que lanza', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('x'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('x'); });
    expect(loadSplitPrefs()).toEqual(DEFAULTS);
    expect(loadMultiMode()).toBe('tf');
    expect(() => saveSplitPrefs(DEFAULTS)).not.toThrow();
    expect(() => saveMultiMode('assets')).not.toThrow();
  });
  it('modo: default tf, ida y vuelta, valor raro → tf', () => {
    expect(loadMultiMode()).toBe('tf');
    saveMultiMode('assets');
    expect(localStorage.getItem(MULTI_MODE_KEY)).toBe('assets');
    expect(loadMultiMode()).toBe('assets');
    saveMultiMode('tf');
    expect(loadMultiMode()).toBe('tf');
    localStorage.setItem(MULTI_MODE_KEY, 'raro');
    expect(loadMultiMode()).toBe('tf');
  });
});
