import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ---- lightweight-charts falso -------------------------------------------
const lw = vi.hoisted(() => {
  const state = { chart: null, series: null, handler: null };
  const LineStyle = { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 };
  const CrosshairMode = { Normal: 0, Magnet: 1, Hidden: 2, MagnetOHLC: 3 };
  function makeChart() {
    const series = {
      setData: vi.fn(),
      update: vi.fn(),
      applyOptions: vi.fn(),
      coordinateToPrice: vi.fn(() => 2600),
    };
    const timeScale = {
      getVisibleRange: vi.fn(() => null),
      applyOptions: vi.fn(),
      scrollToRealTime: vi.fn(),
    };
    const chart = {
      addSeries: vi.fn(() => series),
      applyOptions: vi.fn(),
      setCrosshairPosition: vi.fn(),
      clearCrosshairPosition: vi.fn(),
      subscribeCrosshairMove: vi.fn((h) => { state.handler = h; }),
      unsubscribeCrosshairMove: vi.fn(),
      timeScale: () => timeScale,
      remove: vi.fn(),
    };
    state.chart = chart;
    state.series = series;
    return chart;
  }
  return { state, LineStyle, CrosshairMode, makeChart };
});

vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => lw.makeChart()),
  CandlestickSeries: { type: 'Candlestick' },
  CrosshairMode: lw.CrosshairMode,
  LineStyle: lw.LineStyle,
}));

// ---- API: velas de 1h desde 2026-10-19 00:00 UTC ------------------------
const BASE_MS = Date.UTC(2026, 9, 19, 0, 0, 0);
const HOUR_MS = 3_600_000;
const CANDLES_1H = Array.from({ length: 24 }, (_, i) => ({
  time: BASE_MS + i * HOUR_MS,
  open: 2500 + i, high: 2510 + i, low: 2490 + i, close: 2505 + i,
}));

vi.mock('../../../services/api', () => ({
  marketApi: { getCandles: vi.fn() },
}));

// ---- crosshairSync: implementación pequeña y fiel al spec §A -----------
vi.mock('./crosshairSync', async (importOriginal) => {
  const actual = await importOriginal();
  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
  const pad = (n) => String(n).padStart(2, '0');
  function formatSyncTime(sec) {
    const d = new Date(sec * 1000);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  function formatOffset(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d) return h ? `${d}d ${h}h` : `${d}d`;
    if (h) return m ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
  }
  function resolveSyncedTime(t, candles, tfSec, visibleRange) {
    const none = (side) => ({ status: 'out', candleTimeSec: null, offsetSec: 0, side });
    if (!candles?.length) return none(null);
    const first = candles[0].time / 1000;
    if (t < first) return none('left');
    let c = null;
    for (const k of candles) if (k.time / 1000 <= t) c = k;
    const open = c.time / 1000;
    if (t >= open + tfSec) return none('right');
    if (visibleRange && open < visibleRange.from) return { status: 'out', candleTimeSec: open, offsetSec: t - open, side: 'left' };
    if (visibleRange && open > visibleRange.to) return { status: 'out', candleTimeSec: open, offsetSec: t - open, side: 'right' };
    return { status: t === open ? 'exact' : 'near', candleTimeSec: open, offsetSec: t - open, side: null };
  }
  function statusLabel(res, { isSource } = {}) {
    if (isSource) return 'Origen';
    if (res.status === 'exact') return 'Coincide exacto';
    if (res.status === 'near') return `Dentro de la vela ${formatSyncTime(res.candleTimeSec)} (+${formatOffset(res.offsetSec)})`;
    return 'Fuera de vista';
  }
  return { ...actual, resolveSyncedTime, statusLabel, formatOffset, formatSyncTime };
});

import { marketApi } from '../../../services/api';
import { LineStyle, CrosshairMode, createChart } from 'lightweight-charts';
import SyncedChart from './SyncedChart';

const ASSET = { symbol: 'ETH', datasource: 'binance' };
const TFS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
const T20 = Math.floor((BASE_MS + 20 * HOUR_MS) / 1000); // 19 oct 20:00 UTC

function renderChart(props = {}) {
  const onPointer = vi.fn();
  const onTimeframeChange = vi.fn();
  const utils = render(
    <SyncedChart
      asset={ASSET}
      timeframe="1h"
      timeframes={TFS}
      onTimeframeChange={onTimeframeChange}
      index={0}
      syncEnabled
      sync={null}
      onPointer={onPointer}
      {...props}
    />,
  );
  return { ...utils, onPointer, onTimeframeChange };
}

async function waitForData() {
  await waitFor(() => expect(lw.state.series.setData).toHaveBeenCalled());
}

function lastCrosshairOptions() {
  const calls = lw.state.chart.applyOptions.mock.calls
    .map(([opts]) => opts)
    .filter((o) => o?.crosshair?.vertLine);
  return calls[calls.length - 1]?.crosshair;
}

beforeEach(() => {
  vi.clearAllMocks();
  marketApi.getCandles.mockResolvedValue(CANDLES_1H.map((c) => ({ ...c })));
});

describe('SyncedChart', () => {
  it('crea el chart en modo Normal y carga velas en segundos', async () => {
    renderChart();
    await waitForData();
    expect(marketApi.getCandles).toHaveBeenCalledWith(
      expect.objectContaining({ asset: 'ETH', datasource: 'binance', timeframe: '1h', limit: 500 }),
    );
    expect(createChart).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ autoSize: true, crosshair: { mode: CrosshairMode.Normal } }),
    );
    const data = lw.state.series.setData.mock.calls.at(-1)[0];
    expect(data[0].time).toBe(BASE_MS / 1000);
    expect(screen.getByTestId('synced-chart-0')).toBeTruthy();
  });

  it('exacto: puntero verde discontinuo y chip "Coincide exacto"', async () => {
    renderChart({ sync: { sourceIndex: 1, timeSec: T20, price: 2500 } });
    await waitForData();
    await waitFor(() => expect(lw.state.chart.setCrosshairPosition)
      .toHaveBeenCalledWith(2500, T20, lw.state.series));
    const ch = lastCrosshairOptions();
    expect(ch.vertLine.color).toBe('#3ddc84');
    expect(ch.vertLine.style).toBe(LineStyle.Dashed);
    expect(ch.horzLine.color).toBe('#3ddc84');
    expect(ch.vertLine.labelBackgroundColor).toBe('#3ddc84');
    const chip = screen.getByTestId('sync-chip-0');
    expect(chip.getAttribute('data-status')).toBe('exact');
    expect(chip.textContent).toContain('Coincide exacto');
  });

  it('dentro de la vela: amarillo oscuro y chip con offset', async () => {
    renderChart({ sync: { sourceIndex: 1, timeSec: T20 + 45 * 60, price: 2500 } });
    await waitForData();
    await waitFor(() => expect(lw.state.chart.setCrosshairPosition)
      .toHaveBeenCalledWith(2500, T20, lw.state.series));
    const ch = lastCrosshairOptions();
    expect(ch.vertLine.color).toBe('#b8860b');
    expect(ch.horzLine.color).toBe('#b8860b');
    expect(ch.vertLine.style).toBe(LineStyle.Dashed);
    const chip = screen.getByTestId('sync-chip-0');
    expect(chip.getAttribute('data-status')).toBe('near');
    expect(chip.textContent).toContain('Dentro de la vela 19 oct 20:00 (+45m)');
  });

  it('fuera de lo cargado: limpia el puntero y muestra el aviso izquierdo', async () => {
    const before = BASE_MS / 1000 - 3 * 3600;
    renderChart({ sync: { sourceIndex: 1, timeSec: before, price: 2500 } });
    await waitForData();
    await waitFor(() => expect(screen.getByTestId('sync-out-0')).toBeTruthy());
    expect(screen.getByTestId('sync-out-0').textContent).toContain('◀');
    expect(screen.getByTestId('sync-out-0').textContent).toContain('fuera de vista');
    expect(lw.state.chart.clearCrosshairPosition).toHaveBeenCalled();
    expect(lw.state.chart.setCrosshairPosition).not.toHaveBeenCalled();
    expect(screen.getByTestId('sync-chip-0').getAttribute('data-status')).toBe('out');
    expect(screen.getByTestId('sync-chip-0').textContent).toContain('Fuera de vista');
  });

  it('gráfico origen: verde continuo, chip "Origen" y sin setCrosshairPosition', async () => {
    renderChart({ sync: { sourceIndex: 0, timeSec: T20, price: 2500 } });
    await waitForData();
    await waitFor(() => expect(screen.getByTestId('sync-chip-0').getAttribute('data-status')).toBe('source'));
    expect(screen.getByTestId('sync-chip-0').textContent).toContain('Origen');
    const ch = lastCrosshairOptions();
    expect(ch.vertLine.color).toBe('#3ddc84');
    expect(ch.vertLine.style).toBe(LineStyle.Solid);
    expect(ch.horzLine.style).toBe(LineStyle.Solid);
    expect(lw.state.chart.setCrosshairPosition).not.toHaveBeenCalled();
  });

  it('propaga solo movimientos reales (con sourceEvent)', async () => {
    const { onPointer } = renderChart();
    await waitForData();
    const handler = lw.state.handler;
    expect(typeof handler).toBe('function');

    handler({ time: T20, point: { x: 10, y: 20 } }); // sintético (polling / salida)
    expect(onPointer).not.toHaveBeenCalled();

    handler({ time: T20, point: { x: 10, y: 20 }, sourceEvent: {} });
    expect(onPointer).toHaveBeenCalledWith(0, { timeSec: T20, price: 2600 });
    expect(lw.state.series.coordinateToPrice).toHaveBeenCalledWith(20);

    onPointer.mockClear();
    handler({ time: undefined, point: { x: 10, y: 20 }, sourceEvent: {} });
    expect(onPointer).toHaveBeenCalledWith(0, null);
  });

  it('fin de toque y salida del ratón limpian el puntero', async () => {
    const { onPointer } = renderChart();
    await waitForData();
    const root = screen.getByTestId('synced-chart-0');
    fireEvent.touchEnd(root);
    expect(onPointer).toHaveBeenLastCalledWith(0, null);
    onPointer.mockClear();
    fireEvent.touchCancel(root);
    expect(onPointer).toHaveBeenLastCalledWith(0, null);
    onPointer.mockClear();
    fireEvent.mouseLeave(root);
    expect(onPointer).toHaveBeenLastCalledWith(0, null);
  });

  it('sincronización apagada: sin chip ni setCrosshairPosition', async () => {
    renderChart({ syncEnabled: false, sync: { sourceIndex: 1, timeSec: T20, price: 2500 } });
    await waitForData();
    expect(screen.queryByTestId('sync-chip-0')).toBeNull();
    expect(screen.queryByTestId('sync-out-0')).toBeNull();
    expect(lw.state.chart.setCrosshairPosition).not.toHaveBeenCalled();
  });

  it('sin puntero: no hay chip', async () => {
    renderChart({ sync: null });
    await waitForData();
    expect(screen.queryByTestId('sync-chip-0')).toBeNull();
  });

  it('selector de temporalidad accesible', async () => {
    const { onTimeframeChange } = renderChart();
    await waitForData();
    const select = screen.getByLabelText('Temporalidad');
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe('1h');
    fireEvent.change(select, { target: { value: '4h' } });
    expect(onTimeframeChange).toHaveBeenCalledWith('4h');
  });

  it('muestra el error de carga dentro del panel', async () => {
    marketApi.getCandles.mockRejectedValueOnce(new Error('boom'));
    renderChart();
    expect((await screen.findByRole('alert')).textContent).toContain('boom');
  });

  it('modo compacto muestra el cierre de la última vela', async () => {
    renderChart({ compact: true });
    await waitForData();
    await waitFor(() => expect(screen.getByTestId('synced-close-0').textContent).toContain('2,528'));
  });
});
