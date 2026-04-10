const test = require('node:test');
const assert = require('node:assert/strict');

const { LpOrchestratorService } = require('../src/services/lp-orchestrator.service');
const accounting = require('../src/services/lp-orchestrator/accounting');

function makeFakeRepo() {
  const orchestrators = new Map();
  const log = [];
  const repo = {
    log,
    orchestrators,
    async create(record) {
      const id = (orchestrators.size || 0) + 1;
      orchestrators.set(id, { ...record, id });
      return id;
    },
    async getById(userId, id) {
      const o = orchestrators.get(id);
      return o && o.userId === userId ? { ...o } : null;
    },
    async listForUser(userId) {
      return [...orchestrators.values()].filter((o) => o.userId === userId);
    },
    async listActiveForLoop() {
      return [...orchestrators.values()].filter((o) => o.status === 'active');
    },
    async updatePhase(userId, id, patch) {
      const o = orchestrators.get(id);
      if (!o) return null;
      Object.assign(o, {
        phase: patch.phase ?? o.phase,
        lastError: patch.lastError !== undefined ? patch.lastError : o.lastError,
        nextEligibleAttemptAt: patch.nextEligibleAttemptAt ?? null,
        cooldownReason: patch.cooldownReason ?? null,
      });
      return id;
    },
    async updateActiveLp(userId, id, patch) {
      const o = orchestrators.get(id);
      if (!o) return null;
      Object.assign(o, {
        activePositionIdentifier: patch.activePositionIdentifier,
        activePoolAddress: patch.activePoolAddress,
        activeProtectedPoolId: patch.activeProtectedPoolId,
        phase: patch.phase ?? o.phase,
      });
      return id;
    },
    async updateStrategyState(userId, id, patch) {
      const o = orchestrators.get(id);
      if (!o) return null;
      if (patch.strategyState !== undefined) o.strategyState = patch.strategyState;
      if (patch.lastEvaluation !== undefined) o.lastEvaluation = patch.lastEvaluation;
      if (patch.lastEvaluationAt !== undefined) o.lastEvaluationAt = patch.lastEvaluationAt;
      if (patch.lastDecision !== undefined) o.lastDecision = patch.lastDecision;
      return id;
    },
    async updateAccounting(userId, id, acc) {
      const o = orchestrators.get(id);
      if (!o) return null;
      o.accounting = acc;
      return id;
    },
    async markUrgentAlertSent(userId, id, { at }) {
      const o = orchestrators.get(id);
      if (o) o.lastUrgentAlertAt = at;
      return id;
    },
    async clearUrgentAlert(userId, id) {
      const o = orchestrators.get(id);
      if (o) o.lastUrgentAlertAt = null;
      return id;
    },
    async archive(userId, id) {
      const o = orchestrators.get(id);
      if (!o || o.activePositionIdentifier) return null;
      o.status = 'archived';
      return id;
    },
    async appendActionLog(entry) {
      log.push(entry);
      return log.length;
    },
    async findLastNotification(orchestratorId) {
      return [...log].reverse().find((e) => e.orchestratorId === orchestratorId && e.kind === 'notification') || null;
    },
    async listActionLog() { return [...log].reverse(); },
  };
  return repo;
}

function makeFakeNotifier() {
  const calls = [];
  return {
    calls,
    urgentOutOfRange: async (...args) => { calls.push({ kind: 'urgentOutOfRange', args }); },
    recommendRebalance: async (...args) => { calls.push({ kind: 'recommendRebalance', args }); },
    recommendCollectFees: async (...args) => { calls.push({ kind: 'recommendCollectFees', args }); },
    actionFinalized: async (...args) => { calls.push({ kind: 'actionFinalized', args }); },
    verificationFailed: async (...args) => { calls.push({ kind: 'verificationFailed', args }); },
    lpKilled: async (...args) => { calls.push({ kind: 'lpKilled', args }); },
    positionMissing: async (...args) => { calls.push({ kind: 'positionMissing', args }); },
  };
}

function makeFakeUniswapService(pool) {
  return {
    scanPoolsCreatedByWallet: async () => ({ pools: pool ? [pool] : [] }),
  };
}

function basePool(overrides = {}) {
  return {
    identifier: '777',
    network: 'arbitrum',
    version: 'v3',
    rangeLowerPrice: 90,
    rangeUpperPrice: 110,
    priceCurrent: 100,
    currentValueUsd: 1000,
    unclaimedFeesUsd: 0,
    liquidity: '1000000',
    ...overrides,
  };
}

async function bootstrapOrchestrator(repo, overrides = {}) {
  const id = await repo.create({
    userId: 1,
    name: 'TEST',
    network: 'arbitrum',
    version: 'v3',
    walletAddress: '0xabc',
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    token0Address: '0x1',
    token1Address: '0x2',
    activePositionIdentifier: '777',
    activePoolAddress: '0xpool',
    activeProtectedPoolId: null,
    phase: 'lp_active',
    status: 'active',
    initialTotalUsd: 1000,
    strategyConfig: {
      rangeWidthPct: 5,
      edgeMarginPct: 40,
      costToRewardThreshold: 0.3333,
      minNetLpEarningsForRebalanceUsd: 0,
      reinvestThresholdUsd: 0,
      urgentAlertRepeatMinutes: 30,
      maxSlippageBps: 100,
    },
    accounting: { ...accounting.DEFAULT_ACCOUNTING, lpFeesUsd: 100 },
    strategyState: {},
    lastEvaluation: null,
    lastUrgentAlertAt: null,
    ...overrides,
  });
  return id;
}

test('decisión hold cuando el precio está en banda central', async () => {
  const repo = makeFakeRepo();
  const id = await bootstrapOrchestrator(repo);
  const notifier = makeFakeNotifier();
  const service = new LpOrchestratorService({
    lpOrchestratorRepository: repo,
    uniswapService: makeFakeUniswapService(basePool()),
    costEstimator: { estimateModifyRangeCost: async () => ({ totalCostUsd: 0 }), invalidate: () => {} },
    notifier,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  });
  const result = await service.evaluateOne(1, id);
  assert.equal(result.decision, 'hold');
  assert.equal(notifier.calls.length, 0);
});

test('decisión urgent_adjust cuando el precio está fuera del rango y notifica', async () => {
  const repo = makeFakeRepo();
  const id = await bootstrapOrchestrator(repo);
  const notifier = makeFakeNotifier();
  const service = new LpOrchestratorService({
    lpOrchestratorRepository: repo,
    uniswapService: makeFakeUniswapService(basePool({ priceCurrent: 80 })),
    costEstimator: { estimateModifyRangeCost: async () => ({ totalCostUsd: 0 }), invalidate: () => {} },
    notifier,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  });
  const result = await service.evaluateOne(1, id);
  assert.equal(result.decision, 'urgent_adjust');
  const urgentCalls = notifier.calls.filter((c) => c.kind === 'urgentOutOfRange');
  assert.equal(urgentCalls.length, 1);
  // Llamar otra vez inmediatamente: NO debe re-notificar (dedup por tiempo)
  await service.evaluateOne(1, id);
  const urgentCalls2 = notifier.calls.filter((c) => c.kind === 'urgentOutOfRange');
  assert.equal(urgentCalls2.length, 1);
});

test('decisión recommend_rebalance cuando es rentable (cost < earnings/3)', async () => {
  const repo = makeFakeRepo();
  // El orquestador tiene $100 en fees acumuladas, cost será 5 → ratio 0.05 → recomendar
  const id = await bootstrapOrchestrator(repo);
  const notifier = makeFakeNotifier();
  const service = new LpOrchestratorService({
    lpOrchestratorRepository: repo,
    uniswapService: makeFakeUniswapService(basePool({ priceCurrent: 91 })),
    costEstimator: {
      estimateModifyRangeCost: async () => ({ totalCostUsd: 5, gasCostUsd: 4, slippageCostUsd: 1, txCount: 2 }),
      invalidate: () => {},
    },
    notifier,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  });
  const result = await service.evaluateOne(1, id);
  assert.equal(result.decision, 'recommend_rebalance');
  assert.ok(notifier.calls.some((c) => c.kind === 'recommendRebalance'));
});

test('en pérdida (netEarnings <= 0) NO se recomienda nada aunque esté en borde', async () => {
  const repo = makeFakeRepo();
  // accounting con gas > fees → en pérdida
  const id = await bootstrapOrchestrator(repo, {
    accounting: { ...accounting.DEFAULT_ACCOUNTING, lpFeesUsd: 1, gasSpentUsd: 10 },
  });
  let estimatorCalls = 0;
  const notifier = makeFakeNotifier();
  const service = new LpOrchestratorService({
    lpOrchestratorRepository: repo,
    uniswapService: makeFakeUniswapService(basePool({ priceCurrent: 91 })),
    costEstimator: {
      estimateModifyRangeCost: async () => { estimatorCalls += 1; return { totalCostUsd: 1 }; },
      invalidate: () => {},
    },
    notifier,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  });
  const result = await service.evaluateOne(1, id);
  assert.equal(result.decision, 'hold');
  assert.equal(result.reason, 'edge_warning_in_loss');
  assert.equal(estimatorCalls, 0, 'no debe llamar al estimator si está en pérdida');
});

test('recomendar collect-fees cuando supera el threshold', async () => {
  const repo = makeFakeRepo();
  const id = await bootstrapOrchestrator(repo, {
    strategyConfig: {
      rangeWidthPct: 5, edgeMarginPct: 40, costToRewardThreshold: 0.3333,
      minNetLpEarningsForRebalanceUsd: 0, reinvestThresholdUsd: 10,
      urgentAlertRepeatMinutes: 30, maxSlippageBps: 100,
    },
  });
  const notifier = makeFakeNotifier();
  const service = new LpOrchestratorService({
    lpOrchestratorRepository: repo,
    uniswapService: makeFakeUniswapService(basePool({ unclaimedFeesUsd: 25 })),
    costEstimator: { estimateModifyRangeCost: async () => ({ totalCostUsd: 0 }), invalidate: () => {} },
    notifier,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  });
  await service.evaluateOne(1, id);
  assert.ok(notifier.calls.some((c) => c.kind === 'recommendCollectFees'));
});

test('posición desaparece → primero queda pending y luego confirma failed + notifier.positionMissing', async () => {
  const repo = makeFakeRepo();
  const id = await bootstrapOrchestrator(repo);
  const notifier = makeFakeNotifier();
  const service = new LpOrchestratorService({
    lpOrchestratorRepository: repo,
    uniswapService: makeFakeUniswapService(null),
    costEstimator: { estimateModifyRangeCost: async () => ({ totalCostUsd: 0 }), invalidate: () => {} },
    notifier,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  });

  const firstResult = await service.evaluateOne(1, id);
  assert.equal(firstResult.skipped, 'position_missing_pending');
  assert.equal(notifier.calls.some((c) => c.kind === 'positionMissing'), false);
  let o = await repo.getById(1, id);
  assert.equal(o.phase, 'lp_active');

  const result = await service.evaluateOne(1, id);
  assert.equal(result.decision, 'failed');
  assert.ok(notifier.calls.some((c) => c.kind === 'positionMissing'));
  o = await repo.getById(1, id);
  assert.equal(o.phase, 'failed');
});

test('kill+recreate: contabilidad persiste entre LPs', async () => {
  const repo = makeFakeRepo();
  const id = await bootstrapOrchestrator(repo, {
    accounting: { ...accounting.DEFAULT_ACCOUNTING, lpFeesUsd: 50, gasSpentUsd: 10, lpCount: 1 },
  });
  const notifier = makeFakeNotifier();
  const service = new LpOrchestratorService({
    lpOrchestratorRepository: repo,
    positionActionsService: {
      preparePositionAction: async () => ({ txPlan: [], estimatedCosts: {} }),
    },
    uniswapService: makeFakeUniswapService(basePool()),
    notifier,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  });

  // 1) Matar el LP
  const killResult = await service.killLp({ userId: 1, orchestratorId: id, mode: 'usdc' });
  assert.equal(killResult.action, 'close-to-usdc');

  // 2) Simular firma + finalización del cierre
  await service.recordTxFinalized({
    userId: 1,
    orchestratorId: id,
    action: 'close-to-usdc',
    finalizeResult: {
      txHashes: ['0xclose'],
      refreshedSnapshot: { liquidity: '0', currentValueUsd: 0 },
    },
    expected: { gasCostUsd: 2, slippageCostUsd: 1 },
  });

  const o1 = await repo.getById(1, id);
  assert.equal(o1.phase, 'idle');
  assert.equal(o1.activePositionIdentifier, null);
  // Contabilidad: 50 fees - 10 gas anteriores - 2 nuevos gas - 1 slippage = 37 net
  assert.equal(o1.accounting.lpFeesUsd, 50);
  assert.equal(o1.accounting.gasSpentUsd, 12);
  assert.equal(o1.accounting.swapSlippageUsd, 1);
  assert.equal(o1.accounting.lpCount, 1);

  // 3) Adjuntar un LP nuevo
  await service.attachLp({
    userId: 1,
    orchestratorId: id,
    finalizeResult: {
      txHashes: ['0xcreate'],
      positionChanges: { newPositionIdentifier: '999' },
      refreshedSnapshot: { identifier: '999', poolAddress: '0xpool2' },
    },
    protectionConfig: { enabled: false },
  });
  const o2 = await repo.getById(1, id);
  assert.equal(o2.phase, 'lp_active');
  assert.equal(o2.activePositionIdentifier, '999');
  // lpCount aumentó pero la contabilidad de fees/gas se conservó
  assert.equal(o2.accounting.lpCount, 2);
  assert.equal(o2.accounting.lpFeesUsd, 50);
  assert.equal(o2.accounting.gasSpentUsd, 12);
});

test('archive solo permitido si no hay LP activo', async () => {
  const repo = makeFakeRepo();
  const id = await bootstrapOrchestrator(repo);
  const service = new LpOrchestratorService({
    lpOrchestratorRepository: repo,
    notifier: makeFakeNotifier(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  });
  await assert.rejects(
    () => service.archive({ userId: 1, orchestratorId: id }),
    /Cierra el LP activo/
  );
});

test('recordTxFinalized con drift critical → phase failed', async () => {
  const repo = makeFakeRepo();
  const id = await bootstrapOrchestrator(repo);
  const notifier = makeFakeNotifier();
  const service = new LpOrchestratorService({
    lpOrchestratorRepository: repo,
    notifier,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  });
  await service.recordTxFinalized({
    userId: 1,
    orchestratorId: id,
    action: 'modify-range',
    finalizeResult: {
      txHashes: ['0x1'],
      refreshedSnapshot: { rangeLowerPrice: 50, rangeUpperPrice: 60, liquidity: '0' },
    },
    expected: { rangeLowerPrice: 90, rangeUpperPrice: 110, gasCostUsd: 1, slippageCostUsd: 0 },
  });
  const o = await repo.getById(1, id);
  assert.equal(o.phase, 'failed');
  assert.ok(o.lastError && o.lastError.includes('verification_failed'));
  assert.ok(notifier.calls.some((c) => c.kind === 'verificationFailed'));
});

test('recordTxFinalized éxito en modify-range con protección refresca el hedge', async () => {
  const repo = makeFakeRepo();
  const id = await bootstrapOrchestrator(repo, { activeProtectedPoolId: 42 });
  const refreshCalls = [];
  const service = new LpOrchestratorService({
    lpOrchestratorRepository: repo,
    protectedPoolRefreshService: {
      refreshProtection: async (userId, protectedPoolId) => {
        refreshCalls.push({ userId, protectedPoolId });
      },
    },
    notifier: makeFakeNotifier(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  });
  await service.recordTxFinalized({
    userId: 1,
    orchestratorId: id,
    action: 'modify-range',
    finalizeResult: {
      txHashes: ['0x1'],
      refreshedSnapshot: { rangeLowerPrice: 92, rangeUpperPrice: 108, liquidity: '1000000' },
    },
    expected: { rangeLowerPrice: 92, rangeUpperPrice: 108, gasCostUsd: 1, slippageCostUsd: 0 },
  });
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].protectedPoolId, 42);
});

// ──────────────── Time-in-range tracking ────────────────

test('time-in-range: primer tick siembra el tracker sin acumular tiempo', async () => {
  const repo = makeFakeRepo();
  const id = await bootstrapOrchestrator(repo);
  const service = new LpOrchestratorService({
    lpOrchestratorRepository: repo,
    uniswapService: makeFakeUniswapService(basePool()),
    costEstimator: { estimateModifyRangeCost: async () => ({ totalCostUsd: 0 }), invalidate: () => {} },
    notifier: makeFakeNotifier(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  });

  await service.evaluateOne(1, id);
  const orch = await repo.getById(1, id);
  const tracking = orch.strategyState.timeTracking;
  assert.ok(tracking, 'tracking debe existir tras primer tick');
  assert.equal(tracking.timeInRangeMs, 0, 'sin tiempo previo no acumula');
  assert.equal(tracking.timeTrackedMs, 0);
  assert.equal(tracking.lastInRange, true, 'usa el estado actual como semilla');
  assert.ok(tracking.lastSampleAt > 0);
});

test('time-in-range: segundo tick (en rango) acumula delta a timeInRangeMs', async () => {
  const repo = makeFakeRepo();
  const id = await bootstrapOrchestrator(repo);
  const service = new LpOrchestratorService({
    lpOrchestratorRepository: repo,
    uniswapService: makeFakeUniswapService(basePool()),
    costEstimator: { estimateModifyRangeCost: async () => ({ totalCostUsd: 0 }), invalidate: () => {} },
    notifier: makeFakeNotifier(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  });

  // Primer tick: siembra el tracker
  await service.evaluateOne(1, id);
  // Manualmente retrocedo lastSampleAt 60s para simular tiempo transcurrido
  const orchAfter1 = await repo.getById(1, id);
  orchAfter1.strategyState.timeTracking.lastSampleAt = Date.now() - 60_000;
  // Re-asignamos al fake repo
  repo.orchestrators.get(id).strategyState = orchAfter1.strategyState;

  // Segundo tick: debería sumar ~60s a timeInRangeMs y a timeTrackedMs
  await service.evaluateOne(1, id);
  const orchAfter2 = await repo.getById(1, id);
  const t = orchAfter2.strategyState.timeTracking;
  assert.ok(t.timeInRangeMs >= 59_000 && t.timeInRangeMs <= 61_000, `timeInRangeMs debe ser ~60000, fue ${t.timeInRangeMs}`);
  assert.ok(t.timeTrackedMs >= 59_000 && t.timeTrackedMs <= 61_000);
  assert.equal(t.timeInRangePct, 100);
});

test('time-in-range: si el último estado fue out-of-range, el delta no suma a timeInRangeMs', async () => {
  const repo = makeFakeRepo();
  const id = await bootstrapOrchestrator(repo);
  const service = new LpOrchestratorService({
    lpOrchestratorRepository: repo,
    // 1er tick: precio fuera de rango (priceCurrent < rangeLowerPrice)
    uniswapService: makeFakeUniswapService(basePool({ priceCurrent: 80 })),
    costEstimator: { estimateModifyRangeCost: async () => ({ totalCostUsd: 0 }), invalidate: () => {} },
    notifier: makeFakeNotifier(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  });

  await service.evaluateOne(1, id);
  // Retroceder 60s
  const orch1 = await repo.getById(1, id);
  orch1.strategyState.timeTracking.lastSampleAt = Date.now() - 60_000;
  repo.orchestrators.get(id).strategyState = orch1.strategyState;

  // Cambio a un escenario en rango para el 2o tick
  service.uniswapService = makeFakeUniswapService(basePool({ priceCurrent: 100 }));
  await service.evaluateOne(1, id);

  const t = (await repo.getById(1, id)).strategyState.timeTracking;
  assert.ok(t.timeTrackedMs >= 59_000, 'tiempo total siempre acumula');
  assert.equal(t.timeInRangeMs, 0, 'el delta del primer tick out-of-range NO acumula a timeInRangeMs');
  assert.equal(t.timeInRangePct, 0);
});

test('time-in-range: attachLp resetea el tracker', async () => {
  const repo = makeFakeRepo();
  const id = await bootstrapOrchestrator(repo, {
    strategyState: { timeTracking: { lastSampleAt: 1000, lastInRange: true, timeInRangeMs: 5000, timeTrackedMs: 10000, timeInRangePct: 50 } },
    activePositionIdentifier: null,
    phase: 'idle',
  });
  const service = new LpOrchestratorService({
    lpOrchestratorRepository: repo,
    notifier: makeFakeNotifier(),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  });
  await service.attachLp({
    userId: 1,
    orchestratorId: id,
    finalizeResult: {
      txHashes: ['0xnew'],
      positionChanges: { newPositionIdentifier: '888' },
      refreshedSnapshot: { identifier: '888' },
    },
    protectionConfig: { enabled: false },
  });
  const orch = await repo.getById(1, id);
  assert.equal(orch.strategyState.timeTracking, null, 'attachLp debe nullificar timeTracking');
});
