import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  alertsApi: { backtest: vi.fn(), list: vi.fn() },
  settingsApi: { getChartAlertMarkers: vi.fn(), saveChartAlertMarkers: vi.fn() },
}));

import { alertsApi } from '../../../services/api';
import { useAlertBacktest } from './useAlertBacktest';

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const ASSET = { symbol: 'ETHUSDT', datasource: 'binance' };
const rule = (tf, operand) => ({ conditions: [{ indicatorType: 'rsi', timeframe: tf, operand: operand || { kind: 'value', value: 30 } }] });
const A1 = { id: 'a1', updatedAt: 1, datasource: 'binance', direction: 'bullish', rules: [rule('1h')] };
const ITEMS = [{ alertId: 'a1', color: '#facc15', hidden: false }];

const resp = (events = [], extra = {}) => ({
  alertId: 'a1', baseTimeframe: '1h', events, insufficient: 0, cooldownApprox: false, ...extra,
});
const ev = (evalTime) => ({ evalTime, time: evalTime - 1000, score: 1, threshold: 1, suppressed: false, rules: [] });

function setup(over = {}) {
  const props = {
    asset: ASSET, items: ITEMS, alertsById: { a1: A1 },
    ranges: [{ fromMs: NOW - 10 * DAY, toMs: NOW }], enabled: true, ...over,
  };
  const hook = renderHook((p) => useAlertBacktest(p), { initialProps: props });
  return { hook, props };
}

beforeEach(() => {
  vi.clearAllMocks();
  alertsApi.backtest.mockResolvedValue(resp([ev(NOW - DAY)]));
});

describe('useAlertBacktest', () => {
  it('pide un tramo y expone eventos', async () => {
    const { hook } = setup();
    await waitFor(() => expect(hook.result.current.statusByAlert.a1?.state).toBe('ready'));
    expect(alertsApi.backtest).toHaveBeenCalledTimes(1);
    expect(alertsApi.backtest).toHaveBeenCalledWith('a1', {
      asset: 'ETHUSDT', datasource: 'binance', startTime: NOW - 10 * DAY, endTime: NOW,
    });
    expect(hook.result.current.eventsByAlert.a1).toHaveLength(1);
  });

  it('el tramo es 2000 velas de la TF base calculada en el cliente', async () => {
    const alert = { ...A1, rules: [rule('1h', { kind: 'series', timeframe: '15m' }), { indicatorType: 'rsi', timeframe: '4h', operand: { kind: 'value' } }] };
    const { hook } = setup({ alertsById: { a1: alert }, ranges: [{ fromMs: NOW - 100 * DAY, toMs: NOW }] });
    await waitFor(() => expect(alertsApi.backtest).toHaveBeenCalled());
    const body = alertsApi.backtest.mock.calls[0][1];
    expect(body.endTime - body.startTime).toBe(2000 * 15 * MIN);
    hook.unmount();
  });

  it('ampliar fromMs pide solo el hueco', async () => {
    const { hook, props } = setup();
    await waitFor(() => expect(hook.result.current.statusByAlert.a1?.state).toBe('ready'));
    hook.rerender({ ...props, ranges: [{ fromMs: NOW - 20 * DAY, toMs: NOW }] });
    await waitFor(() => expect(alertsApi.backtest).toHaveBeenCalledTimes(2));
    const body = alertsApi.backtest.mock.calls[1][1];
    expect(body.endTime).toBe(NOW - 10 * DAY);
    expect(body.startTime).toBe(NOW - 20 * DAY);
    await waitFor(() => expect(hook.result.current.statusByAlert.a1?.state).toBe('ready'));
  });

  it('crecer toMs no pide nada', async () => {
    const { hook, props } = setup();
    await waitFor(() => expect(hook.result.current.statusByAlert.a1?.state).toBe('ready'));
    hook.rerender({ ...props, ranges: [{ fromMs: NOW - 10 * DAY, toMs: NOW + 5 * DAY }] });
    await act(async () => { await Promise.resolve(); });
    expect(alertsApi.backtest).toHaveBeenCalledTimes(1);
  });

  it('updatedAt invalida la caché', async () => {
    const { hook, props } = setup();
    await waitFor(() => expect(hook.result.current.statusByAlert.a1?.state).toBe('ready'));
    hook.rerender({ ...props, alertsById: { a1: { ...A1, updatedAt: 2 } } });
    await waitFor(() => expect(alertsApi.backtest).toHaveBeenCalledTimes(2));
  });

  it('rango mayor que el tope queda parcial', async () => {
    const alert = { ...A1, rules: [rule('1m')] };
    alertsApi.backtest.mockResolvedValue(resp([], { baseTimeframe: '1m' }));
    const { hook } = setup({ alertsById: { a1: alert }, ranges: [{ fromMs: NOW - 365 * DAY, toMs: NOW }] });
    await waitFor(() => expect(hook.result.current.statusByAlert.a1?.state).toBe('ready'));
    expect(alertsApi.backtest.mock.calls.length).toBeLessThanOrEqual(10);
    expect(alertsApi.backtest).toHaveBeenCalledTimes(10);
    expect(hook.result.current.statusByAlert.a1.partialFromMs).toBe(NOW - 10 * 2000 * MIN);
  });

  it('alerta eliminada: estado deleted y sin llamada', async () => {
    const { hook } = setup({ alertsById: {} });
    await waitFor(() => expect(hook.result.current.statusByAlert.a1?.state).toBe('deleted'));
    expect(alertsApi.backtest).not.toHaveBeenCalled();
  });

  it('error pasa a estado error y retry vuelve a pedir', async () => {
    alertsApi.backtest.mockRejectedValueOnce(new Error('boom'));
    const { hook, props } = setup();
    await waitFor(() => expect(hook.result.current.statusByAlert.a1?.state).toBe('error'));
    expect(hook.result.current.statusByAlert.a1.error).toBe('boom');
    hook.rerender({ ...props, ranges: [{ fromMs: NOW - 10 * DAY, toMs: NOW }] }); // sin cambios: no reintenta
    await act(async () => { await Promise.resolve(); });
    expect(alertsApi.backtest).toHaveBeenCalledTimes(1);
    act(() => { hook.result.current.retry('a1'); });
    await waitFor(() => expect(hook.result.current.statusByAlert.a1?.state).toBe('ready'));
    expect(alertsApi.backtest).toHaveBeenCalledTimes(2);
  });

  it('dedupe por evalTime, suma insufficient y marca approx y sourceMismatch', async () => {
    alertsApi.backtest.mockResolvedValue(resp([ev(1000), ev(1000), ev(2000)], { insufficient: 3, cooldownApprox: true }));
    const alert = { ...A1, datasource: 'deribit' };
    const { hook } = setup({ alertsById: { a1: alert } });
    await waitFor(() => expect(hook.result.current.statusByAlert.a1?.state).toBe('ready'));
    expect(hook.result.current.eventsByAlert.a1.map((e) => e.evalTime)).toEqual([1000, 2000]);
    expect(hook.result.current.statusByAlert.a1).toMatchObject({ insufficient: 3, approx: true, sourceMismatch: 'deribit' });
  });
});
