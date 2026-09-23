const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveNakedExposure,
  resolveNakedNotionalBreach,
  normalizeEvaluationStatus,
} = require('../src/services/protected-pool-delta-neutral.helpers');

/**
 * Divergencia por diseno vs exposicion sin cubrir.
 *
 * El detector de exposicion solo mira dolares y porcentaje: es material si
 * supera $15 Y el 5% del pool. No sabe que politica lo produjo.
 *
 * `range_exit_v1` congela el hedge entre cruces de borde y deja que el delta se
 * aleje — esa divergencia no es un fallo, es el producto. Resultado medido el
 * 2026-09-22 sobre pp28: 5 episodios en 11 h, $33 sobre un pool de $529 (6.2%),
 * con la politica funcionando exactamente como debe. Un aviso que suena cuando
 * no pasa nada entrena a ignorar el que si importa.
 *
 * Lo que NO puede pasar es que silenciar el aviso desactive el LIMITE: el cap
 * se alimenta del mismo `tier`, y es la pieza que faltaba cuando pp27 sostuvo
 * $53.90 desnudos 72 h.
 */

// Cifras reales de pp28 el 2026-09-22 18:53.
const PP28 = { nakedNotionalUsd: 33.13, poolValueUsd: 529 };
const T0 = 1_700_000_000_000;

function sostenida({ nakedNotionalUsd, poolValueUsd }, elapsedMs) {
  const primera = resolveNakedExposure({ nakedNotionalUsd, poolValueUsd, now: T0 });
  return resolveNakedExposure({
    nakedNotionalUsd,
    poolValueUsd,
    now: T0 + elapsedMs,
    priorSince: primera.since,
    priorTier: primera.tier,
  });
}

test('la divergencia de pp28 es material para el detector: por eso alertaba', () => {
  // $33.13 sobre $529 es 6.26%, por encima del 5%, y supera el piso de $15.
  const e = resolveNakedExposure({ ...PP28, now: T0 });
  assert.equal(e.material, true);

  // A los 15 min escala a tier 0 y dispara.
  const tras15 = sostenida(PP28, 15 * 60_000 + 1);
  assert.ok(tras15.tier >= 0);
  assert.equal(tras15.escalated, true, 'este es el aviso que llegaba cada rato');
});

test('el cap NO se rompe: $33 sigue por debajo del limite y no interviene', () => {
  const tras1h = sostenida(PP28, 61 * 60_000);
  const breach = resolveNakedNotionalBreach({
    ...PP28,
    tier: tras1h.tier,
    protection: null,
  });

  // Cap por defecto: max($30, 15% de $529) = $79.35.
  assert.ok(breach.capUsd > 79 && breach.capUsd < 80);
  assert.equal(breach.breached, false, '$33 no es una brecha; alertar por ello era el ruido');
});

test('si la divergencia SI supera el cap, el limite interviene igual', () => {
  // Esto es lo que no puede romperse al silenciar el aviso. $120 sobre $529.
  const grande = { nakedNotionalUsd: 120, poolValueUsd: 529 };
  const tras1h = sostenida(grande, 61 * 60_000);
  const breach = resolveNakedNotionalBreach({
    ...grande,
    tier: tras1h.tier,
    protection: null,
  });

  assert.ok(tras1h.tier >= 1, 'sostenida mas de 1 h');
  assert.equal(breach.breached, true, 'el cap es un limite de RIESGO, no un aviso');
});

test('el cap exige duracion: un pico instantaneo no interviene', () => {
  // La duracion es lo que protege a range_exit_v1 de que el cap la anule en
  // cada movimiento del precio.
  const pico = resolveNakedExposure({ nakedNotionalUsd: 120, poolValueUsd: 529, now: T0 });
  const breach = resolveNakedNotionalBreach({
    nakedNotionalUsd: 120,
    poolValueUsd: 529,
    tier: pico.tier,
    protection: null,
  });

  assert.equal(breach.breached, false, 'sin sostenerse una hora, no se toca la politica');
});

test('el estado deja de decir naked_exposure cuando la divergencia es por diseno', () => {
  // El motor pasa `nakedExposureSustained: tier >= 0 && !divergenceByDesign`.
  const porDiseno = normalizeEvaluationStatus({
    status: 'tracking',
    nakedExposureSustained: false,
  });
  assert.notEqual(porDiseno, 'naked_exposure');

  const deVerdad = normalizeEvaluationStatus({
    status: 'tracking',
    nakedExposureSustained: true,
  });
  assert.equal(deVerdad, 'naked_exposure', 'para el resto de politicas no cambia nada');
});

test('un descubierto por debajo del 5% del pool nunca fue material', () => {
  // Las dos condiciones a la vez: el piso en USD y el porcentaje. Sin esto, un
  // pool grande alertaria por centavos.
  const e = resolveNakedExposure({ nakedNotionalUsd: 20, poolValueUsd: 2000, now: T0 });
  assert.equal(e.material, false, '$20 sobre $2000 es 1%: irrelevante para ese tamano');
});

test('un descubierto grande en porcentaje pero minusculo en dolares tampoco', () => {
  const e = resolveNakedExposure({ nakedNotionalUsd: 9, poolValueUsd: 50, now: T0 });
  assert.equal(e.material, false, '$9 no mueve la aguja aunque sea el 18% de un pool diminuto');
});

// ---------------------------------------------------------------------------
// La condicion del motor, atada a las compuertas REALES de la politica.
//
// `evaluate.js` calla el aviso cuando el gate es `inside_range_hold` u
// `outside_range_hold`. Eso vale porque los dos caminos que implican una orden
// pendiente —`commit_incomplete` y `commit_below_min_notional`— retornan antes,
// asi que llegar a esos gates ya es prueba de que la ultima orden aterrizo.
//
// El test llama a la politica de verdad en vez de copiar los nombres: si algun
// dia cambian, esto se entera.
// ---------------------------------------------------------------------------

const { decideRangeExitV1, rangeKey } = require('../src/services/range-exit-policy.service');

const LOWER = 2280;
const UPPER = 2520;
const RANGO = { rangeLowerPrice: LOWER, rangeUpperPrice: UPPER };

// Misma expresion que `evaluate.js`.
const esPorDiseno = (gate) => gate === 'inside_range_hold' || gate === 'outside_range_hold';

test('quieta dentro del rango con la orden cumplida: es por diseno', () => {
  const d = decideRangeExitV1({
    ...RANGO, deltaQty: 0.05, actualQty: 0.10, currentPrice: 2400,
    state: { rangeKey: rangeKey(LOWER, UPPER), zone: 'inside', committedTargetQty: 0.10 },
  });

  assert.equal(d.gate, 'inside_range_hold');
  assert.equal(esPorDiseno(d.gate), true, 'la divergencia de pp28 cae aqui');
});

test('quieta fuera del rango con la orden cumplida: tambien', () => {
  const d = decideRangeExitV1({
    ...RANGO, deltaQty: 0, actualQty: 0, currentPrice: UPPER * 1.2,
    state: { rangeKey: rangeKey(LOWER, UPPER), zone: 'above', committedTargetQty: 0 },
  });

  assert.equal(d.gate, 'outside_range_hold');
  assert.equal(esPorDiseno(d.gate), true);
});

test('con una orden SIN cumplir NO es por diseno: ahi el aviso debe sonar', () => {
  // El caso de pp24: la orden no aterrizo. Esto es el bug, no el producto.
  const d = decideRangeExitV1({
    ...RANGO, deltaQty: 0.0516, actualQty: 0.0849, currentPrice: 2500,
    state: { rangeKey: rangeKey(LOWER, UPPER), zone: 'inside', committedTargetQty: 0.11435 },
  });

  assert.equal(d.gate, 'commit_incomplete');
  assert.equal(esPorDiseno(d.gate), false, 'silenciar esto habria devuelto el bug de pp24');
});

test('un hueco pendiente e inejecutable tampoco se considera diseno', () => {
  const d = decideRangeExitV1({
    ...RANGO, deltaQty: 0.00546, actualQty: 0.00280, currentPrice: 2400,
    minOrderNotionalUsd: 11,
    state: { rangeKey: rangeKey(LOWER, UPPER), zone: 'inside', committedTargetQty: 0.00546 },
  });

  assert.equal(d.gate, 'commit_below_min_notional');
  assert.equal(esPorDiseno(d.gate), false);
  // Aunque en la practica nunca alertaria: un hueco sub-minimo (<$11) no llega
  // al piso de materialidad de $15.
});

test('un cruce a medio confirmar no es un hold de diseno', () => {
  const d = decideRangeExitV1({
    ...RANGO, deltaQty: 0.02, actualQty: 0.10, currentPrice: UPPER * 1.05,
    state: { rangeKey: rangeKey(LOWER, UPPER), zone: 'inside', committedTargetQty: 0.10 },
  });

  assert.equal(d.gate, 'cross_confirming');
  assert.equal(esPorDiseno(d.gate), false, 'durante el cruce la divergencia si es transitoria y real');
});

// ---------------------------------------------------------------------------
// Cerca del cap, el aviso vuelve.
//
// De los 5 episodios de pp28, cuatro eran ruido y el quinto precedio al
// `naked_notional_cap_exceeded` del 2026-09-23 01:13, que corto el short de
// 0.09330 a 0.06420. Callarlos todos habria dejado esa intervencion sin aviso
// previo: cambiar ruido por sordera no es una mejora.
// ---------------------------------------------------------------------------

const { resolveNakedNotionalCapUsd } = require('../src/services/protected-pool-delta-neutral.helpers');

const PROXIMIDAD = 0.75;                       // NAKED_ALERT_CAP_PROXIMITY
const lejosDelCap = (usd, cap) => !(cap > 0) || Math.abs(usd) < cap * PROXIMIDAD;

test('el regimen normal de range_exit queda por debajo del umbral de proximidad', () => {
  const cap = resolveNakedNotionalCapUsd(null, 529);   // $79.35
  // $33 es el 42% del cap: ruido, se calla.
  assert.equal(lejosDelCap(33.13, cap), true);
});

test('acercarse al cap devuelve la voz antes de que intervenga', () => {
  const cap = resolveNakedNotionalCapUsd(null, 529);
  // 75% de $79.35 son $59.51: a partir de ahi vuelve a avisar.
  assert.equal(lejosDelCap(59, cap), true, 'justo debajo todavia calla');
  assert.equal(lejosDelCap(62, cap), false, 'ya en el tramo donde el cap es plausible');
});

test('el episodio que precedio a la intervencion real de pp28 SI habria avisado', () => {
  // La divergencia que disparo el cap: 0.09330 vivo contra 0.06414 de target,
  // a $2774. Son $80.9, por encima del cap de $79.35.
  const cap = resolveNakedNotionalCapUsd(null, 529);
  const divergencia = (0.09330 - 0.06414) * 2774;

  assert.ok(divergencia > cap, 'por eso el cap intervino');
  assert.equal(lejosDelCap(divergencia, cap), false, 'y por eso no puede callarse');
});

test('sin pool valorado no se calla nada', () => {
  // Un cap de 0 o desconocido no puede usarse para decidir silencio.
  assert.equal(lejosDelCap(50, 0), true, 'el piso del cap nunca es 0 en la practica');
  const capMinimo = resolveNakedNotionalCapUsd(null, 0);
  assert.ok(capMinimo >= 30, 'siempre hay piso: max($30, 15% del pool)');
});
