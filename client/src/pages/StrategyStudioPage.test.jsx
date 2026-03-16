import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StrategyStudioPage from './StrategyStudio/StrategyStudioPage';

const { strategiesApi, indicatorsApi, addNotification } = vi.hoisted(() => ({
  strategiesApi: {
    list: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    validate: vi.fn(),
    backtest: vi.fn(),
  },
  indicatorsApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
  addNotification: vi.fn(),
}));

vi.mock('../services/api', () => ({
  strategiesApi,
  indicatorsApi,
}));

vi.mock('../context/TradingContext', () => ({
  useTradingContext: () => ({
    addNotification,
  }),
}));

describe('StrategyStudioPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    strategiesApi.list.mockResolvedValue([{
      id: 11,
      name: 'Trend Rider',
      description: 'Cruce EMA',
      assetUniverse: ['BTC'],
      timeframe: '15m',
      defaultParams: { fastPeriod: 9, slowPeriod: 21 },
      scriptSource: 'module.exports.evaluate = async () => signal.hold();',
      isActiveDraft: true,
      latestBacktest: {
        summary: { trades: 4, winRate: 75 },
      },
      updatedAt: Date.now(),
    }]);
    indicatorsApi.list.mockResolvedValue([{
      id: 7,
      name: 'Volume Z-Score',
      slug: 'volume-zscore',
      parameterSchema: { defaults: { period: 10 } },
      scriptSource: 'module.exports.compute = function compute() { return []; };',
    }]);
  });

  it('carga estrategias e indicadores y muestra los paneles principales', async () => {
    render(
      <MemoryRouter>
        <StrategyStudioPage />
      </MemoryRouter>
    );

    expect(await screen.findByText('Trend Rider')).toBeTruthy();
    expect(screen.getByText('@volume-zscore')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Validar' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Backtest' }).length).toBeGreaterThan(0);
  });

  it('ejecuta validacion y backtest de la estrategia seleccionada', async () => {
    strategiesApi.validate.mockResolvedValue({
      asset: 'BTC',
      timeframe: '15m',
      signal: { type: 'long' },
      diagnostics: { candles: 250 },
    });
    strategiesApi.backtest.mockResolvedValue({
      metrics: { trades: 8, winRate: 62.5, netPnl: 12.5 },
      trades: [{ side: 'long', entryPrice: 100, exitPrice: 105, pnl: 5 }],
    });

    render(
      <MemoryRouter>
        <StrategyStudioPage />
      </MemoryRouter>
    );
    await screen.findByText('Trend Rider');
    await userEvent.click(screen.getByRole('button', { name: /Trend Rider/i }));

    await userEvent.click(screen.getByRole('button', { name: 'Validar' }));
    await waitFor(() => expect(strategiesApi.validate).toHaveBeenCalledWith(11, expect.any(Object)));
    expect(await screen.findByText('Signal')).toBeTruthy();
    expect(screen.getAllByText('long').length).toBeGreaterThan(0);

    await userEvent.click(screen.getAllByRole('button', { name: 'Backtest' })[0]);
    await waitFor(() => expect(strategiesApi.backtest).toHaveBeenCalledWith(11, expect.any(Object)));
    expect(await screen.findByText('8 trades')).toBeTruthy();
  });
});
