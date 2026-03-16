import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BotsPage from './Bots/BotsPage';
import { buildBot, buildRun } from './Bots/test/fixtures';

const { botsApi, strategiesApi, addNotification } = vi.hoisted(() => ({
  botsApi: {
    list: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    duplicate: vi.fn(),
    activate: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    getRuns: vi.fn(),
  },
  strategiesApi: {
    list: vi.fn(),
  },
  addNotification: vi.fn(),
}));

vi.mock('../services/api', () => ({
  botsApi,
  strategiesApi,
}));

vi.mock('../context/TradingContext', () => ({
  useTradingContext: () => ({
    accounts: [{
      id: 1,
      alias: 'Cuenta Alpha',
      address: '0x00000000000000000000000000000000000000AA',
      shortAddress: '0x0000...00AA',
      balanceUsd: 1234,
      isDefault: true,
    }],
    defaultAccountId: 1,
    isLoadingAccounts: false,
    lastBotEvent: null,
    addNotification,
  }),
}));

describe('BotsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    strategiesApi.list.mockResolvedValue([{
      id: 11,
      name: 'Trend Rider',
      timeframe: '15m',
      latestBacktest: { summary: { trades: 4, winRate: 75 } },
    }]);
    botsApi.list.mockResolvedValue([buildBot()]);
    botsApi.getRuns.mockResolvedValue([
      buildRun(),
      buildRun({
        id: 2,
        action: 'market_data_failed',
        status: 'error',
        signal: null,
        details: { message: 'Sin velas', actionTaken: 'Reintento programado' },
      }),
    ]);
  });

  it('carga bots y muestra el historial de ejecuciones', async () => {
    render(<BotsPage selectedAsset="BTC" />);

    expect(await screen.findByText(/#21 · BTC/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /#21 · BTC/i }));
    expect(screen.getAllByText('Trend Rider').length).toBeGreaterThan(0);
    expect(await screen.findByText(/^hold$/)).toBeTruthy();
  });

  it('activa el bot seleccionado y refresca su estado', async () => {
    botsApi.activate.mockResolvedValue({});
    botsApi.getById.mockResolvedValue(buildBot({
      status: 'active',
      lastSignal: { type: 'long' },
      runtime: {
        state: 'healthy',
        consecutiveFailures: 0,
      },
    }));

    render(<BotsPage selectedAsset="BTC" />);
    await screen.findByText(/#21 · BTC/);
    await userEvent.click(screen.getByRole('button', { name: /#21 · BTC/i }));

    await userEvent.click(screen.getByRole('button', { name: 'Activar' }));
    await waitFor(() => expect(botsApi.activate).toHaveBeenCalledWith(21));
    await waitFor(() => expect(botsApi.getById).toHaveBeenCalledWith(21));
  });

  it('permite filtrar el historial para ver solo errores', async () => {
    render(<BotsPage selectedAsset="BTC" />);

    expect(await screen.findByText(/#21 · BTC/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /#21 · BTC/i }));
    expect(await screen.findByText('market_data_failed')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Solo errores' }));

    expect(screen.queryByText('hold')).toBeFalsy();
    expect(screen.getByText('market_data_failed')).toBeTruthy();
    expect(screen.getByText('Sin velas')).toBeTruthy();
  });

  it('notifica el error cuando falla la carga inicial', async () => {
    botsApi.list.mockRejectedValue(new Error('backend caido'));

    render(<BotsPage selectedAsset="BTC" />);

    await waitFor(() => expect(addNotification).toHaveBeenCalledWith('error', expect.stringMatching(/backend caido/i)));
  });
});
