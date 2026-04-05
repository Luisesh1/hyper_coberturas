import { render, screen, waitFor, within } from '@testing-library/react';
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
    timeInRangePct: 66.7,
    timeInRangeMs: 40_020,
    timeTrackedMs: 60_000,
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
      breakoutConfirmDistancePct: 0.5,
      breakoutConfirmDurationSec: 600,
      midPrice: 100500,
      deltaNeutralEligible: true,
      deltaNeutralAsset: 'BTC',
      stableTokenSymbol: 'USDC',
      volatileTokenSymbol: 'BTC',
      estimatedInitialHedgeQty: 0.01234,
      deltaQty: 0.01234,
      gamma: 0.00001234,
      bandMode: 'adaptive',
      baseRebalancePriceMovePct: 3,
      rebalanceIntervalSec: 21600,
      targetHedgeRatio: 1,
      minRebalanceNotionalUsd: 50,
      maxSlippageBps: 20,
      twapMinNotionalUsd: 10000,
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
    protectionMode: 'dynamic',
    reentryBufferPct: 0.01,
    flipCooldownSec: 15,
    maxSequentialFlips: 6,
    breakoutConfirmDistancePct: 0.5,
    breakoutConfirmDurationSec: 600,
    dynamicState: {
      phase: 'neutral',
      pendingBreakoutEdge: null,
    },
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
    timeInRangePct: 50,
    timeInRangeMs: 86_400_000,
    timeTrackedMs: 172_800_000,
    poolSnapshot: snapshot,
    hedges: {
      downside: {
        id: 101,
        status: 'active',
        entryPrice: 3000,
        dynamicAnchorPrice: 3000,
        exitPrice: 3150,
      },
      upside: {
        id: 102,
        status: 'active',
        entryPrice: 3500,
        dynamicAnchorPrice: 3500,
        exitPrice: 3325,
      },
    },
  };
}

function buildInactiveProtectedPool() {
  const snapshot = buildPool({
    id: 'scan-inactive',
    identifier: 'pos-3',
    owner: '0x00000000000000000000000000000000000000dd',
    creator: '0x00000000000000000000000000000000000000dd',
    token0: { symbol: 'WETH' },
    token1: { symbol: 'USDC' },
    poolAddress: '0x0000000000000000000000000000000000000ddd',
    currentValueUsd: 34.33,
    initialValueUsd: 0,
    unclaimedFeesUsd: 0.16,
    pnlTotalUsd: null,
    yieldPct: null,
    rangeLowerPrice: 2117.56,
    rangeUpperPrice: 2182.05,
    priceAtOpen: 2150,
    priceCurrent: 2100,
    priceApprox: 2100,
    currentOutOfRangeSide: 'below',
    inRange: false,
    protectionCandidate: {
      eligible: true,
      inferredAsset: 'ETH',
      baseNotionalUsd: 34.33,
      suggestedNotionalUsd: 34.33,
      hedgeSize: 0.01,
      maxLeverage: 20,
      defaultLeverage: 10,
      stopLossDifferenceDefaultPct: 0.05,
      midPrice: 2100,
    },
  });

  return {
    id: 10,
    status: 'inactive',
    walletAddress: snapshot.owner,
    network: 'arbitrum',
    version: 'v3',
    positionIdentifier: snapshot.identifier,
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    inferredAsset: 'ETH',
    hedgeSize: 0.01,
    hedgeNotionalUsd: 34.33,
    configuredHedgeNotionalUsd: 34.33,
    valueMultiplier: null,
    stopLossDifferencePct: 0.05,
    protectionMode: 'dynamic',
    reentryBufferPct: 0.01,
    flipCooldownSec: 15,
    maxSequentialFlips: 6,
    breakoutConfirmDistancePct: 0.5,
    breakoutConfirmDurationSec: 600,
    dynamicState: {
      phase: 'neutral',
      pendingBreakoutEdge: null,
    },
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
    updatedAt: Date.now() - 58 * 60_000,
    timeInRangePct: 25,
    timeInRangeMs: 21_600_000,
    timeTrackedMs: 86_400_000,
    poolSnapshot: snapshot,
    hedges: {
      downside: null,
      upside: null,
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
    const inactiveProtectedPool = buildInactiveProtectedPool();
    uniswapApi.listProtectedPools.mockResolvedValue([protectedPool, inactiveProtectedPool]);
    uniswapApi.createProtectedPool.mockResolvedValue(protectedPool);
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
            breakoutConfirmDistancePct: 0.5,
            breakoutConfirmDurationSec: 600,
            midPrice: 3580,
            reason: 'Este pool ya tiene una proteccion activa.',
          },
        }),
      ],
    });
  });

  it('carga el panel protegido y muestra resultados despues de escanear', async () => {
    render(<UniswapPoolsPage />);

    expect(await screen.findByRole('button', { name: /Protegidos/i })).toBeTruthy();
    expect(await screen.findByText('Listo para escanear una wallet')).toBeTruthy();

    await userEvent.click(await screen.findByRole('button', { name: 'Escanear' }));

    await waitFor(() => expect(uniswapApi.scanPools).toHaveBeenCalledWith({
      wallet: '0x00000000000000000000000000000000000000ff',
      network: 'ethereum',
      version: 'v3',
    }));

    expect(await screen.findByRole('button', { name: /Resultados/i })).toBeTruthy();
    expect(await screen.findByText('2 de 2')).toBeTruthy();
    expect(await screen.findByText('WBTC / USDC')).toBeTruthy();
    expect((await screen.findAllByText('66.7%')).length).toBeGreaterThan(0);
  });

  it('permite filtrar pools protegibles y abrir el modal de cobertura', async () => {
    render(<UniswapPoolsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Escanear' }));
    await screen.findByText('2 de 2');

    await userEvent.click(screen.getByRole('button', { name: /Protegibles/i }));

    expect(await screen.findByText('1 de 2')).toBeTruthy();

    const applyButtons = screen.getAllByRole('button', { name: 'Aplicar cobertura' });
    await userEvent.click(applyButtons[0]);

    expect(await screen.findByRole('dialog', { name: 'Aplicar proteccion al pool' })).toBeTruthy();
    expect(screen.getAllByText('Configuracion de cobertura').length).toBeGreaterThan(0);
    expect(screen.getByText('Vista previa')).toBeTruthy();
    expect(screen.getByDisplayValue('1240')).toBeTruthy();
  });

  it('envia la confirmacion dinamica por distancia y tiempo al crear la proteccion', async () => {
    render(<UniswapPoolsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Escanear' }));
    await screen.findByText('2 de 2');

    const applyButtons = screen.getAllByRole('button', { name: 'Aplicar cobertura' });
    await userEvent.click(applyButtons[0]);

    const dialog = screen.getByRole('dialog', { name: 'Aplicar proteccion al pool' });
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: /Modo/i }), 'dynamic');
    const reentryField = within(dialog).getByRole('spinbutton', { name: /Separacion reentrada/i });
    expect(reentryField.value).toBe('1');
    await userEvent.clear(reentryField);
    await userEvent.type(reentryField, '1.25');
    await userEvent.clear(within(dialog).getByRole('spinbutton', { name: /Distancia confirmacion breakout/i }));
    await userEvent.type(within(dialog).getByRole('spinbutton', { name: /Distancia confirmacion breakout/i }), '0.75');
    await userEvent.clear(within(dialog).getByRole('spinbutton', { name: /Duracion confirmacion breakout/i }));
    await userEvent.type(within(dialog).getByRole('spinbutton', { name: /Duracion confirmacion breakout/i }), '900');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Activar proteccion dinamica' }));

    await waitFor(() => expect(uniswapApi.createProtectedPool).toHaveBeenCalled());
    expect(uniswapApi.createProtectedPool).toHaveBeenCalledWith(expect.objectContaining({
      protectionMode: 'dynamic',
      reentryBufferPct: 0.0125,
      breakoutConfirmDistancePct: 0.75,
      breakoutConfirmDurationSec: 900,
    }));
  }, 20000);

  it('envia la configuracion delta-neutral con presets y parametros de overlay', async () => {
    render(<UniswapPoolsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Escanear' }));
    await screen.findByText('2 de 2');

    const applyButtons = screen.getAllByRole('button', { name: 'Aplicar cobertura' });
    await userEvent.click(applyButtons[0]);

    const dialog = screen.getByRole('dialog', { name: 'Aplicar proteccion al pool' });
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: /Modo/i }), 'delta_neutral');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aggressive' }));
    await userEvent.clear(within(dialog).getByRole('spinbutton', { name: /Hedge ratio/i }));
    await userEvent.type(within(dialog).getByRole('spinbutton', { name: /Hedge ratio/i }), '0.9');
    await userEvent.clear(within(dialog).getByRole('spinbutton', { name: /Drift minimo USD/i }));
    await userEvent.type(within(dialog).getByRole('spinbutton', { name: /Drift minimo USD/i }), '75');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Activar overlay delta-neutral' }));

    await waitFor(() => expect(uniswapApi.createProtectedPool).toHaveBeenCalled());
    expect(uniswapApi.createProtectedPool).toHaveBeenCalledWith(expect.objectContaining({
      protectionMode: 'delta_neutral',
      bandMode: 'fixed',
      baseRebalancePriceMovePct: 1,
      rebalanceIntervalSec: 3600,
      targetHedgeRatio: 0.9,
      minRebalanceNotionalUsd: 75,
      maxSlippageBps: 20,
      twapMinNotionalUsd: 10000,
    }));
  }, 20000);

  it('muestra la configuracion dinamica extra en la tarjeta del pool protegido', async () => {
    render(<UniswapPoolsPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Protegidos/i }));
    expect(await screen.findByText('Dist. breakout')).toBeTruthy();
    expect(screen.getByText('0.5%')).toBeTruthy();
    expect(screen.getByText('10m')).toBeTruthy();
    expect(screen.getByText('50.0%')).toBeTruthy();
    expect(screen.queryByText('WETH / USDC')).toBeNull();

    await userEvent.click(screen.getByRole('checkbox', { name: /Ver pools sin proteccion/i }));

    expect(await screen.findByText('WETH / USDC')).toBeTruthy();
    expect(screen.getByText('Inactiva')).toBeTruthy();
  });
});
