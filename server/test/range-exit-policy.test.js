const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RANGE_EXIT_V1,
  CROSS_CONFIRM_MS,
  MIN_TRIGGER_OFFSET_PCT,
  MAX_TRIGGER_OFFSET_PCT,
  COST_COVERAGE_MULTIPLE,
  rangeKey,
  resolveZone,
  resolveTriggerOffsetPct,
  decideRangeExitV1,
} = require('../src/services/range-exit-policy.service');
const { ALL_POLICIES } = require('../src/services/protected-pool-delta-neutral/shadow-policies');

// Rango de trabajo: +/-5% alrededor de 2400. Los mismos numeros en todos los
// tests para que un fallo se lea sin recalcular nada.
const LOWER = 2280;
const UPPER = 2520;
const RANGE = { rangeLowerPrice: LOWER, rangeUpperPrice: UPPER };
const T0 = 1_700_000_000_000;

function open(overrides = {}) {
  return decideRangeExitV1({
    deltaQty: 0.1,
    actualQty: 0,
    currentPrice: 2400,
    ...RANGE,
    state: {},
    now: T0,
    ...overrides,
  });
}

test('abre cubriendo el 100% del delta', () => {
  const d = open();
  assert.equal(d.policyVersion, RANGE_EXIT_V1);
  assert.equal(d.decision, 'rebalance');
  assert.equal(d.gate, 'initial_full_hedge');
  assert.equal(d.targetQty, 0.1);
  assert.equal(d.nextState.zone, 'inside');
  assert.equal(d.nextState.rangeKey, rangeKey(LOWER, UPPER));
});

test('dentro del rango no rebalancea aunque el delta se mueva mucho', () => {
  const anchored = open().nextState;
  // El precio se pasea por casi todo el rango y el delta del LP cambia con el;
  // la politica no manda una sola orden.
  for (const [price, delta] of [[2300, 0.19], [2400, 0.1], [2500, 0.02], [2350, 0.15]]) {
    const d = decideRangeExitV1({
      deltaQty: delta,
      actualQty: 0.1,
      currentPrice: price,
      ...RANGE,
      state: anchored,
      now: T0 + 60_000,
    });
    assert.equal(d.decision, 'hold', `precio ${price} no deberia disparar`);
    assert.equal(d.gate, 'inside_range_hold');
    assert.equal(d.adjustQty, 0);
  }
});

test('tocar el borde no basta: hace falta pasar el corrimiento del trigger', () => {
  const anchored = open().nextState;
  const d = decideRangeExitV1({
    deltaQty: 0.02,
    actualQty: 0.1,
    currentPrice: UPPER + 0.01, // ya esta fuera, pero pegado al borde
    ...RANGE,
    state: anchored,
    now: T0 + 60_000,
  });
  assert.equal(d.decision, 'hold');
  assert.equal(d.gate, 'trigger_offset_not_reached');
  assert.ok(d.triggerPrice > UPPER, 'el trigger vive por encima del borde');
});

test('salida del rango: confirma en el tiempo y despues cubre el delta nuevo', () => {
  const anchored = open().nextState;
  const farAbove = UPPER * (1 + MAX_TRIGGER_OFFSET_PCT + 0.01);
  const base = { deltaQty: 0.02, actualQty: 0.1, currentPrice: farAbove, ...RANGE };

  // Primer tick fuera: arranca la confirmacion, no ejecuta.
  const first = decideRangeExitV1({ ...base, state: anchored, now: T0 + 60_000 });
  assert.equal(first.decision, 'hold');
  assert.equal(first.gate, 'cross_confirming');

  // Antes de que venza la ventana sigue esperando.
  const during = decideRangeExitV1({ ...base, state: first.nextState, now: T0 + 60_000 + CROSS_CONFIRM_MS - 1 });
  assert.equal(during.decision, 'hold');
  assert.equal(during.gate, 'cross_confirming');

  // Vencida la ventana, rebalancea al delta de afuera.
  const after = decideRangeExitV1({ ...base, state: first.nextState, now: T0 + 60_000 + CROSS_CONFIRM_MS + 1 });
  assert.equal(after.decision, 'rebalance');
  assert.equal(after.gate, 'range_exit');
  assert.equal(after.targetQty, 0.02);
  assert.equal(after.nextState.zone, 'above');
});

test('una mecha que vuelve al rango aborta el cruce sin ejecutar', () => {
  const anchored = open().nextState;
  const farAbove = UPPER * (1 + MAX_TRIGGER_OFFSET_PCT + 0.01);
  const started = decideRangeExitV1({
    deltaQty: 0.02, actualQty: 0.1, currentPrice: farAbove, ...RANGE, state: anchored, now: T0 + 60_000,
  });
  assert.equal(started.gate, 'cross_confirming');

  const back = decideRangeExitV1({
    deltaQty: 0.1, actualQty: 0.1, currentPrice: 2400, ...RANGE, state: started.nextState, now: T0 + 90_000,
  });
  assert.equal(back.decision, 'hold');
  assert.equal(back.gate, 'cross_aborted');
  assert.equal(back.nextState.crossPendingZone, null);
});

test('fuera del rango se queda quieta: ahi el delta ya no cambia', () => {
  const outside = { rangeKey: rangeKey(LOWER, UPPER), zone: 'above' };
  const d = decideRangeExitV1({
    deltaQty: 0, actualQty: 0, currentPrice: UPPER * 1.2, ...RANGE, state: outside, now: T0,
  });
  assert.equal(d.decision, 'hold');
  assert.equal(d.gate, 'outside_range_hold');
});

test('reentrada: el trigger exige meterse DENTRO, no rozar el borde por fuera', () => {
  const outside = { rangeKey: rangeKey(LOWER, UPPER), zone: 'above' };
  // Justo debajo del borde superior: ya esta "inside" pero no paso el offset.
  const shallow = decideRangeExitV1({
    deltaQty: 0.03, actualQty: 0.02, currentPrice: UPPER - 0.01, ...RANGE, state: outside, now: T0,
  });
  assert.equal(shallow.decision, 'hold');
  assert.equal(shallow.gate, 'trigger_offset_not_reached');
  assert.ok(shallow.triggerPrice < UPPER, 'al reentrar el trigger vive por dentro del borde');

  // Bien adentro: confirma y vuelve a cubrir al 100%.
  const deep = UPPER * (1 - MAX_TRIGGER_OFFSET_PCT - 0.01);
  const first = decideRangeExitV1({
    deltaQty: 0.05, actualQty: 0.02, currentPrice: deep, ...RANGE, state: outside, now: T0,
  });
  assert.equal(first.gate, 'cross_confirming');
  const done = decideRangeExitV1({
    deltaQty: 0.05, actualQty: 0.02, currentPrice: deep, ...RANGE, state: first.nextState, now: T0 + CROSS_CONFIRM_MS + 1,
  });
  assert.equal(done.decision, 'rebalance');
  assert.equal(done.gate, 'range_reentry');
  assert.equal(done.targetQty, 0.05);
  assert.equal(done.nextState.zone, 'inside');
});

test('re-centrar el LP re-ancla la cobertura al rango nuevo', () => {
  const anchored = open().nextState;
  const d = decideRangeExitV1({
    deltaQty: 0.12,
    actualQty: 0.1,
    currentPrice: 2600,
    rangeLowerPrice: 2470,
    rangeUpperPrice: 2730,
    state: anchored,
    now: T0 + 60_000,
  });
  assert.equal(d.decision, 'rebalance');
  assert.equal(d.gate, 'range_rebased');
  assert.equal(d.targetQty, 0.12);
  assert.equal(d.nextState.rangeKey, rangeKey(2470, 2730));
});

test('un forzado del orquestador manda sobre la maquina de estados', () => {
  const anchored = open().nextState;
  const d = decideRangeExitV1({
    deltaQty: 0.15, actualQty: 0.1, currentPrice: 2400, ...RANGE, state: anchored, now: T0 + 60_000, forceRebalance: true,
  });
  assert.equal(d.decision, 'rebalance');
  assert.equal(d.gate, 'forced');
  assert.equal(d.targetQty, 0.15);
});

test('sin rango utilizable no inventa un ancla', () => {
  const d = decideRangeExitV1({
    deltaQty: 0.1, actualQty: 0.1, currentPrice: 2400, rangeLowerPrice: null, rangeUpperPrice: null, state: {}, now: T0,
  });
  assert.equal(d.decision, 'hold');
  assert.equal(d.gate, 'range_unavailable');
});

test('el corrimiento del trigger sale del coste y no depende del tamano', () => {
  // Resultado central de la derivacion: como la comision de HL es puramente
  // proporcional al notional, el `adjustQty` se cancela y el offset de
  // equilibrio es 2 * COST_COVERAGE_MULTIPLE * tasa. Este test existe para que
  // si alguien le mete una parte fija al coste, falle aqui y no en produccion.
  const rate = 0.001;
  assert.equal(resolveTriggerOffsetPct({ takerFeeRate: rate }), 2 * COST_COVERAGE_MULTIPLE * rate);

  // Una tasa chica cae al piso: un offset de cero devolveria el whipsaw.
  assert.equal(resolveTriggerOffsetPct({ takerFeeRate: 0.00001 }), MIN_TRIGGER_OFFSET_PCT);
  // Una tasa corrupta se topa arriba en vez de dejar la cobertura llegando tarde.
  assert.equal(resolveTriggerOffsetPct({ takerFeeRate: 0.5 }), MAX_TRIGGER_OFFSET_PCT);
  // Sin argumentos usa la tasa taker por defecto y sigue dentro de la banda.
  const def = resolveTriggerOffsetPct();
  assert.ok(def >= MIN_TRIGGER_OFFSET_PCT && def <= MAX_TRIGGER_OFFSET_PCT);
});

test('resolveZone ubica el precio contra el rango', () => {
  assert.equal(resolveZone(2400, LOWER, UPPER), 'inside');
  assert.equal(resolveZone(UPPER, LOWER, UPPER), 'above');
  assert.equal(resolveZone(LOWER, LOWER, UPPER), 'below');
});

test('la politica queda registrada en el motor de sombra', () => {
  assert.ok(ALL_POLICIES.includes(RANGE_EXIT_V1));
});
