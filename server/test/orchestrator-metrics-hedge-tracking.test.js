const test = require('node:test');
const assert = require('node:assert/strict');

const { OrchestratorMetricsService } = require('../src/services/orchestrator-metrics.service');
const marketService = require('../src/services/market.service');
const protectedPoolRepository = require('../src/repositories/protected-uniswap-pool.repository');

function withStubs({ assetContexts, protection }, fn) {
  const origCtx = marketService.getAssetContexts;
  const origGet = protectedPoolRepository.getById;
  marketService.getAssetContexts = async () => assetContexts;
  protectedPoolRepository.getById = async () => protection;
  return Promise.resolve(fn()).finally(() => {
    marketService.getAssetContexts = origCtx;
    protectedPoolRepository.getById = origGet;
  });
}

const poolSnapshot = { priceCurrent: 2500 };
const lastEval = { timeInRangePct: 34 };

function orchestrator(extra = {}) {
  return {
    id: 4, userId: 1, inferredAsset: 'ETH', activeProtectedPoolId: 4, ...extra,
  };
}

test('hedgeTracking: trackingErrorUsd y residualUsd desde el strategy_state', async () => {
  const svc = new OrchestratorMetricsService();
  await withStubs({
    assetContexts: [{ name: 'ETH', fundingRate: 0.00001 }],
    protection: {
      inferredAsset: 'ETH',
      strategyState: { lastDeltaQty: 0.0255, lastTargetQty: 0.0153, lastActualQty: 0.0148, zoneState: 'center', modelConfidence: 'high' },
    },
  }, async () => {
    const t = await svc._computeHedgeTracking(orchestrator(), poolSnapshot, lastEval);
    assert.equal(t.hasHedge, true);
    assert.equal(t.timeInRangePct, 34);
    // residual = (0.0255 - 0.0153) * 2500 = 25.5  (el 40% sin cubrir por la zona)
    assert.ok(Math.abs(t.residualUsd - 25.5) < 1e-6, `residualUsd=${t.residualUsd}`);
    // trackingError = |0.0255 - 0.0148| * 2500 = 26.75
    assert.ok(Math.abs(t.trackingErrorUsd - 26.75) < 1e-6, `trackingErrorUsd=${t.trackingErrorUsd}`);
    assert.equal(t.zoneState, 'center');
  });
});

test('funding positivo → el hedge corto COBRA (proyección diaria > 0, sin headwind)', async () => {
  const svc = new OrchestratorMetricsService();
  await withStubs({
    assetContexts: [{ name: 'ETH', fundingRate: 0.00002 }], // +0.002%/h
    protection: { inferredAsset: 'ETH', strategyState: { lastDeltaQty: 0.02, lastTargetQty: 0.02, lastActualQty: 0.02 } },
  }, async () => {
    const t = await svc._computeHedgeTracking(orchestrator(), poolSnapshot, lastEval);
    // hedgeActualUsd = 0.02 * 2500 = 50; proj diario = 0.00002 * 50 * 24 = 0.024
    assert.ok(Math.abs(t.hedgeActualUsd - 50) < 1e-6);
    assert.ok(t.projectedDailyFundingUsd > 0, `proj=${t.projectedDailyFundingUsd}`);
    assert.equal(t.fundingHeadwind, false);
  });
});

test('funding negativo → el hedge corto PAGA (headwind = true)', async () => {
  const svc = new OrchestratorMetricsService();
  await withStubs({
    assetContexts: [{ name: 'ETH', fundingRate: -0.00003 }],
    protection: { inferredAsset: 'ETH', strategyState: { lastDeltaQty: 0.02, lastTargetQty: 0.02, lastActualQty: 0.02 } },
  }, async () => {
    const t = await svc._computeHedgeTracking(orchestrator(), poolSnapshot, lastEval);
    assert.ok(t.projectedDailyFundingUsd < 0, `proj=${t.projectedDailyFundingUsd}`);
    assert.equal(t.fundingHeadwind, true);
    assert.equal(t.fundingRateHourly, -0.00003);
  });
});

test('sin protección activa → hasHedge false pero conserva timeInRangePct', async () => {
  const svc = new OrchestratorMetricsService();
  const t = await svc._computeHedgeTracking(orchestrator({ activeProtectedPoolId: null }), poolSnapshot, lastEval);
  assert.equal(t.hasHedge, false);
  assert.equal(t.timeInRangePct, 34);
});
