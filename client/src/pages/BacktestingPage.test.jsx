import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BacktestingPage from './Backtesting/BacktestingPage';

const { strategiesApi, indicatorsApi, backtestingApi, addNotification } = vi.hoisted(() => ({
  strategiesApi: {
    list: vi.fn(),
  },
  indicatorsApi: {
    list: vi.fn(),
  },
  backtestingApi: {
    simulate: vi.fn(),
  },
  addNotification: vi.fn(),
}));

vi.mock('../services/api', () => ({
  strategiesApi,
  indicatorsApi,
  backtestingApi,
}));

vi.mock('../context/TradingContext', () => ({
  useTradingContext: () => ({
    addNotification,
  }),
}));

vi.mock('../components/Backtesting/BacktestChartPanel', () => ({
  default: ({ result }) => (
    <div data-testid="chart-panel">chart {result?.metrics?.trades || 0}</div>
  ),
}));

describe('BacktestingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    strategiesApi.list.mockResolvedValue([{
      id: 11,
      name: 'Trend Rider',
      assetUniverse: ['BTC'],
      timeframe: '15m',
      defaultParams: { fastPeriod: 9, slowPeriod: 21 },
    }]);
    indicatorsApi.list.mockResolvedValue([{
      id: 7,
      name: 'Volume Z-Score',
      slug: 'volume-zscore',
    }]);
    backtestingApi.simulate.mockResolvedValue({
      config: {
        strategyId: 11,
        asset: 'BTC',
        timeframe: '15m',
        limit: 500,
      },
      metrics: {
        trades: 3,
        winRate: 66.67,
        netPnl: 25.4,
        maxDrawdown: 8.2,
        profitFactor: 1.8,
        avgTrade: 8.46,
      },
      candles: [{
        time: 1,
        closeTime: 2,
        open: 100,
        high: 102,
        low: 99,
        close: 101,
      }],
      trades: [{
        side: 'long',
        entryTime: 2,
        exitTime: 3,
        entryPrice: 100,
        exitPrice: 104,
        qty: 1,
        sizeUsd: 100,
        pnl: 4,
        reason: 'signal_close',
      }],
      signals: [{
        closeTime: 2,
        type: 'long',
        action: 'open_long',
        price: 101,
      }],
      positionSegments: [],
      equitySeries: [{ time: 2, value: 4 }],
      drawdownSeries: [{ time: 2, value: 0 }],
      overlays: [],
      assumptions: {
        entryMode: 'close_with_slippage',
      },
    });
  });

  it('carga la configuracion base y muestra topbar', async () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/backtesting', state: { strategyId: 11 } }]}>
        <BacktestingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Backtesting Lab')).toBeTruthy();
    expect(await screen.findByText('Configuracion')).toBeTruthy();
  });

  it('ejecuta una simulacion y muestra resultados', async () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/backtesting', state: { strategyId: 11 } }]}>
        <BacktestingPage />
      </MemoryRouter>,
    );

    await screen.findByText('Backtesting Lab');
    const simBtns = screen.getAllByRole('button', { name: /simular/i });
    await userEvent.click(simBtns[0]);

    await waitFor(() => expect(backtestingApi.simulate).toHaveBeenCalledTimes(1));
    expect(backtestingApi.simulate).toHaveBeenCalledWith(expect.objectContaining({
      strategyId: 11,
      asset: 'BTC',
      timeframe: '15m',
      sizeUsd: 100,
      overlayRequests: expect.any(Array),
    }));
    expect(await screen.findByText('chart 3')).toBeTruthy();
  });

  it('muestra empty state cuando no hay resultado', async () => {
    render(
      <MemoryRouter>
        <BacktestingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Configura tu primera simulacion')).toBeTruthy();
  });
});
