const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProtectedPoolDeltaNeutralService,
  computeVolatilityStats,
  deriveBandSettings,
} = require('../src/services/protected-pool-delta-neutral.service');
const {
  buildCooldown,
  isCooldownActive,
} = require('../src/services/protected-pool-delta-neutral.helpers');

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

function makeHybridTestDeps() {
  return {
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
    ...makeHybridTestDeps(),
  });
  service._fetchSpot = async () => ({ priceCurrent: 2500 });

  const result = await service.evaluateProtection(protection);

  assert.ok(['healthy', 'tracking'].includes(result.status));
  assert.notEqual(result.status, 'rebalance_pending');
  assert.equal(result.lastDecision, 'hold');
  assert.equal(updates.at(-1).strategyState.status, result.status);
  assert.equal(decisions.at(-1).finalStrategyStatus, result.status);
});

test('_buildPreflight permite ejecutar con drift entre 11 y 25 USD', async () => {
  const service = new ProtectedPoolDeltaNeutralService();

  const preflight = await service._buildPreflight({
    protection: {
      leverage: 7,
      snapshotStatus: 'ready',
      minOrderNotionalUsd: null,
    },
    hl: {
      getClearinghouseState: async () => ({ withdrawable: '1000' }),
    },
    strategyState: {
      status: 'tracking',
      nextEligibleAttemptAt: null,
      cooldownReason: null,
    },
    currentPrice: 2500,
    tracking: {
      trackingErrorQty: 0.0048,
      trackingErrorUsd: 12,
    },
    bands: {
      estimatedCostUsd: 0.01,
    },
    decision: 'rebalance_partial',
  });

  assert.equal(preflight.ok, true);
  assert.equal(preflight.status, 'rebalance_pending');
});

test('_buildPreflight sigue bloqueando drift por debajo de 11 USD', async () => {
  const service = new ProtectedPoolDeltaNeutralService();

  const preflight = await service._buildPreflight({
    protection: {
      leverage: 7,
      snapshotStatus: 'ready',
      minOrderNotionalUsd: null,
    },
    hl: {
      getClearinghouseState: async () => ({ withdrawable: '1000' }),
    },
    strategyState: {
      status: 'tracking',
      nextEligibleAttemptAt: null,
      cooldownReason: null,
    },
    currentPrice: 2500,
    tracking: {
      trackingErrorQty: 0.004,
      trackingErrorUsd: 10,
    },
    bands: {
      estimatedCostUsd: 0.01,
    },
    decision: 'rebalance_partial',
  });

  assert.equal(preflight.ok, false);
  assert.equal(preflight.reason, 'below_min_order_notional');
});

test('isCooldownActive ignora strategyState heredado cuando protection ya define nextEligibleAttemptAt nulo', () => {
  const active = isCooldownActive(
    { nextEligibleAttemptAt: null },
    { nextEligibleAttemptAt: Date.now() + 60_000 },
  );

  assert.equal(active, false);
});

test('_buildPreflight usa cooldownReason persistido y no hereda uno obsoleto del strategyState', async () => {
  const service = new ProtectedPoolDeltaNeutralService();

  const preflight = await service._buildPreflight({
    protection: {
      leverage: 7,
      snapshotStatus: 'ready',
      nextEligibleAttemptAt: Date.now() + 60_000,
      cooldownReason: null,
    },
    hl: {
      getClearinghouseState: async () => ({ withdrawable: '1000' }),
    },
    strategyState: {
      status: 'tracking',
      nextEligibleAttemptAt: Date.now() + 120_000,
      cooldownReason: 'stale_margin_reason',
    },
    currentPrice: 2500,
    tracking: {
      trackingErrorQty: 0.0048,
      trackingErrorUsd: 12,
    },
    bands: {
      estimatedCostUsd: 0.01,
    },
    decision: 'rebalance_partial',
  });

  assert.equal(preflight.ok, false);
  assert.equal(preflight.reason, 'cooldown_active');
  assert.equal(preflight.executionSkippedBecause, 'cooldown_active');
});

test('buildCooldown trata "insufficient margin" como cooldown de margen', () => {
  const cooldown = buildCooldown(new Error('Insufficient margin available for order'), {
    status: 'tracking',
  });

  assert.equal(cooldown.status, 'margin_pending');
  assert.match(String(cooldown.cooldownReason), /insufficient margin/i);
  assert.equal(Number.isFinite(cooldown.nextEligibleAttemptAt), true);
});

test('evaluateProtection deja risk_paused cuando la distancia a liquidacion es demasiado baja', async () => {
  const decisions = [];
  let openCalls = 0;
  let closeCalls = 0;
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
          szi: '-0.001',
          liquidationPx: 2650,
          leverage: { type: 'isolated', value: 7 },
          unrealizedPnl: 0,
        }),
        getClearinghouseState: async () => ({ withdrawable: '1000' }),
        getCandleSnapshot: async () => [],
      }),
    },
    getTradingService: async () => ({
      openPosition: async () => {
        openCalls += 1;
        return { fillPrice: 2500 };
      },
      closePosition: async () => {
        closeCalls += 1;
        return { closePrice: 2500 };
      },
    }),
    marketService: {
      getAssetContexts: async () => [],
    },
    logger: {
      warn: () => {},
      error: () => {},
    },
    ...makeHybridTestDeps(),
  });
  service._fetchSpot = async () => ({ priceCurrent: 2500 });

  const result = await service.evaluateProtection(protection);

  assert.equal(result.status, 'risk_paused');
  assert.match(result.lastError, /distancia a liquidacion/i);
  assert.equal(result.lastDecision, 'hold');
  assert.equal(decisions.at(-1).finalStrategyStatus, 'risk_paused');
  assert.equal(decisions.at(-1).riskGateTriggered, true);
  assert.equal(openCalls, 0);
  assert.equal(closeCalls, 0);
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
    ...makeHybridTestDeps(),
  });
  service._fetchSpot = async () => null;

  const result = await service.evaluateProtection(protection);

  assert.equal(result, null);
  assert.equal(protection.strategyState.status, 'spot_stale');
  assert.match(protection.strategyState.lastError, /precio actual del pool/i);
  assert.equal(decisions.at(-1).finalStrategyStatus, 'spot_stale');
});
