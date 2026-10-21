import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ---- lightweight-charts falso -------------------------------------------
const lw = vi.hoisted(() => {
  const LineStyle = { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 };
  function makeSeries(type, opts) {
    const s = {
      type,
      opts: { ...opts },
      setData: vi.fn(),
      applyOptions: vi.fn((o) => { Object.assign(s.opts, o); }),
    };
    return s;
  }
  function makeChart() {
    const scales = {};
    const chart = {
      series: [],
      addSeries: vi.fn((def, opts) => {
        const s = makeSeries(def.type, opts);
        chart.series.push(s);
        return s;
      }),
      removeSeries: vi.fn((s) => { chart.series = chart.series.filter((x) => x !== s); }),
      priceScale: vi.fn((id) => {
        scales[id] = scales[id] || { applyOptions: vi.fn() };
        return scales[id];
      }),
      applyOptions: vi.fn(),
      scales,
    };
    return chart;
  }
  return { LineStyle, makeChart, makeSeries };
});

vi.mock('lightweight-charts', () => ({
  LineSeries: { type: 'Line' },
  LineStyle: lw.LineStyle,
}));

vi.mock('../../../services/api', () => ({
  marketApi: { getCandles: vi.fn(), getOptionCandles: vi.fn() },
}));

import { marketApi } from '../../../services/api';
import { useChartOverlays } from './useChartOverlays';
import { OVERLAYS_STORAGE_KEY } from './overlayModel';

const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 9, 19, 0, 0, 0);
const MAIN = Array.from({ length: 5 }, (_, i) => ({ time: BASE + i * HOUR, open: 1, high: 1, low: 1, close: 100 + i }));
const COLORS = { up: '#26a69a', down: '#ef5350', upEdge: '#39c8b9', downEdge: '#ff6b68' };
const ETH = { symbol: 'ETHUSDT', datasource: 'binance', name: 'ETH' };
const BTC = { kind: 'asset', asset: { symbol: 'BTCUSDT', datasource: 'binance', name: 'BTC' } };
const SOL = { kind: 'asset', asset: { symbol: 'SOLUSDT', datasource: 'binance', name: 'SOL' } };
const OPT = {
  kind: 'option',
  option: { instrument: 'ETH-31OCT26-4000-C', underlying: 'ETH', expiryMs: Date.UTC(2026, 9, 31, 8), strike: 4000, type: 'C' },
};

function memStorage(initial) {
  const m = new Map(initial ? [[OVERLAYS_STORAGE_KEY, JSON.stringify(initial)]] : []);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), m };
}

function setup(props = {}) {
  const chart = lw.makeChart();
  const candle = lw.makeSeries('Candlestick', {});
  const chartRef = { current: chart };
  const candleSeriesRef = { current: candle };
  const storage = props.storage ?? memStorage();
  const initial = { chartRef, candleSeriesRef, mainAsset: ETH, timeframe: '1h', enabled: true, candleColors: COLORS, storage, ...props };
  const hook = renderHook((p) => useChartOverlays(p), { initialProps: initial });
  return { chart, candle, storage, hook, props: initial };
}

const lineSeries = (chart) => chart.series.filter((s) => s.type === 'Line');
const lastApplied = (mockFn, key) => mockFn.mock.calls.map(([o]) => o).filter((o) => o && key in o).pop();

beforeEach(() => {
  vi.clearAllMocks();
  marketApi.getCandles.mockImplementation(async () => MAIN.slice(0, 3).map((c) => ({ ...c, close: c.close * 10 })));
  marketApi.getOptionCandles.mockImplementation(async () => [
    { time: MAIN[0].time, close: 50, traded: true },
    { time: MAIN[1].time, close: 52, traded: false },
    { time: MAIN[2].time, close: 55, traded: true },
  ]);
});

describe('useChartOverlays', () => {
  it('el primer activo va al eje izquierdo; el segundo a ov-<id>; focus intercambia', async () => {
    const { chart, hook } = setup();
    act(() => { hook.result.current.add(BTC); });
    let ls = lineSeries(chart);
    expect(ls).toHaveLength(1);
    expect(ls[0].opts.priceScaleId).toBe('left');
    expect(ls[0].opts.lineWidth).toBe(2.2);
    expect(ls[0].opts.color).toBe('#f59e0b');

    act(() => { hook.result.current.add(SOL); });
    ls = lineSeries(chart);
    expect(ls).toHaveLength(2);
    const solId = 'asset:binance:SOLUSDT';
    expect(ls[1].opts.priceScaleId).toBe(`ov-${solId}`);
    expect(ls[1].opts.lineWidth).toBe(1.5);
    expect(chart.scales[`ov-${solId}`].applyOptions).toHaveBeenCalledWith({ visible: false, scaleMargins: { top: 0.12, bottom: 0.12 } });

    act(() => { hook.result.current.focus(solId); });
    expect(ls[0].opts.priceScaleId).toBe('ov-asset:binance:BTCUSDT');
    expect(ls[1].opts.priceScaleId).toBe('left');
    expect(ls[1].opts.lineWidth).toBe(2.2);
    expect(ls[1].opts.lastValueVisible).toBe(true);
    expect(ls[0].opts.lastValueVisible).toBe(false);
    const left = lastApplied(chart.applyOptions, 'leftPriceScale').leftPriceScale;
    expect(left.visible).toBe(true);
    expect(left.textColor).toBe('#22d3ee');
  });

  it('isMain: el mismo activo que el principal no crea serie', async () => {
    const { chart, hook } = setup();
    act(() => { hook.result.current.add({ kind: 'asset', asset: ETH }); });
    expect(lineSeries(chart)).toHaveLength(0);
    expect(hook.result.current.status['asset:binance:ETHUSDT']).toBe('isMain');
    const left = lastApplied(chart.applyOptions, 'leftPriceScale').leftPriceScale;
    expect(left.visible).toBe(false);
  });

  it('pasa a isMain al cambiar el activo principal', async () => {
    const { chart, hook, props } = setup();
    act(() => { hook.result.current.add(BTC); });
    expect(lineSeries(chart)).toHaveLength(1);
    hook.rerender({ ...props, mainAsset: BTC.asset });
    expect(lineSeries(chart)).toHaveLength(0);
    expect(hook.result.current.status['asset:binance:BTCUSDT']).toBe('isMain');
  });

  it('syncMain pide el tramo, alinea y setData recibe huecos', async () => {
    const { chart, hook } = setup();
    act(() => { hook.result.current.add(BTC); });
    await act(async () => { hook.result.current.syncMain(MAIN); });
    expect(marketApi.getCandles).toHaveBeenCalledWith({
      asset: 'BTCUSDT', datasource: 'binance', timeframe: '1h', limit: 1000,
      startTime: MAIN[0].time, endTime: MAIN[4].time + HOUR,
    });
    const s = lineSeries(chart)[0];
    await waitFor(() => expect(s.setData).toHaveBeenCalled());
    const data = s.setData.mock.calls.at(-1)[0];
    expect(data).toHaveLength(5);
    expect(data[0]).toEqual({ time: MAIN[0].time / 1000, value: 1000 });
    expect(data[3]).toEqual({ time: MAIN[3].time / 1000 });
    expect(data[4]).toEqual({ time: MAIN[4].time / 1000 });
    expect(hook.result.current.status['asset:binance:BTCUSDT']).toBe('ready');
  });

  it('syncMain sólo pide el tramo nuevo', async () => {
    const { hook } = setup();
    act(() => { hook.result.current.add(BTC); });
    await act(async () => { hook.result.current.syncMain(MAIN.slice(0, 3)); });
    marketApi.getCandles.mockClear();
    await act(async () => { hook.result.current.syncMain(MAIN); });
    const call = marketApi.getCandles.mock.calls[0][0];
    // refresca la última vela que ya tenía y pide lo nuevo
    expect(call.startTime).toBe(MAIN[2].time);
    expect(call.endTime).toBe(MAIN[4].time + HOUR);
  });

  it('opción: dos series (negociada y sin operaciones discontinua gris)', async () => {
    const { chart, hook } = setup();
    act(() => { hook.result.current.add(OPT); });
    const ls = lineSeries(chart);
    expect(ls).toHaveLength(2);
    expect(ls[1].opts).toMatchObject({ color: '#a8a29e', lineStyle: lw.LineStyle.Dashed, lineWidth: 2, priceScaleId: 'left' });
    await act(async () => { hook.result.current.syncMain(MAIN); });
    expect(marketApi.getOptionCandles).toHaveBeenCalledWith({
      instrument: 'ETH-31OCT26-4000-C', timeframe: '1h', startTime: MAIN[0].time, endTime: MAIN[4].time + HOUR,
    });
    await waitFor(() => expect(ls[0].setData).toHaveBeenCalled());
    const untraded = ls[1].setData.mock.calls.at(-1)[0];
    expect(untraded[1]).toMatchObject({ value: 52 });

    const rows = hook.result.current.valuesAt(MAIN[1].time / 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'option:ETH-31OCT26-4000-C', value: 52, traded: false, lastTradeAgoH: 1, color: '#f59e0b' });
    expect(rows[0].changePct).toBeCloseTo(4);
    const r2 = hook.result.current.valuesAt(MAIN[2].time / 1000)[0];
    expect(r2.lastTradeAgoH).toBeNull();
    expect(hook.result.current.valuesAt(MAIN[0].time / 1000)[0].changePct).toBeNull();
  });

  it('enabled=false elimina todas las series y true las recrea', async () => {
    const { chart, hook, props } = setup();
    act(() => { hook.result.current.add(BTC); hook.result.current.add(OPT); });
    expect(lineSeries(chart)).toHaveLength(3);
    hook.rerender({ ...props, enabled: false });
    expect(chart.series).toHaveLength(0);
    hook.rerender({ ...props, enabled: true });
    expect(lineSeries(chart)).toHaveLength(3);
  });

  it('sin visibles: eje izquierdo oculto y velas con sus colores; con visibles, atenuadas', async () => {
    const { chart, candle, hook } = setup();
    act(() => { hook.result.current.add(BTC); });
    expect(lastApplied(candle.applyOptions, 'upColor')).toMatchObject({ upColor: 'rgba(38,166,154,0.55)', downColor: 'rgba(239,83,80,0.55)' });
    act(() => { hook.result.current.toggleHidden('asset:binance:BTCUSDT'); });
    expect(lineSeries(chart)).toHaveLength(0);
    expect(lastApplied(chart.applyOptions, 'leftPriceScale').leftPriceScale.visible).toBe(false);
    expect(lastApplied(candle.applyOptions, 'upColor')).toMatchObject({
      upColor: COLORS.up, downColor: COLORS.down, borderUpColor: COLORS.upEdge, wickDownColor: COLORS.downEdge,
    });
  });

  it('enfoca la primera visible si no hay enfocada', async () => {
    const btc = 'asset:binance:BTCUSDT';
    const sol = 'asset:binance:SOLUSDT';
    const { hook } = setup();
    act(() => { hook.result.current.add(BTC); hook.result.current.add(SOL); });
    expect(hook.result.current.state.focusedId).toBe(btc);
    // ocultar la enfocada pasa el foco a la primera visible
    act(() => { hook.result.current.toggleHidden(btc); });
    expect(hook.result.current.state.focusedId).toBe(sol);
    // quitarla deja sin foco (BTC sigue oculta)
    act(() => { hook.result.current.remove(sol); });
    expect(hook.result.current.state.focusedId).toBeNull();
    // al mostrar BTC se enfoca
    act(() => { hook.result.current.toggleHidden(btc); });
    expect(hook.result.current.state.focusedId).toBe(btc);
  });

  it('persiste cada cambio y restaura al montar', async () => {
    const { hook, storage } = setup();
    act(() => { hook.result.current.add(BTC); });
    act(() => { hook.result.current.setColor('asset:binance:BTCUSDT', '#a78bfa'); });
    const saved = JSON.parse(storage.m.get(OVERLAYS_STORAGE_KEY));
    expect(saved.items[0].color).toBe('#a78bfa');
    const again = setup({ storage });
    expect(again.hook.result.current.state.items).toHaveLength(1);
    expect(lineSeries(again.chart)[0].opts.color).toBe('#a78bfa');
  });

  it('descarta respuestas viejas tras cambiar la temporalidad', async () => {
    let resolveOld;
    marketApi.getCandles.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    const { chart, hook, props } = setup();
    act(() => { hook.result.current.add(BTC); });
    act(() => { hook.result.current.syncMain(MAIN); });
    hook.rerender({ ...props, timeframe: '4h' });
    const s = lineSeries(chart)[0];
    await act(async () => { resolveOld(MAIN.map((c) => ({ ...c }))); });
    // sólo el vaciado por el cambio de temporalidad; nunca los datos viejos
    expect(s.setData.mock.calls.every(([d]) => d.length === 0)).toBe(true);
    expect(s.setData).toHaveBeenCalledWith([]);
  });

  it('error en la carga deja status error', async () => {
    marketApi.getCandles.mockRejectedValueOnce(new Error('boom'));
    const { hook } = setup();
    act(() => { hook.result.current.add(BTC); });
    await act(async () => { hook.result.current.syncMain(MAIN); });
    await waitFor(() => expect(hook.result.current.status['asset:binance:BTCUSDT']).toBe('error'));
  });
  it("status 'hidden' para ocultas y con el hook desactivado (nunca 'loading' eterno)", async () => {
    const { hook, props } = setup();
    act(() => { hook.result.current.add(BTC); hook.result.current.add(SOL); });
    act(() => { hook.result.current.toggleHidden('asset:binance:BTCUSDT'); });
    expect(hook.result.current.status['asset:binance:BTCUSDT']).toBe('hidden');
    hook.rerender({ ...props, enabled: false });
    expect(hook.result.current.status['asset:binance:SOLUSDT']).toBe('hidden');
    hook.rerender({ ...props, enabled: true });
    expect(hook.result.current.status['asset:binance:SOLUSDT']).toBe('loading');
  });

  it('el foco sale de una superposición que pasa a ser el principal', async () => {
    const btc = 'asset:binance:BTCUSDT';
    const sol = 'asset:binance:SOLUSDT';
    const { hook, props } = setup();
    act(() => { hook.result.current.add(BTC); hook.result.current.add(SOL); });
    expect(hook.result.current.state.focusedId).toBe(btc);
    hook.rerender({ ...props, mainAsset: BTC.asset });
    await waitFor(() => expect(hook.result.current.state.focusedId).toBe(sol));
    // no se puede enfocar la que es el principal
    act(() => { hook.result.current.focus(btc); });
    expect(hook.result.current.state.focusedId).toBe(sol);
  });

  it('al montar no enfoca una superposición que es el principal', () => {
    const storage = memStorage({
      items: [
        { id: 'asset:binance:ETHUSDT', kind: 'asset', color: '#f59e0b', hidden: false, asset: ETH },
        { id: 'asset:binance:BTCUSDT', kind: 'asset', color: '#22d3ee', hidden: false, asset: BTC.asset },
      ],
      focusedId: 'asset:binance:ETHUSDT',
    });
    const { hook } = setup({ storage });
    expect(hook.result.current.state.focusedId).toBe('asset:binance:BTCUSDT');
  });

  it('replace sustituye conservando el color y recrea la serie', async () => {
    const { chart, hook } = setup();
    act(() => { hook.result.current.add(BTC); });
    act(() => { hook.result.current.setColor('asset:binance:BTCUSDT', '#93c5fd'); });
    act(() => { hook.result.current.replace('asset:binance:BTCUSDT', SOL); });
    const { items, focusedId } = hook.result.current.state;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'asset:binance:SOLUSDT', color: '#93c5fd' });
    expect(focusedId).toBe('asset:binance:SOLUSDT');
    const ls = lineSeries(chart);
    expect(ls).toHaveLength(1);
    expect(ls[0].opts.color).toBe('#93c5fd');
  });
  it('si el principal salta a un tramo que no toca la caché, pide sólo el tramo nuevo (no el hueco)', async () => {
    const { chart, hook } = setup();
    act(() => { hook.result.current.add(BTC); });
    await act(async () => { hook.result.current.syncMain(MAIN); });
    marketApi.getCandles.mockClear();
    const s = lineSeries(chart)[0];
    s.setData.mockClear();
    const OLD = MAIN.map((c) => ({ ...c, time: c.time - 365 * 24 * HOUR }));
    await act(async () => { hook.result.current.syncMain(OLD); });
    // la serie se vacía al momento: datos con tiempos del tramo viejo
    // ensancharían el eje de tiempo y moverían la vista
    expect(s.setData.mock.calls[0][0]).toEqual([]);
    expect(marketApi.getCandles).toHaveBeenCalledTimes(1);
    expect(marketApi.getCandles.mock.calls[0][0]).toMatchObject({ startTime: OLD[0].time, endTime: OLD[4].time + HOUR });
  });
});
