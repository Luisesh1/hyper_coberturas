const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProtectionCandidate,
  buildDeltaNeutralCandidate,
  createProtectedPool,
  deactivateProtectedPool,
  diagnoseDeltaNeutral,
  DYNAMIC_REENTRY_BUFFER_DEFAULT_PCT,
  DYNAMIC_FLIP_COOLDOWN_DEFAULT_SEC,
  DYNAMIC_MAX_SEQUENTIAL_FLIPS_DEFAULT,
  DEFAULT_BAND_MODE,
  DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT,
  DEFAULT_REBALANCE_INTERVAL_SEC,
  DEFAULT_TARGET_HEDGE_RATIO,
  DEFAULT_MIN_REBALANCE_NOTIONAL_USD,
  DEFAULT_MAX_SLIPPAGE_BPS,
  DEFAULT_TWAP_MIN_NOTIONAL_USD,
} = require('../src/services/uniswap-protection.service');

function buildPool(overrides = {}) {
  return {
    mode: 'lp_position',
    version: 'v3',
    network: 'ethereum',
    identifier: '123',
    owner: '0x00000000000000000000000000000000000000AA',
    creator: '0x00000000000000000000000000000000000000AA',
    poolAddress: '0x00000000000000000000000000000000000000BB',
    token0Address: '0x00000000000000000000000000000000000000CC',
    token1Address: '0x00000000000000000000000000000000000000DD',
    rangeLowerPrice: 49000,
    rangeUpperPrice: 51000,
    priceCurrent: 50000,
    currentValueUsd: 1000,
    inRange: true,
    token0: { symbol: 'BTC' },
    token1: { symbol: 'USDC' },
    ...overrides,
  };
}

function buildDeltaNeutralPool(overrides = {}) {
  return buildPool({
    token0: { symbol: 'ETH', decimals: 18 },
    token1: { symbol: 'USDC', decimals: 6 },
    priceCurrent: 2500,
    rangeLowerPrice: 2000,
    rangeUpperPrice: 3000,
    currentValueUsd: 2500,
    liquidity: '2000000000000',
    tickLower: 74000,
    tickUpper: 79000,
    unclaimedFees0: 0.01,
    unclaimedFees1: 12,
    ...overrides,
  });
}

function buildTimeInRangeService(overrides = {}) {
  return {
    computeRangeMetricsForPool: async () => ({
      timeInRangeMs: 86_400_000,
      timeTrackedMs: 172_800_000,
      timeInRangePct: 50,
      rangeLastStateInRange: true,
      rangeLastStateAt: 1710000000000,
      rangeComputedAt: 1710000000000,
      rangeFrozenAt: null,
      rangeResolution: '5m',
    }),
    computeIncrementalRangeMetrics: async () => ({
      timeInRangeMs: 90_000_000,
      timeTrackedMs: 180_000_000,
      timeInRangePct: 50,
      rangeLastStateInRange: false,
      rangeLastStateAt: 1710000900000,
      rangeComputedAt: 1710000900000,
      rangeFrozenAt: 1710000900000,
      rangeResolution: '5m',
    }),
    applyRangeMetricsToSnapshot: (snapshot, metrics) => ({
      ...snapshot,
      timeInRangePct: metrics.timeInRangePct,
      timeInRangeMs: metrics.timeInRangeMs,
      timeTrackedMs: metrics.timeTrackedMs,
      rangeComputedAt: metrics.rangeComputedAt,
      rangeResolution: metrics.rangeResolution,
      rangeFrozenAt: metrics.rangeFrozenAt,
    }),
    ...overrides,
  };
}

test('buildProtectionCandidate infiere el activo HL y deriva size desde currentValueUsd', async () => {
  const candidate = await buildProtectionCandidate(buildPool(), {
    availableAssets: [
      { name: 'BTC', maxLeverage: 40 },
      { name: 'ETH', maxLeverage: 25 },
    ],
    mids: { BTC: '50000' },
  });

  assert.equal(candidate.eligible, true);
  assert.equal(candidate.inferredAsset, 'BTC');
  assert.equal(candidate.maxLeverage, 40);
  assert.equal(candidate.defaultLeverage, 10);
  assert.equal(candidate.baseNotionalUsd, 1000);
  assert.equal(candidate.suggestedNotionalUsd, 1000);
  assert.equal(candidate.hedgeNotionalUsd, 1000);
  assert.equal(candidate.hedgeSize, 0.02);
  assert.equal(candidate.stopLossDifferenceDefaultPct, 0.05);
});

test('buildProtectionCandidate trata WBTC como equivalente a BTC', async () => {
  const candidate = await buildProtectionCandidate(buildPool({
    token0: { symbol: 'WBTC' },
  }), {
    availableAssets: [
      { name: 'BTC', maxLeverage: 40 },
      { name: 'ETH', maxLeverage: 25 },
    ],
    mids: { BTC: '50000' },
  });

  assert.equal(candidate.eligible, true);
  assert.equal(candidate.inferredAsset, 'BTC');
  assert.equal(candidate.hedgeSize, 0.02);
});

test('buildProtectionCandidate trata WETH como equivalente a ETH', async () => {
  const candidate = await buildProtectionCandidate(buildPool({
    token0: { symbol: 'WETH' },
    token1: { symbol: 'USDC' },
    rangeLowerPrice: 2400,
    rangeUpperPrice: 2600,
    priceCurrent: 2500,
  }), {
    availableAssets: [
      { name: 'ETH', maxLeverage: 25 },
      { name: 'BTC', maxLeverage: 40 },
    ],
    mids: { ETH: '2500' },
  });

  assert.equal(candidate.eligible, true);
  assert.equal(candidate.inferredAsset, 'ETH');
  assert.equal(candidate.hedgeSize, 0.4);
});

test('buildProtectionCandidate rechaza pools fuera de rango', async () => {
  const candidate = await buildProtectionCandidate(buildPool({
    inRange: false,
  }), {
    availableAssets: [{ name: 'BTC', maxLeverage: 40 }],
    mids: { BTC: '50000' },
  });

  assert.equal(candidate.eligible, false);
  assert.match(candidate.reason, /dentro de rango/i);
});

test('buildProtectionCandidate rechaza pools con inferencia ambigua', async () => {
  const candidate = await buildProtectionCandidate(buildPool({
    token1: { symbol: 'ETH' },
  }), {
    availableAssets: [
      { name: 'BTC', maxLeverage: 40 },
      { name: 'ETH', maxLeverage: 25 },
    ],
    mids: { BTC: '50000', ETH: '2500' },
  });

  assert.equal(candidate.eligible, false);
  assert.match(candidate.reason, /ambiguo/i);
});

test('buildDeltaNeutralCandidate detecta pools stable + volatil y deriva delta/gamma', async () => {
  const candidate = buildDeltaNeutralCandidate(buildDeltaNeutralPool(), [
    { name: 'ETH', maxLeverage: 25 },
    { name: 'BTC', maxLeverage: 40 },
  ], {
    ETH: '2500',
  });

  assert.equal(candidate.deltaNeutralEligible, true);
  assert.equal(candidate.deltaNeutralAsset, 'ETH');
  assert.equal(candidate.stableTokenSymbol, 'USDC');
  assert.equal(candidate.volatileTokenSymbol, 'ETH');
  assert.ok(Number(candidate.estimatedInitialHedgeQty) > 0);
  assert.ok(Number(candidate.deltaQty) > 0);
  assert.equal(Number.isFinite(Number(candidate.gamma)), true);
});

test('createProtectedPool crea dos coberturas ligadas con parametros correctos', async () => {
  const createdHedges = [];
  const validateCalls = [];
  const protectionWrites = [];

  const result = await createProtectedPool({
    userId: 1,
    pool: buildPool(),
    accountId: 5,
    leverage: 12,
    configuredNotionalUsd: 1500,
    valueMultiplier: 1.5,
    stopLossDifferencePct: 0.08,
  }, {
    availableAssets: [{ name: 'BTC', maxLeverage: 30 }],
    mids: { BTC: '50000' },
    hyperliquidAccountsService: {
      resolveAccount: async () => ({ id: 5, alias: 'Cuenta test', address: '0xabc' }),
    },
    protectedPoolRepository: {
      findReusableByIdentity: async () => null,
      create: async (record) => {
        protectionWrites.push(record);
        return 77;
      },
      updateSnapshot: async () => 77,
      getById: async () => ({ id: 77, status: 'active' }),
    },
    hedgeRepository: {
      unlinkByProtectedPoolId: async () => {},
    },
    hedgeRegistry: {
      getOrCreate: async () => ({
        validateCreateRequest: (payload) => validateCalls.push(payload),
        createHedge: async (payload) => {
          createdHedges.push(payload);
          return {
            id: createdHedges.length,
            status: 'entry_pending',
          };
        },
      }),
    },
    timeInRangeService: buildTimeInRangeService(),
  });

  assert.equal(result.id, 77);
  assert.equal(validateCalls.length, 2);
  assert.equal(createdHedges.length, 2);
  assert.equal(protectionWrites.length, 1);
  assert.equal(createdHedges[0].direction, 'short');
  assert.equal(createdHedges[0].entryPrice, 49000);
  assert.equal(createdHedges[0].exitPrice, 49039.2);
  assert.equal(createdHedges[0].size, 0.03);
  assert.equal(createdHedges[0].protectedPoolId, 77);
  assert.equal(createdHedges[0].protectedRole, 'downside');
  assert.equal(createdHedges[1].direction, 'long');
  assert.equal(createdHedges[1].entryPrice, 51000);
  assert.equal(createdHedges[1].exitPrice, 50959.2);
  assert.equal(createdHedges[1].size, 0.03);
  assert.equal(createdHedges[1].protectedRole, 'upside');
  assert.equal(protectionWrites[0].configuredHedgeNotionalUsd, 1500);
  assert.equal(protectionWrites[0].valueMultiplier, 1.5);
  assert.equal(protectionWrites[0].stopLossDifferencePct, 0.08);
  assert.equal(protectionWrites[0].protectionMode, 'static');
  assert.equal(protectionWrites[0].dynamicState, null);
});

test('createProtectedPool usa 0.05 como diferencia SL por defecto', async () => {
  const createdHedges = [];

  await createProtectedPool({
    userId: 1,
    pool: buildPool(),
    accountId: 5,
    leverage: 10,
    configuredNotionalUsd: 1000,
    valueMultiplier: null,
  }, {
    availableAssets: [{ name: 'BTC', maxLeverage: 30 }],
    mids: { BTC: '50000' },
    hyperliquidAccountsService: {
      resolveAccount: async () => ({ id: 5, alias: 'Cuenta test', address: '0xabc' }),
    },
    protectedPoolRepository: {
      findReusableByIdentity: async () => null,
      create: async () => 90,
      updateSnapshot: async () => 90,
      getById: async () => ({ id: 90, status: 'active' }),
    },
    hedgeRepository: {
      unlinkByProtectedPoolId: async () => {},
    },
    hedgeRegistry: {
      getOrCreate: async () => ({
        validateCreateRequest: () => {},
        createHedge: async (payload) => {
          createdHedges.push(payload);
          return { id: createdHedges.length, status: 'entry_pending' };
        },
      }),
    },
    timeInRangeService: buildTimeInRangeService(),
  });

  assert.equal(createdHedges[0].exitPrice, 49024.5);
  assert.equal(createdHedges[1].exitPrice, 50974.5);
});

test('createProtectedPool reactiva un pool inactivo sin duplicar el registro', async () => {
  const createdHedges = [];
  const reactivated = [];

  const result = await createProtectedPool({
    userId: 1,
    pool: buildPool(),
    accountId: 5,
    leverage: 9,
    configuredNotionalUsd: 1000,
    valueMultiplier: null,
  }, {
    availableAssets: [{ name: 'BTC', maxLeverage: 30 }],
    mids: { BTC: '50000' },
    hyperliquidAccountsService: {
      resolveAccount: async () => ({ id: 5, alias: 'Cuenta test', address: '0xabc' }),
    },
    protectedPoolRepository: {
      findReusableByIdentity: async () => ({ id: 55, status: 'inactive' }),
      reactivate: async (userId, id, record) => {
        reactivated.push({ userId, id, record });
        return id;
      },
      getById: async () => ({ id: 55, status: 'active' }),
    },
    hedgeRepository: {
      unlinkByProtectedPoolId: async () => {},
    },
    hedgeRegistry: {
      getOrCreate: async () => ({
        validateCreateRequest: () => {},
        createHedge: async (payload) => {
          createdHedges.push(payload);
          return { id: createdHedges.length, status: 'entry_pending' };
        },
      }),
    },
    timeInRangeService: buildTimeInRangeService(),
  });

  assert.equal(result.id, 55);
  assert.equal(reactivated.length, 1);
  assert.equal(reactivated[0].id, 55);
  assert.equal(createdHedges[0].protectedPoolId, 55);
  assert.equal(createdHedges[1].protectedPoolId, 55);
});

test('createProtectedPool guarda configuracion dinamica y defaults operativos', async () => {
  const protectionWrites = [];

  await createProtectedPool({
    userId: 1,
    pool: buildPool(),
    accountId: 5,
    leverage: 10,
    configuredNotionalUsd: 1000,
    protectionMode: 'dynamic',
  }, {
    availableAssets: [{ name: 'BTC', maxLeverage: 30 }],
    mids: { BTC: '50000' },
    hyperliquidAccountsService: {
      resolveAccount: async () => ({ id: 5, alias: 'Cuenta test', address: '0xabc' }),
    },
    protectedPoolRepository: {
      findReusableByIdentity: async () => null,
      create: async (record) => {
        protectionWrites.push(record);
        return 91;
      },
      updateSnapshot: async () => 91,
      getById: async () => ({ id: 91, status: 'active' }),
    },
    hedgeRepository: {
      unlinkByProtectedPoolId: async () => {},
    },
    hedgeRegistry: {
      getOrCreate: async () => ({
        validateCreateRequest: () => {},
        createHedge: async (payload) => ({ id: payload.direction === 'short' ? 1 : 2, status: 'entry_pending' }),
      }),
    },
    timeInRangeService: buildTimeInRangeService(),
  });

  assert.equal(protectionWrites.length, 1);
  assert.equal(protectionWrites[0].protectionMode, 'dynamic');
  assert.equal(protectionWrites[0].reentryBufferPct, DYNAMIC_REENTRY_BUFFER_DEFAULT_PCT);
  assert.equal(protectionWrites[0].flipCooldownSec, DYNAMIC_FLIP_COOLDOWN_DEFAULT_SEC);
  assert.equal(protectionWrites[0].maxSequentialFlips, DYNAMIC_MAX_SEQUENTIAL_FLIPS_DEFAULT);
  assert.equal(protectionWrites[0].dynamicState.phase, 'neutral');
  assert.equal(protectionWrites[0].dynamicState.upperReentryPrice, 51000 * (1 - DYNAMIC_REENTRY_BUFFER_DEFAULT_PCT));
});

test('createProtectedPool crea una proteccion delta-neutral con defaults y bootstrap', async () => {
  const protectionWrites = [];
  const bootstrapCalls = [];

  const created = {
    id: 120,
    userId: 1,
    accountId: 5,
    status: 'active',
    protectionMode: 'delta_neutral',
    inferredAsset: 'ETH',
    poolSnapshot: buildDeltaNeutralPool(),
    strategyState: null,
  };

  const result = await createProtectedPool({
    userId: 1,
    pool: buildDeltaNeutralPool(),
    accountId: 5,
    leverage: 7,
    configuredNotionalUsd: 2500,
    protectionMode: 'delta_neutral',
  }, {
    availableAssets: [{ name: 'ETH', maxLeverage: 25 }],
    mids: { ETH: '2500' },
    hyperliquidAccountsService: {
      resolveAccount: async () => ({ id: 5, alias: 'Cuenta test', address: '0xabc' }),
    },
    protectedPoolRepository: {
      findReusableByIdentity: async () => null,
      listActiveByUser: async () => [],
      create: async (record) => {
        protectionWrites.push(record);
        return 120;
      },
      updateSnapshot: async () => 120,
      getById: async () => created,
    },
    protectedPoolDeltaNeutralService: {
      bootstrapProtection: async (protection) => {
        bootstrapCalls.push(protection.id);
      },
    },
    timeInRangeService: buildTimeInRangeService(),
  });

  assert.equal(result.id, 120);
  assert.equal(protectionWrites.length, 1);
  assert.equal(protectionWrites[0].protectionMode, 'delta_neutral');
  assert.equal(protectionWrites[0].bandMode, DEFAULT_BAND_MODE);
  assert.equal(protectionWrites[0].baseRebalancePriceMovePct, DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT);
  assert.equal(protectionWrites[0].rebalanceIntervalSec, DEFAULT_REBALANCE_INTERVAL_SEC);
  assert.equal(protectionWrites[0].targetHedgeRatio, DEFAULT_TARGET_HEDGE_RATIO);
  assert.equal(protectionWrites[0].minRebalanceNotionalUsd, DEFAULT_MIN_REBALANCE_NOTIONAL_USD);
  assert.equal(protectionWrites[0].maxSlippageBps, DEFAULT_MAX_SLIPPAGE_BPS);
  assert.equal(protectionWrites[0].twapMinNotionalUsd, DEFAULT_TWAP_MIN_NOTIONAL_USD);
  assert.equal(protectionWrites[0].minOrderNotionalUsd, 11);
  assert.equal(protectionWrites[0].initialConfiguredHedgeNotionalUsd, 2500);
  assert.equal(protectionWrites[0].marginMode, 'isolated');
  assert.ok(protectionWrites[0].strategyState);
  assert.equal(bootstrapCalls.length, 1);
  assert.equal(bootstrapCalls[0], 120);
});

test('createProtectedPool delta-neutral deja snapshot_invalid y no bootstrappea si el snapshot no es operativo', async () => {
  const protectionWrites = [];
  const bootstrapCalls = [];

  await createProtectedPool({
    userId: 1,
    pool: buildDeltaNeutralPool({
      token0: { symbol: 'ETH' },
      token1: { symbol: 'USDC' },
    }),
    accountId: 5,
    leverage: 7,
    configuredNotionalUsd: 2500,
    protectionMode: 'delta_neutral',
  }, {
    availableAssets: [{ name: 'ETH', maxLeverage: 25 }],
    mids: { ETH: '2500' },
    hyperliquidAccountsService: {
      resolveAccount: async () => ({ id: 5, alias: 'Cuenta test', address: '0xabc' }),
    },
    protectedPoolRepository: {
      findReusableByIdentity: async () => null,
      listActiveByUser: async () => [],
      create: async (record) => {
        protectionWrites.push(record);
        return 120;
      },
      updateSnapshot: async () => 120,
      getById: async () => ({
        id: 120,
        userId: 1,
        accountId: 5,
        status: 'active',
        protectionMode: 'delta_neutral',
        inferredAsset: 'ETH',
        poolSnapshot: protectionWrites[0]?.poolSnapshot || null,
        strategyState: protectionWrites[0]?.strategyState || null,
      }),
    },
    protectedPoolDeltaNeutralService: {
      bootstrapProtection: async (protection) => {
        bootstrapCalls.push(protection.id);
      },
    },
    timeInRangeService: buildTimeInRangeService(),
  });

  assert.equal(protectionWrites.length, 1);
  assert.equal(protectionWrites[0].snapshotStatus, 'invalid');
  assert.equal(protectionWrites[0].strategyEngineVersion, 'v2');
  assert.equal(protectionWrites[0].strategyState.status, 'snapshot_invalid');
  assert.equal(bootstrapCalls.length, 0);
});

test('createProtectedPool delta-neutral rechaza conflictos por activo en la misma cuenta', async () => {
  await assert.rejects(() => createProtectedPool({
    userId: 1,
    pool: buildDeltaNeutralPool(),
    accountId: 5,
    leverage: 7,
    configuredNotionalUsd: 2500,
    protectionMode: 'delta_neutral',
  }, {
    availableAssets: [{ name: 'ETH', maxLeverage: 25 }],
    mids: { ETH: '2500' },
    hyperliquidAccountsService: {
      resolveAccount: async () => ({ id: 5, alias: 'Cuenta test', address: '0xabc' }),
    },
    protectedPoolRepository: {
      findReusableByIdentity: async () => null,
      listActiveByUser: async () => [{
        id: 999,
        status: 'active',
        accountId: 5,
        inferredAsset: 'ETH',
      }],
    },
  }), /otra proteccion activa en ETH/i);
});

test('diagnoseDeltaNeutral usa trading service real y devuelve warnings parciales', async () => {
  const protection = {
    id: 5,
    userId: 1,
    accountId: 8,
    status: 'active',
    protectionMode: 'delta_neutral',
    createdAt: 1710000000000,
    network: 'arbitrum',
    version: 'v3',
    inferredAsset: 'ETH',
    leverage: 7,
    marginMode: 'isolated',
    hedgeSize: 0.0174,
    hedgeNotionalUsd: 45,
    bandMode: DEFAULT_BAND_MODE,
    baseRebalancePriceMovePct: DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT,
    rebalanceIntervalSec: DEFAULT_REBALANCE_INTERVAL_SEC,
    targetHedgeRatio: DEFAULT_TARGET_HEDGE_RATIO,
    minRebalanceNotionalUsd: DEFAULT_MIN_REBALANCE_NOTIONAL_USD,
    maxSlippageBps: DEFAULT_MAX_SLIPPAGE_BPS,
    twapMinNotionalUsd: DEFAULT_TWAP_MIN_NOTIONAL_USD,
    executionMode: 'auto',
    maxSpreadBps: 30,
    maxExecutionFeeUsd: 25,
    minOrderNotionalUsd: null,
    twapSlices: 5,
    twapDurationSec: 60,
    rangeLowerPrice: 2000,
    rangeUpperPrice: 3000,
    priceCurrent: 2500,
    walletAddress: '0x00000000000000000000000000000000000000AA',
    poolAddress: '0x00000000000000000000000000000000000000BB',
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    snapshotStatus: 'ready',
    snapshotFreshAt: Date.now(),
    snapshotHash: 'hash-1',
    strategyEngineVersion: 'v2',
    strategyState: {
      status: 'tracking',
      lastActualQty: 0.0174,
      lastTargetQty: 0.0175,
      distanceToLiqPct: 8.5,
      lastDecision: 'hold',
      lastDecisionReason: 'within_cost_aware_band',
      lastSpotFailureAt: 1710000001234,
      lastSpotFailureReason: 'request timeout',
    },
    poolSnapshot: buildDeltaNeutralPool(),
  };

  const diagnostics = await diagnoseDeltaNeutral(1, 5, {
    protectedPoolRepository: {
      getById: async () => protection,
    },
    protectionDecisionLogRepository: {
      listByProtectedPoolId: async () => ([{
        decision: 'hold',
        reason: 'within_cost_aware_band',
        spotSource: 'snapshot',
        finalStrategyStatus: 'tracking',
        riskGateTriggered: false,
        liquidationDistancePct: 8.5,
      }]),
    },
    deltaRebalanceLogRepository: {
      listByProtectedPoolId: async () => ([{
        reason: 'restart_reconcile',
      }]),
    },
    getTradingService: async () => ({
      getAccountState: async () => ({
        account: { alias: 'Cuenta test' },
        accountValue: 150,
        totalMarginUsed: 20,
        totalNtlPos: 45,
        withdrawable: 120,
        positions: [{
          asset: 'ETH',
          size: '-0.0174',
          side: 'short',
          leverage: { type: 'isolated', value: 7 },
          liquidationPrice: 2710,
          unrealizedPnl: 1.25,
          marginUsed: 7,
        }],
        lastUpdatedAt: 1710000002000,
      }),
      getOpenOrders: async () => {
        throw new Error('orders timeout');
      },
    }),
    hyperliquidRegistry: {
      getOrCreate: async () => ({
        getPosition: async () => ({
          asset: 'ETH',
          szi: '-0.0174',
          leverage: { type: 'isolated', value: 7 },
          liquidationPx: 2710,
          unrealizedPnl: 1.25,
          marginUsed: 7,
        }),
      }),
    },
  });

  assert.equal(diagnostics.checks.hyperliquid.account.accountValue, 150);
  assert.equal(diagnostics.checks.hyperliquid.position.asset, 'ETH');
  assert.equal(diagnostics.checks.hyperliquid.position.side, 'short');
  assert.equal(diagnostics.checks.hyperliquid.openOrders, null);
  assert.equal(diagnostics.configuration.minOrderNotionalUsd, 11);
  assert.equal(diagnostics.spot.source, 'snapshot');
  assert.ok(Array.isArray(diagnostics.warnings));
  assert.match(diagnostics.warnings[0], /open_orders_unavailable/i);
});

test('createProtectedPool rechaza configuracion dinamica insegura por solapamiento wire', async () => {
  await assert.rejects(() => createProtectedPool({
    userId: 1,
    pool: buildPool(),
    accountId: 5,
    leverage: 10,
    configuredNotionalUsd: 1000,
    protectionMode: 'dynamic',
    reentryBufferPct: 0.0001,
    stopLossDifferencePct: 0.05,
  }, {
    availableAssets: [{ name: 'BTC', maxLeverage: 30 }],
    mids: { BTC: '50000' },
    hyperliquidAccountsService: {
      resolveAccount: async () => ({ id: 5, alias: 'Cuenta test', address: '0xabc' }),
    },
    protectedPoolRepository: {
      findReusableByIdentity: async () => null,
    },
  }), /Configuracion dinamica insegura/i);
});

test('createProtectedPool rechaza pools que ya tienen proteccion activa', async () => {
  await assert.rejects(() => createProtectedPool({
    userId: 1,
    pool: buildPool(),
    accountId: 5,
    leverage: 10,
    configuredNotionalUsd: 1000,
  }, {
    availableAssets: [{ name: 'BTC', maxLeverage: 30 }],
    mids: { BTC: '50000' },
    hyperliquidAccountsService: {
      resolveAccount: async () => ({ id: 5, alias: 'Cuenta test', address: '0xabc' }),
    },
    protectedPoolRepository: {
      findReusableByIdentity: async () => ({ id: 44, status: 'active' }),
    },
  }), /proteccion activa/i);
});

test('deactivateProtectedPool cancela hedges activos, desvincula hedges y marca la proteccion inactiva', async () => {
  const cancelled = [];
  const unlinked = [];
  let readCount = 0;

  const result = await deactivateProtectedPool(1, 22, {
    protectedPoolRepository: {
      getById: async () => {
        readCount += 1;
        if (readCount === 1) {
          return {
            id: 22,
            accountId: 5,
            status: 'active',
            hedges: {
              downside: { id: 201, status: 'entry_pending' },
              upside: { id: 202, status: 'cancelled' },
            },
          };
        }
        return {
          id: 22,
          accountId: 5,
          status: 'inactive',
          hedges: {
            downside: { id: 201, status: 'cancel_pending' },
            upside: { id: 202, status: 'cancelled' },
          },
        };
      },
      deactivate: async () => 22,
    },
    hedgeRepository: {
      unlinkByProtectedPoolId: async (id) => {
        unlinked.push(id);
      },
    },
    hedgeRegistry: {
      getOrCreate: async () => ({
        cancelHedge: async (id) => {
          cancelled.push(id);
        },
      }),
    },
    timeInRangeService: buildTimeInRangeService(),
  });

  assert.deepEqual(cancelled, [201]);
  assert.deepEqual(unlinked, [22]);
  assert.equal(result.status, 'inactive');
});

test('deactivateProtectedPool delega la desactivacion delta-neutral al servicio dedicado', async () => {
  const delegated = [];

  const result = await deactivateProtectedPool(1, 33, {
    protectedPoolRepository: {
      getById: async () => ({
        id: 33,
        accountId: 5,
        status: 'active',
        protectionMode: 'delta_neutral',
        inferredAsset: 'ETH',
      }),
    },
    protectedPoolDeltaNeutralService: {
      requestDeactivate: async (protection) => {
        delegated.push(protection.id);
        return { ...protection, strategyState: { status: 'deactivating' } };
      },
    },
  });

  assert.deepEqual(delegated, [33]);
  assert.equal(result.strategyState.status, 'deactivating');
});
