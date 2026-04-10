const test = require('node:test');
const assert = require('node:assert/strict');

const LpOrchestratorCostEstimator = require('../src/services/lp-orchestrator/cost-estimator');

function makeOrch() {
  return {
    id: 1,
    network: 'arbitrum',
    version: 'v3',
    walletAddress: '0xabc',
    activePositionIdentifier: '777',
  };
}

test('estimateModifyRangeCost suma gas + slippage del prepareResult', async () => {
  let calls = 0;
  const estimator = new LpOrchestratorCostEstimator({
    positionActionsService: {
      preparePositionAction: async ({ action, payload }) => {
        calls += 1;
        assert.equal(action, 'modify-range');
        assert.equal(payload.positionIdentifier, '777');
        return {
          txPlan: [{ kind: 'swap' }, { kind: 'modify_range_v4' }],
          estimatedCosts: {
            gasCostUsd: 4.2,
            slippageCostUsd: 0.8,
            totalEstimatedCostUsd: 5.0,
            txCount: 2,
          },
        };
      },
    },
    logger: { warn: () => {}, error: () => {} },
  });

  const result = await estimator.estimateModifyRangeCost({
    orchestrator: makeOrch(),
    pool: { priceCurrent: 100 },
    snapshotHash: 'h1',
    rangeWidthPct: 5,
  });
  assert.equal(result.totalCostUsd, 5);
  assert.equal(result.gasCostUsd, 4.2);
  assert.equal(result.slippageCostUsd, 0.8);
  assert.equal(result.txCount, 2);

  // Llamar de nuevo con el mismo snapshotHash usa la cache (no llama otra vez)
  await estimator.estimateModifyRangeCost({
    orchestrator: makeOrch(),
    pool: { priceCurrent: 100 },
    snapshotHash: 'h1',
    rangeWidthPct: 5,
  });
  assert.equal(calls, 1, 'segunda llamada debe usar la caché');
});

test('estimateModifyRangeCost con prepareResult fallido devuelve costo cero', async () => {
  const estimator = new LpOrchestratorCostEstimator({
    positionActionsService: {
      preparePositionAction: async () => { throw new Error('rpc down'); },
    },
    logger: { warn: () => {}, error: () => {} },
  });
  const result = await estimator.estimateModifyRangeCost({
    orchestrator: makeOrch(),
    pool: { priceCurrent: 100 },
    snapshotHash: 'h2',
    rangeWidthPct: 5,
  });
  assert.equal(result.totalCostUsd, 0);
  assert.equal(result.reason, 'prepare_failed');
});

test('invalidate borra entradas del orquestador', async () => {
  let calls = 0;
  const estimator = new LpOrchestratorCostEstimator({
    positionActionsService: {
      preparePositionAction: async () => {
        calls += 1;
        return { estimatedCosts: { gasCostUsd: 1, slippageCostUsd: 0, totalEstimatedCostUsd: 1, txCount: 1 } };
      },
    },
    logger: { warn: () => {}, error: () => {} },
  });
  await estimator.estimateModifyRangeCost({
    orchestrator: makeOrch(), pool: { priceCurrent: 100 }, snapshotHash: 'x', rangeWidthPct: 5,
  });
  estimator.invalidate(1);
  await estimator.estimateModifyRangeCost({
    orchestrator: makeOrch(), pool: { priceCurrent: 100 }, snapshotHash: 'x', rangeWidthPct: 5,
  });
  assert.equal(calls, 2);
});
