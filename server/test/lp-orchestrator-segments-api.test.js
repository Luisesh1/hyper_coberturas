const test = require('node:test');
const assert = require('node:assert/strict');

const { LpOrchestratorService } = require('../src/services/lp-orchestrator.service');
const { makeSegmentFakeRepo } = require('./support/segment-fake-repo');

/**
 * API de tramos: lista en orden seq desc con totales que cuadran contra el
 * acumulado del orquestador, y detalle filtrado por segmento.
 */

const silentLogger = { warn: () => {}, info: () => {}, error: () => {} };
const acc = (net, extra = {}) => ({ lpFeesUsd: net, totalNetPnlUsd: net, ...extra });

async function setup({ orchNet = 15 } = {}) {
  const segRepo = makeSegmentFakeRepo();
  const orch = {
    id: 5,
    userId: 1,
    activeSegmentId: null,
    activeProtectedPoolId: 9,
    accounting: acc(orchNet),
  };
  const rebalanceCalls = [];
  const rebalances = [
    { id: 1, segmentId: 3, createdAt: 2_000, actualQtyAfter: 1, targetQtyAfter: 1 },
    { id: 2, segmentId: 2, createdAt: 1_500, actualQtyAfter: 1, targetQtyAfter: 2 },
  ];
  const logs = [
    { id: 1, kind: 'tx_finalized', segmentId: 3 },
    { id: 2, kind: 'tx_finalized', segmentId: 2 },
  ];
  const service = new LpOrchestratorService({
    lpOrchestratorRepository: {
      async getById(userId, id) { return userId === 1 && id === 5 ? JSON.parse(JSON.stringify(orch)) : null; },
      async listActionLog() { return logs; },
    },
    segmentRepository: segRepo,
    rebalanceRepository: {
      async listBySegmentId(segmentId) { rebalanceCalls.push(segmentId); return rebalances.filter((r) => r.segmentId === segmentId); },
    },
    logger: silentLogger,
    db: { transaction: async (fn) => fn(undefined) },
  });
  // seq 1, 2 cerrados; seq 3 vivo con baseline = suma de los anteriores.
  await segRepo.create({ orchestratorId: 5, openedAt: 100, accounting: acc(4), baselineAccounting: acc(0) });
  await segRepo.close(1, { closedAt: 200, accounting: acc(4), closeReason: 'range_exit_below' });
  await segRepo.create({ orchestratorId: 5, openedAt: 200, accounting: acc(6), baselineAccounting: acc(4) });
  await segRepo.close(2, { closedAt: 300, accounting: acc(6), closeReason: 'manual_rerange' });
  await segRepo.create({ orchestratorId: 5, openedAt: 300, openPrice: 2500, baselineAccounting: acc(10) });
  orch.activeSegmentId = 3;
  return { service, segRepo, orch, rebalanceCalls };
}

test('listSegments: orden seq desc y la diferencia de reconstrucción es 0', async () => {
  const { service } = await setup();
  const out = await service.listSegments(1, 5);
  assert.deepEqual(out.segments.map((s) => s.seq), [3, 2, 1]);
  assert.equal(out.segments[0].status, 'open');
  assert.equal(out.segments[0].accounting.totalNetPnlUsd, 5);
  assert.equal(out.totals.sumNetPnlUsd, 15);
  assert.equal(out.totals.orchestratorNetPnlUsd, 15);
  assert.equal(out.totals.differenceUsd, 0);
  assert.equal(out.segments[0].coverage.adjustments, 1);
  assert.equal(out.segments[2].baselineAccounting, undefined);
});

test('listSegments: una diferencia real se expone en differenceUsd', async () => {
  const { service, segRepo } = await setup({ orchNet: 17.5 });
  await segRepo.close(3, { closedAt: 400, accounting: acc(5) });
  const out = await service.listSegments(1, 5);
  assert.equal(out.totals.differenceUsd, 2.5);
});

test('listSegments / getSegment: orquestador ajeno o inexistente => null', async () => {
  const { service } = await setup();
  assert.equal(await service.listSegments(2, 5), null);
  assert.equal(await service.getSegment(2, 5, 1), null);
  assert.equal(await service.getSegment(1, 5, 999), null);
});

test('getSegment: añade eventos y reajustes del propio tramo', async () => {
  const { service } = await setup();
  const out = await service.getSegment(1, 5, 2);
  assert.equal(out.id, 2);
  assert.deepEqual(out.events.map((e) => e.id), [2]);
  assert.deepEqual(out.rebalances.map((r) => r.id), [2]);
  assert.equal(out.coverage.adjustments, 1);
});
