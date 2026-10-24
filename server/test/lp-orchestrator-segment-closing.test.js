const test = require('node:test');
const assert = require('node:assert/strict');

const { LpOrchestratorService } = require('../src/services/lp-orchestrator.service');
const accounting = require('../src/services/lp-orchestrator/accounting');
const { makeSegmentFakeRepo } = require('./support/segment-fake-repo');

/**
 * Corte de tramos: cada LP del orquestador es un tramo. Caso real #57: tres
 * LPs seguidos y la tarjeta seguía mostrando el precio de apertura del LP
 * anterior (2668.73) sobre el rango nuevo 2401.9 - 2628.1.
 */

const fakeDb = { transaction: async (fn) => fn(undefined) };
const silentLogger = { warn: () => {}, info: () => {}, error: () => {} };

// Snapshot ETH/USDC valorable (ticks reales del rango 2401.9 - 2628.1).
function lp(identifier, overrides = {}) {
  return {
    identifier,
    network: 'arbitrum',
    version: 'v3',
    poolAddress: '0xpool',
    token0: { symbol: 'WETH', address: '0x1', decimals: 18 },
    token1: { symbol: 'USDC', address: '0x2', decimals: 6 },
    tickLower: -198480,
    tickUpper: -197580,
    liquidity: '1000000000000000',
    rangeLowerPrice: 2401.9,
    rangeUpperPrice: 2628.1,
    priceCurrent: 2515,
    currentValueUsd: 1000,
    unclaimedFeesUsd: 0,
    ...overrides,
  };
}

function makeFakeRepo() {
  const orchestrators = new Map();
  const log = [];
  return {
    log,
    orchestrators,
    async create(record) {
      const id = orchestrators.size + 1;
      orchestrators.set(id, { ...record, id });
      return id;
    },
    async getById(userId, id) {
      const o = orchestrators.get(id);
      return o && o.userId === userId ? JSON.parse(JSON.stringify(o)) : null;
    },
    async updatePhase(userId, id, patch) {
      const o = orchestrators.get(id);
      Object.assign(o, {
        phase: patch.phase ?? o.phase,
        lastError: patch.lastError !== undefined ? patch.lastError : o.lastError,
      });
      return id;
    },
    async updateActiveLp(userId, id, patch) {
      const o = orchestrators.get(id);
      Object.assign(o, {
        activePositionIdentifier: patch.activePositionIdentifier,
        activePoolAddress: patch.activePoolAddress,
        activeProtectedPoolId: patch.activeProtectedPoolId,
        phase: patch.phase ?? o.phase,
      });
      return id;
    },
    async updateActiveSegment(userId, id, segmentId) {
      orchestrators.get(id).activeSegmentId = segmentId;
      return id;
    },
    async updateStrategyState(userId, id, patch) {
      const o = orchestrators.get(id);
      if (patch.strategyState !== undefined) o.strategyState = patch.strategyState;
      if (patch.lastEvaluation !== undefined) o.lastEvaluation = patch.lastEvaluation;
      if (patch.lastEvaluationAt !== undefined) o.lastEvaluationAt = patch.lastEvaluationAt;
      if (patch.lastDecision !== undefined) o.lastDecision = patch.lastDecision;
      return id;
    },
    async updateAccounting(userId, id, acc) {
      orchestrators.get(id).accounting = acc;
      return id;
    },
    async clearUrgentAlert() { return null; },
    async markUrgentAlertSent() { return null; },
    async appendActionLog(entry) {
      log.push(entry);
      return log.length;
    },
    async findFinalizedByTxHash(orchestratorId, hashes) {
      return log.find((e) => e.orchestratorId === orchestratorId && e.kind === 'tx_finalized'
        && (e.txHashes || []).some((h) => hashes.includes(h))) || null;
    },
    async findLastNotification() { return null; },
  };
}

function makeNotifier() {
  const noop = async () => {};
  return {
    urgentOutOfRange: noop,
    recommendRebalance: noop,
    recommendCollectFees: noop,
    actionFinalized: noop,
    verificationFailed: noop,
    lpKilled: noop,
    positionMissing: noop,
    protectionMissing: noop,
  };
}

/**
 * Orquestador con un LP vivo desde un `attachLp` real (abre el tramo 1).
 * `protection` (opcional) es la fila de la protección 42 vinculada.
 */
async function setup({ protection = null, pools = {}, scanPools = null, accountingDeps } = {}) {
  const repo = makeFakeRepo();
  const segRepo = makeSegmentFakeRepo();
  const evaluateCalls = [];
  const inspectCalls = [];
  const id = await repo.create({
    userId: 1,
    name: 'T57',
    network: 'arbitrum',
    version: 'v3',
    walletAddress: '0xabc',
    token0Address: '0x1',
    token1Address: '0x2',
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    activePositionIdentifier: null,
    activeProtectedPoolId: null,
    activeSegmentId: null,
    phase: 'idle',
    status: 'active',
    protectionConfig: protection ? { enabled: true, policyVersion: 'range_exit_v1' } : { enabled: false },
    strategyConfig: { rangeWidthPct: 5, edgeMarginPct: 40 },
    accounting: { ...accounting.DEFAULT_ACCOUNTING },
    strategyState: {},
    lastEvaluation: null,
  });

  const service = new LpOrchestratorService({
    lpOrchestratorRepository: repo,
    segmentRepository: segRepo,
    rebalanceRepository: { listByProtectedPoolId: async () => [] },
    protectedPoolRepository: {
      getById: async () => {
        if (!protection) throw new Error('no debe leer la protección');
        return JSON.parse(JSON.stringify(protection));
      },
    },
    protectedPoolRefreshService: {
      refreshProtection: async (_userId, pid) => ({ id: pid, status: 'active' }),
    },
    protectedPoolDeltaNeutralService: {
      evaluateProtection: async (p, options) => { evaluateCalls.push({ id: p.id, options }); },
    },
    uniswapProtectionService: {
      deactivateProtectedPool: async () => ({ status: 'inactive' }),
    },
    uniswapService: {
      inspectPositionByIdentifier: async ({ positionIdentifier, lightweight }) => {
        inspectCalls.push({ positionIdentifier, lightweight });
        const pool = pools[positionIdentifier];
        if (!pool) return null;
        const copy = { ...pool };
        if (lightweight) delete copy.priceAtOpen;
        return copy;
      },
      scanPoolsCreatedByWallet: async () => ({ pools: scanPools || Object.values(pools) }),
    },
    positionActionsService: { computeRealizedGasUsd: async () => 0 },
    costEstimator: { estimateModifyRangeCost: async () => ({ totalCostUsd: 0 }), invalidate: () => {} },
    notifier: makeNotifier(),
    logger: silentLogger,
    db: fakeDb,
    ...(accountingDeps ? { accounting: accountingDeps } : {}),
  });

  const attach = async (identifier, snapshot, extra = {}) => service.attachLp({
    userId: 1,
    orchestratorId: id,
    finalizeResult: {
      txHashes: [`0xmint-${identifier}`],
      positionChanges: { newPositionIdentifier: identifier },
      refreshedSnapshot: snapshot,
    },
    protectionConfig: protection ? { enabled: true } : { enabled: false },
    existingProtectedPoolId: protection ? protection.id : null,
    ...extra,
  });

  const finalize = async (action, {
    newId = null, snapshot = null, gasCostUsd = 0, collectedFeesUsd, txHashes,
  } = {}) => (
    service.recordTxFinalized({
      userId: 1,
      orchestratorId: id,
      action,
      finalizeResult: {
        txHashes: txHashes || [`0x${action}-${newId || 'same'}`],
        positionChanges: newId ? { newPositionIdentifier: newId } : undefined,
        refreshedSnapshot: snapshot,
      },
      expected: { gasCostUsd, slippageCostUsd: 0, ...(collectedFeesUsd != null ? { collectedFeesUsd } : {}) },
    })
  );

  const orch = () => repo.orchestrators.get(id);
  const ordered = () => [...segRepo.segments].sort((a, b) => a.seq - b.seq);
  return { service, repo, segRepo, id, orch, ordered, attach, finalize, evaluateCalls, inspectCalls };
}

const MIN = 60_000;

test('markActionStarted pasa el tramo vivo a closing y es idempotente', async () => {
  const pools = { 777: lp('777') };
  const ctx = await setup({ pools });
  await ctx.attach('777', pools[777]);

  const first = await ctx.service.markActionStarted({ userId: 1, orchestratorId: ctx.id, action: 'modify-range' });
  assert.ok(first);
  const [seg] = ctx.ordered();
  assert.equal(seg.status, 'closing');
  const startedAt = seg.closingStartedAt;
  assert.ok(startedAt > 0);

  await ctx.service.markActionStarted({ userId: 1, orchestratorId: ctx.id, action: 'modify-range' });
  assert.equal(ctx.ordered()[0].closingStartedAt, startedAt);
  assert.equal(ctx.ordered().length, 1);
  const logs = ctx.repo.log.filter((e) => e.reason === 'action_started');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, 'decision');

  await assert.rejects(
    () => ctx.service.markActionStarted({ userId: 1, orchestratorId: ctx.id, action: 'collect-fees' }),
    /no soportada/
  );
});

test('en closing con la posición vacía no hay position_not_found tras 3 evaluaciones', async () => {
  const pools = { 777: lp('777') };
  const ctx = await setup({ pools });
  await ctx.attach('777', pools[777]);
  await ctx.service.markActionStarted({ userId: 1, orchestratorId: ctx.id, action: 'modify-range' });
  pools[777] = lp('777', { liquidity: '0' });

  for (let i = 0; i < 3; i++) {
    const res = await ctx.service.evaluateOne(1, ctx.id);
    assert.deepEqual(res, { skipped: 'segment_closing' });
  }
  assert.notEqual(ctx.orch().phase, 'failed');
  assert.equal(ctx.repo.log.filter((e) => e.reason === 'position_not_found').length, 0);
  assert.equal(ctx.ordered()[0].status, 'closing');
});

test('en closing, un tokenId nuevo sigue cortando el tramo como unknown', async () => {
  const pools = { 777: lp('777', { liquidity: '0' }), 888: lp('888') };
  const ctx = await setup({ pools });
  await ctx.attach('777', lp('777'));
  await ctx.service.markActionStarted({ userId: 1, orchestratorId: ctx.id, action: 'modify-range' });

  await ctx.service.evaluateOne(1, ctx.id);
  const segs = ctx.ordered();
  assert.equal(segs.length, 2);
  assert.equal(segs[0].status, 'closed');
  assert.equal(segs[0].closeReason, 'unknown');
  assert.equal(segs[1].status, 'open');
  assert.equal(segs[1].positionIdentifier, '888');
});

test('Review Focus 4: closing >30 min con el LP viejo con liquidez vuelve a open', async () => {
  const pools = { 777: lp('777') };
  const ctx = await setup({ pools });
  await ctx.attach('777', pools[777]);
  await ctx.service.markActionStarted({ userId: 1, orchestratorId: ctx.id, action: 'modify-range' });

  await ctx.service.evaluateOne(1, ctx.id);
  assert.equal(ctx.ordered()[0].status, 'closing', 'antes del plazo sigue cerrando');

  ctx.segRepo.segments[0].closingStartedAt = Date.now() - 31 * MIN;
  await ctx.service.evaluateOne(1, ctx.id);
  assert.equal(ctx.ordered()[0].status, 'open');
  assert.equal(ctx.ordered()[0].closingStartedAt, null);
  assert.equal(ctx.ordered().length, 1);
});
