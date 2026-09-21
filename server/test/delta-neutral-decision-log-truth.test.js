const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProtectedPoolDeltaNeutralService,
} = require('../src/services/protected-pool-delta-neutral.service');

/**
 * Regresion de pp26 / orq #53 (2026-09-12 y 09-13).
 *
 * `protection_decision_log` registro 2.870 filas el 09-12 y 2.860 el 09-13 con
 * `decision = 'rebalance_full'`, `reason = 'drift_exceeds_cost_aware_band'` y
 * `execution_skipped_because = NULL` — o sea "decidi rebalancear y nada me lo
 * impidio". `protected_pool_delta_rebalance_log` tiene CERO rebalanceos esos
 * dos dias.
 *
 * La causa: bajo zonas legacy conviven dos variables distintas.
 *   - `resolveRebalanceDecision` (helpers:504) es drift-contra-banda PURO y no
 *     sabe nada del temporizador -> devuelve 'rebalance_full'.
 *   - `effectiveShouldRebalance` (evaluate:996) es lo que gatea la ejecucion y
 *     SI incluye el gate del timer -> false.
 * Y `executionSkippedBecause` solo miraba el preflight, que estaba en verde.
 *
 * El log quedaba indistinguible de una ejecucion exitosa, y cualquier
 * diagnostico construido sobre el heredaba la mentira.
 */

const PRICE = 2500;
const NOW = 1_800_000_000_000;

function buildProtection(overrides = {}) {
  return {
    id: 26,
    userId: 1,
    accountId: 3,
    status: 'active',
    protectionMode: 'delta_neutral',
    inferredAsset: 'ETH',
    network: 'arbitrum',
    version: 'v3',
    positionIdentifier: '123',
    walletAddress: '0x00000000000000000000000000000000000000AA',
    poolAddress: '0x00000000000000000000000000000000000000BB',
    leverage: 10,
    rangeLowerPrice: 2000,
    rangeUpperPrice: 3000,
    priceCurrent: PRICE,
    snapshotStatus: 'ready',
    snapshotFreshAt: NOW,
    minOrderNotionalUsd: 11,
    poolSnapshot: {
      mode: 'lp_position',
      version: 'v3',
      network: 'arbitrum',
      identifier: '123',
      positionIdentifier: '123',
      owner: '0x00000000000000000000000000000000000000AA',
      creator: '0x00000000000000000000000000000000000000AA',
      poolAddress: '0x00000000000000000000000000000000000000BB',
      token0Address: '0x00000000000000000000000000000000000000CC',
      token1Address: '0x00000000000000000000000000000000000000DD',
      token0: { symbol: 'WETH', address: '0x00000000000000000000000000000000000000CC', decimals: 18 },
      token1: { symbol: 'USDC', address: '0x00000000000000000000000000000000000000DD', decimals: 6 },
      // Ticks que de verdad contienen a $2500 para WETH/USDC (token0 18 dec,
      // token1 6 dec): 1.0001^tick * 10^12 = precio. Con los ticks positivos de
      // otros fixtures el delta sale 0 y se dispara `forceReduceNearZero`, que
      // saltea el temporizador — justo el gate que este test quiere observar.
      tickLower: -199000,
      tickUpper: -197000,
      liquidity: '80000000000000',
      rangeLowerPrice: 2000,
      rangeUpperPrice: 3000,
      priceCurrent: PRICE,
      currentValueUsd: 2500,
      inRange: true,
      unclaimedFees0: 0,
      unclaimedFees1: 0,
      snapshotFreshAt: NOW,
    },
    ...overrides,
  };
}

function buildService(protection, { actualQty = 0, logged = [] } = {}) {
  const service = new ProtectedPoolDeltaNeutralService({
    // Zona muerta apagada: con ella encendida el bloqueo lo escribe
    // `center_dead_zone` y no se veria el gate del temporizador.
    centerDeadZonePct: 0,
    protectedPoolRepository: {
      getById: async () => protection,
      updateStrategyState: async (_userId, _id, payload) => {
        protection.strategyState = payload.strategyState;
        protection.nextEligibleAttemptAt = payload.nextEligibleAttemptAt;
        protection.cooldownReason = payload.cooldownReason;
      },
    },
    protectionDecisionLogRepository: { create: async (payload) => { logged.push(payload); } },
    hlRegistry: {
      getOrCreate: async () => ({
        getPosition: async () => (actualQty > 0
          ? { coin: 'ETH', szi: String(-actualQty), leverage: { type: 'isolated', value: 10 } }
          : null),
        // Margen de sobra: el preflight tiene que salir en verde para que el
        // unico freno posible sea el gate del temporizador.
        getClearinghouseState: async () => ({ withdrawable: '1000' }),
        getCandleSnapshot: async () => [],
      }),
    },
    getTradingService: async () => ({}),
    marketService: { getAssetContexts: async () => [] },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
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
  service._fetchSpot = async () => ({ priceCurrent: PRICE });
  service._executeRebalance = async ({ strategyState, reason }) => ({
    ...strategyState,
    lastRebalanceReason: reason,
    executed: true,
  });
  return service;
}

// Temporizador recien reseteado -> `timerDue` false. Precio quieto -> el brazo
// urgente tampoco dispara. Sin dwell y con confianza alta para que el unico
// freno sea el timer.
const timerNotDueState = () => ({
  lastRebalanceAt: Date.now() - 1_000,
  lastSnapshotPrice: PRICE,
  modelConfidence: 'high',
  minDwellUntil: null,
});

test('el gate del temporizador escribe su motivo en vez de dejar el log en NULL', async () => {
  const logged = [];
  const protection = buildProtection({ strategyState: timerNotDueState() });
  // Hedge muy por encima del delta: el drift ($499) supera la banda de coste,
  // asi que la rama drift-contra-banda dice 'rebalance_full'. El hedge existe,
  // de modo que no hay hedge huerfano ni reduce-a-cero que saltee el timer.
  const service = buildService(protection, { actualQty: 0.25, logged });

  const state = await service.evaluateProtection(protection);

  assert.equal(state.executed ?? false, false, 'el temporizador tiene que seguir frenando la ejecucion');

  const entry = logged.at(-1);
  assert.ok(entry, 'la evaluacion tiene que dejar una fila de decision');
  assert.equal(entry.reason, 'drift_exceeds_cost_aware_band');
  assert.notEqual(
    entry.executionSkippedBecause,
    null,
    'un rebalanceo diagnosticado que NO se ejecuta no puede quedar sin motivo: es el bug de pp26'
  );
  assert.equal(entry.executionSkippedBecause, 'timer_not_due');
});

test('un rebalanceo que si se ejecuta no inventa un motivo de bloqueo', async () => {
  const logged = [];
  const protection = buildProtection({
    // Temporizador vencido: el drift ya puede disparar.
    strategyState: {
      ...timerNotDueState(),
      lastRebalanceAt: Date.now() - (13 * 60 * 60_000),
    },
  });
  const service = buildService(protection, { actualQty: 0.25, logged });

  const state = await service.evaluateProtection(protection);

  assert.equal(state.executed, true, 'con el timer vencido y margen de sobra tiene que ejecutar');
  assert.equal(
    logged.at(-1).executionSkippedBecause ?? null,
    null,
    'marcar como bloqueada una ejecucion que si ocurrio seria el error simetrico'
  );
});

test('un hold genuino no se disfraza de bloqueo', async () => {
  const timerDueState = () => ({
    ...timerNotDueState(),
    lastRebalanceAt: Date.now() - (13 * 60 * 60_000),
  });

  // El target no se fija a mano: se le pregunta al motor.
  //
  // `targetQty` = delta del LP x multiplicador de zona, y los multiplicadores
  // salen de la config del proceso — que otros tests de la suite modifican. Con
  // el valor hardcodeado este test pasaba aislado y fallaba dentro de `node
  // --test`, que es la peor forma de fallar: parece flakiness y es acoplamiento.
  const probeLog = [];
  const probeProtection = buildProtection({ strategyState: timerDueState() });
  const probe = buildService(probeProtection, { actualQty: 0, logged: probeLog });
  await probe.evaluateProtection(probeProtection);
  const targetQty = Number(probeLog.at(-1).targetQty);
  assert.ok(targetQty > 0, 'el fixture tiene que producir un delta real que cubrir');

  // Hedge exactamente en su sitio: no hay drift que corregir.
  const logged = [];
  const protection = buildProtection({ strategyState: timerDueState() });
  const service = buildService(protection, { actualQty: targetQty, logged });

  await service.evaluateProtection(protection);

  const entry = logged.at(-1);
  assert.equal(entry.reason, 'within_cost_aware_band');
  assert.equal(
    entry.executionSkippedBecause ?? null,
    null,
    'un hold no es un bloqueo: nada le impidio actuar, no habia nada que hacer'
  );
});

// ---------------------------------------------------------------------------
// `_normalizeBlockReason`: Hyperliquid no dice "insufficient margin" siempre.
//
// El 2026-09-18 el mismo evento quedo partido en 41 filas `insufficient_margin`
// y 355 filas con la frase cruda en ingles, porque
// "Account does not have sufficient margin available..." NO contiene
// "insufficient margin". Cualquier conteo sobre esa categoria subcontaba x9.
// ---------------------------------------------------------------------------

const normalizer = () => buildService(buildProtection())._normalizeBlockReason;

test('las tres variantes de margen de Hyperliquid caen en la misma categoria', () => {
  const normalize = normalizer();

  // Textos literales observados en produccion.
  assert.equal(
    normalize('Account does not have sufficient margin available for increasing position'),
    'insufficient_margin'
  );
  assert.equal(
    normalize('Position does not have sufficient margin for reduction.'),
    'insufficient_margin'
  );
  assert.equal(normalize('Insufficient margin to place order'), 'insufficient_margin');
  // La forma interna y la castellana no se rompen.
  assert.equal(normalize('insufficient_margin'), 'insufficient_margin');
  assert.equal(normalize('Margen insuficiente: necesitas $10.00'), 'insufficient_margin');
});

test('normalizar el margen no se traga otros motivos', () => {
  const normalize = normalizer();

  assert.equal(normalize('cooldown_active'), 'cooldown_active');
  assert.equal(normalize('below_min_order_notional'), 'below_min_order_notional');
  assert.equal(normalize('spread_too_wide'), 'spread_too_wide');
  assert.equal(normalize(''), 'unknown');
});
