const test = require('node:test');
const assert = require('node:assert/strict');

const { TERMINAL_RANGE_V1 } = require('../src/services/terminal-range-policy.service');
const {
  FULL_DELTA_POLICIES,
  SELECTABLE_LIVE_POLICIES,
  policyOwnsFullDelta,
  policyOwnsTarget,
  policyHonorsCenterDeadZone,
  resolveNoOpZone,
  resolveExposureMeasureUsd,
  resolveLivePolicy,
} = require('../src/services/protected-pool-delta-neutral.helpers');
const { computeInitialTerminalQty } = require('../src/services/protected-pool-delta-neutral/terminal-range');
const { protectionConfigSchema } = require('../src/schemas/lp-orchestrator.schema');
const {
  ProtectedPoolDeltaNeutralService,
} = require('../src/services/protected-pool-delta-neutral.service');

// --- Registro --------------------------------------------------------------

test('terminal es seleccionable como viva y no cae a legacy', () => {
  assert.ok(SELECTABLE_LIVE_POLICIES.includes(TERMINAL_RANGE_V1));
  assert.equal(resolveLivePolicy({ policyVersion: TERMINAL_RANGE_V1, executionIntent: 'live' }), TERMINAL_RANGE_V1);
  // En sombra no ejecuta: la viva sigue siendo legacy, como con las demas.
  assert.equal(resolveLivePolicy({ policyVersion: TERMINAL_RANGE_V1, executionIntent: 'shadow' }), 'legacy_zones_v1');
});

test('terminal fija su objetivo pero NO es delta completo', () => {
  // Si estuviera en la lista de delta completo, el alta la dimensionaria al
  // delta y cualquier lector de esa lista asumiria un objetivo que no es el suyo.
  assert.ok(!FULL_DELTA_POLICIES.includes(TERMINAL_RANGE_V1));
  assert.equal(policyOwnsFullDelta(TERMINAL_RANGE_V1, 'live'), false);
  // Pero tampoco hereda los escalones de zona legacy.
  assert.equal(policyOwnsTarget(TERMINAL_RANGE_V1, 'live'), true);
  assert.equal(policyOwnsTarget(TERMINAL_RANGE_V1, 'shadow'), false);
  // Las existentes no cambian.
  for (const policy of FULL_DELTA_POLICIES) assert.equal(policyOwnsTarget(policy, 'live'), true);
  assert.equal(policyOwnsTarget('legacy_zones_v1', 'live'), false);
});

test('sin zona muerta configurable; su banda sin operacion es la de sus umbrales', () => {
  assert.equal(policyHonorsCenterDeadZone(TERMINAL_RANGE_V1), false);
  assert.deepEqual(resolveNoOpZone(TERMINAL_RANGE_V1, 10), { kind: 'center', pct: 40 });
  // range_exit sigue igual.
  assert.deepEqual(resolveNoOpZone('range_exit_v1', 40), { kind: 'full_range', pct: 100 });
});

test('la exposicion de terminal se mide contra lo que ella ordeno, no contra el delta', () => {
  const usd = resolveExposureMeasureUsd({
    livePolicy: TERMINAL_RANGE_V1, actualQty: 1, deltaQty: 0.5, committedTargetQty: 1, currentPrice: 2000,
  });
  assert.equal(usd, 0);
});

const BASE = { enabled: true, accountId: 1, leverage: 3, configuredNotionalUsd: 300 };

test('el schema acepta terminal con su perfil y rechaza parametros invalidos', () => {
  const ok = protectionConfigSchema.safeParse({
    ...BASE, policyVersion: TERMINAL_RANGE_V1, executionIntent: 'live', activationConfirmed: true,
    terminalRangeConfig: { threshold: 0.4, confirmMinutes: 2 },
  });
  assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error?.issues));
  assert.deepEqual(ok.data.terminalRangeConfig, { threshold: 0.4, confirmMinutes: 2 });

  for (const terminalRangeConfig of [
    { threshold: 1.2, confirmMinutes: 2 },
    { threshold: 0.4, confirmMinutes: 1.5 },
    { threshold: 0.4, confirmMinutes: 2, reversalThreshold: 0.6 },
  ]) {
    const bad = protectionConfigSchema.safeParse({ ...BASE, policyVersion: TERMINAL_RANGE_V1, terminalRangeConfig });
    assert.equal(bad.success, false, JSON.stringify(terminalRangeConfig));
  }
});

// --- Evaluador --------------------------------------------------------------

const PRICE = 2500;

function buildProtection(overrides = {}) {
  return {
    id: 91,
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
    leverage: 3,
    policyVersion: TERMINAL_RANGE_V1,
    rangeLowerPrice: 2000,
    rangeUpperPrice: 3000,
    priceCurrent: PRICE,
    snapshotStatus: 'ready',
    snapshotFreshAt: Date.now(),
    minOrderNotionalUsd: 11,
    strategyState: {
      policyVersion: TERMINAL_RANGE_V1,
      executionIntent: 'live',
      terminalRangeConfig: { threshold: 0.4, confirmMinutes: 2 },
      lastRebalanceAt: Date.now() - 60_000,
      // Minimo de permanencia vigente: a terminal no la frena.
      minDwellUntil: Date.now() + 10 * 60_000,
      lastSnapshotPrice: PRICE,
      modelConfidence: 'high',
      // Estado de OTRAS politicas: no se toca.
      rangeExitPolicyState: { rangeKey: 'x', zone: 'inside', committedTargetQty: 0.42 },
      netProfitPolicyState: { rotationBudgetDay: 3, rotationBudgetCount: 1 },
    },
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
      tickLower: -200311,
      tickUpper: -196257,
      liquidity: '2000000000000000',
      rangeLowerPrice: 2000,
      rangeUpperPrice: 3000,
      priceCurrent: PRICE,
      currentValueUsd: 2500,
      inRange: true,
      unclaimedFees0: 0,
      unclaimedFees1: 0,
      snapshotFreshAt: Date.now(),
    },
    ...overrides,
  };
}

function buildService(protection, { onExecute, actualQty = 0 } = {}) {
  const service = new ProtectedPoolDeltaNeutralService({
    protectedPoolRepository: {
      getById: async () => protection,
      updateStrategyState: async (_userId, _id, payload) => {
        if (payload.strategyState) protection.strategyState = payload.strategyState;
      },
    },
    protectionDecisionLogRepository: { create: async () => {} },
    hlRegistry: {
      getOrCreate: async () => ({
        getPosition: async () => (actualQty > 0
          ? { coin: 'ETH', szi: String(-actualQty), leverage: { type: 'isolated', value: 3 } }
          : null),
        getClearinghouseState: async () => ({ withdrawable: '100000' }),
        getCandleSnapshot: async () => [],
        getUserFills: async () => [],
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
  service._executeRebalance = async ({ strategyState, reason, metrics }) => {
    onExecute?.({ reason, metrics, strategyState });
    return { ...strategyState, lastRebalanceReason: reason, executed: true };
  };
  return service;
}

test('en vivo abre con la secante —no con el delta— y con su propio motivo', async () => {
  const protection = buildProtection();
  const priorOthers = {
    rangeExitPolicyState: protection.strategyState.rangeExitPolicyState,
    netProfitPolicyState: protection.strategyState.netProfitPolicyState,
  };
  let ejecucion = null;
  const service = buildService(protection, { onExecute: (e) => { ejecucion = e; } });

  await service.evaluateProtection(protection);

  assert.ok(ejecucion, 'la apertura del ciclo tiene que ejecutar pese al min-dwell');
  assert.equal(ejecucion.reason, TERMINAL_RANGE_V1);
  const secante = computeInitialTerminalQty(protection.poolSnapshot, { volatilePriceUsd: PRICE });
  assert.ok(secante > 0);
  assert.ok(
    Math.abs(ejecucion.metrics.targetQty - secante) / secante < 0.01,
    `target ${ejecucion.metrics.targetQty} vs secante ${secante}`,
  );
  assert.notEqual(ejecucion.metrics.targetQty, ejecucion.metrics.deltaQty);
  assert.ok(ejecucion.metrics.terminalIntentId, 'la orden lleva el id de su intencion');

  const state = ejecucion.strategyState;
  assert.equal(state.terminalRangePolicyGate, 'cycle_open');
  assert.equal(state.lastDecisionReason, 'cycle_open');
  assert.equal(state.terminalRangePolicyState.pendingIntent.id, ejecucion.metrics.terminalIntentId);
  assert.equal(state.terminalRangePolicyState.side, undefined, 'el lado no avanza sin fill');
  // Aislamiento: los bloques de las otras politicas quedan tal cual.
  assert.deepEqual(state.rangeExitPolicyState, priorOthers.rangeExitPolicyState);
  assert.deepEqual(state.netProfitPolicyState, priorOthers.netProfitPolicyState);
});

test('con la orden cumplida se queda quieta: sin legacy, sin zona muerta, sin delta', async () => {
  const protection = buildProtection();
  const secante = computeInitialTerminalQty(protection.poolSnapshot, { volatilePriceUsd: PRICE });
  const now = Date.now();
  protection.strategyState = {
    ...protection.strategyState,
    terminalRangePolicyState: {
      rangeKey: '2000.00000000:3000.00000000',
      cycleId: 1,
      anchorPrice: PRICE,
      openedAt: now - 3_600_000,
      baselineValueUsd: 2500,
      hedgeNetBaselineUsd: 0,
      liquidity: protection.poolSnapshot.liquidity,
      side: 0,
      zone: 'inside',
      committedTargetQty: secante,
      pendingIntent: null,
      minute: { bucket: Math.floor(now / 60_000), lastPrice: PRICE },
    },
  };
  let ejecucion = null;
  const service = buildService(protection, { onExecute: (e) => { ejecucion = e; }, actualQty: secante });

  await service.evaluateProtection(protection);

  assert.equal(ejecucion, null, 'dentro de la banda central y con la orden cumplida no opera');
  assert.equal(protection.strategyState.terminalRangePolicyGate, 'balanced_hold');
  assert.equal(protection.strategyState.lastDecisionReason, 'balanced_hold');
  assert.ok(Math.abs(protection.strategyState.lastTargetQty - secante) < 1e-9);
});
