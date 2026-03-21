const test = require('node:test');
const assert = require('node:assert/strict');

const { ProtectedPoolDynamicService } = require('../src/services/protected-pool-dynamic.service');

function buildLiveHedges(overrides = {}) {
  const downside = {
    id: 201,
    protectedRole: 'downside',
    direction: 'short',
    status: 'entry_pending',
    entryPrice: 90,
    dynamicAnchorPrice: 90,
    exitPrice: 90.045,
    label: 'WBTC/USDC · Proteccion baja',
    slOid: null,
  };
  const upside = {
    id: 202,
    protectedRole: 'upside',
    direction: 'long',
    status: 'entry_pending',
    entryPrice: 110,
    dynamicAnchorPrice: 110,
    exitPrice: 109.945,
    label: 'WBTC/USDC · Proteccion alza',
    slOid: null,
  };

  return {
    downside: { ...downside, ...(overrides.downside || {}) },
    upside: { ...upside, ...(overrides.upside || {}) },
  };
}

function buildProtection(overrides = {}) {
  const liveHedges = buildLiveHedges(overrides.liveHedges || {});
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
    breakoutConfirmDistancePct: 0.5,
    breakoutConfirmDurationSec: 600,
    updatedAt: Date.now(),
    dynamicState: {
      phase: 'neutral',
      regime: 'neutral',
      activeSide: null,
      recoveryStatus: null,
      transition: null,
      pendingBreakoutEdge: null,
      pendingBreakoutSince: null,
      pendingBreakoutPrice: null,
    },
    hedges: {
      downside: {
        id: liveHedges.downside.id,
        status: liveHedges.downside.status,
        entryPrice: liveHedges.downside.entryPrice,
        dynamicAnchorPrice: liveHedges.downside.dynamicAnchorPrice,
        exitPrice: liveHedges.downside.exitPrice,
      },
      upside: {
        id: liveHedges.upside.id,
        status: liveHedges.upside.status,
        entryPrice: liveHedges.upside.entryPrice,
        dynamicAnchorPrice: liveHedges.upside.dynamicAnchorPrice,
        exitPrice: liveHedges.upside.exitPrice,
      },
    },
    _liveHedges: liveHedges,
    ...overrides,
  };
}

function buildService(protection, calls, savedStates) {
  return new ProtectedPoolDynamicService({
    protectedPoolRepository: {
      updateDynamicState: async (userId, id, payload) => {
        savedStates.push({ userId, id, payload });
        return id;
      },
    },
    hedgeRegistry: {
      getOrCreate: async () => ({
        getById: (id) => {
          if (id === protection._liveHedges.downside.id) return protection._liveHedges.downside;
          if (id === protection._liveHedges.upside.id) return protection._liveHedges.upside;
          throw new Error('not found');
        },
        retargetPendingHedge: async (id, payload) => {
          calls.push({ type: 'retarget', id, payload });
          const hedge = id === protection._liveHedges.downside.id
            ? protection._liveHedges.downside
            : protection._liveHedges.upside;
          hedge.entryPrice = payload.entryPrice;
          hedge.dynamicAnchorPrice = payload.entryPrice;
          hedge.exitPrice = payload.exitPrice;
          hedge.label = payload.label;
        },
        updateOpenHedgeDynamicAnchor: async (id, payload) => {
          calls.push({ type: 'reanchor', id, payload });
          const hedge = id === protection._liveHedges.downside.id
            ? protection._liveHedges.downside
            : protection._liveHedges.upside;
          hedge.dynamicAnchorPrice = payload.dynamicAnchorPrice;
          hedge.exitPrice = payload.exitPrice;
          hedge.label = payload.label;
          hedge.status = 'open_protected';
          hedge.slOid = hedge.slOid || 999;
        },
      }),
    },
    marketService: {
      getAllPrices: async () => ({ BTC: 100 }),
    },
    logger: { warn() {}, error() {}, info() {} },
  });
}

test('dynamic service confirma breakout superior y reancla ambos hedges al régimen superior', async () => {
  const savedStates = [];
  const calls = [];
  const protection = buildProtection({
    breakoutConfirmDistancePct: 0,
    breakoutConfirmDurationSec: 0,
    liveHedges: {
      upside: {
        status: 'open_protected',
        slOid: 555,
      },
    },
  });
  const service = buildService(protection, calls, savedStates);

  await service.evaluateProtection(protection, { BTC: 120 });

  assert.deepEqual(calls, [
    {
      type: 'retarget',
      id: 201,
      payload: {
        entryPrice: 108.9,
        exitPrice: 108.95444999999999,
        label: 'WBTC/USDC · Proteccion baja',
      },
    },
  ]);
  assert.equal(savedStates[0].payload.dynamicState.phase, 'upper_regime_confirmed');
  assert.equal(savedStates[0].payload.dynamicState.currentReentryPrice, 108.9);
});

test('dynamic service confirma breakout inferior y mantiene régimen migrado al volver al rango', async () => {
  const savedStates = [];
  const calls = [];
  const protection = buildProtection({
    breakoutConfirmDistancePct: 0,
    breakoutConfirmDurationSec: 0,
    liveHedges: {
      downside: {
        status: 'open_protected',
        slOid: 444,
      },
    },
  });
  const service = buildService(protection, calls, savedStates);

  await service.evaluateProtection(protection, { BTC: 85 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'retarget');
  assert.equal(calls[0].id, 202);
  assert.equal(calls[0].payload.entryPrice, 90.9);
  assert.ok(Math.abs(calls[0].payload.exitPrice - 90.85455) < 1e-9);
  assert.equal(calls[0].payload.label, 'WBTC/USDC · Proteccion alza');
  assert.equal(savedStates.at(-1).payload.dynamicState.phase, 'lower_regime_confirmed');

  calls.length = 0;
  savedStates.length = 0;
  protection.dynamicState = savedStates.at(-1)?.payload?.dynamicState || {
    phase: 'lower_regime_confirmed',
    regime: 'lower_regime_confirmed',
  };
  protection._liveHedges.upside.entryPrice = 90.9;
  protection._liveHedges.upside.dynamicAnchorPrice = 90.9;
  protection._liveHedges.upside.exitPrice = 90.85455;

  await service.evaluateProtection(protection, { BTC: 100 });

  assert.equal(calls.length, 0);
  assert.equal(savedStates[0].payload.dynamicState.phase, 'lower_regime_confirmed');
});

test('dynamic service confirma flip de régimen superior a inferior y reubica ambas coberturas', async () => {
  const savedStates = [];
  const calls = [];
  const protection = buildProtection({
    dynamicState: {
      phase: 'confirming_lower_breakout',
      regime: 'upper_regime_confirmed',
      pendingBreakoutEdge: 'lower',
      pendingBreakoutSince: Date.now() - 601_000,
      pendingBreakoutPrice: 85,
      transition: 'confirming_lower_breakout',
      currentReentryPrice: 108.9,
    },
    liveHedges: {
      downside: {
        entryPrice: 108.9,
        dynamicAnchorPrice: 108.9,
        exitPrice: 108.95444999999999,
      },
      upside: {
        entryPrice: 110,
        dynamicAnchorPrice: 110,
        exitPrice: 109.945,
      },
    },
  });
  const service = buildService(protection, calls, savedStates);

  await service.evaluateProtection(protection, { BTC: 85 });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].type, 'retarget');
  assert.equal(calls[0].id, 201);
  assert.equal(calls[0].payload.entryPrice, 90);
  assert.ok(Math.abs(calls[0].payload.exitPrice - 90.045) < 1e-9);
  assert.equal(calls[0].payload.label, 'WBTC/USDC · Proteccion baja');
  assert.equal(calls[1].type, 'retarget');
  assert.equal(calls[1].id, 202);
  assert.equal(calls[1].payload.entryPrice, 90.9);
  assert.ok(Math.abs(calls[1].payload.exitPrice - 90.85455) < 1e-9);
  assert.equal(calls[1].payload.label, 'WBTC/USDC · Proteccion alza');
  assert.equal(savedStates.at(-1).payload.dynamicState.phase, 'lower_regime_confirmed');
  assert.equal(savedStates.at(-1).payload.dynamicState.regime, 'lower_regime_confirmed');
  assert.equal(savedStates.at(-1).payload.dynamicState.currentReentryPrice, 90.9);
});

test('dynamic service confirma flip de régimen inferior a superior y reubica ambas coberturas', async () => {
  const savedStates = [];
  const calls = [];
  const protection = buildProtection({
    dynamicState: {
      phase: 'confirming_upper_breakout',
      regime: 'lower_regime_confirmed',
      pendingBreakoutEdge: 'upper',
      pendingBreakoutSince: Date.now() - 601_000,
      pendingBreakoutPrice: 120,
      transition: 'confirming_upper_breakout',
      currentReentryPrice: 90.9,
    },
    liveHedges: {
      downside: {
        entryPrice: 90,
        dynamicAnchorPrice: 90,
        exitPrice: 90.045,
      },
      upside: {
        entryPrice: 90.9,
        dynamicAnchorPrice: 90.9,
        exitPrice: 90.85455,
      },
    },
  });
  const service = buildService(protection, calls, savedStates);

  await service.evaluateProtection(protection, { BTC: 120 });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].type, 'retarget');
  assert.equal(calls[0].id, 201);
  assert.equal(calls[0].payload.entryPrice, 108.9);
  assert.ok(Math.abs(calls[0].payload.exitPrice - 108.95444999999999) < 1e-9);
  assert.equal(calls[0].payload.label, 'WBTC/USDC · Proteccion baja');
  assert.equal(calls[1].type, 'retarget');
  assert.equal(calls[1].id, 202);
  assert.equal(calls[1].payload.entryPrice, 110);
  assert.ok(Math.abs(calls[1].payload.exitPrice - 109.945) < 1e-9);
  assert.equal(calls[1].payload.label, 'WBTC/USDC · Proteccion alza');
  assert.equal(savedStates.at(-1).payload.dynamicState.phase, 'upper_regime_confirmed');
  assert.equal(savedStates.at(-1).payload.dynamicState.regime, 'upper_regime_confirmed');
  assert.equal(savedStates.at(-1).payload.dynamicState.currentReentryPrice, 108.9);
});

test('dynamic service guarda breakout pendiente antes de confirmar el cambio de régimen', async () => {
  const savedStates = [];
  const calls = [];
  const protection = buildProtection();
  const service = buildService(protection, calls, savedStates);

  await service.evaluateProtection(protection, { BTC: 111 });

  assert.equal(calls.length, 0);
  assert.equal(savedStates[0].payload.dynamicState.phase, 'confirming_upper_breakout');
  assert.equal(savedStates[0].payload.dynamicState.pendingBreakoutEdge, 'upper');
});

test('dynamic service conserva el régimen al cancelar un breakout no confirmado', async () => {
  const savedStates = [];
  const calls = [];
  const protection = buildProtection({
    dynamicState: {
      phase: 'lower_regime_confirmed',
      regime: 'lower_regime_confirmed',
      pendingBreakoutEdge: 'upper',
      pendingBreakoutSince: Date.now() - 60_000,
      pendingBreakoutPrice: 111,
      transition: 'confirming_upper_breakout',
    },
    liveHedges: {
      downside: {
        status: 'open_protected',
        slOid: 400,
      },
      upside: {
        entryPrice: 90.9,
        dynamicAnchorPrice: 90.9,
        exitPrice: 90.85455,
      },
    },
  });
  const service = buildService(protection, calls, savedStates);

  await service.evaluateProtection(protection, { BTC: 100 });

  assert.equal(savedStates[0].payload.dynamicState.phase, 'lower_regime_confirmed');
  assert.equal(savedStates[0].payload.dynamicState.pendingBreakoutEdge, null);
});

test('dynamic service migra en runtime una dinámica legacy por anclas actuales', async () => {
  const savedStates = [];
  const calls = [];
  const protection = buildProtection({
    dynamicState: {
      phase: 'inside_range',
      pendingBreakoutEdge: null,
      pendingBreakoutSince: null,
      pendingBreakoutPrice: null,
    },
    liveHedges: {
      downside: {
        status: 'open_protected',
        slOid: 400,
      },
      upside: {
        entryPrice: 90.9,
        dynamicAnchorPrice: 90.9,
        exitPrice: 90.85455,
      },
    },
  });
  const service = buildService(protection, calls, savedStates);

  await service.evaluateProtection(protection, { BTC: 100 });

  assert.equal(savedStates[0].payload.dynamicState.phase, 'lower_regime_confirmed');
});

test('dynamic service restaura SL del hedge abierto antes de pausar una inconsistencia', async () => {
  const savedStates = [];
  const calls = [];
  const protection = buildProtection({
    dynamicState: {
      phase: 'neutral',
      regime: 'neutral',
    },
    liveHedges: {
      downside: {
        status: 'open_protected',
        slOid: null,
        dynamicAnchorPrice: 90,
        exitPrice: 90.045,
      },
      upside: {
        status: 'open_protected',
        slOid: 333,
      },
    },
  });
  const service = buildService(protection, calls, savedStates);

  await service.evaluateProtection(protection, { BTC: 100 });

  assert.equal(calls[0].type, 'reanchor');
  assert.equal(savedStates.at(-1).payload.dynamicState.phase, 'paused');
  assert.equal(savedStates.at(-1).payload.dynamicState.recoveryStatus, 'both_hedges_open');
});

test('dynamic service pausa cuando no puede inferir el régimen actual', async () => {
  const savedStates = [];
  const calls = [];
  const protection = buildProtection({
    dynamicState: {
      phase: 'neutral',
      regime: 'neutral',
    },
    liveHedges: {
      downside: {
        dynamicAnchorPrice: 95,
        entryPrice: 95,
        exitPrice: 95.0475,
      },
    },
  });
  const service = buildService(protection, calls, savedStates);

  await service.evaluateProtection(protection, { BTC: 100 });

  assert.equal(savedStates.at(-1).payload.dynamicState.phase, 'paused');
  assert.equal(savedStates.at(-1).payload.dynamicState.recoveryStatus, 'regime_inference_failed');
});
