const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveMinRebalanceNotionalUsd,
  DEFAULT_MIN_REBALANCE_NOTIONAL_PCT,
  MIN_REBALANCE_NOTIONAL_FLOOR_USD,
} = require('../src/services/protected-pool-delta-neutral.helpers');

// Regresion del caso real: proteccion 22 (LP ETH/USDC de ~$51) con el default
// historico de $50 absolutos. Tras un increase de liquidez la cobertura quedo
// al 50% y el brazo por temporizador de `shouldRebalance` no podia dispararla:
// exigia un drift de $50 sobre un LP de $51, o sea que el hedge estuviera
// equivocado casi al 100%. El umbral ahora sale del valor VIVO del LP.
test('el umbral es un % del valor del LP, no un absoluto congelado', () => {
  assert.equal(resolveMinRebalanceNotionalUsd({}, 51), 51 * 0.12);
  assert.equal(resolveMinRebalanceNotionalUsd({}, 1000), 120);
});

test('el LP de ~$51 que se quedo colgado ahora dispara con su drift real', () => {
  // El drift observado era de $25.85 contra un umbral de $50.
  assert.ok(25.85 > resolveMinRebalanceNotionalUsd({}, 51.37));
});

test('un LP mas grande sube el umbral solo, sin reconfigurar la proteccion', () => {
  const pequeno = resolveMinRebalanceNotionalUsd({}, 100);
  const grande = resolveMinRebalanceNotionalUsd({}, 10_000);
  assert.ok(grande > pequeno);
  assert.equal(grande / pequeno, 100);
});

test('el porcentaje configurado en la proteccion manda sobre el default', () => {
  assert.equal(resolveMinRebalanceNotionalUsd({ minRebalanceNotionalPct: 5 }, 1000), 50);
  assert.equal(resolveMinRebalanceNotionalUsd({ minRebalanceNotionalPct: null }, 1000), 1000 * (DEFAULT_MIN_REBALANCE_NOTIONAL_PCT / 100));
});

// Por debajo del suelo el ajuste no paga ni sus comisiones.
test('un LP diminuto no baja del suelo en USD', () => {
  assert.equal(resolveMinRebalanceNotionalUsd({}, 5), MIN_REBALANCE_NOTIONAL_FLOOR_USD);
  assert.equal(resolveMinRebalanceNotionalUsd({ minRebalanceNotionalPct: 1 }, 50), MIN_REBALANCE_NOTIONAL_FLOOR_USD);
});

// Sin valor de LP, `targetQty` puede irse a cero y un umbral bajo desharia el
// hedge entero: el brazo por temporizador se apaga y solo actuan los forzados.
test('sin valor de LP el umbral es inalcanzable en vez de cero', () => {
  for (const valor of [null, undefined, 0, -1, NaN, 'x']) {
    assert.equal(resolveMinRebalanceNotionalUsd({}, valor), Infinity, `valor: ${String(valor)}`);
  }
});
