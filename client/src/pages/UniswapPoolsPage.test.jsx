import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import UniswapPoolsPage from './UniswapPools/UniswapPoolsPage';

const { settingsApi, uniswapApi } = vi.hoisted(() => ({
  settingsApi: {
    getWallet: vi.fn(),
    getEtherscan: vi.fn(),
    getHyperliquidAccounts: vi.fn(),
  },
  uniswapApi: {
    getMeta: vi.fn(),
    listProtectedPools: vi.fn(),
    scanPools: vi.fn(),
    createProtectedPool: vi.fn(),
    deactivateProtectedPool: vi.fn(),
  },
}));

vi.mock('../services/api', () => ({
  settingsApi,
  uniswapApi,
}));

function buildPool(overrides = {}) {
  return {
    id: `pool-${overrides.identifier || overrides.id || '1'}`,
    mode: 'lp_position',
    version: 'v3',
    network: 'ethereum',
    networkLabel: 'Ethereum',
    owner: '0x00000000000000000000000000000000000000aa',
    creator: '0x00000000000000000000000000000000000000aa',
    identifier: 'pos-1',
    poolAddress: '0x0000000000000000000000000000000000000aaa',
    explorerUrl: 'https://etherscan.io',
    txHash: '0x0000000000000000000000000000000000000000000000000000000000000abc',
    openedAt: Date.now() - 60_000,
    activeForMs: 60_000,
    token0: { symbol: 'WBTC' },
    token1: { symbol: 'USDC' },
    fee: 30,
    tickSpacing: 60,
    reserve0: 0.4,
    reserve1: 38000,
    liquiditySummary: { text: '0.4 WBTC · 38,000 USDC' },
    initialValueUsd: 1100,
    currentValueUsd: 1240,
    unclaimedFeesUsd: 32,
    pnlTotalUsd: 140,
    yieldPct: 12.7,
    distanceToRangePct: 0,
    distanceToRangePrice: 0,
    rangeLowerPrice: 92000,
    rangeUpperPrice: 106000,
    priceAtOpen: 99000,
    priceCurrent: 100500,
    priceApprox: 100500,
    priceBaseSymbol: 'BTC',
    priceQuoteSymbol: 'USDC',
    positionAmount0: 0.21,
    positionAmount1: 17000,
    inRange: true,
    currentOutOfRangeSide: null,
    protectionCandidate: {
      eligible: true,
      inferredAsset: 'BTC',
      baseNotionalUsd: 1240,
      suggestedNotionalUsd: 1240,
      hedgeSize: 0.01234,
      maxLeverage: 20,
      defaultLeverage: 10,
      stopLossDifferenceDefaultPct: 0.05,
      midPrice: 100500,
    },
    ...overrides,
  };
}

function buildProtectedPool() {
  const snapshot = buildPool({
    id: 'scan-protected',
    identifier: 'pos-2',
    owner: '0x00000000000000000000000000000000000000bb',
    creator: '0x00000000000000000000000000000000000000bb',
    token0: { symbol: 'ETH' },
    token1: { symbol: 'USDC' },
    poolAddress: '0x0000000000000000000000000000000000000bbb',
    currentValueUsd: 1880,
    initialValueUsd: 1750,
    unclaimedFeesUsd: 48,
    pnlTotalUsd: 130,
    yieldPct: 7.42,
    rangeLowerPrice: 3000,
    rangeUpperPrice: 3500,
    priceAtOpen: 3250,
    priceCurrent: 3580,
    priceApprox: 3580,
    positionAmount0: 0.32,
    positionAmount1: 710,
    currentOutOfRangeSide: 'above',
    inRange: false,
    protectionCandidate: {
      eligible: false,
      inferredAsset: 'ETH',
      baseNotionalUsd: 1880,
      suggestedNotionalUsd: 1880,
      hedgeSize: 0.52,
      maxLeverage: 20,
      defaultLeverage: 10,
      stopLossDifferenceDefaultPct: 0.05,
      midPrice: 3580,
      reason: 'Este pool ya tiene una proteccion activa.',
    },
  });

  return {
    id: 9,
    status: 'active',
    walletAddress: snapshot.owner,
    network: 'ethereum',
    version: 'v3',
    positionIdentifier: snapshot.identifier,
    token0Symbol: 'ETH',
    token1Symbol: 'USDC',
    inferredAsset: 'ETH',
    hedgeSize: 0.52,
    hedgeNotionalUsd: 1880,
    configuredHedgeNotionalUsd: 1880,
    valueMultiplier: null,
    stopLossDifferencePct: 0.05,
    valueMode: 'usd',
    leverage: 10,
    marginMode: 'isolated',
    accountId: 1,
    account: {
      id: 1,
      alias: 'Cuenta Alpha',
      address: '0x00000000000000000000000000000000000000cc',
      shortAddress: '0x0000...00cc',
      isDefault: true,
    },
    rangeLowerPrice: snapshot.rangeLowerPrice,
    rangeUpperPrice: snapshot.rangeUpperPrice,
    updatedAt: Date.now() - 5 * 60_000,
    poolSnapshot: snapshot,
    hedges: {
      downside: {
        id: 101,
        status: 'active',
        entryPrice: 3000,
        exitPrice: 3150,
      },
      upside: {
        id: 102,
        status: 'active',
        entryPrice: 3500,
        exitPrice: 3325,
      },
    },
  };
}

describe('UniswapPoolsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    settingsApi.getWallet.mockResolvedValue({
      address: '0x00000000000000000000000000000000000000ff',
    });
    settingsApi.getEtherscan.mockResolvedValue({ hasApiKey: true });
    settingsApi.getHyperliquidAccounts.mockResolvedValue([{
      id: 1,
      alias: 'Cuenta Alpha',
      address: '0x00000000000000000000000000000000000000cc',
      shortAddress: '0x0000...00cc',
      isDefault: true,
    }]);
    uniswapApi.getMeta.mockResolvedValue({
      networks: [{
        id: 'ethereum',
        label: 'Ethereum',
        versions: ['v3', 'v4'],
      }],
    });

    const protectedPool = buildProtectedPool();
    uniswapApi.listProtectedPools.mockResolvedValue([protectedPool]);
    uniswapApi.scanPools.mockResolvedValue({
      wallet: '0x00000000000000000000000000000000000000ff',
      network: { id: 'ethereum', label: 'Ethereum' },
      version: 'v3',
      mode: 'lp_positions',
      count: 2,
      inspectedTxCount: 2,
      totalTxCount: 2,
      completeness: '100%',
      warnings: [],
      pools: [
        buildPool(),
        buildPool({
          id: 'pool-2',
          identifier: 'pos-2',
          owner: '0x00000000000000000000000000000000000000bb',
          creator: '0x00000000000000000000000000000000000000bb',
          token0: { symbol: 'ETH' },
          token1: { symbol: 'USDC' },
          poolAddress: '0x0000000000000000000000000000000000000bbb',
          currentValueUsd: 1880,
          currentOutOfRangeSide: 'above',
          inRange: false,
          protectionCandidate: {
            eligible: false,
            inferredAsset: 'ETH',
            baseNotionalUsd: 1880,
            suggestedNotionalUsd: 1880,
            hedgeSize: 0.52,
            maxLeverage: 20,
            defaultLeverage: 10,
            stopLossDifferenceDefaultPct: 0.05,
            midPrice: 3580,
            reason: 'Este pool ya tiene una proteccion activa.',
          },
        }),
      ],
    });
  });

  it('carga el panel protegido y muestra resultados despues de escanear', async () => {
    render(<UniswapPoolsPage />);

    expect(await screen.findByText('Pools protegidos')).toBeTruthy();
    expect(await screen.findByText('Proteccion activa')).toBeTruthy();

    await userEvent.click(await screen.findByRole('button', { name: 'Escanear' }));

    await waitFor(() => expect(uniswapApi.scanPools).toHaveBeenCalledWith({
      wallet: '0x00000000000000000000000000000000000000ff',
      network: 'ethereum',
      version: 'v3',
    }));

    expect(await screen.findByText('Resultados del scan')).toBeTruthy();
    expect(await screen.findByText('2 visibles de 2')).toBeTruthy();
    expect(await screen.findByText('WBTC / USDC')).toBeTruthy();
  });

  it('permite filtrar pools protegibles y abrir el modal de cobertura', async () => {
    render(<UniswapPoolsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Escanear' }));
    await screen.findByText('Resultados del scan');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filtro' }), 'eligible');

    expect(await screen.findByText('1 visibles de 2')).toBeTruthy();

    const applyButtons = screen.getAllByRole('button', { name: 'Aplicar cobertura' });
    await userEvent.click(applyButtons[0]);

    expect(await screen.findByRole('dialog', { name: 'Aplicar proteccion al pool' })).toBeTruthy();
    expect(screen.getAllByText('Configuracion de cobertura').length).toBeGreaterThan(0);
    expect(screen.getByText('Resultado estimado')).toBeTruthy();
    expect(screen.getByDisplayValue('1240')).toBeTruthy();
  });
});
