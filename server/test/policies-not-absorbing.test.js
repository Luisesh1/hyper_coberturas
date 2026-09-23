const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NET_PROFIT_V2,
  decideNetProfitV1,
} = require('../src/services/net-profit-policy.service');
const { decideLegacyZones } = require('../src/services/legacy-zones-policy.service');

/**
 * Una orden bloqueada no puede dejar la politica varada.
 *
 * `evaluate.js` persiste el estado de la politica al DECIDIR, no al ejecutar:
 * el `updateStrategyState` (~1217) va ANTES del preflight, y la ejecucion puede
 * abortarse despues (~1345). Eso es real y costo 47 h de cobertura varada en
 * pp24 el 2026-09-15/18.
 *
 * `range_exit_v1` era vulnerable porque tenia transiciones COMPROMETIDAS —zona
 * y clave de rango— y un `hold` absorbente: si la zona ya coincidia, no volvia
 * a mirar hasta el proximo cruce de borde. Corregido en b56f035 con
 * `committedTargetQty`, y fijado en `range-exit-commit.test.js`.
 *
 * Las otras dos NO son vulnerables, por una razon estructural: sus compuertas
 * se recalculan sobre el drift ACTUAL en cada tick. Una orden bloqueada deja el
 * drift en pie y el tick siguiente lo vuelve a ver.
 *
 * Hasta hoy eso lo sostenia una lectura del codigo. Estos tests lo convierten
 * en una garantia que se rompe ruidosamente si alguien introduce un estado
 * absorbente. Es la alternativa DELIBERADA a reordenar `evaluate.js`, que
 * tocaria las tres politicas sobre capital vivo para tapar un peligro cuyo
 * unico caso real ya esta cubierto.
 */

const RANGO = { rangeLowerPrice: 2280, rangeUpperPrice: 2520 };
const PRECIO = 2400;
const T0 = 1_700_000_000_000;

// Drift grande y persistente: la orden se decidio y NO entro, asi que el short
// sigue donde estaba tick tras tick.
const DRIFT = { deltaQty: 0.12, actualQty: 0.08, currentPrice: PRECIO };

test('net_profit: el hold tras una orden bloqueada esta ACOTADO, no es absorbente', () => {
  const primero = decideNetProfitV1({
    policyVersion: NET_PROFIT_V2, ...DRIFT, ...RANGO, state: {}, now: T0,
  });
  assert.equal(primero.decision, 'rebalance', 'el drift justifica actuar');

  // La orden NO entra: `actualQty` no se mueve. Se arrastra el estado que la
  // politica devolvio, que es lo que `evaluate.js` habria persistido.
  const siguiente = (ms) => decideNetProfitV1({
    policyVersion: NET_PROFIT_V2, ...DRIFT, ...RANGO,
    state: primero.nextState || {},
    now: T0 + ms,
  });

  // Dentro del reposo (DWELL 5 min / COOLDOWN 10 min) se queda quieta, y eso
  // es deliberado: evita martillear el exchange.
  assert.equal(siguiente(30_000).decision, 'hold');

  // Pasada la ventana vuelve a ver el MISMO drift y actua. Esa es la
  // diferencia con un estado absorbente: el reposo caduca, la zona no caducaba.
  assert.equal(
    siguiente(11 * 60_000).decision, 'rebalance',
    'si siguiera en hold aqui, el drift viviria para siempre sin que nadie lo mire'
  );
});

test('net_profit: el reposo se consume al DECIDIR, aunque la orden no entre', () => {
  // Matiz honesto, y una version leve del mismo problema estructural: el
  // temporizador arranca con la decision, no con la ejecucion. Una orden
  // bloqueada gasta igualmente hasta 10 min de espera antes del siguiente
  // intento.
  //
  // No es estrangulamiento —el drift se vuelve a ver— pero retrasa la
  // recuperacion. Queda anotado aqui en vez de en un comentario suelto.
  const decidio = decideNetProfitV1({
    policyVersion: NET_PROFIT_V2, ...DRIFT, ...RANGO, state: {}, now: T0,
  });
  const aLos30s = decideNetProfitV1({
    policyVersion: NET_PROFIT_V2, ...DRIFT, ...RANGO,
    state: decidio.nextState || {}, now: T0 + 30_000,
  });

  assert.equal(aLos30s.decision, 'hold');
  assert.ok(
    ['dwell', 'cooldown'].includes(aLos30s.gate),
    `el freno es temporal y se nombra: ${aLos30s.gate}`
  );
});

test('net_profit: cien ticks bloqueados y sigue decidiendo', () => {
  // La prueba de que no hay estado absorbente: no basta con un tick.
  let state = {};
  let decisiones = 0;
  for (let i = 0; i < 100; i += 1) {
    const d = decideNetProfitV1({
      policyVersion: NET_PROFIT_V2, ...DRIFT, ...RANGO, state, now: T0 + i * 30_000,
    });
    if (d.decision === 'rebalance') decisiones += 1;
    state = d.nextState || state;
  }

  assert.ok(decisiones > 0, 'nunca deja de intentarlo');
});

test('net_profit: cuando la orden SI entra, deja de pedir', () => {
  // El contraste que da sentido al test anterior: no es que siempre diga que
  // si, es que responde al drift real.
  const cubierto = decideNetProfitV1({
    policyVersion: NET_PROFIT_V2,
    deltaQty: 0.12, actualQty: 0.12, currentPrice: PRECIO,
    ...RANGO, state: {}, now: T0,
  });

  assert.equal(cubierto.decision, 'hold', 'sin drift no hay nada que hacer');
});

test('legacy: tras una orden bloqueada, el tick siguiente vuelve a decidir', () => {
  const comun = {
    ...DRIFT,
    ...RANGO,
    zoneState: 'center',
    bandDecision: 'rebalance_full',
    effectiveBandPct: 0.5,
    intervalSec: 1,
    minRebalanceNotionalUsd: 1,
    referencePrice: 2200,
  };

  const primero = decideLegacyZones({ ...comun, state: {}, now: T0 });
  assert.equal(primero.decision, 'rebalance');

  const segundo = decideLegacyZones({
    ...comun,
    state: primero.nextState || {},
    now: T0 + 12 * 3600_000,
  });

  assert.equal(segundo.decision, 'rebalance', 'el drift sigue en pie y se vuelve a ver');
});

test('legacy: su gate depende del drift actual, no de una transicion guardada', () => {
  // Misma llamada, drift distinto: la decision cambia. Eso es lo que hace que
  // no pueda quedarse varada — no hay memoria de "ya cruce".
  const comun = {
    ...RANGO,
    currentPrice: PRECIO,
    zoneState: 'center',
    bandDecision: 'rebalance_full',
    effectiveBandPct: 0.5,
    intervalSec: 1,
    minRebalanceNotionalUsd: 1,
    referencePrice: 2200,
    state: {},
    now: T0,
  };

  const conDrift = decideLegacyZones({ ...comun, deltaQty: 0.12, actualQty: 0.08 });
  const sinDrift = decideLegacyZones({ ...comun, deltaQty: 0.12, actualQty: 0.12 });

  assert.notEqual(
    conDrift.decision, sinDrift.decision,
    'si fueran iguales, la decision no dependeria del estado real del hedge'
  );
});

test('range_exit SI necesitaba el arreglo: sin committedTargetQty se quedaba quieta', () => {
  // El contraste que justifica tratarla distinto. Aqui se usa el estado ANTIGUO
  // —sin `committedTargetQty`— y la politica se queda en hold pese al drift.
  const { decideRangeExitV1, rangeKey } = require('../src/services/range-exit-policy.service');

  const varada = decideRangeExitV1({
    ...RANGO, deltaQty: 0.12, actualQty: 0.08, currentPrice: PRECIO,
    state: { rangeKey: rangeKey(2280, 2520), zone: 'inside' },
    now: T0,
  });
  assert.equal(varada.decision, 'hold', 'asi vivio pp24 durante 47 h');

  // Con el commit registrado, detecta que su orden no aterrizo.
  const reintenta = decideRangeExitV1({
    ...RANGO, deltaQty: 0.12, actualQty: 0.08, currentPrice: PRECIO,
    state: { rangeKey: rangeKey(2280, 2520), zone: 'inside', committedTargetQty: 0.12 },
    now: T0,
  });
  assert.equal(reintenta.decision, 'rebalance');
  assert.equal(reintenta.gate, 'commit_incomplete');
});
