import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useBacktestRuns from './useBacktestRuns';

const { backtestingApi } = vi.hoisted(() => ({
  backtestingApi: {
    run: vi.fn(),
    getJob: vi.fn(),
  },
}));

vi.mock('../../../services/api', () => ({ backtestingApi }));

describe('useBacktestRuns polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detiene el polling y limpia pendingJob si el servidor perdió el job tras reiniciar', async () => {
    const missing = Object.assign(new Error('Job no encontrado'), { status: 404 });
    backtestingApi.run.mockResolvedValue({ id: 'bt-lost', status: 'running' });
    backtestingApi.getJob.mockRejectedValue(missing);
    const addNotification = vi.fn();
    const { result } = renderHook(() => useBacktestRuns({
      getPayload: () => ({ strategyId: 11, asset: 'BTC', timeframe: '15m' }),
      selectedStrategy: { id: 11, name: 'Trend Rider' },
      addNotification,
    }));

    await act(async () => {
      await result.current.execute({ strategyId: 11 });
    });
    expect(result.current.pendingJob?.jobId).toBe('bt-lost');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(result.current.pendingJob).toBeNull();
    expect(addNotification).toHaveBeenCalledWith(
      'error',
      expect.stringMatching(/reinici|ya no existe/i),
      8000,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(backtestingApi.getJob).toHaveBeenCalledTimes(1);
  });
});
