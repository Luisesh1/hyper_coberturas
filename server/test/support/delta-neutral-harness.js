/**
 * Arnes del motor delta-neutral para tests de evaluacion completa: una
 * proteccion v3 WETH/USDC en rango [2000, 3000] a 2500 y un servicio con
 * repositorio, Hyperliquid y ejecucion falsos. `onExecute(reason, {metrics})`
 * recibe lo que el motor mandaria a ejecutar.
 */
const {
  ProtectedPoolDeltaNeutralService,
} = require('../../src/services/protected-pool-delta-neutral.service');

const NOW = 1_800_000_000_000;
const PRICE = 2500;

function buildProtection(overrides = {}) {
  return {
    id: 55,
    userId: 1,
    accountId: 8,
    status: 'active',
    protectionMode: 'delta_neutral',
    inferredAsset: 'ETH',
    network: 'arbitrum',
    version: 'v3',
    positionIdentifier: '123',
    walletAddress: '0x00000000000000000000000000000000000000AA',
    poolAddress: '0x00000000000000000000000000000000000000BB',
    leverage: 7,
    rangeLowerPrice: 2000,
    rangeUpperPrice: 3000,
    priceCurrent: PRICE,
    snapshotStatus: 'ready',
    snapshotFreshAt: NOW,
    minOrderNotionalUsd: 11,
    poolSnapshot: {
      mode: 'lp_position',
      version: 'v3',
      network: 'arbitrum',
      identifier: '123',
      positionIdentifier: '123',
      owner: '0x00000000000000000000000000000000000000AA',
      creator: '0x00000000000000000000000000000000000000AA',
      poolAddress: '0x00000000000000000000000000000000000000BB',
      token0Address: '0x00000000000000000000000000000000000000CC',
      token1Address: '0x00000000000000000000000000000000000000DD',
      token0: { symbol: 'WETH', address: '0x00000000000000000000000000000000000000CC', decimals: 18 },
      token1: { symbol: 'USDC', address: '0x00000000000000000000000000000000000000DD', decimals: 6 },
      tickLower: 74000,
      tickUpper: 79000,
      liquidity: '2000000000000',
      rangeLowerPrice: 2000,
      rangeUpperPrice: 3000,
      priceCurrent: PRICE,
      currentValueUsd: 2500,
      inRange: true,
      unclaimedFees0: 0.01,
      unclaimedFees1: 12,
      snapshotFreshAt: NOW,
    },
    ...overrides,
  };
}

function buildService(protection, { onExecute, actualQty = 0.25, centerDeadZonePct } = {}) {
  const service = new ProtectedPoolDeltaNeutralService({
    ...(centerDeadZonePct != null ? { centerDeadZonePct } : {}),
    protectedPoolRepository: {
      getById: async () => protection,
      updateStrategyState: async (_userId, _id, payload) => {
        protection.strategyState = payload.strategyState;
        protection.nextEligibleAttemptAt = payload.nextEligibleAttemptAt;
        protection.cooldownReason = payload.cooldownReason;
      },
    },
    protectionDecisionLogRepository: { create: async () => {} },
    hlRegistry: {
      getOrCreate: async () => ({
        getPosition: async () => ({ coin: 'ETH', szi: String(-actualQty), leverage: { type: 'isolated', value: 7 } }),
        getClearinghouseState: async () => ({ withdrawable: '1000' }),
        getCandleSnapshot: async () => [],
      }),
    },
    getTradingService: async () => ({}),
    marketService: { getAssetContexts: async () => [] },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    hyperliquidStreamService: {
      trackProtection: () => {},
      start: () => {},
      stop: () => {},
      getMidPrice: async () => null,
      getBbo: async () => null,
      getActiveAssetCtx: async () => null,
      getClearinghouseState: async () => null,
      getDiagnostics: () => ({ enabled: false }),
    },
    rpcBudgetManager: {
      canSpend: () => ({ allowed: true, snapshot: null }),
      getSnapshot: () => null,
      record: () => {},
    },
  });
  service._fetchSpot = async () => ({ priceCurrent: PRICE });
  // Aisla la ejecucion: aqui interesa SI se decide ejecutar, no el envio real.
  service._executeRebalance = async ({ strategyState, reason, metrics }) => {
    onExecute?.(reason, { metrics, strategyState });
    return { ...strategyState, lastRebalanceReason: reason, executed: true };
  };
  return service;
}

module.exports = { NOW, PRICE, buildProtection, buildService };
