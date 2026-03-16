import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TradingProvider, useTradingContext } from './TradingContext';

let wsHandler = null;

const {
  settingsApi,
  tradingApi,
  hedgeApi,
} = vi.hoisted(() => ({
  settingsApi: {
    getHyperliquidAccounts: vi.fn(),
    getHyperliquidAccountSummary: vi.fn(),
  },
  tradingApi: {
    getAccount: vi.fn(),
    openPosition: vi.fn(),
    closePosition: vi.fn(),
  },
  hedgeApi: {
    getAll: vi.fn(),
    create: vi.fn(),
    cancel: vi.fn(),
  },
}));

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: (handler) => {
    wsHandler = handler;
    return { isConnected: true };
  },
}));

vi.mock('../services/api', () => ({
  settingsApi,
  tradingApi,
  hedgeApi,
}));

function Probe() {
  const { notifications, lastBotEvent } = useTradingContext();

  return (
    <div>
      <div data-testid="event">{lastBotEvent?.event || ''}</div>
      <div data-testid="notifications">
        {notifications.map((item) => `${item.type}:${item.message}`).join('||')}
      </div>
    </div>
  );
}

describe('TradingContext', () => {
  beforeEach(() => {
    wsHandler = null;
    vi.clearAllMocks();
    settingsApi.getHyperliquidAccounts.mockResolvedValue([]);
    settingsApi.getHyperliquidAccountSummary.mockResolvedValue({});
    tradingApi.getAccount.mockResolvedValue(null);
    tradingApi.openPosition.mockResolvedValue({});
    tradingApi.closePosition.mockResolvedValue({});
    hedgeApi.getAll.mockResolvedValue([]);
  });

  it('convierte runtime_warning en notificacion visible y actualiza lastBotEvent', async () => {
    render(
      <TradingProvider>
        <Probe />
      </TradingProvider>
    );

    await waitFor(() => expect(settingsApi.getHyperliquidAccounts).toHaveBeenCalled());

    act(() => {
      wsHandler({
        type: 'bot_event',
        event: 'runtime_warning',
        bot: { id: 21 },
        payload: {
          actionTaken: 'Programando reintento',
          message: 'Market down',
        },
      });
    });

    expect(screen.getByTestId('event').textContent).toBe('runtime_warning');
    expect(screen.getByTestId('notifications').textContent).toContain('error:Bot en riesgo');
    expect(screen.getByTestId('notifications').textContent).toContain('Programando reintento');
  });

  it('convierte runtime_recovered en notificacion success', async () => {
    render(
      <TradingProvider>
        <Probe />
      </TradingProvider>
    );

    await waitFor(() => expect(settingsApi.getHyperliquidAccounts).toHaveBeenCalled());

    act(() => {
      wsHandler({
        type: 'bot_event',
        event: 'runtime_recovered',
        bot: { id: 21 },
        payload: {
          message: 'Bot recuperado y de vuelta en healthy',
        },
      });
    });

    expect(screen.getByTestId('event').textContent).toBe('runtime_recovered');
    expect(screen.getByTestId('notifications').textContent).toContain('success:Bot recuperado');
    expect(screen.getByTestId('notifications').textContent).toContain('healthy');
  });
});
