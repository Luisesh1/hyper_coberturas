const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveCapTrimTarget,
  resolveNakedNotionalCapUsd,
} = require('../src/services/protected-pool-delta-neutral.helpers');

/**
 * El cap recorta, no reinicia.
 *
 * El cap es un limite de RIESGO: "el descubierto no puede pasar de X". La
 * primera version rebalanceaba al delta completo, o sea imponia descubierto
 * CERO — eso no es hacer cumplir el limite, es imponer el objetivo de otra
 * politica.
 *
 * Bajo `range_exit_v1` tiene un coste concreto, medido en pp28 el 2026-09-23:
 *
 *   01:13  ETH 2774 (maximo local, delta en su minimo)
 *          cap interviene: short 0.09330 -> 0.06420
 *   01:54  ETH 2752, el delta sube a 0.0846
 *          la politica congela dentro del rango -> infra-cubierta $56
 *
 * El cap corto en un extremo de precio y la politica quedo anclada ahi. Un
 * recorte parcial habria dejado el short cerca de donde estaba, que es casi
 * exactamente donde el delta volvio.
 */

const PRECIO = 2774;

test('recorta hasta el 50% del cap, no hasta cero', () => {
  // Episodio real: short 0.09330, delta 0.06414, cap $79.35.
  const cap = resolveNakedNotionalCapUsd(null, 529);
  const t = resolveCapTrimTarget({
    actualQty: 0.09330, targetQty: 0.06414, currentPrice: PRECIO, capUsd: cap,
  });

  // Queda descubierto ~50% del cap, no 0.
  const residualUsd = Math.abs(t - 0.06414) * PRECIO;
  assert.ok(Math.abs(residualUsd - cap * 0.5) < 0.01);
  // Y el short queda entre el original y el delta, mas cerca del original.
  assert.ok(t < 0.09330 && t > 0.06414);
});

test('el recorte habria acertado donde el corte completo fallo', () => {
  const cap = resolveNakedNotionalCapUsd(null, 529);
  const conRecorte = resolveCapTrimTarget({
    actualQty: 0.09330, targetQty: 0.06414, currentPrice: PRECIO, capUsd: cap,
  });

  // El delta al que revirtio el precio 40 min despues.
  const deltaTrasRevertir = 0.0846;
  const errorCorteCompleto = Math.abs(deltaTrasRevertir - 0.06414);
  const errorConRecorte = Math.abs(deltaTrasRevertir - conRecorte);

  assert.ok(
    errorConRecorte < errorCorteCompleto,
    'recortar deja el ancla mas cerca de donde el delta vuelve'
  );
});

test('la orden del recorte siempre supera el minimo del exchange', () => {
  // El caso peor: divergencia justo por encima del cap. Recortar al BORDE
  // habria pedido $1.55 —inejecutable, y disparando otra vez al instante—.
  const cap = 79.35;
  const divergenciaQty = (cap + 1) / PRECIO;
  const held = 0.09330;
  const target = held - divergenciaQty;

  const t = resolveCapTrimTarget({ actualQty: held, targetQty: target, currentPrice: PRECIO, capUsd: cap });
  const ordenUsd = Math.abs(t - held) * PRECIO;

  assert.ok(ordenUsd > 11, `la orden es de $${ordenUsd.toFixed(2)}, enviable`);
  assert.ok(Math.abs(ordenUsd - cap * 0.5) < 1.5, 'y vale ~la mitad del cap');
});

test('funciona igual infra-cubierto que sobre-cubierto', () => {
  const cap = 79.35;
  // Infra-cubierto: el target esta POR ENCIMA del short.
  const t = resolveCapTrimTarget({
    actualQty: 0.06420, targetQty: 0.10000, currentPrice: PRECIO, capUsd: cap,
  });

  assert.ok(t > 0.06420 && t < 0.10000, 'sube el short, pero no hasta el delta');
  const residualUsd = Math.abs(0.10000 - t) * PRECIO;
  assert.ok(Math.abs(residualUsd - cap * 0.5) < 0.01);
});

test('si la divergencia no supera el cap no se toca nada', () => {
  const cap = 79.35;
  const target = 0.08;
  const t = resolveCapTrimTarget({
    actualQty: 0.079, targetQty: target, currentPrice: PRECIO, capUsd: cap,
  });
  assert.equal(t, target, 'sin brecha, el objetivo es el de siempre');
});

test('con datos corruptos devuelve el objetivo original, no un numero inventado', () => {
  const target = 0.08;
  assert.equal(resolveCapTrimTarget({ actualQty: 0.09, targetQty: target, currentPrice: 0, capUsd: 79 }), target);
  assert.equal(resolveCapTrimTarget({ actualQty: 0.09, targetQty: target, currentPrice: PRECIO, capUsd: 0 }), target);
  assert.equal(resolveCapTrimTarget({ actualQty: NaN, targetQty: target, currentPrice: PRECIO, capUsd: 79 }), target);
});

test('el recorte nunca cruza al otro lado del objetivo', () => {
  // Con un cap enorme frente a una divergencia pequena, no debe sobrepasar.
  const t = resolveCapTrimTarget({
    actualQty: 0.09330, targetQty: 0.09000, currentPrice: PRECIO, capUsd: 5000,
  });
  assert.equal(t, 0.09000, 'la divergencia ya cabia en el cap');
});

// ---------------------------------------------------------------------------
// El recorte tiene que convertirse en el ancla nueva de la politica.
//
// Sin esto los dos mecanismos se anulaban. Medido en pp28 el 2026-09-23, dos
// veces seguidas:
//
//   12:18:16  el cap recorta a 0.0959 (no al delta 0.11047): correcto
//   12:19:43  `commit_incomplete` ve held 0.0959 != committed 0.0785
//             y reintenta al delta COMPLETO
//   12:19:48  short en 0.10960 — justo donde el cap trataba de no ponerlo
//
// El recorte vivio 92 segundos. La politica interpretaba el movimiento del cap
// como SU orden incumplida: no distingue "me movieron" de "mi orden no
// aterrizo". Adoptar el valor recortado como `committedTargetQty` convierte la
// intervencion en el ancla nueva, que es lo que es.
// ---------------------------------------------------------------------------

const { decideRangeExitV1, rangeKey } = require('../src/services/range-exit-policy.service');

test('tras adoptar el recorte como ancla, la politica NO lo deshace', () => {
  const RANGO = { rangeLowerPrice: 2612, rangeUpperPrice: 2858 };
  const key = rangeKey(2612, 2858);

  // Estado justo despues del recorte, CON el ancla actualizada.
  const conAncla = decideRangeExitV1({
    ...RANGO, deltaQty: 0.11047, actualQty: 0.0959, currentPrice: 2715.5,
    state: { rangeKey: key, zone: 'inside', committedTargetQty: 0.0959 },
  });

  assert.equal(conAncla.decision, 'hold', 'el recorte se respeta');
  assert.equal(conAncla.gate, 'inside_range_hold');
});

test('sin adoptarlo, la politica lo deshace: la regresion que hubo en vivo', () => {
  const RANGO = { rangeLowerPrice: 2612, rangeUpperPrice: 2858 };
  const key = rangeKey(2612, 2858);

  // El ancla vieja, anterior al recorte. Esto es lo que paso en produccion.
  const sinAncla = decideRangeExitV1({
    ...RANGO, deltaQty: 0.11047, actualQty: 0.0959, currentPrice: 2715.5,
    state: { rangeKey: key, zone: 'inside', committedTargetQty: 0.0785 },
  });

  assert.equal(sinAncla.decision, 'rebalance');
  assert.equal(sinAncla.gate, 'commit_incomplete');
  assert.equal(
    Number(sinAncla.targetQty.toFixed(5)), 0.11047,
    'reintenta al delta completo, deshaciendo el recorte'
  );
});
