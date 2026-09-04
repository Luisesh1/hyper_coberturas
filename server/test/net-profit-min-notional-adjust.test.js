const test = require('node:test');
const assert = require('node:assert/strict');

const { decideNetProfitV1 } = require('../src/services/net-profit-policy.service');

// Caso real de la proteccion #27 (ETH/USDC, net_profit_v2): drift de $11.50
// contra un minimo de exchange de $11.00. El drift PASA el minimo, pero la
// correccion parcial que esta politica manda no llega.
const PRECIO = 2400;

// El drift se fija al 20% del target: bien afuera de la banda exterior (8% en
// el centro del rango), para que la decision llegue hasta el dimensionado de
// la orden y no se frene antes. Ahi el recorte que manda es el porcentual
// —75% en V2, 50% en V1—, que es el que abre la franja imposible.
const ERROR_PCT = 0.20;

function escenario({ driftUsd, policyVersion = 'net_profit_v2', ...rest }) {
  const errorAbsQty = driftUsd / PRECIO;
  const targetQty = errorAbsQty / ERROR_PCT;
  return decideNetProfitV1({
    policyVersion,
    deltaQty: targetQty,
    actualQty: targetQty - errorAbsQty,
    currentPrice: PRECIO,
    rangeLowerPrice: 2000,
    rangeUpperPrice: 3000,
    expectedCostUsd: 0,
    // Un LP grande deja `riskToInner` en false, que es donde aplica el recorte
    // porcentual. Con el LP chico la politica corrige entero y no hay franja.
    lpValueUsd: 100000,
    state: {},
    ...rest,
  });
}

test('un drift que solo puede parir una orden bajo el minimo no decide rebalancear', () => {
  // ESTE es el bug: $11.50 pasaba el gate del drift, y la orden salia de
  // $8.63 (75%). El exchange la rechazaba y saltaba una alerta de Telegram en
  // cada tick mientras el drift siguiera en esa franja.
  const d = escenario({ driftUsd: 11.5 });
  assert.equal(d.decision, 'hold');
  assert.equal(d.gate, 'min_notional_adjust');
  // La orden que se habria mandado, para que el log diga por que se frena.
  assert.ok(d.adjustNotionalUsd < d.minNotionalUsd);
  assert.ok(d.adjustNotionalUsd > 0);
});

test('toda la franja [minimo, minimo/0.75) queda en hold, no solo un punto', () => {
  // Con el recorte del 75% de V2 y minimo $11, ningun drift por debajo de
  // $14.67 puede producir una orden valida. Antes, TODA esa franja decidia
  // rebalancear para que el exchange la rechazara.
  for (const driftUsd of [11.01, 12, 13, 14, 14.6]) {
    const d = escenario({ driftUsd });
    assert.equal(d.decision, 'hold', `drift ${driftUsd} deberia frenarse`);
    assert.equal(d.gate, 'min_notional_adjust', `drift ${driftUsd}`);
  }
});

test('en cuanto la correccion parcial supera el minimo, vuelve a rebalancear', () => {
  // El limite no se mueve hacia arriba: lo que se ejecutaba antes se sigue
  // ejecutando. Solo deja de decidir lo que el exchange iba a rechazar.
  const d = escenario({ driftUsd: 16 });
  assert.equal(d.decision, 'rebalance');
  assert.ok(Math.abs(d.adjustQty) * PRECIO >= d.minNotionalUsd);
});

test('V1 recorta al 50%, asi que su franja imposible es mas ancha', () => {
  // Misma clase de fallo, distinto ancho: con el 50%, $20 todavia no alcanza.
  const v1 = escenario({ driftUsd: 20, policyVersion: 'net_profit_v1' });
  assert.equal(v1.decision, 'hold');
  assert.equal(v1.gate, 'min_notional_adjust');
  // Y con el 75% de V2 ese mismo drift si sale.
  assert.equal(escenario({ driftUsd: 20 }).decision, 'rebalance');
});

test('el cierre terminal sigue pasando por debajo del minimo', () => {
  // Hyperliquid acepta un reduce-only sub-minimo si deja la posicion en 0. Sin
  // esta excepcion, los residuos quedarian atascados para siempre — que es el
  // motivo por el que el gate del drift ya tenia el mismo bypass.
  const d = escenario({ driftUsd: 11.5, reason: 'deactivation' });
  assert.notEqual(d.gate, 'min_notional_adjust');
});

test('el gate del drift completo sigue frenando antes, y se distingue del nuevo', () => {
  // Dos frenos distintos con nombres distintos: uno dice "ni siquiera hay
  // drift suficiente", el otro "hay drift, pero mi correccion no llega".
  const d = escenario({ driftUsd: 5 });
  assert.equal(d.decision, 'hold');
  assert.equal(d.gate, 'min_notional');
});
