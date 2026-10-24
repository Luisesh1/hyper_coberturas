const test = require('node:test');
const assert = require('node:assert/strict');

const { LpOrchestratorService } = require('../src/services/lp-orchestrator.service');
const accounting = require('../src/services/lp-orchestrator/accounting');
const { subtractAccounting } = require('../src/services/lp-orchestrator/segments');
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
 * db falsa con transacción de verdad: guarda una copia del estado de los
 * repos en memoria y la restaura si `fn` lanza (como un ROLLBACK). Pasa un
 * cliente no nulo, como el pool real.
 */
function makeRollbackDb(repo, segRepo) {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  return {
    transactions: 0,
    async transaction(fn) {
      this.transactions += 1;
      const saved = {
        orchestrators: clone([...repo.orchestrators.entries()]),
        log: clone(repo.log),
        segments: clone(segRepo.segments),
      };
      try {
        return await fn({ fakeClient: true });
      } catch (err) {
        repo.orchestrators.clear();
        for (const [k, v] of saved.orchestrators) repo.orchestrators.set(Number(k), v);
        repo.log.splice(0, repo.log.length, ...saved.log);
        segRepo.segments.splice(0, segRepo.segments.length, ...saved.segments);
        throw err;
      }
    },
  };
}

/**
 * Orquestador con un LP vivo desde un `attachLp` real (abre el tramo 1).
 * `protection` (opcional) es la fila de la protección 42 vinculada.
 */
async function setup({ protection = null, pools = {}, scanPools = null, accountingDeps, transactional = false } = {}) {
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
    db: transactional ? makeRollbackDb(repo, segRepo) : fakeDb,
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

const NUMERIC_FIELDS = Object.keys(accounting.DEFAULT_ACCOUNTING)
  .filter((k) => typeof accounting.DEFAULT_ACCOUNTING[k] === 'number');

// Σ tramos cerrados + (acumulado − baseline del abierto) === acumulado.
function assertSegmentsSumToTotal(ctx, label = '') {
  const total = accounting.normalizeAccounting(ctx.orch().accounting);
  const parts = ctx.ordered().map((s) => (s.status === 'closed'
    ? accounting.normalizeAccounting(s.accounting)
    : subtractAccounting(total, s.baselineAccounting)));
  for (const field of NUMERIC_FIELDS) {
    const sum = parts.reduce((acc, p) => acc + Number(p[field] || 0), 0);
    assert.ok(Math.abs(sum - total[field]) < 1e-9, `${label} ${field}: Σ tramos ${sum} != total ${total[field]}`);
  }
}

function liveAccounting(ctx) {
  const open = ctx.ordered().find((s) => s.status !== 'closed');
  return subtractAccounting(ctx.orch().accounting, open.baselineAccounting);
}

test('caso #57: tres LPs dan tres tramos y la apertura es la del LP nuevo', async () => {
  const pools = {
    200000: lp('200000', { priceCurrent: 2700, rangeLowerPrice: 2600, rangeUpperPrice: 2800, priceAtOpen: 2700 }),
    217346: lp('217346', { priceCurrent: 2668.73, rangeLowerPrice: 2550, rangeUpperPrice: 2790, priceAtOpen: 2668.73 }),
    224599: lp('224599', { priceCurrent: 2515, priceAtOpen: 2515 }),
  };
  const ctx = await setup({ pools });

  await ctx.attach('200000', pools[200000]);
  await ctx.service.evaluateOne(1, ctx.id);
  await ctx.finalize('modify-range', { newId: '217346', snapshot: pools[217346] });
  await ctx.service.evaluateOne(1, ctx.id);
  assert.equal(ctx.orch().lastEvaluation.poolSnapshot.priceAtOpen, 2668.73);
  assertSegmentsSumToTotal(ctx, 'tras el 2.º LP');

  // El finalize del 3.er LP llega sin valor ni priceAtOpen (snapshot pobre):
  // el baseline sigue siendo el snapshot del LP 217346.
  const thin = { ...pools[224599] };
  delete thin.priceAtOpen;
  delete thin.currentValueUsd;
  await ctx.finalize('modify-range', { newId: '224599', snapshot: thin });
  await ctx.service.evaluateOne(1, ctx.id);

  const segs = ctx.ordered();
  assert.equal(segs.length, 3);
  assert.deepEqual(segs.map((s) => s.status), ['closed', 'closed', 'open']);
  assert.deepEqual(segs.map((s) => s.positionIdentifier), ['200000', '217346', '224599']);
  assert.ok(segs[2].openPrice >= 2401.9 && segs[2].openPrice <= 2628.1, `openPrice ${segs[2].openPrice}`);
  assert.equal(segs[2].openReason, 'rerange');
  assert.equal(ctx.orch().activeSegmentId, segs[2].id);

  const lastInspect = ctx.inspectCalls[ctx.inspectCalls.length - 1];
  assert.equal(lastInspect.lightweight, false, 'el priceAtOpen de otro LP no evita el scan completo');
  assert.notEqual(ctx.orch().lastEvaluation.poolSnapshot.priceAtOpen, 2668.73);
  assert.equal(ctx.orch().lastEvaluation.poolSnapshot.priceAtOpen, 2515);
  assertSegmentsSumToTotal(ctx, 'tras el 3.er LP');
});

test('el gas del ajuste va al tramo nuevo, no al que cierra', async () => {
  const pools = { 777: lp('777'), 888: lp('888') };
  const ctx = await setup({ pools });
  await ctx.attach('777', pools[777]);
  await ctx.service.evaluateOne(1, ctx.id);

  await ctx.finalize('modify-range', { newId: '888', snapshot: pools[888], gasCostUsd: 0.5 });

  const [closed, open] = ctx.ordered();
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closeReason, 'manual_rerange');
  assert.equal(accounting.normalizeAccounting(closed.accounting).gasSpentUsd, 0);
  assert.equal(liveAccounting(ctx).gasSpentUsd, 0.5);
  assert.equal(liveAccounting(ctx).lpCount, 1, 'el LP nuevo cuenta en su tramo');
  assert.equal(open.openReason, 'rerange');
  assertSegmentsSumToTotal(ctx);
});

test('foto del hedge: el no realizado hasta el corte es del tramo viejo', async () => {
  const protection = {
    id: 42,
    status: 'active',
    protectionMode: 'delta_neutral',
    policyVersion: 'range_exit_v1',
    strategyState: { hedgeRealizedPnlUsd: 10, hedgeUnrealizedPnlUsd: 0, lastActualQty: 0.0048 },
  };
  const pools = { 777: lp('777'), 888: lp('888') };
  const ctx = await setup({ protection, pools });
  await ctx.attach('777', pools[777]);
  await ctx.service.evaluateOne(1, ctx.id); // baseline del hedge = realized 10

  protection.strategyState = { ...protection.strategyState, hedgeUnrealizedPnlUsd: 4 };
  await ctx.finalize('modify-range', { newId: '888', snapshot: pools[888] });

  const [closed, open] = ctx.ordered();
  const closedAcc = accounting.normalizeAccounting(closed.accounting);
  assert.equal(closedAcc.hedgeUnrealizedPnlUsd, 4);
  assert.equal(closedAcc.hedgeRealizedPnlUsd, 0, 'el realizado previo era baseline, no P&L del tramo');
  assert.equal(liveAccounting(ctx).hedgeUnrealizedPnlUsd, 0, 'el tramo nuevo arranca en 0');
  assert.equal(open.hedgeOpenQty, 0.0048);
  assert.equal(open.protectedPoolId, 42);
  assert.equal(open.policyVersion, 'range_exit_v1');
  assert.deepEqual(open.hedgeBaseline.hedgeUnrealizedPnlUsd, 4);

  protection.strategyState = { ...protection.strategyState, hedgeUnrealizedPnlUsd: 6 };
  await ctx.service.evaluateOne(1, ctx.id);
  assert.equal(liveAccounting(ctx).hedgeUnrealizedPnlUsd, 2);
  assertSegmentsSumToTotal(ctx);
});

test('un modify-range con cobertura dispara UNA sola evaluación forzada', async () => {
  const protection = {
    id: 42,
    status: 'active',
    protectionMode: 'delta_neutral',
    strategyState: { lastActualQty: 0.0048 },
  };
  const pools = { 777: lp('777'), 888: lp('888') };
  const ctx = await setup({ protection, pools });
  await ctx.attach('777', pools[777]);

  await ctx.finalize('modify-range', { newId: '888', snapshot: pools[888] });

  assert.equal(ctx.evaluateCalls.length, 1);
  assert.deepEqual(ctx.evaluateCalls[0], {
    id: 42,
    options: { forceReason: 'lp_range_changed', forceRebalance: true },
  });
});

test('Review Focus 1: un finalize repetido no corta dos tramos', async () => {
  const pools = { 777: lp('777'), 888: lp('888') };
  const ctx = await setup({ pools });
  await ctx.attach('777', pools[777]);

  await ctx.finalize('modify-range', { newId: '888', snapshot: pools[888], txHashes: ['0xdup'], gasCostUsd: 1 });
  const again = await ctx.finalize('modify-range', {
    newId: '888', snapshot: pools[888], txHashes: ['0xdup'], gasCostUsd: 1,
  });

  assert.equal(again.alreadyRecorded, true);
  assert.equal(ctx.ordered().length, 2);
  assert.equal(ctx.orch().accounting.gasSpentUsd, 1);
  assertSegmentsSumToTotal(ctx);
});

test('Review Focus 2: sin finalize, _evaluateOne corta al ver el tokenId nuevo (unknown)', async () => {
  // Re-range hecho desde la página de pools: el orquestador ya apunta al LP
  // nuevo pero su tramo vivo sigue siendo el del viejo.
  const pools = { 777: lp('777'), 888: lp('888', { priceCurrent: 2520 }) };
  const ctx = await setup({ pools });
  await ctx.attach('777', pools[777]);
  await ctx.service.evaluateOne(1, ctx.id);
  ctx.orch().activePositionIdentifier = '888';

  await ctx.service.evaluateOne(1, ctx.id);

  const [closed, open] = ctx.ordered();
  assert.equal(closed.closeReason, 'unknown');
  assert.equal(closed.closePrice, 2520);
  assert.equal(open.positionIdentifier, '888');
  assert.equal(open.openReason, 'rerange');
  assert.equal(ctx.orch().activeSegmentId, open.id);
  assertSegmentsSumToTotal(ctx);

  // El siguiente tick ya no vuelve a cortar.
  await ctx.service.evaluateOne(1, ctx.id);
  assert.equal(ctx.ordered().length, 2);
});

test('Review Focus 2: la reconciliación del tokenId también corta con unknown', async () => {
  const pools = { 777: lp('777'), 888: lp('888') };
  const ctx = await setup({ pools });
  await ctx.attach('777', pools[777]);
  await ctx.service.evaluateOne(1, ctx.id);
  // El LP viejo quedó vacío y el nuevo está en la wallet.
  pools[777] = lp('777', { liquidity: '0' });

  await ctx.service.evaluateOne(1, ctx.id);

  const [closed, open] = ctx.ordered();
  assert.equal(ctx.orch().activePositionIdentifier, '888');
  assert.equal(closed.closeReason, 'unknown');
  assert.equal(open.positionIdentifier, '888');
  assert.equal(ctx.ordered().length, 2, 'reconciliar y evaluar no cortan dos veces');
  assert.equal(liveAccounting(ctx).lpCount, 1);
  assertSegmentsSumToTotal(ctx);
});

test('un finalize tardío tras la reconciliación no vuelve a cortar: reetiqueta el corte unknown', async () => {
  // El LP viejo estaba bajo su rango (2550 - 2800) cuando se re-rangeó.
  const pools = {
    777: lp('777', { rangeLowerPrice: 2550, rangeUpperPrice: 2800 }),
    888: lp('888'),
  };
  const ctx = await setup({ pools });
  await ctx.attach('777', pools[777]);
  await ctx.service.evaluateOne(1, ctx.id);
  pools[777] = { ...pools[777], liquidity: '0' };
  await ctx.service.evaluateOne(1, ctx.id); // reconcilia y corta como unknown
  assert.equal(ctx.ordered()[0].closeReason, 'unknown');

  await ctx.finalize('modify-range', { newId: '888', snapshot: pools[888], gasCostUsd: 0.7 });

  const segs = ctx.ordered();
  assert.equal(segs.length, 2, 'un solo tramo nuevo');
  const [closed, live] = segs;
  assert.equal(closed.closeReason, 'range_exit_below');
  assert.deepEqual(closed.closeTxHashes, ['0xmodify-range-888']);
  assert.equal(live.status, 'open');
  assert.equal(live.openReason, 'rerange');
  assert.deepEqual(live.openTxHashes, ['0xmodify-range-888']);
  assert.equal(liveAccounting(ctx).gasSpentUsd, 0.7, 'el gas cae en el tramo vivo');
  assert.equal(accounting.normalizeAccounting(closed.accounting).gasSpentUsd, 0);
  assertSegmentsSumToTotal(ctx);
});

test('un reintento tras un corte confirmado que falló antes del log no corta otra vez', async () => {
  const pools = { 777: lp('777'), 888: lp('888') };
  const ctx = await setup({ pools });
  await ctx.attach('777', pools[777]);
  await ctx.service.evaluateOne(1, ctx.id);
  const realAppend = ctx.repo.appendActionLog;
  let failOnce = true;
  ctx.repo.appendActionLog = async (entry) => {
    if (entry.kind === 'tx_finalized' && failOnce) {
      failOnce = false;
      throw new Error('db caida justo antes del log');
    }
    return realAppend(entry);
  };

  await assert.rejects(() => ctx.finalize('modify-range', { newId: '888', snapshot: pools[888], txHashes: ['0xr'] }));
  assert.equal(ctx.ordered().length, 2);
  await ctx.finalize('modify-range', { newId: '888', snapshot: pools[888], txHashes: ['0xr'] });

  const segs = ctx.ordered();
  assert.equal(segs.length, 2, 'el reintento no abre un tercer tramo');
  assert.equal(segs[0].closeReason, 'manual_rerange');
  assert.equal(segs[1].status, 'open');
  assertSegmentsSumToTotal(ctx);
});

test('I3: un fallo entre el corte y updateActiveLp revierte todo y el reintento corta una vez', async () => {
  const pools = { 777: lp('777'), 888: lp('888') };
  const ctx = await setup({ pools, transactional: true });
  await ctx.attach('777', pools[777]);
  await ctx.service.evaluateOne(1, ctx.id);
  const before = JSON.parse(JSON.stringify({
    orch: ctx.orch(), segments: ctx.ordered(), log: ctx.repo.log,
  }));

  const realUpdateActiveLp = ctx.repo.updateActiveLp;
  let failOnce = true;
  ctx.repo.updateActiveLp = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('proceso caido entre el corte y updateActiveLp');
    }
    return realUpdateActiveLp(...args);
  };

  await assert.rejects(() => ctx.finalize('modify-range', {
    newId: '888', snapshot: pools[888], gasCostUsd: 0.5, txHashes: ['0xatomic'],
  }));
  // Nada persistido: ni tramo nuevo, ni gas, ni tokenId, ni log tx_finalized.
  assert.deepEqual(ctx.ordered(), before.segments);
  assert.deepEqual(ctx.orch().accounting, before.orch.accounting);
  assert.equal(ctx.orch().activePositionIdentifier, '777');
  assert.equal(ctx.orch().activeSegmentId, before.orch.activeSegmentId);
  assert.deepEqual(ctx.orch().lastEvaluation, before.orch.lastEvaluation);
  assert.equal(ctx.repo.log.filter((e) => e.kind === 'tx_finalized').length, 0);

  await ctx.finalize('modify-range', {
    newId: '888', snapshot: pools[888], gasCostUsd: 0.5, txHashes: ['0xatomic'],
  });
  const segs = ctx.ordered();
  assert.equal(segs.length, 2, 'exactamente un corte');
  assert.equal(segs[0].closeReason, 'manual_rerange');
  assert.equal(segs[1].positionIdentifier, '888');
  assert.equal(ctx.orch().activePositionIdentifier, '888');
  assert.equal(ctx.orch().activeSegmentId, segs[1].id);
  const total = accounting.normalizeAccounting(ctx.orch().accounting);
  assert.equal(total.gasSpentUsd, 0.5, 'el gas entra una sola vez');
  assert.equal(total.lpCount, accounting.normalizeAccounting(before.orch.accounting).lpCount + 1);
  assert.equal(ctx.repo.log.filter((e) => e.kind === 'tx_finalized').length, 1);
  assert.equal(ctx.orch().phase, 'lp_active');

  // Un tick posterior no ve un tokenId "nuevo": no hay tramo fantasma.
  await ctx.service.evaluateOne(1, ctx.id);
  assert.equal(ctx.ordered().length, 2);
  assertSegmentsSumToTotal(ctx);
});

test('I3: un fallo al escribir el log tx_finalized revierte el corte (el log es el marcador)', async () => {
  const pools = { 777: lp('777'), 888: lp('888') };
  const ctx = await setup({ pools, transactional: true });
  await ctx.attach('777', pools[777]);
  await ctx.service.evaluateOne(1, ctx.id);
  const realAppend = ctx.repo.appendActionLog;
  let failOnce = true;
  ctx.repo.appendActionLog = async (entry, ...rest) => {
    if (entry.kind === 'tx_finalized' && failOnce) {
      failOnce = false;
      throw new Error('db caida justo antes del log');
    }
    return realAppend(entry, ...rest);
  };
  await assert.rejects(() => ctx.finalize('modify-range', {
    newId: '888', snapshot: pools[888], gasCostUsd: 0.5, txHashes: ['0xlog'],
  }));
  assert.equal(ctx.ordered().length, 1);
  assert.equal(ctx.orch().activePositionIdentifier, '777');
  await ctx.finalize('modify-range', { newId: '888', snapshot: pools[888], gasCostUsd: 0.5, txHashes: ['0xlog'] });
  assert.equal(ctx.ordered().length, 2);
  assert.equal(accounting.normalizeAccounting(ctx.orch().accounting).gasSpentUsd, 0.5);
  assertSegmentsSumToTotal(ctx);
});

test('I3: el cierre del LP es atómico con su cambio de fase y su log', async () => {
  const pools = { 777: lp('777') };
  const ctx = await setup({ pools, transactional: true });
  await ctx.attach('777', pools[777]);
  await ctx.service.evaluateOne(1, ctx.id);
  const realUpdatePhase = ctx.repo.updatePhase;
  let failOnce = true;
  ctx.repo.updatePhase = async (userId, id, patch, ...rest) => {
    if (patch.phase === 'idle' && failOnce) {
      failOnce = false;
      throw new Error('caida al pasar a idle');
    }
    return realUpdatePhase(userId, id, patch, ...rest);
  };
  await assert.rejects(() => ctx.finalize('close-keep-assets', { gasCostUsd: 0.3, txHashes: ['0xclose'] }));
  assert.equal(ctx.ordered()[0].status, 'open', 'el tramo sigue vivo');
  assert.equal(ctx.orch().activePositionIdentifier, '777');
  await ctx.finalize('close-keep-assets', { gasCostUsd: 0.3, txHashes: ['0xclose'] });
  const segs = ctx.ordered();
  assert.equal(segs.length, 1);
  assert.equal(segs[0].status, 'closed');
  assert.equal(segs[0].closeReason, 'lp_closed');
  assert.equal(ctx.orch().phase, 'idle');
  assert.equal(accounting.normalizeAccounting(ctx.orch().accounting).gasSpentUsd, 0.3);
});

test('I3: killLp con el LP ya cerrado corta el tramo atómicamente con la fase idle', async () => {
  const pools = { 777: lp('777') };
  const ctx = await setup({ pools, transactional: true });
  await ctx.attach('777', pools[777]);
  await ctx.service.evaluateOne(1, ctx.id);
  ctx.service._reconcileActivePosition = async () => ({ pool: null, oldIdentifier: '777' });
  const realAppend = ctx.repo.appendActionLog;
  let failOnce = true;
  ctx.repo.appendActionLog = async (entry, ...rest) => {
    if (entry.kind === 'recovery' && failOnce) {
      failOnce = false;
      throw new Error('caida antes del log de recovery');
    }
    return realAppend(entry, ...rest);
  };
  await assert.rejects(() => ctx.service.killLp({ userId: 1, orchestratorId: ctx.id }));
  assert.equal(ctx.ordered()[0].status, 'open');
  assert.equal(ctx.orch().activePositionIdentifier, '777');

  const result = await ctx.service.killLp({ userId: 1, orchestratorId: ctx.id });
  assert.equal(result.alreadyClosed, true);
  assert.equal(ctx.ordered().length, 1);
  assert.equal(ctx.ordered()[0].status, 'closed');
  assert.equal(ctx.ordered()[0].closeReason, 'lp_closed');
  assert.equal(ctx.orch().activePositionIdentifier, null);
  assert.equal(ctx.orch().phase, 'idle');
});

test('reinvest-fees: las fees cobradas son del tramo viejo, el gas del nuevo', async () => {
  const pools = { 777: lp('777') };
  const ctx = await setup({ pools });
  await ctx.attach('777', pools[777]);
  await ctx.service.evaluateOne(1, ctx.id);

  await ctx.finalize('reinvest-fees', {
    snapshot: lp('777', { currentValueUsd: 1003 }),
    collectedFeesUsd: 3,
    gasCostUsd: 0.2,
  });

  const [closed, live] = ctx.ordered();
  assert.equal(closed.closeReason, 'capital_change');
  assert.equal(live.openReason, 'capital_change');
  const closedAcc = accounting.normalizeAccounting(closed.accounting);
  assert.equal(closedAcc.lpFeesUsd, 3);
  assert.equal(closedAcc.gasSpentUsd, 0);
  assert.equal(liveAccounting(ctx).lpFeesUsd, 0);
  assert.equal(liveAccounting(ctx).gasSpentUsd, 0.2);
  assert.equal(ctx.orch().accounting.lpFeesUsd, 3, 'las fees se suman una sola vez');
  assertSegmentsSumToTotal(ctx);
});

test('el motivo de cierre usa el precio de antes del ajuste, no el del finalize', async () => {
  // Última foto del LP viejo: 2390, bajo 2401.9. Al finalizar el precio ya
  // volvió al rango (2515).
  const pools = { 777: lp('777', { priceCurrent: 2390 }), 888: lp('888', { priceCurrent: 2515 }) };
  const ctx = await setup({ pools });
  await ctx.attach('777', pools[777]);
  await ctx.service.evaluateOne(1, ctx.id);

  await ctx.finalize('modify-range', { newId: '888', snapshot: pools[888] });

  const [closed] = ctx.ordered();
  assert.equal(closed.closeReason, 'range_exit_below');
  assert.equal(closed.closePrice, 2515, 'el valor de cierre sigue al precio del finalize');
});

test('C1: pool con el estable en token0 y fees pendientes, precio sin cambiar => sin deriva y lado correcto', async () => {
  // USDC/WETH: priceCurrent y límites en WETH por USDC. ETH a 2390, bajo el
  // rango 2401.9 - 2628.1; la firma no movió el precio.
  const usdcWeth = (identifier) => lp(identifier, {
    token0: { symbol: 'USDC', address: '0x2', decimals: 6 },
    token1: { symbol: 'WETH', address: '0x1', decimals: 18 },
    tickLower: 197580,
    tickUpper: 198480,
    rangeLowerPrice: 1 / 2628.1,
    rangeUpperPrice: 1 / 2401.9,
    priceCurrent: 1 / 2390,
    unclaimedFees0: 25,
    unclaimedFees1: 0.01,
  });
  const pools = { 777: usdcWeth('777'), 888: usdcWeth('888') };
  const ctx = await setup({ pools });
  await ctx.attach('777', pools[777]);
  await ctx.service.evaluateOne(1, ctx.id);
  await ctx.finalize('modify-range', { newId: '888', snapshot: pools[888] });

  const [closed] = ctx.ordered();
  assert.equal(closed.closeReason, 'range_exit_below');
  const drift = accounting.normalizeAccounting(closed.accounting).priceDriftUsd;
  assert.ok(Math.abs(drift) < 1e-9, `priceDriftUsd ${drift}`);
  assertSegmentsSumToTotal(ctx);
});

test('Review Focus 3: sin protección el corte no lee el hedge', async () => {
  const pools = { 777: lp('777'), 888: lp('888') };
  const accountingDeps = {
    ...accounting,
    readHedgeStateFromProtection: () => { throw new Error('no debe leer el hedge'); },
  };
  const ctx = await setup({ pools, accountingDeps });
  await ctx.attach('777', pools[777]);

  await ctx.finalize('modify-range', { newId: '888', snapshot: pools[888] });

  const [closed, open] = ctx.ordered();
  assert.equal(closed.status, 'closed');
  assert.equal(open.status, 'open');
  assert.equal(open.hedgeBaseline, null);
  assert.equal(open.hedgeOpenQty, null);
  assert.equal(ctx.evaluateCalls.length, 0, 'sin protección no hay re-hedge');
  assertSegmentsSumToTotal(ctx);
});

test('Review Focus 5: cerrar el LP deja sin tramo vivo y el siguiente attach abre el seq siguiente', async () => {
  const protection = {
    id: 42,
    status: 'active',
    protectionMode: 'delta_neutral',
    strategyState: { hedgeRealizedPnlUsd: 10, hedgeUnrealizedPnlUsd: 3, lastActualQty: 0.1 },
  };
  const pools = { 777: lp('777'), 999: lp('999') };
  const ctx = await setup({ protection, pools });
  await ctx.attach('777', pools[777]);
  await ctx.service.evaluateOne(1, ctx.id); // baseline realized 10

  // La desactivación reconcilia fills: realized 10 -> 15 y el short se cierra.
  protection.strategyState = { hedgeRealizedPnlUsd: 15, hedgeUnrealizedPnlUsd: 0, lastActualQty: 0 };
  await ctx.finalize('close-keep-assets', {
    snapshot: { liquidity: '0', currentValueUsd: 0, priceCurrent: 2515 },
    gasCostUsd: 0.3,
  });

  const [closed] = ctx.ordered();
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closeReason, 'lp_closed');
  assert.equal(ctx.orch().activeSegmentId, null);
  assert.equal(ctx.ordered().filter((s) => s.status !== 'closed').length, 0);
  // El delta del hedge se aplica una sola vez (10 -> 15 = +5), en el tramo cerrado.
  assert.equal(ctx.orch().accounting.hedgeRealizedPnlUsd, 5);
  assert.equal(accounting.normalizeAccounting(closed.accounting).hedgeRealizedPnlUsd, 5);
  assert.equal(accounting.normalizeAccounting(closed.accounting).gasSpentUsd, 0.3);
  assert.equal(closed.hedgeCloseQty, 0);
  assertSegmentsSumToTotal(ctx, 'tras cerrar');

  protection.strategyState = { hedgeRealizedPnlUsd: 0, hedgeUnrealizedPnlUsd: 0 };
  await ctx.attach('999', pools[999]);
  const segs = ctx.ordered();
  assert.equal(segs.length, 2);
  assert.equal(segs[1].seq, segs[0].seq + 1);
  assert.equal(segs[1].status, 'open');
  assert.equal(segs[1].openReason, 'attach');
  assertSegmentsSumToTotal(ctx, 'tras el attach');
});

test('attachLp guarda el motivo de apertura del llamador', async () => {
  const pools = { 777: lp('777') };
  const ctx = await setup({ pools });
  await ctx.attach('777', pools[777], { openReason: 'adopt' });
  const [seg] = ctx.ordered();
  assert.equal(seg.openReason, 'adopt');
  assert.equal(seg.openPrice, 2515);
  assert.equal(seg.openValueUsd, 1000);
  assert.deepEqual(seg.openTxHashes, ['0xmint-777']);
  assert.equal(ctx.repo.log.find((e) => e.kind === 'attach_lp').segmentId, seg.id);
});

// ── Una sola orden en el motor ──────────────────────────────────────────────
// Tras el re-range la evaluación forzada lleva el short del delta viejo
// (0.0048) al del LP nuevo (0.1072) con UNA orden por la diferencia: nunca
// cierra todo para reabrir.

const { ProtectedPoolDeltaNeutralService } = require('../src/services/protected-pool-delta-neutral.service');

const ENGINE_PRICE = 2500;

function engineProtection(overrides = {}) {
  return {
    id: 42,
    userId: 1,
    accountId: 8,
    status: 'active',
    protectionMode: 'delta_neutral',
    policyVersion: 'range_exit_v1',
    executionMode: 'ioc',
    inferredAsset: 'ETH',
    network: 'arbitrum',
    version: 'v3',
    positionIdentifier: '224599',
    walletAddress: '0x00000000000000000000000000000000000000AA',
    poolAddress: '0x00000000000000000000000000000000000000BB',
    leverage: 7,
    minOrderNotionalUsd: 11,
    rangeLowerPrice: 2000,
    rangeUpperPrice: 3000,
    priceCurrent: ENGINE_PRICE,
    snapshotStatus: 'ready',
    snapshotFreshAt: Date.now(),
    poolSnapshot: {
      mode: 'lp_position',
      version: 'v3',
      network: 'arbitrum',
      identifier: '224599',
      positionIdentifier: '224599',
      owner: '0x00000000000000000000000000000000000000AA',
      creator: '0x00000000000000000000000000000000000000AA',
      poolAddress: '0x00000000000000000000000000000000000000BB',
      token0Address: '0x00000000000000000000000000000000000000CC',
      token1Address: '0x00000000000000000000000000000000000000DD',
      token0: { symbol: 'WETH', address: '0x00000000000000000000000000000000000000CC', decimals: 18 },
      token1: { symbol: 'USDC', address: '0x00000000000000000000000000000000000000DD', decimals: 6 },
      // Ticks reales de 2000 - 3000 en WETH/USDC; la liquidez da un delta de
      // ~0.1072 ETH a 2500.
      tickLower: -200310,
      tickUpper: -196260,
      liquidity: '61517929082277',
      rangeLowerPrice: 2000,
      rangeUpperPrice: 3000,
      priceCurrent: ENGINE_PRICE,
      currentValueUsd: 2500,
      inRange: true,
      unclaimedFees0: 0,
      unclaimedFees1: 0,
      snapshotFreshAt: Date.now(),
    },
    strategyState: {
      executionIntent: 'live',
      policyVersion: 'range_exit_v1',
      lastSnapshotPrice: ENGINE_PRICE,
      modelConfidence: 'high',
      lastActualQty: 0.0048,
    },
    ...overrides,
  };
}

// Motor con la ejecución REAL (`_executeRebalance` + `_runSingleAdjustment`) y
// un exchange fake que anota cada orden y mueve el short en consecuencia.
function engineService(protection, { startQty }) {
  const orders = [];
  let shortQty = startQty;
  const hl = {
    getPosition: async () => (shortQty > 0
      ? { coin: 'ETH', szi: String(-shortQty), leverage: { type: 'isolated', value: 7 } }
      : null),
    getClearinghouseState: async () => ({ withdrawable: '1000' }),
    getCandleSnapshot: async () => [],
  };
  const tradingService = {
    openPosition: async ({ side, size }) => {
      orders.push({ op: 'open', side, size });
      shortQty += size;
      return { fillPrice: ENGINE_PRICE, filledQty: size };
    },
    closePosition: async ({ size }) => {
      orders.push({ op: 'close', size });
      shortQty -= size;
      return { closePrice: ENGINE_PRICE, filledQty: size };
    },
  };
  const service = new ProtectedPoolDeltaNeutralService({
    centerDeadZonePct: 0,
    protectedPoolRepository: {
      getById: async () => protection,
      updateStrategyState: async (_userId, _id, payload) => {
        if (payload.strategyState) protection.strategyState = payload.strategyState;
      },
      setPendingForceReason: async () => {},
    },
    protectionDecisionLogRepository: { create: async () => {} },
    protectedPoolDeltaRebalanceRepository: { create: async () => 1 },
    hlRegistry: { getOrCreate: async () => hl },
    getTradingService: async () => tradingService,
    marketService: { getAssetContexts: async () => [] },
    logger: silentLogger,
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
  service._fetchSpot = async () => ({ priceCurrent: ENGINE_PRICE });
  service._ensureIsolatedMarginBuffer = async () => {};
  service._reconcileHedgeFills = async () => ({ realizedDelta: 0, feeDelta: 0, lastFillTime: Date.now() });
  service.deltaLogRepo = { create: async () => 1 };
  return { service, orders, hl, tradingService };
}

test('una sola orden: de 0.0048 a 0.1072 se vende 0.1024, sin cerrar antes', async () => {
  const protection = engineProtection();
  const { service, orders, hl, tradingService } = engineService(protection, { startQty: 0.0048 });

  await service._executeRebalance({
    protection,
    tradingService,
    hl,
    actualQty: 0.0048,
    currentPrice: ENGINE_PRICE,
    metrics: { targetQty: 0.1072, deltaQty: 0.1072, gamma: 0 },
    band: {},
    strategyState: { ...protection.strategyState, status: 'tracking' },
    reason: 'lp_range_changed',
  });

  assert.equal(orders.length, 1, JSON.stringify(orders));
  assert.equal(orders[0].op, 'open');
  assert.equal(orders[0].side, 'short');
  assert.ok(Math.abs(orders[0].size - 0.1024) < 1e-9, `size ${orders[0].size}`);
});

test('una sola orden: range_exit_v1 forzado tras el re-range ordena solo la diferencia', async () => {
  const protection = engineProtection();
  const { service, orders } = engineService(protection, { startQty: 0.0048 });
  const executions = [];
  const realExecute = service._executeRebalance.bind(service);
  service._executeRebalance = async (args) => {
    executions.push({ reason: args.reason, targetQty: Number(args.metrics.targetQty), actualQty: args.actualQty });
    return realExecute(args);
  };

  await service.evaluateProtection(protection, { forceReason: 'lp_range_changed', forceRebalance: true });

  assert.equal(executions.length, 1, 'una evaluación forzada, una ejecución');
  const { targetQty } = executions[0];
  // range_exit_v1 vivo cubre el 100 % del delta del LP nuevo.
  assert.ok(Math.abs(targetQty - 0.1072) < 0.001, `target ${targetQty}`);
  assert.equal(orders.length, 1, JSON.stringify(orders));
  assert.equal(orders[0].op, 'open', 'no se cierra el short para reabrirlo');
  assert.ok(Math.abs(orders[0].size - (targetQty - 0.0048)) < 1e-9);
  assert.ok(Math.abs(orders[0].size - 0.1024) < 0.001, `size ${orders[0].size}`);
});
