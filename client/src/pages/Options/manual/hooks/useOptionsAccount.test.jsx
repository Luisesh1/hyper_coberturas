import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { optionsApi, settingsApi, market } = vi.hoisted(() => ({
  optionsApi: { getAccount: vi.fn(), getPositions: vi.fn(), getOpenOrders: vi.fn(), getTrades: vi.fn() },
  settingsApi: { getOptionsLimits: vi.fn() },
  market: { current: null },
}));
vi.mock('../../../../services/api', () => ({ optionsApi, settingsApi }));
vi.mock('../../../../context/MarketContext', () => ({ useOptionalMarket: () => market.current }));

import { useOptionsAccount } from './useOptionsAccount';

function fakeMarket() {
  const listeners = new Set();
  return {
    wsReady: true,
    wsSend: vi.fn(() => true),
    addWsListener: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: (msg) => listeners.forEach((fn) => fn(msg)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  optionsApi.getAccount.mockResolvedValue({ balanceUsdt: 1 });
  optionsApi.getPositions.mockResolvedValue([]);
  optionsApi.getOpenOrders.mockResolvedValue([]);
  settingsApi.getOptionsLimits.mockResolvedValue(null);
});

describe('useOptionsAccount en tiempo real', () => {
  it('se suscribe por WebSocket y deja de sondear REST al recibir la cuenta', async () => {
    market.current = fakeMarket();
    const { result, unmount } = renderHook(() => useOptionsAccount({ enabled: true }));
    expect(market.current.wsSend).toHaveBeenCalledWith({ type: 'options_account_subscribe' });
    const restCalls = optionsApi.getAccount.mock.calls.length;

    act(() => market.current.emit({
      type: 'options_account',
      data: { account: { balanceUsdt: 500 }, positions: [{ symbol: 'X' }], openOrders: [], updatedAt: 1, stale: false },
    }));
    await waitFor(() => expect(result.current.account?.balanceUsdt).toBe(500));
    expect(result.current.live).toBe(true);
    expect(result.current.positions).toHaveLength(1);
    expect(optionsApi.getAccount.mock.calls.length).toBe(restCalls);

    // 429 con datos previos: se conservan y se marcan como desactualizados.
    act(() => market.current.emit({
      type: 'options_account',
      data: { account: { balanceUsdt: 500 }, positions: [], openOrders: [], updatedAt: 1, stale: true,
        error: { message: 'límite', code: 'BINANCE_OPTIONS_RATE_LIMIT' } },
    }));
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.error).toBeNull();

    unmount();
    expect(market.current.wsSend).toHaveBeenLastCalledWith({ type: 'options_account_unsubscribe' });
  });

  it('sin WebSocket listo sondea por REST como antes', async () => {
    market.current = { ...fakeMarket(), wsReady: false };
    const { result } = renderHook(() => useOptionsAccount({ enabled: true }));
    await waitFor(() => expect(result.current.account?.balanceUsdt).toBe(1));
    expect(market.current.wsSend).not.toHaveBeenCalled();
    expect(result.current.live).toBe(false);
  });
});
