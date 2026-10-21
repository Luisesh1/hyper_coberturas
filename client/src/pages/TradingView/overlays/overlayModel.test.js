import { describe, it, expect } from 'vitest';
import {
  OVERLAY_PALETTE, MAX_OVERLAYS, OVERLAYS_STORAGE_KEY, overlayId, addOverlay,
  removeOverlay, toggleHidden, focusOverlay, setColor, loadOverlays, saveOverlays,
  isSameAsMain, alignToMain, splitTraded, shortLabel, mobileLabel, replaceOverlay,
} from './overlayModel.js';

const EMPTY = { items: [], focusedId: null };
const asset = (symbol, datasource = 'binance') => ({ kind: 'asset', asset: { symbol, datasource, name: symbol } });
const opt = (instrument) => ({ kind: 'option', option: { instrument, underlying: 'ETH', expiryMs: Date.UTC(2025, 9, 31, 8), strike: 2500, type: 'C' } });
const memStorage = (init = {}) => {
  const m = { ...init };
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; }, m };
};

describe('constantes', () => {
  it('paleta, tope y clave', () => {
    expect(OVERLAY_PALETTE).toEqual(['#f59e0b', '#22d3ee', '#a78bfa', '#f472b6', '#a3e635', '#93c5fd']);
    expect(MAX_OVERLAYS).toBe(6);
    expect(OVERLAYS_STORAGE_KEY).toBe('tv_overlays_v1');
  });
});

describe('overlayId', () => {
  it('asset y option', () => {
    expect(overlayId(asset('BTCUSDT'))).toBe('asset:binance:BTCUSDT');
    expect(overlayId(opt('ETH-31OCT25-2500-C'))).toBe('option:ETH-31OCT25-2500-C');
  });
});

describe('addOverlay', () => {
  it('asigna colores en orden, enfoca la primera y no duplica', () => {
    let s = addOverlay(EMPTY, asset('A'));
    expect(s.focusedId).toBe('asset:binance:A');
    expect(s.items[0]).toMatchObject({ color: OVERLAY_PALETTE[0], hidden: false });
    s = addOverlay(s, asset('B'));
    expect(s.items[1].color).toBe(OVERLAY_PALETTE[1]);
    expect(s.focusedId).toBe('asset:binance:A');
    expect(addOverlay(s, asset('B'))).toBe(s);
  });
  it('el 7.º no cambia el estado', () => {
    let s = EMPTY;
    for (let i = 0; i < 6; i++) s = addOverlay(s, asset(`S${i}`));
    expect(s.items).toHaveLength(6);
    expect(addOverlay(s, asset('S7'))).toBe(s);
  });
  it('reutiliza el color liberado', () => {
    let s = EMPTY;
    for (let i = 0; i < 3; i++) s = addOverlay(s, asset(`S${i}`));
    s = removeOverlay(s, 'asset:binance:S1');
    s = addOverlay(s, asset('N'));
    expect(s.items.find((o) => o.id === 'asset:binance:N').color).toBe(OVERLAY_PALETTE[1]);
  });
});

describe('removeOverlay / toggleHidden / focusOverlay / setColor', () => {
  it('quitar la enfocada pasa el foco a la primera visible', () => {
    let s = EMPTY;
    for (const x of ['A', 'B', 'C']) s = addOverlay(s, asset(x));
    s = toggleHidden(s, 'asset:binance:B');
    s = removeOverlay(s, 'asset:binance:A');
    expect(s.focusedId).toBe('asset:binance:C');
    s = removeOverlay(s, 'asset:binance:C');
    s = removeOverlay(s, 'asset:binance:B');
    expect(s).toEqual(EMPTY);
  });
  it('quitar otra no cambia el foco', () => {
    let s = addOverlay(addOverlay(EMPTY, asset('A')), asset('B'));
    expect(removeOverlay(s, 'asset:binance:B').focusedId).toBe('asset:binance:A');
  });
  it('toggleHidden, focusOverlay, setColor', () => {
    let s = addOverlay(addOverlay(EMPTY, asset('A')), asset('B'));
    expect(toggleHidden(s, 'asset:binance:A').items[0].hidden).toBe(true);
    expect(focusOverlay(s, 'asset:binance:B').focusedId).toBe('asset:binance:B');
    expect(focusOverlay(s, 'nope')).toBe(s);
    expect(setColor(s, 'asset:binance:A', '#fff').items[0].color).toBe('#fff');
  });
});

describe('persistencia', () => {
  it('JSON corrupto o vacío → estado vacío', () => {
    expect(loadOverlays(memStorage({ [OVERLAYS_STORAGE_KEY]: '{bad' }))).toEqual(EMPTY);
    expect(loadOverlays(memStorage())).toEqual(EMPTY);
    expect(loadOverlays({ getItem() { throw new Error('x'); } })).toEqual(EMPTY);
  });
  it('round trip', () => {
    const st = memStorage();
    let s = addOverlay(addOverlay(EMPTY, asset('A')), opt('ETH-31OCT25-2500-C'));
    s = focusOverlay(s, 'option:ETH-31OCT25-2500-C');
    saveOverlays(st, s);
    expect(loadOverlays(st)).toEqual(s);
  });
  it('saveOverlays no lanza si el storage falla', () => {
    expect(() => saveOverlays({ setItem() { throw new Error('x'); } }, EMPTY)).not.toThrow();
  });
  it('con 8 entradas carga 6; dedupe; descarta inválidas', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ id: `asset:binance:S${i}`, kind: 'asset', color: '#f59e0b', hidden: false, asset: { symbol: `S${i}`, datasource: 'binance', name: 'x' } }));
    const st = memStorage({ [OVERLAYS_STORAGE_KEY]: JSON.stringify({ items, focusedId: null }) });
    expect(loadOverlays(st).items).toHaveLength(6);
    const dup = [items[0], items[0], { id: 5 }, { id: 'x', kind: 'asset' }, null];
    const st2 = memStorage({ [OVERLAYS_STORAGE_KEY]: JSON.stringify({ items: dup, focusedId: 'zzz' }) });
    const r = loadOverlays(st2);
    expect(r.items).toHaveLength(1);
    expect(r.focusedId).toBe(items[0].id);
  });
  it('color fuera de paleta se reasigna', () => {
    const it0 = { id: 'asset:binance:A', kind: 'asset', color: '#00ff00', hidden: false, asset: { symbol: 'A', datasource: 'binance', name: 'A' } };
    const r = loadOverlays(memStorage({ [OVERLAYS_STORAGE_KEY]: JSON.stringify({ items: [it0], focusedId: it0.id }) }));
    expect(r.items[0].color).toBe(OVERLAY_PALETTE[0]);
  });
});

describe('isSameAsMain', () => {
  it('compara datasource y símbolo', () => {
    expect(isSameAsMain({ kind: 'asset', asset: { symbol: 'BTC', datasource: 'binance' } }, { symbol: 'BTC', datasource: 'binance' })).toBe(true);
    expect(isSameAsMain({ kind: 'asset', asset: { symbol: 'btc', datasource: 'binance' } }, { symbol: 'BTC', datasource: 'binance' })).toBe(true);
    expect(isSameAsMain({ kind: 'asset', asset: { symbol: 'BTC', datasource: 'yahoo' } }, { symbol: 'BTC', datasource: 'binance' })).toBe(false);
    expect(isSameAsMain({ kind: 'option', option: {} }, { symbol: 'BTC', datasource: 'binance' })).toBe(false);
  });
});

describe('alignToMain', () => {
  const H = 3600000;
  it('fin de semana sin velas → huecos', () => {
    const start = Date.UTC(2025, 9, 17, 20); // viernes 20:00 UTC
    const main = Array.from({ length: 72 }, (_, i) => ({ time: start + i * H }));
    const ov = [{ time: start, close: 10, traded: true }, { time: start + H, close: 11 }, { time: start + 52 * H, close: 12, traded: true }];
    const pts = alignToMain(main, ov, H);
    expect(pts).toHaveLength(72);
    expect(pts[0]).toEqual({ time: start / 1000, value: 10, traded: true });
    expect(pts[1]).toEqual({ time: (start + H) / 1000, value: 11, traded: true });
    expect(pts[10]).toEqual({ time: (start + 10 * H) / 1000 });
    expect('value' in pts[30]).toBe(false);
    expect(pts[52].value).toBe(12);
  });
  it('vela de 13:30 cae en la de 13:00', () => {
    const t = Date.UTC(2025, 9, 20, 13);
    const pts = alignToMain([{ time: t }], [{ time: t + 1800000, close: 7 }], H);
    expect(pts[0]).toEqual({ time: t / 1000, value: 7, traded: true });
  });
  it('varias velas en el intervalo: toma la última; respeta traded false', () => {
    const t = 0;
    const pts = alignToMain([{ time: t }, { time: H }], [{ time: 0, close: 1 }, { time: 1800000, close: 2, traded: false }], H);
    expect(pts[0]).toEqual({ time: 0, value: 2, traded: false });
    expect(pts[1]).toEqual({ time: H / 1000 });
  });
});

describe('splitTraded', () => {
  const p = (i, traded) => ({ time: i, value: i, traded });
  const vals = (a) => a.map((x) => ('value' in x ? x.value : null));
  it('[T,T,U,U,T]', () => {
    const { traded, untraded } = splitTraded([p(0, true), p(1, true), p(2, false), p(3, false), p(4, true)]);
    expect(vals(traded)).toEqual([0, 1, null, 3, 4]);
    expect(vals(untraded)).toEqual([null, 1, 2, 3, null]);
    expect(traded.map((x) => x.time)).toEqual([0, 1, 2, 3, 4]);
    expect(untraded.map((x) => x.time)).toEqual([0, 1, 2, 3, 4]);
  });
  it('los huecos siguen siendo huecos', () => {
    const { traded, untraded } = splitTraded([p(0, true), { time: 1 }, p(2, false)]);
    expect(vals(traded)).toEqual([0, null, null]);
    expect(vals(untraded)).toEqual([null, null, 2]);
  });
});

describe('mobileLabel', () => {
  it('activos: el símbolo base sin la cotización', () => {
    expect(mobileLabel({ kind: 'asset', asset: { symbol: 'BTCUSDT', name: 'Bitcoin' } })).toBe('BTC');
    expect(mobileLabel({ kind: 'asset', asset: { symbol: 'SOLUSDC' } })).toBe('SOL');
    expect(mobileLabel({ kind: 'asset', asset: { symbol: '^GSPC' } })).toBe('^GSPC');
  });
  it('opciones: tipo, strike y vencimiento', () => {
    expect(mobileLabel({ kind: 'option', option: { underlying: 'ETH', expiryMs: Date.UTC(2025, 9, 31, 8), type: 'C', strike: 2500 } })).toBe('C 2500 · 31 oct');
    expect(mobileLabel({ kind: 'option', option: { underlying: 'XRP', expiryMs: Date.UTC(2025, 11, 5, 8), type: 'P', strike: 2.2 } })).toBe('P 2.2 · 5 dic');
  });
});

describe('shortLabel', () => {
  it('activos', () => {
    expect(shortLabel({ kind: 'asset', asset: { symbol: 'BTCUSDT', name: 'Bitcoin' } })).toBe('BTC/USDT');
    expect(shortLabel({ kind: 'asset', asset: { symbol: 'SOLUSDC' } })).toBe('SOL/USDC');
    expect(shortLabel({ kind: 'asset', asset: { symbol: 'AAPL' } })).toBe('AAPL');
  });
  it('opciones', () => {
    expect(shortLabel({ kind: 'option', option: { underlying: 'ETH', expiryMs: Date.UTC(2025, 9, 31, 8), type: 'C', strike: 2500 } })).toBe('ETH 31 oct · C 2500');
    expect(shortLabel({ kind: 'option', option: { underlying: 'XRP', expiryMs: Date.UTC(2025, 11, 5, 8), type: 'P', strike: 2.2 } })).toBe('XRP 5 dic · P 2.2');
  });
});

describe('replaceOverlay', () => {
  it('sustituye en el mismo hueco, conserva color y pasa el foco', () => {
    let s = addOverlay(addOverlay(EMPTY, asset('BTCUSDT')), asset('SOLUSDT'));
    s = setColor(s, 'asset:binance:BTCUSDT', '#a3e635');
    s = toggleHidden(s, 'asset:binance:BTCUSDT');
    s = { ...s, focusedId: 'asset:binance:BTCUSDT' };
    const next = replaceOverlay(s, 'asset:binance:BTCUSDT', asset('ETHUSDT'));
    expect(next.items.map((o) => o.id)).toEqual(['asset:binance:ETHUSDT', 'asset:binance:SOLUSDT']);
    expect(next.items[0]).toMatchObject({ kind: 'asset', color: '#a3e635', hidden: false, asset: { symbol: 'ETHUSDT' } });
    expect(next.focusedId).toBe('asset:binance:ETHUSDT');
  });
  it('si el reemplazo ya estaba en la lista, quita el duplicado', () => {
    const s = addOverlay(addOverlay(EMPTY, asset('BTCUSDT')), asset('ETHUSDT'));
    const next = replaceOverlay(s, 'asset:binance:BTCUSDT', asset('ETHUSDT'));
    expect(next.items.map((o) => o.id)).toEqual(['asset:binance:ETHUSDT']);
    expect(next.items[0].color).toBe('#f59e0b');
  });
  it('id inexistente: sin cambios', () => {
    const s = addOverlay(EMPTY, asset('BTCUSDT'));
    expect(replaceOverlay(s, 'nope', asset('ETHUSDT'))).toBe(s);
  });
});
