import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ---- lightweight-charts falso -------------------------------------------
const lw = vi.hoisted(() => ({ plugins: [], charts: [] }));
vi.mock('lightweight-charts', () => {
  const timeScale = {
    applyOptions: () => {}, scrollToRealTime: () => {}, scrollToPosition: () => {},
    getVisibleLogicalRange: () => null, setVisibleLogicalRange: () => {},
    getVisibleRange: () => null, setVisibleRange: () => {},
    subscribeVisibleLogicalRangeChange: () => {}, unsubscribeVisibleLogicalRangeChange: () => {},
    subscribeVisibleTimeRangeChange: () => {}, unsubscribeVisibleTimeRangeChange: () => {},
    timeToCoordinate: () => null, coordinateToTime: () => null, logicalToCoordinate: () => null,
    coordinateToLogical: () => null, width: () => 800,
  };
  const series = () => ({
    setData: () => {}, update: () => {}, applyOptions: () => {}, priceToCoordinate: () => null,
    coordinateToPrice: () => null, priceScale: () => ({ applyOptions: () => {} }), data: () => [],
  });
  return {
    CandlestickSeries: 'Candlestick', LineSeries: 'Line', HistogramSeries: 'Histogram', AreaSeries: 'Area',
    CrosshairMode: { Normal: 0, Magnet: 1 }, PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2 },
    LineStyle: { Solid: 0, Dashed: 2 },
    createChart: () => {
      const chart = {
        addSeries: series, removeSeries: () => {}, remove: () => {}, applyOptions: () => {},
        timeScale: () => timeScale, priceScale: () => ({ applyOptions: () => {} }),
        subscribeCrosshairMove: () => {}, unsubscribeCrosshairMove: () => {},
        clicks: new Set(),
        subscribeClick: (fn) => chart.clicks.add(fn), unsubscribeClick: (fn) => chart.clicks.delete(fn),
        chartElement: () => document.createElement('div'), panes: () => [],
      };
      lw.charts.push(chart);
      return chart;
    },
    createSeriesMarkers: (s) => {
      const p = { series: s, setMarkers: vi.fn(), detach: vi.fn() };
      lw.plugins.push(p);
      return p;
    },
  };
});

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 0, 0);
const CANDLES = Array.from({ length: 24 }, (_, i) => ({
  time: T0 + i * H, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1,
}));
const ALERT = {
  id: 'a1', name: 'RSI sobreventa', updatedAt: 1, datasource: 'binance', direction: 'bullish',
  rules: [{ conditions: [{ indicatorType: 'rsi', timeframe: '1h', operand: { kind: 'value', value: 30 } }] }],
};
const EVENT = { evalTime: T0 + 5 * H + 3000, time: T0 + 4 * H, score: 72, threshold: 60, suppressed: false, rules: [] };

vi.mock('../../services/api', () => ({
  marketApi: { getCandles: vi.fn() },
  settingsApi: {
    getChartIndicators: vi.fn(), saveChartIndicators: vi.fn(),
    getChartAlertMarkers: vi.fn(), saveChartAlertMarkers: vi.fn(),
    getChartDrawings: vi.fn(), saveChartDrawings: vi.fn(),
  },
  alertsApi: { list: vi.fn(), backtest: vi.fn() },
}));
vi.mock('../../context/TradingContext', () => ({
  useTradingContext: () => ({ selectedAsset: 'ETH', addNotification: () => {} }),
}));
vi.mock('./indicators/renderAdapter', () => ({
  createIndicatorsController: () => ({ render: () => {}, removeAll: () => {}, getLegend: () => [] }),
}));
vi.mock('./drawings/use-drawings', () => ({
  useDrawings: () => ({
    drawings: [], selectedUid: null, canUndo: false, undo: () => {}, clearAll: () => {},
    deleteSelected: () => {}, onPointerDown: () => {}, onPointerMove: () => {}, onPointerUp: () => {},
  }),
}));
vi.mock('./overlays/useChartOverlays', async (importOriginal) => ({
  ...(await importOriginal()),
  useChartOverlays: () => ({
    state: { items: [], focusedId: null }, status: {}, syncMain: () => {}, valuesAt: () => [],
    focus: () => {}, remove: () => {}, retry: () => {}, setColor: () => {}, toggleHidden: () => {},
    add: () => {}, swap: () => {},
  }),
}));
const media = vi.hoisted(() => ({ mobile: false }));
vi.mock('./useMediaQuery', async (importOriginal) => ({
  ...(await importOriginal()),
  useMediaQuery: () => media.mobile,
}));
const replayMock = vi.hoisted(() => ({ value: null }));
vi.mock('./replay/useReplayController', () => ({
  useReplayController: () => replayMock.value,
}));

import { alertsApi, marketApi, settingsApi } from '../../services/api';
import TradingViewPage from './TradingViewPage';

const idleReplay = () => ({
  active: false, paused: true, loading: false, speed: 1, subTf: '15m', anchor: null,
  progress: { ltfTime: null, htfBucket: null },
  start: () => {}, stop: () => {}, play: () => {}, pause: () => {}, step: () => {}, setSpeed: () => {}, setSubTf: () => {},
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/trading-view?symbol=ETHUSDT&datasource=binance&tf=1h']}>
      <TradingViewPage />
    </MemoryRouter>,
  );
}

const lastMarkers = () => {
  const calls = lw.plugins.flatMap((p) => p.setMarkers.mock.calls);
  return calls[calls.length - 1]?.[0];
};

beforeEach(() => {
  vi.clearAllMocks();
  lw.plugins.length = 0;
  lw.charts.length = 0;
  media.mobile = false;
  replayMock.value = idleReplay();
  marketApi.getCandles.mockResolvedValue(CANDLES);
  settingsApi.getChartIndicators.mockResolvedValue(null);
  settingsApi.getChartDrawings.mockResolvedValue([]);
  settingsApi.getChartAlertMarkers.mockResolvedValue({ items: [{ alertId: 'a1', color: '#facc15', hidden: false }] });
  settingsApi.saveChartAlertMarkers.mockResolvedValue({});
  alertsApi.list.mockResolvedValue([ALERT]);
  alertsApi.backtest.mockResolvedValue({ alertId: 'a1', baseTimeframe: '1h', events: [EVENT], insufficient: 0 });
  try { localStorage.clear(); } catch { /* noop */ }
});

describe('TradingViewPage · marcas de alertas', () => {
  it('con una alerta elegida y un disparo, pinta una marca arrowUp en las velas', async () => {
    renderPage();
    await waitFor(() => expect(lastMarkers()).toHaveLength(1));
    expect(lastMarkers()[0]).toMatchObject({ shape: 'arrowUp', time: (T0 + 5 * H) / 1000 });
    expect(alertsApi.backtest).toHaveBeenCalledWith('a1', expect.objectContaining({ asset: 'ETHUSDT', datasource: 'binance' }));
    // Escritorio: botón «Alertas» en la barra y fila de chips.
    expect(screen.getByRole('button', { name: /Alertas/ })).toBeTruthy();
    expect(screen.getByRole('toolbar', { name: 'Alertas en el gráfico' })).toBeTruthy();
  });

  it('en replay con el instante anterior al disparo, setMarkers([])', async () => {
    replayMock.value = { ...idleReplay(), active: true, anchor: T0, progress: { ltfTime: T0 + 4 * H, htfBucket: T0 + 4 * H } };
    renderPage();
    await waitFor(() => expect(alertsApi.backtest).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('toolbar', { name: 'Alertas en el gráfico' })).toBeTruthy());
    await waitFor(() => expect(within(screen.getByRole('toolbar', { name: 'Alertas en el gráfico' })).getByTitle('Disparos en el rango').textContent).toBe('0'));
    expect(lastMarkers()).toEqual([]);
  });

  it('móvil: la barra inferior tiene la pestaña «Alertas» con contador', async () => {
    media.mobile = true;
    renderPage();
    const nav = await screen.findByRole('navigation', { name: 'Herramientas del gráfico' });
    await waitFor(() => expect(within(nav).getByRole('button', { name: 'Alertas, 1 en el gráfico' })).toBeTruthy());
  });

  it('móvil: tocar una vela con disparos abre la hoja del disparo con su puntuación', async () => {
    media.mobile = true;
    renderPage();
    await waitFor(() => expect(lastMarkers()).toHaveLength(1));
    const chart = lw.charts[lw.charts.length - 1];
    act(() => { chart.clicks.forEach((fn) => fn({ time: (T0 + 5 * H) / 1000, point: { x: 10, y: 10 } })); });
    expect(await screen.findByText('Disparo de alerta')).toBeTruthy();
    const entry = screen.getByText('Puntuación 72% (umbral 60%)').closest('section');
    expect(within(entry).getByText('RSI sobreventa')).toBeTruthy();
  });
});
