const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProtectedPoolDeltaNeutralService,
  computeVolatilityStats,
  deriveBandSettings,
} = require('../src/services/protected-pool-delta-neutral.service');

function buildDeltaNeutralProtection(overrides = {}) {
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
    priceCurrent: 2500,
    snapshotStatus: 'ready',
    snapshotFreshAt: Date.now(),
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
      priceCurrent: 2500,
      currentValueUsd: 2500,
      inRange: true,
      unclaimedFees0: 0.01,
      unclaimedFees1: 12,
      snapshotFreshAt: Date.now(),
    },
    strategyState: null,
    ...overrides,
  };
}

test('computeVolatilityStats devuelve RV de 4h y 24h', () => {
  const candles = Array.from({ length: 24 }, (_, index) => ({
    close: 100 + (index * 2),
  }));

  const stats = computeVolatilityStats(candles);

  assert.equal(Number.isFinite(stats.rv4hPct), true);
  assert.equal(Number.isFinite(stats.rv24hPct), true);
  assert.ok(stats.rv24hPct >= 0);
});

test('deriveBandSettings usa max(rv4h, rv24h) y estrecha la banda cerca del borde', () => {
  const settings = deriveBandSettings({
    bandMode: 'adaptive',
    rangeLowerPrice: 2400,
    rangeUpperPrice: 2600,
  }, {
    rv4hPct: 85,
    rv24hPct: 35,
  }, {
    normalizedGamma: 0.25,
  }, 2505);

  assert.equal(settings.rv4hPct, 85);
  assert.equal(settings.rv24hPct, 35);
  assert.equal(settings.baseBandPct, 1);
  assert.equal(settings.intervalSec, 3600);
  assert.equal(settings.effectiveBandPct, 0.5);
});

test('auto top-up usa un cap diario fijo basado en el notional inicial', async () => {
  let marginUpdates = 0;
  const service = new ProtectedPoolDeltaNeutralService();

  const blocked = await service._maybeTopUpMargin({
    protection: {
      inferredAsset: 'ETH',
      configuredHedgeNotionalUsd: 1_000,
      initialConfiguredHedgeNotionalUsd: 1_000,
    },
    hl: {
      getAssetMeta: async () => ({ index: 0 }),
      updateIsolatedMargin: async () => {
        marginUpdates += 1;
      },
    },
    currentPrice: 3_000,
    actualQty: 1,
    strategyState: {
      topUpCount24h: 2,
      topUpUsd24h: 240,
      topUpWindowStartedAt: Date.now(),
    },
  });

  assert.equal(blocked.allowed, false);
  assert.equal(blocked.success, false);
  assert.match(blocked.reason, /cap diario/i);
  assert.equal(marginUpdates, 0);
});

test('runTwap registra slices completados cuando queda parcial', async () => {
  const service = new ProtectedPoolDeltaNeutralService();
  let closeCalls = 0;

  const result = await service._runTwap({
    protection: {
      id: 77,
      inferredAsset: 'ETH',
      leverage: 5,
    },
    tradingService: {
      closePosition: async ({ size }) => {
        closeCalls += 1;
        if (closeCalls === 1) {
          return { closePrice: 2500 + size };
        }
        throw new Error('slice failed');
      },
    },
    hl: {},
    currentPrice: 2500,
    driftQty: -0.5,
  });

  assert.equal(result.partial, true);
  assert.equal(result.twapSlicesPlanned, 5);
  assert.equal(result.twapSlicesCompleted, 1);
  assert.ok(result.executedQty > 0);
});

test('_ensureIsolatedMarginBuffer no intenta fondear margen si la posicion aun no existe', async () => {
  const service = new ProtectedPoolDeltaNeutralService();
  let leverageUpdates = 0;
  let marginUpdates = 0;

  await service._ensureIsolatedMarginBuffer({
    inferredAsset: 'ETH',
    leverage: 5,
    id: 12,
  }, {
    getAssetMeta: async () => ({ index: 0 }),
    updateLeverage: async () => {
      leverageUpdates += 1;
    },
    updateIsolatedMargin: async () => {
      marginUpdates += 1;
    },
  }, 2500, 0.1, 0);

  assert.equal(leverageUpdates, 1);
  assert.equal(marginUpdates, 0);
});

test('evaluateProtection con decision hold nunca persiste rebalance_pending', async () => {
  const updates = [];
  const decisions = [];
  const protection = buildDeltaNeutralProtection();
  const repo = {
    getById: async () => protection,
    updateStrategyState: async (_userId, _id, payload) => {
      updates.push(payload);
      protection.strategyState = payload.strategyState;
      protection.lastDecision = payload.lastDecision;
      protection.lastDecisionReason = payload.lastDecisionReason;
      protection.nextEligibleAttemptAt = payload.nextEligibleAttemptAt;
      protection.cooldownReason = payload.cooldownReason;
    },
  };
  const service = new ProtectedPoolDeltaNeutralService({
    protectedPoolRepository: repo,
    protectionDecisionLogRepository: {
      create: async (payload) => decisions.push(payload),
    },
    hlRegistry: {
      getOrCreate: async () => ({
        getPosition: async () => null,
        getClearinghouseState: async () => ({ withdrawable: '1000' }),
        getCandleSnapshot: async () => [],
      }),
    },
    getTradingService: async () => ({}),
    marketService: {
      getAssetContexts: async () => [],
    },
    logger: {
      warn: () => {},
      error: () => {},
    },
  });
  service._fetchSpot = async () => ({ priceCurrent: 2500 });

  const result = await service.evaluateProtection(protection);

  assert.ok(['healthy', 'tracking'].includes(result.status));
  assert.notEqual(result.status, 'rebalance_pending');
  assert.equal(result.lastDecision, 'hold');
  assert.equal(updates.at(-1).strategyState.status, result.status);
  assert.equal(decisions.at(-1).finalStrategyStatus, result.status);
});

test('evaluateProtection deja risk_paused cuando la distancia a liquidacion es demasiado baja', async () => {
  const decisions = [];
  const protection = buildDeltaNeutralProtection({
    strategyState: {
      status: 'healthy',
    },
  });
  const repo = {
    getById: async () => protection,
    updateStrategyState: async (_userId, _id, payload) => {
      protection.strategyState = payload.strategyState;
    },
  };
  const service = new ProtectedPoolDeltaNeutralService({
    protectedPoolRepository: repo,
    protectionDecisionLogRepository: {
      create: async (payload) => decisions.push(payload),
    },
    hlRegistry: {
      getOrCreate: async () => ({
        getPosition: async () => ({
          asset: 'ETH',
          szi: '-0.01',
          liquidationPx: 2650,
          leverage: { type: 'isolated', value: 7 },
          unrealizedPnl: 0,
        }),
        getClearinghouseState: async () => ({ withdrawable: '1000' }),
        getCandleSnapshot: async () => [],
      }),
    },
    getTradingService: async () => ({}),
    marketService: {
      getAssetContexts: async () => [],
    },
    logger: {
      warn: () => {},
      error: () => {},
    },
  });
  service._fetchSpot = async () => ({ priceCurrent: 2500 });

  const result = await service.evaluateProtection(protection);

  assert.equal(result.status, 'risk_paused');
  assert.match(result.lastError, /distancia a liquidacion/i);
  assert.equal(result.lastDecision, 'hold');
  assert.equal(decisions.at(-1).finalStrategyStatus, 'risk_paused');
  assert.equal(decisions.at(-1).riskGateTriggered, true);
});

test('evaluateProtection degrada a spot_stale si falla spot y el snapshot esta viejo', async () => {
  const now = Date.now();
  const decisions = [];
  const protection = buildDeltaNeutralProtection({
    snapshotFreshAt: now - (5 * 60_000),
    poolSnapshot: {
      ...buildDeltaNeutralProtection().poolSnapshot,
      snapshotFreshAt: now - (5 * 60_000),
      priceCurrent: 2500,
    },
  });
  const repo = {
    getById: async () => protection,
    updateStrategyState: async (_userId, _id, payload) => {
      protection.strategyState = payload.strategyState;
      protection.snapshotFreshAt = payload.snapshotFreshAt || protection.snapshotFreshAt;
    },
  };
  const service = new ProtectedPoolDeltaNeutralService({
    protectedPoolRepository: repo,
    protectionDecisionLogRepository: {
      create: async (payload) => decisions.push(payload),
    },
    uniswapService: {
      scanPoolsCreatedByWallet: async () => ({ pools: [] }),
    },
    hlRegistry: {
      getOrCreate: async () => ({
        getPosition: async () => null,
        getClearinghouseState: async () => ({ withdrawable: '1000' }),
        getCandleSnapshot: async () => [],
      }),
    },
    getTradingService: async () => ({}),
    marketService: {
      getAssetContexts: async () => [],
    },
    logger: {
      warn: () => {},
      error: () => {},
    },
  });
  service._fetchSpot = async () => null;

  const result = await service.evaluateProtection(protection);

  assert.equal(result, null);
  assert.equal(protection.strategyState.status, 'spot_stale');
  assert.match(protection.strategyState.lastError, /precio actual del pool/i);
  assert.equal(decisions.at(-1).finalStrategyStatus, 'spot_stale');
});
