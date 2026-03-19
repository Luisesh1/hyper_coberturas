const test = require('node:test');
const assert = require('node:assert/strict');

const { ProtectedPoolDynamicService } = require('../src/services/protected-pool-dynamic.service');

function buildProtection(overrides = {}) {
  return {
    id: 10,
    userId: 1,
    accountId: 5,
    token0Symbol: 'WBTC',
    token1Symbol: 'USDC',
    inferredAsset: 'BTC',
    rangeLowerPrice: 90,
    rangeUpperPrice: 110,
    stopLossDifferencePct: 0.05,
    reentryBufferPct: 0.01,
    flipCooldownSec: 15,
    maxSequentialFlips: 6,
    updatedAt: Date.now(),
    dynamicState: {
      phase: 'inside_range',
      activeSide: null,
      armedReentrySide: null,
      lastBrokenEdge: null,
      currentReentryPrice: null,
      lastFlipAt: null,
      sequentialFlipCount: 0,
      recoveryStatus: null,
      transition: null,
    },
    hedges: {
      downside: {
        id: 201,
        status: 'entry_pending',
        entryPrice: 90,
        exitPrice: 94.5,
      },
      upside: {
        id: 202,
        status: 'open_protected',
        entryPrice: 110,
        exitPrice: 104.5,
      },
    },
    ...overrides,
  };
}

test('dynamic service rearma short arriba y ajusta salida del long al reentry', async () => {
  const savedStates = [];
  const calls = [];
  const service = new ProtectedPoolDynamicService({
    protectedPoolRepository: {
      updateDynamicState: async (userId, id, payload) => {
        savedStates.push({ userId, id, payload });
        return id;
      },
    },
    hedgeRegistry: {
      getOrCreate: async () => ({
        retargetPendingHedge: async (id, payload) => calls.push({ type: 'retarget', id, payload }),
        updateOpenHedgeExit: async (id, exitPrice) => calls.push({ type: 'update_exit', id, exitPrice }),
      }),
    },
    marketService: {
      getAllPrices: async () => ({ BTC: 120 }),
    },
    logger: { warn() {}, error() {}, info() {} },
  });

  await service.evaluateProtection(buildProtection(), { BTC: 120 });

  assert.deepEqual(calls, [
    {
      type: 'retarget',
      id: 201,
      payload: {
        entryPrice: 108.9,
        exitPrice: 108.95444999999999,
        label: 'WBTC/USDC · Reentrada short',
      },
    },
    {
      type: 'update_exit',
      id: 202,
      exitPrice: 108.9,
    },
  ]);
  assert.equal(savedStates[0].payload.dynamicState.phase, 'broken_upper');
  assert.equal(savedStates[0].payload.dynamicState.currentReentryPrice, 108.9);
  assert.equal(savedStates[0].payload.dynamicState.armedReentrySide, 'short');
});

test('dynamic service rearma long abajo y ajusta salida del short al reentry', async () => {
  const savedStates = [];
  const calls = [];
  const service = new ProtectedPoolDynamicService({
    protectedPoolRepository: {
      updateDynamicState: async (userId, id, payload) => {
        savedStates.push({ userId, id, payload });
        return id;
      },
    },
    hedgeRegistry: {
      getOrCreate: async () => ({
        retargetPendingHedge: async (id, payload) => calls.push({ type: 'retarget', id, payload }),
        updateOpenHedgeExit: async (id, exitPrice) => calls.push({ type: 'update_exit', id, exitPrice }),
      }),
    },
    marketService: {
      getAllPrices: async () => ({ BTC: 85 }),
    },
    logger: { warn() {}, error() {}, info() {} },
  });

  await service.evaluateProtection(buildProtection({
    dynamicState: {
      phase: 'broken_upper',
      activeSide: 'short',
      armedReentrySide: 'short',
      lastBrokenEdge: 'upper',
      currentReentryPrice: 108.9,
      lastFlipAt: null,
      sequentialFlipCount: 1,
      recoveryStatus: null,
      transition: null,
    },
    hedges: {
      downside: {
        id: 201,
        status: 'open_protected',
        entryPrice: 108.9,
        exitPrice: 104,
      },
      upside: {
        id: 202,
        status: 'entry_pending',
        entryPrice: 110,
        exitPrice: 104.5,
      },
    },
  }), { BTC: 85 });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].type, 'retarget');
  assert.equal(calls[0].id, 202);
  assert.equal(calls[0].payload.entryPrice, 90.9);
  assert.ok(Math.abs(calls[0].payload.exitPrice - 90.85455) < 1e-9);
  assert.equal(calls[0].payload.label, 'WBTC/USDC · Reentrada long');
  assert.equal(calls[1].type, 'update_exit');
  assert.equal(calls[1].id, 201);
  assert.equal(calls[1].exitPrice, 90.9);
  assert.equal(savedStates[0].payload.dynamicState.phase, 'broken_lower');
  assert.equal(savedStates[0].payload.dynamicState.armedReentrySide, 'long');
  assert.equal(savedStates[0].payload.dynamicState.currentReentryPrice, 90.9);
});
