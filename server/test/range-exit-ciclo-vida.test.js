const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CROSS_CONFIRM_MS,
  decideRangeExitV1,
} = require('../src/services/range-exit-policy.service');
const {
  resolveExposureMeasureUsd,
  resolveNakedExposure,
  resolveNakedNotionalBreach,
  resolveNakedNotionalCapUsd,
} = require('../src/services/protected-pool-delta-neutral.helpers');

/**
 * Ciclo de vida completo de una proteccion `range_exit_v1` recien creada.
 *
 * Revision previa a abrir orquestadores con capital real. Los tests sueltos
 * cubren cada pieza; esto recorre la secuencia entera y comprueba los dos
 * criterios de aceptacion del plan:
 *
 *   un recorrido de +/-4% DENTRO del rango  -> CERO ordenes
 *   un cruce de borde confirmado            -> EXACTAMENTE una
 *
 * La linea base contra la que se mide: antes de la Fase 1, de 37 ejecuciones de
 * pp28 CERO las decidio su politica. Todas venian del tope, de compuertas de
 * riesgo o de strings legacy.
 */

// LP equivalente al que hubo: ~$520 y rango +/-4,5% alrededor de 2735.
const LOWER = 2612;
const UPPER = 2858;
const RANGO = { rangeLowerPrice: LOWER, rangeUpperPrice: UPPER };
const POOL_USD = 520;
let T = 1_700_000_000_000;

// Delta de un LP concentrado: 0 por encima del borde, maximo por debajo, y
// decreciente con el precio dentro. Aproximacion lineal, suficiente para
// ejercitar la maquina de estados.
function deltaEn(precio) {
  if (precio >= UPPER) return 0;
  if (precio <= LOWER) return POOL_USD / LOWER;
  const fraccion = (UPPER - precio) / (UPPER - LOWER);
  return (POOL_USD / precio) * fraccion;
}

// Simula el motor: la politica decide, y si decide se ejecuta al completo.
function correr(precios, { fallaEjecucion = false } = {}) {
  let state = {};
  let held = 0;
  const ordenes = [];

  for (const precio of precios) {
    T += 30_000;
    const d = decideRangeExitV1({
      ...RANGO, deltaQty: deltaEn(precio), actualQty: held, currentPrice: precio,
      state, now: T,
    });
    state = d.nextState || state;
    if (d.decision === 'rebalance') {
      ordenes.push({ precio, gate: d.gate, target: d.targetQty, desde: held });
      if (!fallaEjecucion) held = d.targetQty;
    }
  }
  return { ordenes, held, state };
}

test('al crear, cubre el 100% del delta en una sola orden', () => {
  const { ordenes, held } = correr([2735]);

  assert.equal(ordenes.length, 1);
  assert.equal(ordenes[0].gate, 'initial_full_hedge');
  assert.ok(Math.abs(held - deltaEn(2735)) < 1e-9, 'queda exactamente al delta');
});

test('CRITERIO: un recorrido de ±4% dentro del rango produce CERO ordenes', () => {
  // Apertura, y despues el precio pasea por casi todo el rango sin salir.
  const paseo = [2735, 2700, 2660, 2640, 2700, 2760, 2800, 2840, 2790, 2735];
  const { ordenes } = correr(paseo);

  // La primera es la apertura; a partir de ahi, nada.
  assert.equal(ordenes.length, 1, `sobran ordenes: ${JSON.stringify(ordenes.slice(1))}`);
  assert.equal(ordenes[0].gate, 'initial_full_hedge');
});

test('CRITERIO: un cruce de borde confirmado produce EXACTAMENTE una orden', () => {
  let state = correr([2735]).state;
  let held = deltaEn(2735);
  const ordenes = [];

  // Sale por arriba y se sostiene. El offset del trigger son 0,15%, asi que
  // 2870 esta comodamente fuera.
  for (const [precio, salto] of [[2870, 30_000], [2870, CROSS_CONFIRM_MS + 1], [2875, 30_000], [2880, 30_000]]) {
    T += salto;
    const d = decideRangeExitV1({
      ...RANGO, deltaQty: deltaEn(precio), actualQty: held, currentPrice: precio, state, now: T,
    });
    state = d.nextState || state;
    if (d.decision === 'rebalance') { ordenes.push(d.gate); held = d.targetQty; }
  }

  assert.deepEqual(ordenes, ['range_exit'], 'ni dos ni cero');
  assert.equal(held, 0, 'por encima del borde el hedge correcto es cero');
});

test('una mecha que pincha el borde y vuelve no ejecuta nada', () => {
  let state = correr([2735]).state;
  const held = deltaEn(2735);
  const ordenes = [];

  for (const [precio, salto] of [[2870, 30_000], [2800, 30_000], [2735, 30_000]]) {
    T += salto;
    const d = decideRangeExitV1({
      ...RANGO, deltaQty: deltaEn(precio), actualQty: held, currentPrice: precio, state, now: T,
    });
    state = d.nextState || state;
    if (d.decision === 'rebalance') ordenes.push(d.gate);
  }

  assert.equal(ordenes.length, 0, 'la confirmacion de 120 s existe para esto');
});

test('si la orden de apertura NO entra, se reintenta en vez de quedarse en cero', () => {
  // El modo de fallo que dejo a pp24 siete dias con actual_qty = 0.00010.
  const { ordenes, held } = correr([2735, 2730, 2725], { fallaEjecucion: true });

  assert.ok(ordenes.length >= 2, 'insiste');
  assert.equal(held, 0);
  assert.equal(ordenes[1].gate, 'commit_incomplete');
});

test('el tope NO interviene durante un recorrido normal dentro del rango', () => {
  // Esto es lo que rompia todo: el tope saltaba al 23% del camino al borde.
  let state = correr([2735]).state;
  let held = deltaEn(2735);
  const cap = resolveNakedNotionalCapUsd(null, POOL_USD);
  const intervenciones = [];

  for (const precio of [2700, 2660, 2640, 2620]) {
    T += 30_000;
    const d = decideRangeExitV1({
      ...RANGO, deltaQty: deltaEn(precio), actualQty: held, currentPrice: precio, state, now: T,
    });
    state = d.nextState || state;
    if (d.decision === 'rebalance') held = d.targetQty;

    const usd = resolveExposureMeasureUsd({
      livePolicy: 'range_exit_v1',
      actualQty: held,
      deltaQty: deltaEn(precio),
      committedTargetQty: state.committedTargetQty,
      currentPrice: precio,
    });
    const exp = resolveNakedExposure({ nakedNotionalUsd: usd, poolValueUsd: POOL_USD, now: T });
    const breach = resolveNakedNotionalBreach({
      nakedNotionalUsd: usd, poolValueUsd: POOL_USD, tier: exp.tier,
    });
    if (breach.breached) intervenciones.push({ precio, usd: usd.toFixed(2) });
  }

  assert.deepEqual(intervenciones, [], `el tope ($${cap.toFixed(2)}) volvio a anular la politica`);
});

test('pero el tope SI interviene si la orden no aterrizo y se sostiene', () => {
  // La red que no se puede perder: el caso de pp27.
  const usd = resolveExposureMeasureUsd({
    livePolicy: 'range_exit_v1',
    actualQty: 0.09, deltaQty: 0, committedTargetQty: 0, currentPrice: 2735,
  });
  const primera = resolveNakedExposure({ nakedNotionalUsd: usd, poolValueUsd: POOL_USD, now: T });
  const sostenida = resolveNakedExposure({
    nakedNotionalUsd: usd, poolValueUsd: POOL_USD,
    now: T + 61 * 60_000, priorSince: primera.since, priorTier: primera.tier,
  });

  assert.equal(
    resolveNakedNotionalBreach({ nakedNotionalUsd: usd, poolValueUsd: POOL_USD, tier: sostenida.tier }).breached,
    true,
    'un short que nadie cierra sigue siendo una averia'
  );
});

test('re-centrar el LP re-ancla y vuelve a cubrir el 100%', () => {
  // El orquestador mueve el rango: clave nueva, apertura nueva.
  const state = correr([2735]).state;
  const held = deltaEn(2735);
  T += 30_000;

  const d = decideRangeExitV1({
    rangeLowerPrice: 2700, rangeUpperPrice: 2950,
    deltaQty: 0.09, actualQty: held, currentPrice: 2820, state, now: T,
  });

  assert.equal(d.decision, 'rebalance');
  assert.equal(d.gate, 'range_rebased');
  assert.equal(d.targetQty, 0.09);
  assert.equal(d.nextState.committedTargetQty, 0.09);
});

test('abrir con el precio YA fuera del rango por arriba no deja una orden absurda', () => {
  // Escenario real al reabrir: el LP se crea y el precio esta sobre el borde.
  // Ahi el delta es 0 y el hedge correcto es cero — no una orden de nada.
  const { ordenes, held, state } = correr([2900]);

  assert.equal(held, 0, 'por encima del borde el hedge correcto es cero');
  assert.equal(ordenes[0].gate, 'initial_full_hedge');
  assert.equal(ordenes[0].target, 0);
  assert.equal(state.zone, 'above');
});

test('abrir fuera por arriba y reentrar cubre al 100% en una sola orden', () => {
  let { state } = correr([2900]);
  let held = 0;
  const ordenes = [];

  // Reentra y se sostiene. El trigger de reentrada exige meterse DENTRO
  // pasando el borde menos el offset, no basta con rozarlo.
  for (const [precio, salto] of [[2800, 30_000], [2800, CROSS_CONFIRM_MS + 1], [2790, 30_000]]) {
    T += salto;
    const d = decideRangeExitV1({
      ...RANGO, deltaQty: deltaEn(precio), actualQty: held, currentPrice: precio, state, now: T,
    });
    state = d.nextState || state;
    if (d.decision === 'rebalance') { ordenes.push(d.gate); held = d.targetQty; }
  }

  assert.deepEqual(ordenes, ['range_reentry']);
  assert.ok(held > 0, 'dentro del rango vuelve a haber delta que cubrir');
});
