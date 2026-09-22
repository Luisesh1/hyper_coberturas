const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CROSS_CONFIRM_MS,
  rangeKey,
  decideRangeExitV1,
} = require('../src/services/range-exit-policy.service');

/**
 * La orden que nunca aterrizo (pp24, 2026-09-15 → 09-18).
 *
 * El motor persiste el estado de esta politica al DECIDIR, no al ejecutar: en
 * `evaluate.js` el `updateStrategyState` va antes del preflight y la ejecucion
 * puede abortarse despues. Y el `hold` por zona coincidente es ABSORBENTE — si
 * la zona ya coincide no se vuelve a mirar hasta el proximo cruce de borde.
 *
 * Las dos cosas juntas varaban el hedge con una sola orden bloqueada:
 *
 *   09-15 18:47  cae bajo el rango, ordena 0.12406 -> llena solo 0.08490
 *   09-15 18:55  reentra, ordena 0.11435 -> insufficient_margin
 *   09-16 19:35  ultimo intento -> insufficient_margin
 *   ...          47 h DENTRO del rango, target 0.0516, short clavado en 0.08490
 *   09-18 18:36  recien se mueve, y solo porque cruzo el borde SUPERIOR
 *
 * El mismo mecanismo, por `rangeKey` en vez de por `zone`, dejaba un LP
 * re-centrado sin cobertura: `range_rebased` movia la clave, la orden se
 * bloqueaba, y el hedge se quedaba en cero indefinidamente.
 */

const LOWER = 2280;
const UPPER = 2520;
const RANGE = { rangeLowerPrice: LOWER, rangeUpperPrice: UPPER };
const T0 = 1_700_000_000_000;

function decide(overrides) {
  return decideRangeExitV1({ ...RANGE, now: T0, ...overrides });
}

test('un llenado parcial se reintenta en el tick siguiente, no se da por bueno', () => {
  // Fuera del rango por abajo: ordeno 0.124 y el exchange solo dio 0.0849.
  const tras = decide({
    deltaQty: 0.124, actualQty: 0.0849, currentPrice: LOWER * 0.97,
    state: {
      rangeKey: rangeKey(LOWER, UPPER),
      zone: 'below',
      committedTargetQty: 0.124,
    },
  });

  assert.equal(tras.decision, 'rebalance', 'antes se quedaba en outside_range_hold para siempre');
  assert.equal(tras.gate, 'commit_incomplete');
  assert.equal(tras.targetQty, 0.124);
});

test('reentrada bloqueada: la zona ya dice inside pero el short sigue al 100%', () => {
  // El caso exacto de pp24 el 09-15 18:55. `range_reentry` decidio, el motor
  // persistio zone=inside, y el preflight rechazo por margen.
  const varado = decide({
    deltaQty: 0.0516, actualQty: 0.0849, currentPrice: 2500,
    state: {
      rangeKey: rangeKey(LOWER, UPPER),
      zone: 'inside',
      committedTargetQty: 0.11435,
    },
  });

  assert.equal(varado.decision, 'rebalance');
  assert.equal(varado.gate, 'commit_incomplete');
  // Reintenta contra el delta de AHORA, no contra el target rancio: es el
  // mismo evento, solo que mas tarde.
  assert.equal(varado.targetQty, 0.0516);
});

test('re-centrar el LP con la orden bloqueada no deja el hedge en cero', () => {
  // `range_rebased` movio la clave y la orden no entro: held sigue en 0.
  const nuevoRango = { rangeLowerPrice: 2400, rangeUpperPrice: 2640 };
  const d = decideRangeExitV1({
    ...nuevoRango,
    deltaQty: 0.09,
    actualQty: 0,
    currentPrice: 2520,
    now: T0,
    state: {
      rangeKey: rangeKey(2400, 2640),
      zone: 'inside',
      committedTargetQty: 0.09,
    },
  });

  assert.equal(d.decision, 'rebalance', 'el LP nuevo no puede quedarse descubierto');
  assert.equal(d.gate, 'commit_incomplete');
  assert.equal(d.targetQty, 0.09);
});

test('una orden que SI aterrizo no se reintenta: la politica sigue quieta dentro del rango', () => {
  // Esto es el corazon de range_exit_v1 y el arreglo no puede romperlo: el
  // delta se movio mucho, pero la orden anterior se cumplio.
  const d = decide({
    deltaQty: 0.05, actualQty: 0.10, currentPrice: 2400,
    state: {
      rangeKey: rangeKey(LOWER, UPPER),
      zone: 'inside',
      committedTargetQty: 0.10,
    },
  });

  assert.equal(d.decision, 'hold');
  assert.equal(d.gate, 'inside_range_hold');
});

test('el redondeo del exchange no cuenta como orden incumplida', () => {
  // szDecimals deja el fill a unos pocos puntos basicos del target pedido.
  const d = decide({
    deltaQty: 0.05, actualQty: 0.09987, currentPrice: 2400,
    state: {
      rangeKey: rangeKey(LOWER, UPPER),
      zone: 'inside',
      committedTargetQty: 0.10,
    },
  });

  assert.equal(d.decision, 'hold', 'un 0.13% de diferencia es redondeo, no un fallo');
  assert.equal(d.gate, 'inside_range_hold');
});

test('por encima del borde el target es 0 y cualquier residuo se reintenta cerrar', () => {
  // pp24 vivio dias con actual_qty = 0.00010 contra un target de 0. Cerrar del
  // todo es la unica orden sub-minimo que Hyperliquid acepta, asi que
  // reintentarlo si lleva a algun lado.
  const d = decide({
    deltaQty: 0, actualQty: 0.0001, currentPrice: UPPER * 1.1,
    state: {
      rangeKey: rangeKey(LOWER, UPPER),
      zone: 'above',
      committedTargetQty: 0,
    },
  });

  assert.equal(d.decision, 'rebalance');
  assert.equal(d.gate, 'commit_incomplete');
  assert.equal(d.targetQty, 0);
});

test('una proteccion vieja sin committedTargetQty no cambia de comportamiento', () => {
  // Compatibilidad: el estado persistido de las protecciones ya vivas no tiene
  // el campo. Sin referencia no se puede juzgar, y se prefiere el
  // comportamiento anterior a inventar una.
  const d = decide({
    deltaQty: 0.05, actualQty: 0.10, currentPrice: 2400,
    state: { rangeKey: rangeKey(LOWER, UPPER), zone: 'inside' },
  });

  assert.equal(d.decision, 'hold');
  assert.equal(d.gate, 'inside_range_hold');
});

test('el reintento no pisa una confirmacion de cruce en curso', () => {
  // Con un cruce a medio confirmar Y una orden incumplida, manda la orden: un
  // hedge varado es peor que perder 120 s de confirmacion, y el cruce se
  // vuelve a confirmar solo si el precio sigue del otro lado.
  const d = decide({
    deltaQty: 0.124, actualQty: 0.0849, currentPrice: LOWER * 0.97,
    state: {
      rangeKey: rangeKey(LOWER, UPPER),
      zone: 'below',
      committedTargetQty: 0.124,
      crossPendingZone: 'inside',
      crossStartedAt: T0 - 1_000,
    },
  });

  assert.equal(d.gate, 'commit_incomplete');
  assert.equal(d.nextState.crossPendingZone, null, 'la confirmacion se descarta, no se arrastra');
});

test('tras ejecutar, el ciclo completo salida-reentrada deja de varar', () => {
  // Recorrido entero con el arreglo puesto, para que la regresion se lea de
  // corrido y no como casos sueltos.
  let t = T0;
  let d = decideRangeExitV1({ ...RANGE, deltaQty: 0.10, actualQty: 0, currentPrice: 2400, state: {}, now: t });
  assert.equal(d.gate, 'initial_full_hedge');
  let state = d.nextState;
  assert.equal(state.committedTargetQty, 0.10);

  // Sale por abajo y confirma.
  const abajo = LOWER * 0.97;
  t += 60_000;
  d = decideRangeExitV1({ ...RANGE, deltaQty: 0.20, actualQty: 0.10, currentPrice: abajo, state, now: t });
  assert.equal(d.gate, 'cross_confirming');
  t += CROSS_CONFIRM_MS + 1;
  d = decideRangeExitV1({ ...RANGE, deltaQty: 0.20, actualQty: 0.10, currentPrice: abajo, state: d.nextState, now: t });
  assert.equal(d.gate, 'range_exit');
  assert.equal(d.targetQty, 0.20);
  state = d.nextState;

  // La orden NO entra: el short sigue en 0.10 contra un commit de 0.20.
  t += 30_000;
  d = decideRangeExitV1({ ...RANGE, deltaQty: 0.20, actualQty: 0.10, currentPrice: abajo, state, now: t });
  assert.equal(d.gate, 'commit_incomplete', 'aqui se quedaba varado hasta el proximo cruce');
  state = d.nextState;

  // Ahora si entra.
  t += 30_000;
  d = decideRangeExitV1({ ...RANGE, deltaQty: 0.20, actualQty: 0.20, currentPrice: abajo, state, now: t });
  assert.equal(d.decision, 'hold');
  assert.equal(d.gate, 'outside_range_hold');
});

// ---------------------------------------------------------------------------
// El reintento no puede perseguir lo que el exchange no acepta.
//
// pp24 arrastraba 0.00546 pedido contra 0.00280 vivo: $7 de hueco sobre un
// minimo de $11. La orden se rechaza, no se mueve capital, la cobertura no
// mejora — y cada intento gasta una alerta. Reintentarlo cada 30 s de forma
// indefinida es ruido sobre algo irreparable.
// ---------------------------------------------------------------------------

test('no reintenta un hueco por debajo del minimo del exchange', () => {
  // 0.00266 ETH a $2400 son ~$6.38, por debajo del minimo de $11.
  const d = decide({
    deltaQty: 0.00546, actualQty: 0.00280, currentPrice: 2400,
    minOrderNotionalUsd: 11,
    state: {
      rangeKey: rangeKey(LOWER, UPPER),
      zone: 'inside',
      committedTargetQty: 0.00546,
    },
  });

  assert.equal(d.decision, 'hold');
  assert.equal(d.gate, 'commit_below_min_notional');
  assert.ok(d.commitGapUsd < 11);
});

test('el hueco inejecutable se nombra distinto de un hold normal', () => {
  // Por fuera se parecen; confundirlos es como se pierden de vista estas cosas.
  const normal = decide({
    deltaQty: 0.05, actualQty: 0.10, currentPrice: 2400,
    state: { rangeKey: rangeKey(LOWER, UPPER), zone: 'inside', committedTargetQty: 0.10 },
  });
  assert.equal(normal.gate, 'inside_range_hold');

  const pendiente = decide({
    deltaQty: 0.00546, actualQty: 0.00280, currentPrice: 2400,
    minOrderNotionalUsd: 11,
    state: { rangeKey: rangeKey(LOWER, UPPER), zone: 'inside', committedTargetQty: 0.00546 },
  });
  assert.equal(pendiente.gate, 'commit_below_min_notional');
  assert.notEqual(pendiente.gate, normal.gate);
});

test('un hueco que SI llega al minimo se sigue reintentando', () => {
  // 0.0351 ETH a $2211 son $77: la frontera no puede tragarse el caso real.
  const d = decide({
    deltaQty: 0.124, actualQty: 0.0889, currentPrice: LOWER * 0.97,
    minOrderNotionalUsd: 11,
    state: { rangeKey: rangeKey(LOWER, UPPER), zone: 'below', committedTargetQty: 0.124 },
  });

  assert.equal(d.decision, 'rebalance');
  assert.equal(d.gate, 'commit_incomplete');
});

test('cerrar del todo se reintenta aunque quede por debajo del minimo', () => {
  // Hyperliquid acepta un reduceOnly sub-minimo si deja la posicion en cero, y
  // es la unica via de sacar un residuo. Sin esta excepcion, el 0.00010 de pp24
  // por encima del borde se quedaria puesto para siempre.
  const d = decide({
    deltaQty: 0, actualQty: 0.0001, currentPrice: UPPER * 1.1,
    minOrderNotionalUsd: 11,
    state: { rangeKey: rangeKey(LOWER, UPPER), zone: 'above', committedTargetQty: 0 },
  });

  assert.equal(d.decision, 'rebalance', 'cerrar es la unica orden sub-minimo que el exchange acepta');
  assert.equal(d.gate, 'commit_incomplete');
  assert.equal(d.targetQty, 0);
});
