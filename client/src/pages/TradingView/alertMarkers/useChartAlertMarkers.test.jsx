import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const lw = vi.hoisted(() => ({ plugins: [] }));
vi.mock('lightweight-charts', () => ({
  createSeriesMarkers: (series) => {
    const p = { series, setMarkers: vi.fn(), detach: vi.fn() };
    lw.plugins.push(p);
    return p;
  },
}));
vi.mock('../../../services/api', () => ({
  alertsApi: { list: vi.fn(), backtest: vi.fn() },
  settingsApi: { getChartAlertMarkers: vi.fn(), saveChartAlertMarkers: vi.fn() },
}));

import { alertsApi, settingsApi } from '../../../services/api';
import { useChartAlertMarkers } from './useChartAlertMarkers';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 0, 0);
const ASSET = { symbol: 'ETHUSDT', datasource: 'binance', name: 'ETH' };
const ALERT = {
  id: 'a1', name: 'RSI', updatedAt: 1, datasource: 'binance', direction: 'bullish',
  rules: [{ conditions: [{ indicatorType: 'rsi', timeframe: '1h', operand: { kind: 'value', value: 30 } }] }],
};
const EVENT = { evalTime: T0 + 5 * H + 3000, time: T0 + 4 * H, score: 1, threshold: 1, suppressed: false, rules: [] };
const candles = Array.from({ length: 24 }, (_, i) => ({ time: T0 + i * H }));
const NO_REPLAY = { active: false, progress: { ltfTime: null }, subTf: '1m', anchor: null };

function setup(replay = NO_REPLAY, notify = vi.fn()) {
  const candlesRef = { current: candles };
  const candleSeriesRef = { current: {} };
  const props = { asset: ASSET, timeframe: '1h', candlesRef, candleSeriesRef, candleCount: candles.length, replay, notify };
  const hook = renderHook((p) => useChartAlertMarkers(p), { initialProps: props });
  return { hook, props };
}

const lastMarkers = () => {
  const calls = lw.plugins[lw.plugins.length - 1]?.setMarkers.mock.calls || [];
  return calls[calls.length - 1]?.[0];
};

beforeEach(() => {
  vi.clearAllMocks();
  lw.plugins.length = 0;
  alertsApi.list.mockResolvedValue([ALERT]);
  settingsApi.getChartAlertMarkers.mockResolvedValue({ items: [{ alertId: 'a1', color: '#facc15', hidden: false }] });
  alertsApi.backtest.mockResolvedValue({ alertId: 'a1', baseTimeframe: '1h', events: [EVENT], insufficient: 0 });
});

describe('useChartAlertMarkers', () => {
  it('una alerta elegida con un disparo → una marca arrowUp en la serie de velas', async () => {
    const { hook } = setup();
    await waitFor(() => expect(lastMarkers()).toHaveLength(1));
    expect(lastMarkers()[0]).toMatchObject({ shape: 'arrowUp', position: 'belowBar', time: (T0 + 5 * H) / 1000 });
    expect(alertsApi.backtest).toHaveBeenCalledWith('a1', expect.objectContaining({
      asset: 'ETHUSDT', datasource: 'binance', endTime: T0 + 24 * H,
    }));
    expect(hook.result.current.countsByAlert).toEqual({ a1: 1 });
    expect(hook.result.current.timeline).toHaveLength(1);
  });

  it('en replay con el instante anterior al disparo → setMarkers([])', async () => {
    const replay = { active: true, progress: { ltfTime: T0 + 4 * H }, subTf: '15m', anchor: T0 };
    const { hook } = setup(replay);
    await waitFor(() => expect(hook.result.current.statusByAlert.a1?.state).toBe('ready'));
    expect(lastMarkers()).toEqual([]);
    expect(hook.result.current.countsByAlert).toEqual({ a1: 0 });
  });

  it('el replay avanza más allá del disparo → aparece la marca', async () => {
    const replay = { active: true, progress: { ltfTime: T0 + 4 * H }, subTf: '15m', anchor: T0 };
    const { hook, props } = setup(replay);
    await waitFor(() => expect(hook.result.current.statusByAlert.a1?.state).toBe('ready'));
    hook.rerender({ ...props, replay: { ...replay, progress: { ltfTime: T0 + 5 * H } } });
    await waitFor(() => expect(lastMarkers()).toHaveLength(1));
  });

  it('avisa si el guardado de la selección falla', async () => {
    settingsApi.saveChartAlertMarkers.mockRejectedValue(new Error('boom'));
    const notify = vi.fn();
    const { hook } = setup(NO_REPLAY, notify);
    await waitFor(() => expect(hook.result.current.selection.loading).toBe(false));
    act(() => { hook.result.current.selection.toggleHidden('a1'); });
    await waitFor(() => expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('boom')));
  });
});
