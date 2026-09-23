const test = require('node:test');
const assert = require('node:assert/strict');

const { decideRangeExitV1, rangeKey } = require('../src/services/range-exit-policy.service');

/**
 * El ancla adopta lo que se COMANDO, venga de quien venga.
 *
 * `range_exit_v1` solo actualizaba `committedTargetQty` cuando decidia ella.
 * Cualquier intervencion externa —el tope, una compuerta de riesgo, un
 * forzado— le dejaba un ancla rancia, y al tick siguiente intentaba deshacerla
 * creyendo que su propia orden no habia aterrizado.
 *
 * Se vio en pp28 el 2026-09-23, dos veces seguidas:
 *
 *   12:18:16  el tope recorta a 0.0959 (no al delta 0.11047)
 *   12:19:43  la politica ve held 0.0959 != committed 0.0785 y reintenta
 *   12:19:48  short en 0.10960 — justo donde el tope trataba de no ponerlo
 *
 * El recorte vivio 92 segundos. Con el ancla adoptada, la intervencion pasa a
 * ser el punto de partida nuevo, que es lo que es.
 *
 * Estos tests cubren la CONSECUENCIA en la politica. La adopcion en si vive en
 * `execution.js`, tras una ejecucion exitosa.
 */

const RANGO = { rangeLowerPrice: 2612, rangeUpperPrice: 2858 };
const KEY = rangeKey(2612, 2858);

function decidir({ deltaQty, actualQty, committedTargetQty, currentPrice = 2715.5 }) {
  return decideRangeExitV1({
    ...RANGO, deltaQty, actualQty, currentPrice,
    state: { rangeKey: KEY, zone: 'inside', committedTargetQty },
  });
}

test('tras adoptar una intervencion del tope, la politica la respeta', () => {
  const d = decidir({ deltaQty: 0.11047, actualQty: 0.0959, committedTargetQty: 0.0959 });

  assert.equal(d.decision, 'hold');
  assert.equal(d.gate, 'inside_range_hold');
});

test('tras adoptar una reduccion por riesgo, tampoco la deshace', () => {
  // La compuerta de riesgo encoge el short para alejar la liquidacion. Si la
  // politica lo restaurara, estaria peleando con el mecanismo que protege la
  // cuenta.
  const d = decidir({ deltaQty: 0.13, actualQty: 0.06, committedTargetQty: 0.06 });

  assert.equal(d.decision, 'hold', 'no se pelea con la compuerta de riesgo');
});

test('un llenado PARCIAL si se reintenta: el ancla apunta a lo pretendido', () => {
  // El recorte por margen entra al 60% a proposito y completa despues. Si el
  // ancla adoptara lo ejecutado en vez de lo pretendido, ese diseno se anularia
  // y el hedge se quedaria corto para siempre.
  const d = decidir({ deltaQty: 0.13, actualQty: 0.08, committedTargetQty: 0.13 });

  assert.equal(d.decision, 'rebalance');
  assert.equal(d.gate, 'commit_incomplete');
  assert.equal(d.targetQty, 0.13);
});

test('el ancla rancia era lo que causaba la pelea', () => {
  // El caso real: el tope movio a 0.0959 pero el ancla seguia en 0.0785.
  const d = decidir({ deltaQty: 0.11047, actualQty: 0.0959, committedTargetQty: 0.0785 });

  assert.equal(d.gate, 'commit_incomplete');
  assert.ok(
    Math.abs(d.targetQty - 0.11047) < 1e-9,
    'reintentaba al delta completo, deshaciendo el recorte'
  );
});

test('adoptar no desactiva la deteccion: una orden que no aterriza sigue viendose', () => {
  // La garantia que no se puede perder al hacer la politica mas complaciente.
  const d = decidir({ deltaQty: 0.13, actualQty: 0, committedTargetQty: 0.13 });

  assert.equal(d.decision, 'rebalance');
  assert.equal(d.gate, 'commit_incomplete');
});

test('el reanclaje manual deja la politica en reposo, no en bucle', () => {
  // `reanclar.js` fuerza un rebalanceo; la compuerta `forced` fija el ancla al
  // delta del momento. El tick siguiente tiene que quedarse quieto.
  const forzado = decideRangeExitV1({
    ...RANGO, deltaQty: 0.0785, actualQty: 0.0642, currentPrice: 2755.6,
    state: { rangeKey: KEY, zone: 'inside', committedTargetQty: 0.0642 },
    forceRebalance: true,
  });
  assert.equal(forzado.gate, 'forced');
  assert.equal(forzado.nextState.committedTargetQty, 0.0785);

  const despues = decideRangeExitV1({
    ...RANGO, deltaQty: 0.0785, actualQty: 0.0785, currentPrice: 2755.6,
    state: forzado.nextState,
  });
  assert.equal(despues.decision, 'hold');
  assert.equal(despues.gate, 'inside_range_hold');
});
