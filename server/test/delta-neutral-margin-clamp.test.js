const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProtectedPoolDeltaNeutralService,
} = require('../src/services/protected-pool-delta-neutral.service');

/**
 * Recorte del incremento por margen (pp24 / orq #51, 2026-09-04 → 09-10).
 *
 * El 09-03 el precio cruzo el borde, `range_exit_v1` cerro el hedge —correcto,
 * el delta del LP se habia ido a 0— y el precio reentro al rango. Reentrar
 * exige reconstruir el hedge ENTERO, que es la orden mas grande que ese pool
 * emite jamas, y es exactamente la que el preflight rechazaba por completo.
 *
 * Resultado: siete dias con `actual_qty = 0.00010` contra un target de 0.068.
 * Descubierto medio $170, pico $270.
 *
 *   dia      target     actual    descubierto
 *   09-04    0.06804    0.00010   $168.19
 *   09-07    0.06239    0.00010   $155.30
 *   09-10    0.08206    0.00010   $201.43
 *
 * La compuerta ademas solo existe hacia arriba: medido sobre 25 dias, 56.722
 * bloqueos con el hedge corto contra 664 con el hedge largo. Cerrar es gratis y
 * reabrir no — esa asimetria es la que convierte un episodio en una semana.
 */

const PRICE = 2500;
const LEVERAGE = 10;

function buildPreflightService({ withdrawable, position = null }) {
  const service = new ProtectedPoolDeltaNeutralService({
    protectedPoolRepository: {},
    protectionDecisionLogRepository: { create: async () => {} },
    hedgeAlertsRepository: { create: async () => {}, resolveOpenByType: async () => {} },
    hlRegistry: {},
    getTradingService: async () => ({}),
    marketService: { getAssetContexts: async () => [] },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    hyperliquidStreamService: {
      trackProtection: () => {}, start: () => {}, stop: () => {},
      getMidPrice: async () => null, getBbo: async () => null,
      getActiveAssetCtx: async () => null, getClearinghouseState: async () => null,
      getDiagnostics: () => ({ enabled: false }),
    },
    rpcBudgetManager: { canSpend: () => ({ allowed: true, snapshot: null }), getSnapshot: () => null, record: () => {} },
  });

  const hl = {
    getClearinghouseState: async () => ({ withdrawable: String(withdrawable), assetPositions: position ? [position] : [] }),
  };

  return { service, hl };
}

function runPreflight({ withdrawable, actualQty, targetQty, minOrderNotionalUsd = 11 }) {
  const { service, hl } = buildPreflightService({ withdrawable });
  const protection = {
    id: 24,
    userId: 1,
    accountId: 2,
    inferredAsset: 'ETH',
    leverage: LEVERAGE,
    snapshotStatus: 'ready',
    minOrderNotionalUsd,
    maxSlippageBps: 20,
  };
  const trackingErrorQty = targetQty - actualQty;
  return service._buildPreflight({
    protection,
    hl,
    strategyState: {},
    actualQty,
    currentPrice: PRICE,
    tracking: {
      trackingErrorQty,
      trackingErrorUsd: Math.abs(trackingErrorQty) * PRICE,
    },
    bands: {},
    decision: 'rebalance_full',
    accountState: { withdrawable: String(withdrawable), assetPositions: [] },
    assetContext: null,
    bbo: null,
    positionObserved: actualQty > 0,
    positionReadSource: 'short_position',
    positionMissingUnconfirmed: false,
  });
}

test('con margen para una parte, la orden entra recortada en vez de rechazarse', async () => {
  // pp24 el 09-04: hacia falta reconstruir 0.068 ETH ($170, $17 de margen a
  // 10x) y solo habia $8 disponibles. Antes: rechazo total, cobertura 0.
  const preflight = await runPreflight({ withdrawable: 8, actualQty: 0.0001, targetQty: 0.068 });

  assert.equal(preflight.ok, true, 'entrar parcial domina a no entrar');
  assert.equal(preflight.reason, 'margin_clamped_increase');
  assert.equal(preflight.executionSkippedBecause, null, 'no se salta nada: se ejecuta menos');
  assert.ok(preflight.maxIncreaseQty > 0);
  assert.ok(
    preflight.maxIncreaseQty < preflight.clampedFromQty,
    'tiene que ser menos de lo pedido, si no no habria recorte'
  );
  // $8 de colateral a 10x son $80 de notional -> 0.032 ETH a $2500, menos el
  // factor de seguridad.
  assert.ok(preflight.maxIncreaseQty > 0.030 && preflight.maxIncreaseQty < 0.032);
});

test('el recorte deja margen de seguridad: no se pega al limite', async () => {
  const preflight = await runPreflight({ withdrawable: 8, actualQty: 0, targetQty: 0.068 });
  const marginUsedByGranted = (preflight.maxIncreaseQty * PRICE) / LEVERAGE;

  assert.ok(
    marginUsedByGranted < 8,
    'el precio se mueve entre el calculo y el fill; pegarse al limite reproduce el rechazo'
  );
});

test('cuando no cabe NADA se sigue bloqueando, y se distingue del caso anterior', async () => {
  // Withdrawable casi nulo: ni siquiera el minimo de orden entra.
  const preflight = await runPreflight({ withdrawable: 0.004, actualQty: 0.0001, targetQty: 0.068 });

  assert.equal(preflight.ok, false);
  assert.equal(preflight.reason, 'insufficient_margin');
  assert.ok(
    preflight.affordableNotionalUsd < 11,
    'lo que cabria no llega al minimo del exchange, por eso no se envia'
  );
  // "No cabe nada" y "no cabe todo" son estados distintos y hasta ahora se
  // registraban igual, asi que no se podian separar en el analisis.
  assert.ok(Number(preflight.affordableNotionalUsd) >= 0);
});

test('reducir el hedge nunca se bloquea por margen', async () => {
  // La compuerta solo existe hacia arriba, y eso es correcto: cerrar libera
  // colateral. Lo que estaba mal era el todo-o-nada del otro lado.
  const preflight = await runPreflight({ withdrawable: 0, actualQty: 0.068, targetQty: 0.0001 });

  assert.notEqual(preflight.reason, 'insufficient_margin');
  assert.equal(preflight.maxIncreaseQty ?? null, null, 'una reduccion no se recorta');
});

test('con margen de sobra no hay recorte', async () => {
  const preflight = await runPreflight({ withdrawable: 1_000, actualQty: 0, targetQty: 0.068 });

  assert.equal(preflight.ok, true);
  assert.equal(preflight.maxIncreaseQty ?? null, null, 'sin escasez no se toca la orden');
});

// ---------------------------------------------------------------------------
// Piso de margen y desapalancamiento (Fase 4.3 / 4.4).
//
// Mecanismo procíclico: el `hedgeRealizedPnl` se descuenta del MISMO margen
// aislado que dimensiona el hedge, y no hay vía de reposición. La cuenta de
// pp18 pasó de $31.76 (26 ago) a $20.38 — exactamente su realizado de −11.63 —
// y la cobertura cayó a 0.55 sin que nada lo frenara.
// ---------------------------------------------------------------------------

const {
  resolveMarginFloor,
  resolveDeleverageTarget,
} = require('../src/services/protected-pool-delta-neutral.helpers');

test('el piso exige holgura por encima del margen nominal', () => {
  // 0.093 ETH a $2.500 y 10x = $23.25 nominales. Con holgura, $30.22.
  const floor = resolveMarginFloor({
    targetQty: 0.093, currentPrice: 2_500, leverage: 10, availableMarginUsd: 25,
  });

  assert.ok(floor.requiredMarginUsd > 23.25, 'el nominal solo no deja espacio al drawdown del hedge');
  assert.equal(floor.satisfied, false);
  assert.ok(floor.shortfallUsd > 0);
});

test('con margen de sobra el piso se cumple y no hay nada que hacer', () => {
  const floor = resolveMarginFloor({
    targetQty: 0.093, currentPrice: 2_500, leverage: 10, availableMarginUsd: 100,
  });

  assert.equal(floor.satisfied, true);
  assert.equal(floor.shortfallUsd, 0);

  const plan = resolveDeleverageTarget({
    poolValueUsd: 330, targetQty: 0.093, currentPrice: 2_500, leverage: 10, availableMarginUsd: 100,
  });
  assert.equal(plan.needed, false);
  assert.equal(plan.reduceByUsd, 0);
});

test('pp18: con $20.38 de cuenta el LP habria que encogerlo, no sostenerlo desnudo', () => {
  // Cifras del 2026-09-01: cuenta $20.38, target 0.093 ETH, LP $330.
  const plan = resolveDeleverageTarget({
    poolValueUsd: 330,
    targetQty: 0.093,
    currentPrice: 2_500,
    leverage: 10,
    availableMarginUsd: 20.38,
  });

  assert.equal(plan.needed, true);
  assert.ok(plan.coverableFraction < 1);
  assert.ok(plan.suggestedPoolValueUsd < 330);
  assert.ok(plan.reduceByUsd > 0);
  // Un LP mas chico y CUBIERTO domina a uno grande y descubierto: esa es toda
  // la tesis de esta ruta.
  const floorTrasEncoger = resolveMarginFloor({
    targetQty: 0.093 * plan.coverableFraction,
    currentPrice: 2_500,
    leverage: 10,
    availableMarginUsd: 20.38,
  });
  assert.ok(
    floorTrasEncoger.shortfallUsd < 0.01,
    'el tamano sugerido tiene que ser justo el que el margen si sostiene'
  );
});

test('sin delta que cubrir no se recomienda encoger nada', () => {
  const plan = resolveDeleverageTarget({
    poolValueUsd: 330, targetQty: 0, currentPrice: 2_500, leverage: 10, availableMarginUsd: 0,
  });
  assert.equal(plan.needed, false);
});
