const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveMinRebalanceNotionalUsd,
  resolveMinOrderNotionalUsd,
  resolveRebalanceDecision,
  DEFAULT_MIN_REBALANCE_NOTIONAL_PCT,
  MIN_REBALANCE_NOTIONAL_FLOOR_USD,
} = require('../src/services/protected-pool-delta-neutral.helpers');

test('protecciones migradas con minimo null usan el mismo $11 que preflight y ejecucion', () => {
  assert.equal(resolveMinOrderNotionalUsd({ minOrderNotionalUsd: null }), 11);
  assert.equal(resolveMinOrderNotionalUsd({}), 11);
  assert.equal(resolveMinOrderNotionalUsd({ minOrderNotionalUsd: 25 }), 25);
});

test('la banda de decision no restaura el fallback legacy de $50', () => {
  const below = resolveRebalanceDecision({
    protection: { minOrderNotionalUsd: null },
    metrics: { targetQty: 0.05 },
    actualQty: 0.03901,
    currentPrice: 1000,
  });
  const executable = resolveRebalanceDecision({
    protection: { minOrderNotionalUsd: null },
    metrics: { targetQty: 0.05 },
    actualQty: 0.039,
    currentPrice: 1000,
  });

  assert.equal(below.decision, 'hold');
  assert.equal(executable.bands.holdBandUsd, 11);
  assert.equal(executable.decision, 'rebalance_full');
});

test('una correccion ejecutable nunca se etiqueta como parcial si se envia completa', () => {
  const result = resolveRebalanceDecision({
    protection: { minOrderNotionalUsd: null },
    metrics: { targetQty: 0.05 },
    actualQty: 0.035,
    currentPrice: 1000,
  });

  assert.equal(result.decision, 'rebalance_full');
});

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

// --- Banda de no-trade de las rutas urgentes (plan 2026-08-10) ---
// `boundary_cross` y `price_band` disparaban orden sin ningun piso economico.
// Medido en prod: pp10 rebalanceo 3 veces en 4 minutos con correcciones de
// ~0.005-0.016 ETH; el hedge realizo -8.58 mientras la deriva perdia -10.71,
// o sea re-cubriendo contra ruido y pagando taker fee + slippage cada vez.
const {
  resolveUrgentMinRebalanceNotionalUsd,
  DEFAULT_URGENT_MIN_REBALANCE_NOTIONAL_PCT,
} = require('../src/services/protected-pool-delta-neutral.helpers');

test('el umbral urgente es un % del valor vivo del LP', () => {
  assert.equal(resolveUrgentMinRebalanceNotionalUsd({}, 1000, 3), 30);
  assert.equal(resolveUrgentMinRebalanceNotionalUsd({}, 997, 3), 997 * 0.03);
});

// Es la propiedad que evita abrir hueco de cobertura: un cruce de borde es mas
// urgente que un tick de reloj, asi que su piso debe ser estrictamente menor.
test('el umbral urgente es MAS BAJO que el del temporizador', () => {
  const urgente = resolveUrgentMinRebalanceNotionalUsd({}, 1000, DEFAULT_URGENT_MIN_REBALANCE_NOTIONAL_PCT);
  const timer = resolveMinRebalanceNotionalUsd({}, 1000);
  assert.ok(urgente < timer, `urgente ${urgente} deberia ser < timer ${timer}`);
});

test('el churn real de pp10 queda por debajo del umbral y se frena', () => {
  // #37: LP ~$997 -> umbral urgente $29.91. Los drifts observados el 2026-08-10
  // en los rebalanceos encadenados fueron 20.69, 20.66, 11.44 y 17.29 USD.
  const umbral = resolveUrgentMinRebalanceNotionalUsd({}, 997, 3);
  for (const drift of [20.69, 20.66, 11.44, 17.29]) {
    assert.ok(drift < umbral, `drift ${drift} deberia quedar bajo el umbral ${umbral}`);
  }
  // ...pero los movimientos genuinos siguen pasando.
  for (const drift of [119.78, 839.92]) {
    assert.ok(drift >= umbral, `drift ${drift} deberia superar el umbral ${umbral}`);
  }
});

test('la proteccion puede sobrescribir el porcentaje urgente', () => {
  assert.equal(resolveUrgentMinRebalanceNotionalUsd({ urgentMinRebalanceNotionalPct: 10 }, 1000, 3), 100);
  // null en la columna cae al valor inyectado, no a 0
  assert.equal(resolveUrgentMinRebalanceNotionalUsd({ urgentMinRebalanceNotionalPct: null }, 1000, 4), 40);
});

test('sin valor de LP el umbral urgente tambien es inalcanzable', () => {
  for (const valor of [null, undefined, 0, -1, NaN, 'x']) {
    assert.equal(resolveUrgentMinRebalanceNotionalUsd({}, valor, 3), Infinity, `valor: ${String(valor)}`);
  }
});

test('el umbral urgente respeta el suelo en USD', () => {
  assert.equal(resolveUrgentMinRebalanceNotionalUsd({}, 10, 3), MIN_REBALANCE_NOTIONAL_FLOOR_USD);
});
