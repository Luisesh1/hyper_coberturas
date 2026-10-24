const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DECISION_STATE_KEYS,
  KEPT_STATE_KEYS,
  resetDecisionStateForNewSegment,
} = require('../src/services/protected-pool-delta-neutral/segment-reset');
const {
  ProtectedPoolDeltaNeutralService,
} = require('../src/services/protected-pool-delta-neutral.service');
const { NET_PROFIT_V2, decideNetProfitV1 } = require('../src/services/net-profit-policy.service');
const protectedPoolRepo = require('../src/repositories/protected-uniswap-pool.repository');
const protectedPoolRefreshService = require('../src/services/protected-pool-refresh.service');
const { updateProtectionRecords } = require('../src/services/uniswap/actions/finalize');

const ACCUMULATORS = {
  lastReconciledFillsAt: 1234,
  hedgeRealizedPnlUsd: 12.5,
  executionFeesUsd: 1.5,
  slippageUsd: 0.7,
  fundingAccumUsd: -3,
  fundingAllTimeBaselineUsd: 4,
  policyVersion: 'net_profit_v2',
  executionIntent: 'live',
  terminalRangeConfig: { enabled: true },
};

function dirtyState() {
  const state = { ...ACCUMULATORS };
  for (const key of DECISION_STATE_KEYS) state[key] = { stale: key };
  state.shadowSnapshots = {
    net_profit_v1: { actualQty: 0.4, markPrice: 100, shadowPolicyState: { cooldown: 1 } },
    range_exit_v1: { actualQty: 0.2, markPrice: 100, shadowPolicyState: { latch: true } },
  };
  return state;
}

test('el reset borra cada clave de decision y conserva los acumuladores', () => {
  const input = dirtyState();
  const out = resetDecisionStateForNewSegment(input);
  for (const key of DECISION_STATE_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(out, key), false, `${key} debe borrarse`);
  }
  for (const [key, value] of Object.entries(ACCUMULATORS)) {
    assert.deepEqual(out[key], value, `${key} se conserva`);
  }
  assert.equal(out.pendingForceReason, 'segment_opened');
  assert.deepEqual(out.shadowSnapshots.net_profit_v1, { actualQty: 0.4, markPrice: 100, shadowPolicyState: {} });
  assert.deepEqual(out.shadowSnapshots.range_exit_v1.shadowPolicyState, {});
  assert.equal(out.shadowSnapshots.range_exit_v1.actualQty, 0.2);
  assert.deepEqual(input.shadowSnapshots.net_profit_v1.shadowPolicyState, { cooldown: 1 }, 'no muta la entrada');
});

// Claves que `evaluate.js` escribe en `nextState` (literal + asignaciones).
const EVALUATE_WRITTEN_KEYS = [
  'status', 'lastSnapshotPrice', 'lastDeltaQty', 'lastGamma', 'lastTargetQty', 'lastShadowTargetQty',
  'lastActualQty', 'monitorHeartbeatAt', 'coverageRatioPct', 'effectiveBandPct', 'rv4hPct', 'rv24hPct',
  'fundingAccumUsd', 'fundingAllTimeBaselineUsd', 'hedgeUnrealizedPnlUsd', 'hedgeRealizedPnlUsd',
  'executionFeesUsd', 'lastReconciledFillsAt', 'lpPnlUsd', 'distanceToLiqPct', 'marginModeVerified',
  'positionMissingSince', 'positionMissingConsecutiveCount', 'lastPositionReadAt', 'lastPositionReadSource',
  'topUpMaxCount24h', 'topUpCapUsd', 'lastObservedBoundarySide', 'trackingMode', 'truthAgeMs',
  'lastTruthAt', 'lastTruthPrice', 'lastModelAt', 'lastModelPrice', 'modelConfidence', 'basisSpreadBps',
  'consecutiveTruthFailures', 'consecutiveInspectFailures', 'zoneState', 'lastTrackedMidPrice',
  'lastBboSpreadBps', 'rpcBudgetState', 'netProtectionPnlUsd', 'lastError', 'cooldownReason',
  'cooldownReason', 'decisionOwner', 'lastDecision', 'lastDecisionReason', 'lastMissingDetectedAt',
  'lastShadowSnapshotAt', 'lastSpotFailureAt', 'lastSpotFailureReason', 'lastTargetQty',
  'nakedExposureByDesign', 'nakedExposureSince', 'nakedExposureTier', 'nakedNotionalCapUsd',
  'nakedNotionalUsd', 'netProfitPolicyGate', 'netProfitPolicyState', 'netProfitPolicyTargetQty',
  'nextEligibleAttemptAt', 'pendingForceReason', 'pendingRotationBudgetIncrement',
  'rangeExitPolicyGate', 'rangeExitPolicyState', 'shadowSnapshots', 'terminalRangeInfeasible',
  'terminalRangePolicyGate', 'terminalRangePolicyState', 'terminalRangeResidualUsd',
  'terminalRangeTargetQty', 'trackingErrorQty', 'trackingErrorUsd', 'truthPending',
];

test('guarda: toda clave que escribe evaluate.js esta clasificada (borrar o conservar)', () => {
  const known = new Set([...DECISION_STATE_KEYS, ...KEPT_STATE_KEYS]);
  for (const key of EVALUATE_WRITTEN_KEYS) {
    assert.ok(known.has(key), `clave sin clasificar en segment-reset.js: ${key}`);
  }
  // Y la lista literal no se queda atras del codigo real.
  const source = fs.readFileSync(
    path.join(__dirname, '../src/services/protected-pool-delta-neutral/evaluate.js'), 'utf8',
  );
  const assigned = new Set([...source.matchAll(/nextState\.([A-Za-z0-9_]+)\s*=[^=]/g)].map((m) => m[1]));
  for (const key of assigned) {
    assert.ok(EVALUATE_WRITTEN_KEYS.includes(key), `evaluate.js escribe ${key}: anadelo a la lista del test`);
  }
  for (const key of DECISION_STATE_KEYS) {
    assert.equal(KEPT_STATE_KEYS.includes(key), false, `${key} no puede estar en ambas listas`);
  }
});

test('resetForNewSegment espera a la evaluacion en curso antes de escribir', async () => {
  const order = [];
  let release;
  const service = new ProtectedPoolDeltaNeutralService({
    protectedPoolRepository: {
      getById: async () => ({ id: 7, userId: 1, strategyState: dirtyState() }),
      updateStrategyState: async (_u, _id, payload) => { order.push(['write', payload]); },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  // Como el candado real: la entrada se retira sola al terminar la evaluacion.
  service.evaluationLocks = new Map();
  service.evaluationLocks.set(7, new Promise((resolve) => { release = resolve; })
    .then(() => order.push(['evaluation-done']))
    .finally(() => service.evaluationLocks.delete(7)));
  service.shadowStates.set('7:net_profit_v1', { actualQty: 1, shadowPolicyState: { x: 1 } });
  service.shadowStates.set('70:net_profit_v1', { actualQty: 1, shadowPolicyState: { x: 1 } });

  const done = service.resetForNewSegment({ id: 7, userId: 1 });
  await new Promise((r) => setImmediate(r));
  assert.equal(order.length, 0, 'no escribe mientras la evaluacion sigue en curso');
  release();
  await done;

  assert.deepEqual(order.map((o) => o[0]), ['evaluation-done', 'write']);
  const written = order[1][1];
  // Las columnas de decision quedan coherentes con el estado reiniciado: el
  // repo anula cooldown_reason/last_decision_reason si no se pasan, y
  // next_eligible_attempt_at se limpia explicitamente (va con COALESCE).
  assert.deepEqual(Object.keys(written).sort(), [
    'clearNextEligibleAttemptAt', 'cooldownReason', 'lastDecisionReason', 'strategyState',
  ]);
  assert.equal(written.clearNextEligibleAttemptAt, true);
  assert.equal(written.cooldownReason, null);
  assert.equal(written.lastDecisionReason, null);
  assert.equal(written.strategyState.nextEligibleAttemptAt ?? null, null);
  assert.equal(written.strategyState.pendingForceReason, 'segment_opened');
  assert.deepEqual(service.shadowStates.get('7:net_profit_v1'), { actualQty: 1, shadowPolicyState: {} });
  assert.deepEqual(service.shadowStates.get('70:net_profit_v1').shadowPolicyState, { x: 1 },
    'otra proteccion con prefijo parecido no se toca');
});

test('net_profit_v2: tras el reset decide rebalance sobre el LP nuevo, sin presupuesto ni histeresis heredados', () => {
  const now = 1_000_000;
  const staleState = {
    rotationBudgetDay: 0,
    rotationBudgetCount: 4,
    rotationBudgetNotionalUsd: 100,
    upperExitConfirmed: true,
    upperExitStartedAt: now - 1,
  };
  const base = {
    policyVersion: NET_PROFIT_V2, deltaQty: 1, actualQty: 0.7, currentPrice: 100,
    rangeLowerPrice: 95, rangeUpperPrice: 105, lpValueUsd: 1_000, now,
  };
  const before = decideNetProfitV1({ ...base, state: staleState });
  assert.equal(before.decision, 'hold', 'con el estado heredado la politica retiene');
  assert.equal(before.gate, 'upper_rearm_confirming');
  const budgetOnly = decideNetProfitV1({
    ...base,
    state: { rotationBudgetDay: 0, rotationBudgetCount: 4, rotationBudgetNotionalUsd: 100 },
  });
  assert.equal(budgetOnly.gate, 'daily_rotation_budget');

  const reset = resetDecisionStateForNewSegment({
    ...ACCUMULATORS, netProfitPolicyState: staleState, netProfitPolicyGate: before.gate,
  });
  const after = decideNetProfitV1({ ...base, state: reset.netProfitPolicyState || {} });
  assert.equal(after.decision, 'rebalance');
  assert.notEqual(after.gate, 'daily_rotation_budget');
  assert.notEqual(after.gate, 'upper_rearm_confirming');
  assert.notEqual(after.gate, 'upper_exit_confirming');
});

test('finalize invoca el reset al abrir tramo (con y sin cambio de tokenId) y tolera su fallo', async (t) => {
  const protectedPoolDeltaNeutralService = require('../src/services/protected-pool-delta-neutral.service');
  const resets = [];
  t.mock.method(protectedPoolRepo, 'findByPositionIdentifier', async () => [
    { id: 7, userId: 1, protectionMode: 'delta_neutral' },
    { id: 8, userId: 1, protectionMode: 'legacy' },
  ]);
  t.mock.method(protectedPoolRepo, 'updateOnchainOperation', async () => 7);
  t.mock.method(protectedPoolRepo, 'migratePositionIdentity', async () => 7);
  t.mock.method(protectedPoolRepo, 'getById', async (_u, id) => ({ id }));
  t.mock.method(protectedPoolRefreshService, 'refreshUser', async () => {});
  t.mock.method(protectedPoolDeltaNeutralService, 'resetForNewSegment', async (p) => {
    resets.push(p.id);
    throw new Error('boom');
  });
  const args = {
    userId: 1, network: 'arbitrum', version: 'v3', walletAddress: '0xabc',
    oldPositionIdentifier: '123', txHashes: ['0x1'], refreshedSnapshot: null,
  };

  await updateProtectionRecords({ ...args, action: 'modify-range', newPositionIdentifier: '999' });
  await updateProtectionRecords({ ...args, action: 'increase-liquidity', newPositionIdentifier: '123' });
  await updateProtectionRecords({ ...args, action: 'collect-fees', newPositionIdentifier: '123' });

  assert.deepEqual(resets, [7, 7], 'solo delta_neutral y solo acciones que abren tramo');
});

test('carrera: evaluacion en curso, forzado encolado y reset a la vez dejan el estado reiniciado', async () => {
  const row = { id: 7, userId: 1, strategyState: { ...dirtyState(), netProfitPolicyState: { stale: true } } };
  const persisted = [];
  const service = new ProtectedPoolDeltaNeutralService({
    protectedPoolRepository: {
      getById: async () => ({ ...row, strategyState: { ...row.strategyState } }),
      updateStrategyState: async (_u, _id, payload) => {
        persisted.push(payload.strategyState);
        row.strategyState = payload.strategyState;
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  let evaluations = 0;
  let releaseFirst;
  // Cada evaluacion lee la fila, cede el turno y reescribe lo leido (como el
  // motor real, que arrastra el netProfitPolicyState que encontro).
  service._withProtectionEvaluationLock = async () => {
    evaluations += 1;
    const read = { ...row.strategyState };
    if (evaluations === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    await new Promise((r) => setImmediate(r));
    row.strategyState = { ...read, pendingForceReason: null };
    persisted.push(row.strategyState);
    return 'ok';
  };

  const inFlight = service.evaluateProtection({ id: 7, userId: 1 });
  const forced = service.evaluateProtection({ id: 7, userId: 1 }, { forceRebalance: true, forceReason: 'x' });
  const reset = service.resetForNewSegment({ id: 7, userId: 1 });
  await new Promise((r) => setImmediate(r));
  releaseFirst();
  await Promise.all([inFlight, forced, reset]);

  assert.equal(service.evaluationLocks.size, 0);
  assert.equal(row.strategyState.netProfitPolicyState, undefined, 'el estado viejo no sobrevive al reset');
  assert.equal(row.strategyState.minDwellUntil, undefined);
  assert.deepEqual(row.strategyState.shadowSnapshots.net_profit_v1.shadowPolicyState, {});
});

// --- Motor completo ----------------------------------------------------------

const NOW_MS = Date.now();
const PRICE = 2500;

function enginePool(strategyState) {
  const addr = (n) => `0x${String(n).padStart(40, '0')}`;
  return {
    id: 55, userId: 1, accountId: 8, status: 'active', protectionMode: 'delta_neutral',
    inferredAsset: 'ETH', network: 'arbitrum', version: 'v3', positionIdentifier: '999',
    walletAddress: addr(1), poolAddress: addr(2), leverage: 7,
    rangeLowerPrice: 2000, rangeUpperPrice: 3000, priceCurrent: PRICE,
    snapshotStatus: 'ready', snapshotFreshAt: NOW_MS, minOrderNotionalUsd: 11,
    policyVersion: 'net_profit_v2', targetHedgeRatio: 0.6,
    poolSnapshot: {
      mode: 'lp_position', version: 'v3', network: 'arbitrum', identifier: '999', positionIdentifier: '999',
      owner: addr(1), creator: addr(1), poolAddress: addr(2), token0Address: addr(3), token1Address: addr(4),
      token0: { symbol: 'WETH', address: addr(3), decimals: 18 },
      token1: { symbol: 'USDC', address: addr(4), decimals: 6 },
      tickLower: 74000, tickUpper: 79000, liquidity: '2000000000000',
      rangeLowerPrice: 2000, rangeUpperPrice: 3000, priceCurrent: PRICE, currentValueUsd: 2500,
      inRange: true, unclaimedFees0: 0.01, unclaimedFees1: 12, snapshotFreshAt: NOW_MS,
    },
    strategyState,
  };
}

function engineService(row, executions) {
  const service = new ProtectedPoolDeltaNeutralService({
    protectedPoolRepository: {
      getById: async () => row,
      updateStrategyState: async (_u, _id, payload) => { row.strategyState = payload.strategyState; },
    },
    protectionDecisionLogRepository: { create: async () => {} },
    hlRegistry: {
      getOrCreate: async () => ({
        getPosition: async () => ({ coin: 'ETH', szi: '-0.0001', leverage: { type: 'isolated', value: 7 } }),
        getClearinghouseState: async () => ({ withdrawable: '1000' }),
        getCandleSnapshot: async () => [],
      }),
    },
    getTradingService: async () => ({}),
    marketService: { getAssetContexts: async () => [] },
    logger: { info() {}, warn() {}, error() {} },
    centerDeadZonePct: 0,
    hyperliquidStreamService: {
      trackProtection() {}, start() {}, stop() {},
      getMidPrice: async () => null, getBbo: async () => null, getActiveAssetCtx: async () => null,
      getClearinghouseState: async () => null, getDiagnostics: () => ({ enabled: false }),
    },
    rpcBudgetManager: { canSpend: () => ({ allowed: true, snapshot: null }), getSnapshot: () => null, record() {} },
  });
  service._fetchSpot = async () => ({ priceCurrent: PRICE });
  service._executeRebalance = async ({ strategyState, reason }) => {
    executions.push(reason);
    return { ...strategyState, executed: true };
  };
  return service;
}

function previousRangeState() {
  return {
    lastRebalanceAt: Date.now() - (13 * 60 * 60_000),
    lastSnapshotPrice: PRICE,
    modelConfidence: 'high',
    executionIntent: 'live',
    policyVersion: 'net_profit_v2',
    netProfitPolicyState: {
      rotationBudgetDay: Math.floor(Date.now() / 86_400_000),
      rotationBudgetCount: 4,
      rotationBudgetNotionalUsd: 100,
      upperExitConfirmed: true,
      upperExitStartedAt: Date.now() - 60_000,
    },
  };
}

const HELD_GATES = ['daily_rotation_budget', 'upper_rearm_confirming', 'upper_exit_confirming', 'upper_exit_latched'];

test('motor: sin reset, el estado del rango anterior retiene la decision (control)', async () => {
  const row = enginePool(previousRangeState());
  const executions = [];
  const state = await engineService(row, executions).evaluateProtection(row);
  assert.ok(HELD_GATES.includes(state.netProfitPolicyGate), `gate inesperado: ${state.netProfitPolicyGate}`);
  assert.deepEqual(executions, []);
});

test('motor: tras resetForNewSegment la politica decide sobre el LP nuevo', async () => {
  const row = enginePool(previousRangeState());
  const executions = [];
  const service = engineService(row, executions);

  await service.resetForNewSegment(row);
  assert.equal(row.strategyState.pendingForceReason, 'segment_opened');
  const state = await service.evaluateProtection(row);

  assert.ok(!HELD_GATES.includes(state.netProfitPolicyGate), `gate heredado: ${state.netProfitPolicyGate}`);
  assert.deepEqual(executions, ['net_profit_v2']);
  assert.equal(state.executed, true);
});
