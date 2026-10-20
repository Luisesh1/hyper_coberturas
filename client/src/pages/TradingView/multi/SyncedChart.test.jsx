import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// ---- lightweight-charts falso -------------------------------------------
const lw = vi.hoisted(() => {
  const state = { chart: null, series: null, handler: null, visibleRange: null };
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
      getVisibleRange: vi.fn(() => state.visibleRange),
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
  TrackingModeExitMode: { OnTouchEnd: 0, OnNextTap: 1 },
}));

// ---- API: velas de 1h desde 2026-10-19 00:00 UTC ------------------------
const BASE_MS = Date.UTC(2026, 9, 19, 0, 0, 0);
const HOUR_MS = 3_600_000;
const CANDLES_1H = Array.from({ length: 24 }, (_, i) => ({
  time: BASE_MS + i * HOUR_MS,
  open: 2500 + i, high: 2510 + i, low: 2490 + i, close: 2505 + i,
}));

// ---- indicadores: controlador falso ------------------------------------
const ind = vi.hoisted(() => ({ controller: null }));
vi.mock('../indicators/renderAdapter', () => ({
  createIndicatorsController: vi.fn(() => {
    ind.controller = { render: vi.fn(), removeAll: vi.fn(), getValuesAt: vi.fn(() => []) };
    return ind.controller;
  }),
}));

vi.mock('../../../services/api', () => ({
  marketApi: { getCandles: vi.fn() },
}));

import { marketApi } from '../../../services/api';
import { LineStyle, CrosshairMode, createChart } from 'lightweight-charts';
import { createIndicatorsController } from '../indicators/renderAdapter';
import SyncedChart from './SyncedChart';

const ASSET = { symbol: 'ETH', datasource: 'binance' };
const TFS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
const T20 = Math.floor((BASE_MS + 20 * HOUR_MS) / 1000); // 19 oct 20:00 UTC
const INDICATORS = [
  { uid: 'sqz', type: 'sqzmom', params: {}, style: {}, visible: true },
  { uid: 'ema', type: 'ema', params: { length: 20 }, style: {}, visible: false },
];

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
  lw.state.visibleRange = null;
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

  it('táctil: sale del modo seguimiento al soltar (sin puntero gris pegado)', async () => {
    renderChart();
    await waitForData();
    expect(createChart).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ trackingMode: { exitMode: 0 } }), // OnTouchEnd
    );
  });

  it('aviso derecho "▶" cuando la vela queda después del rango visible', async () => {
    // Rango visible que termina 5 h antes de la vela señalada.
    lw.state.visibleRange = { from: BASE_MS / 1000, to: T20 - 5 * 3600 };
    renderChart({ sync: { sourceIndex: 1, timeSec: T20, price: 2500 } });
    await waitForData();
    const edge = await screen.findByTestId('sync-out-0');
    expect(edge.textContent).toContain('▶');
    expect(edge.textContent).not.toContain('◀');
    expect(edge.textContent).toContain('19 oct 20:00 fuera de vista');
    expect(screen.getByTestId('sync-chip-0').getAttribute('data-status')).toBe('out');
    expect(lw.state.chart.setCrosshairPosition).not.toHaveBeenCalled();
  });

  it('el aviso de fuera de vista no se anuncia en cada movimiento', async () => {
    const before = BASE_MS / 1000 - 3 * 3600;
    renderChart({ sync: { sourceIndex: 1, timeSec: before, price: 2500 } });
    await waitForData();
    const edge = await screen.findByTestId('sync-out-0');
    expect(edge.getAttribute('role')).toBeNull();
  });

  it('chip: el texto va en un span recortable y el completo en title', async () => {
    renderChart({ sync: { sourceIndex: 1, timeSec: T20 + 45 * 60, price: 2500 } });
    await waitForData();
    const chip = await screen.findByTestId('sync-chip-0');
    const full = 'Dentro de la vela 19 oct 20:00 (+45m)';
    expect(chip.getAttribute('title')).toBe(full);
    const text = screen.getByTestId('sync-chip-text-0');
    expect(text.textContent).toBe(full);
    expect(text.getAttribute('aria-hidden')).toBeNull();
  });

  it('compacto: etiqueta corta "≈20:00 +45m" para dentro de la vela', async () => {
    renderChart({ compact: true, sync: { sourceIndex: 1, timeSec: T20 + 45 * 60, price: 2500 } });
    await waitForData();
    const chip = await screen.findByTestId('sync-chip-0');
    expect(screen.getByTestId('sync-chip-text-0').textContent).toBe('≈20:00 +45m');
    const full = 'Dentro de la vela 19 oct 20:00 (+45m)';
    expect(chip.getAttribute('title')).toBe(full);
    // El lector de pantalla recibe el texto completo, no el abreviado.
    expect(screen.getByTestId('sync-chip-text-0').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText(full)).toBeTruthy();
  });

  it('encuadre inicial: la última vela queda separada de la escala de precios', async () => {
    renderChart();
    await waitForData();
    const ts = lw.state.chart.timeScale();
    await waitFor(() => expect(ts.scrollToRealTime).toHaveBeenCalled());
    const opts = ts.applyOptions.mock.calls.map(([o]) => o).find((o) => o?.rightOffset != null);
    expect(opts.rightOffset).toBeGreaterThan(0);
    expect(opts.barSpacing).toBeGreaterThan(0);
    // Primero se encuadra y luego se lleva al final.
    expect(ts.applyOptions.mock.invocationCallOrder[0])
      .toBeLessThan(ts.scrollToRealTime.mock.invocationCallOrder[0]);
  });

  it('encuadre también al recargar por cambio de temporalidad', async () => {
    const { rerender } = renderChart();
    await waitForData();
    const ts = lw.state.chart.timeScale();
    ts.applyOptions.mockClear();
    rerender(
      <SyncedChart asset={ASSET} timeframe="4h" timeframes={TFS} index={0} syncEnabled sync={null} />,
    );
    await waitFor(() => expect(ts.applyOptions).toHaveBeenCalledWith(
      expect.objectContaining({ rightOffset: expect.any(Number), barSpacing: expect.any(Number) }),
    ));
  });

  it('onLastPrice: avisa del cierre de la última vela al cargar', async () => {
    const onLastPrice = vi.fn();
    renderChart({ onLastPrice });
    await waitForData();
    await waitFor(() => expect(onLastPrice).toHaveBeenLastCalledWith(0, 2528));
  });
});

describe('SyncedChart · indicadores', () => {
  it('crea el controlador con el chart y dibuja los indicadores con las velas en ms', async () => {
    renderChart({ indicators: INDICATORS });
    await waitForData();
    expect(createIndicatorsController).toHaveBeenCalledWith(lw.state.chart);
    await waitFor(() => expect(ind.controller.render).toHaveBeenCalledWith(
      INDICATORS,
      expect.arrayContaining([expect.objectContaining({ time: BASE_MS, close: 2505 })]),
    ));
    const [, candles] = ind.controller.render.mock.calls.at(-1);
    expect(candles).toHaveLength(24);
  });

  it('vuelve a dibujar al cambiar la lista de indicadores', async () => {
    const { rerender } = renderChart({ indicators: INDICATORS });
    await waitForData();
    await waitFor(() => expect(ind.controller.render).toHaveBeenCalled());
    const next = [INDICATORS[0]];
    rerender(
      <SyncedChart asset={ASSET} timeframe="1h" timeframes={TFS} index={0} syncEnabled sync={null} indicators={next} />,
    );
    await waitFor(() => expect(ind.controller.render).toHaveBeenLastCalledWith(next, expect.any(Array)));
  });

  it('al desmontar quita los indicadores antes de destruir el chart', async () => {
    const { unmount } = renderChart({ indicators: INDICATORS });
    await waitForData();
    unmount();
    expect(ind.controller.removeAll).toHaveBeenCalled();
    expect(ind.controller.removeAll.mock.invocationCallOrder[0])
      .toBeLessThan(lw.state.chart.remove.mock.invocationCallOrder[0]);
  });

  it('puntero sobre un sub-panel: propaga el cierre de la vela, no la coordenada', async () => {
    const { onPointer } = renderChart({ indicators: INDICATORS });
    await waitForData();
    lw.state.series.coordinateToPrice.mockClear();
    lw.state.handler({ time: T20, point: { x: 10, y: 20 }, paneIndex: 1, sourceEvent: {} });
    expect(onPointer).toHaveBeenCalledWith(0, { timeSec: T20, price: 2525 });
    expect(lw.state.series.coordinateToPrice).not.toHaveBeenCalled();

    onPointer.mockClear();
    lw.state.handler({ time: T20, point: { x: 10, y: 20 }, paneIndex: 0, sourceEvent: {} });
    expect(onPointer).toHaveBeenCalledWith(0, { timeSec: T20, price: 2600 });
  });
});

describe('SyncedChart · polling en vivo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function advance(ms) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }
  const fullLoads = () => marketApi.getCandles.mock.calls.filter(([a]) => a.limit === 500).length;
  const LAST = CANDLES_1H[CANDLES_1H.length - 1];

  it('un polling que cambia la última vela vuelve a llamar onLastPrice', async () => {
    const onLastPrice = vi.fn();
    renderChart({ onLastPrice });
    await advance(0);
    expect(onLastPrice).toHaveBeenLastCalledWith(0, 2528);
    marketApi.getCandles.mockResolvedValue([
      { ...CANDLES_1H[CANDLES_1H.length - 2] },
      { ...LAST, close: 2600 },
    ]);
    await advance(3_000);
    expect(onLastPrice).toHaveBeenLastCalledWith(0, 2600);
    expect(lw.state.series.update).toHaveBeenCalled();
  });

  it('un polling que cambia datos redibuja los indicadores con las velas nuevas', async () => {
    renderChart({ indicators: INDICATORS });
    await advance(0);
    const before = ind.controller.render.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    marketApi.getCandles.mockResolvedValue([{ ...LAST }, { ...LAST, time: LAST.time + HOUR_MS, close: 2700 }]);
    await advance(3_000);
    expect(ind.controller.render.mock.calls.length).toBeGreaterThan(before);
    const [list, candles] = ind.controller.render.mock.calls.at(-1);
    expect(list).toBe(INDICATORS);
    expect(candles.at(-1)).toEqual(expect.objectContaining({ time: LAST.time + HOUR_MS, close: 2700 }));
  });

  it('hueco tras pestaña oculta: si la primera vela del polling salta velas, recarga completa', async () => {
    renderChart();
    await advance(0);
    expect(fullLoads()).toBe(1);
    marketApi.getCandles.mockResolvedValueOnce([
      { ...LAST, time: LAST.time + 3 * HOUR_MS },
      { ...LAST, time: LAST.time + 4 * HOUR_MS },
    ]);
    await advance(3_000);
    expect(fullLoads()).toBe(2);
    // No se añadieron velas sueltas a través del hueco.
    expect(lw.state.series.update).not.toHaveBeenCalled();
  });

  it('al volver a estar visible la pestaña recarga las velas', async () => {
    renderChart();
    await advance(0);
    expect(fullLoads()).toBe(1);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await advance(0);
    expect(fullLoads()).toBe(2);
  });
});

describe('SyncedChart · syncPrice y onAssetClick', () => {
  const closeAt20 = () => CANDLES_1H.map((c, i) => ({ ...c, close: i === 20 ? 2510 : c.close }));

  it('syncPrice=false en destino: usa el cierre y oculta la línea horizontal; se restaura sin sync', async () => {
    marketApi.getCandles.mockResolvedValue(closeAt20());
    const sync = { sourceIndex: 1, timeSec: T20, price: 2500 };
    const { rerender, onPointer } = renderChart({ sync, syncPrice: false });
    await waitForData();
    await waitFor(() => expect(lw.state.chart.setCrosshairPosition)
      .toHaveBeenCalledWith(2510, T20, lw.state.series));
    const ch = lastCrosshairOptions();
    expect(ch.vertLine.color).toBe('#3ddc84');
    expect(ch.horzLine.visible).toBe(false);
    expect(ch.horzLine.labelVisible).toBe(false);

    rerender(
      <SyncedChart
        asset={ASSET} timeframe="1h" timeframes={TFS} index={0}
        syncEnabled sync={null} syncPrice={false} onPointer={onPointer}
      />,
    );
    await waitFor(() => expect(lastCrosshairOptions().horzLine.visible).toBe(true));
    expect(lastCrosshairOptions().horzLine.labelVisible).toBe(true);
  });

  it('syncPrice=false en el origen conserva la línea horizontal', async () => {
    renderChart({ sync: { sourceIndex: 0, timeSec: T20, price: 2500 }, syncPrice: false });
    await waitForData();
    await waitFor(() => expect(lastCrosshairOptions()).toBeTruthy());
    expect(lastCrosshairOptions().horzLine.visible).toBe(true);
    expect(lastCrosshairOptions().horzLine.labelVisible).toBe(true);
  });

  it('con onAssetClick muestra el botón del activo y lo notifica', async () => {
    const onAssetClick = vi.fn();
    renderChart({ onAssetClick, asset: { symbol: 'BTC', datasource: 'binance' } });
    const btn = screen.getByTestId('asset-btn-0');
    expect(btn.textContent).toContain('BTC');
    expect(btn.getAttribute('aria-label')).toBe('Cambiar activo (actual: BTC)');
    fireEvent.click(btn);
    expect(onAssetClick).toHaveBeenCalledWith(0);
    await waitForData();
  });

  it('sin onAssetClick no hay botón', async () => {
    renderChart();
    expect(screen.queryByTestId('asset-btn-0')).toBeNull();
    await waitForData();
  });
});
