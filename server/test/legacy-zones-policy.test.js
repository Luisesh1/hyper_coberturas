const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LEGACY_ZONES_V1,
  decideLegacyZones,
  isCenterDeadZoneBlocking,
  resolveLegacyTargetQty,
  zoneMultiplier,
} = require('../src/services/legacy-zones-policy.service');
const { computeDeltaNeutralMetrics } = require('../src/services/delta-neutral-math.service');

const AHORA = 1_700_000_000_000;
const HORA_MS = 3_600_000;
// Set historico de multiplicadores. Se inyecta explicitamente porque los
// vigentes se overridean por env: un test que asuma un valor concreto
// verificaria el .env de la maquina, no la logica.
const MULTIPLICADORES = { center: 0.6, transition: 0.85, edge: 1 };
const ZONA_LIBRE = { pct: 40, active: false, positionPct: 0.1 };
const ZONA_MUERTA = { pct: 40, active: true, positionPct: 0.5 };
const INALCANZABLE = Infinity;

// Entrada "sana": el precio no se movio desde la ultima foto, el temporizador
// ya vencio y la deriva ($1000) supera los dos pisos.
function entrada(overrides = {}) {
  return {
    deltaQty: 1,
    targetHedgeRatio: 1,
    zoneState: 'edge',
    multipliers: MULTIPLICADORES,
    actualQty: 0,
    currentPrice: 1000,
    referencePrice: 1000,
    hasPosition: true,
    bandDecision: 'rebalance_full',
    effectiveBandPct: 1.5,
    intervalSec: 3600,
    minRebalanceNotionalUsd: 120,
    urgentMinNotionalUsd: 30,
    centerDeadZone: ZONA_LIBRE,
    lastRebalanceAt: AHORA - (2 * HORA_MS),
    forceReason: null,
    forceRebalance: false,
    now: AHORA,
    ...overrides,
  };
}

// ── Target derivado ────────────────────────────────────────────────────────

test('el target aplica el multiplicador de la zona sobre el ratio configurado', () => {
  assert.equal(resolveLegacyTargetQty({ deltaQty: 2, targetHedgeRatio: 1, zoneState: 'center', multipliers: MULTIPLICADORES }), 1.2);
  assert.equal(resolveLegacyTargetQty({ deltaQty: 2, targetHedgeRatio: 1, zoneState: 'transition', multipliers: MULTIPLICADORES }), 1.7);
  assert.equal(resolveLegacyTargetQty({ deltaQty: 2, targetHedgeRatio: 1, zoneState: 'edge', multipliers: MULTIPLICADORES }), 2);
  // 'outside' no tiene multiplicador propio: cubre igual que 'edge'.
  assert.equal(resolveLegacyTargetQty({ deltaQty: 2, targetHedgeRatio: 1, zoneState: 'outside', multipliers: MULTIPLICADORES }), 2);
  assert.equal(zoneMultiplier('outside', MULTIPLICADORES), MULTIPLICADORES.edge);
});

test('un delta negativo no produce target negativo', () => {
  assert.equal(resolveLegacyTargetQty({ deltaQty: -3, targetHedgeRatio: 1, zoneState: 'edge', multipliers: MULTIPLICADORES }), 0);
});

// Este es el punto donde la extraccion puede romper la ruta real: el motor
// calcula el target dentro del gemelo digital y la politica lo recalcula. Si
// las dos formulas divergen, la decision se toma sobre otro numero.
test('el target replica bit a bit el que ya calcula el gemelo digital', () => {
  const snapshot = {
    version: 'v3',
    network: 'arbitrum',
    identifier: '123',
    token0: { symbol: 'WETH', address: `0x${'C'.repeat(40)}`, decimals: 18 },
    token1: { symbol: 'USDC', address: `0x${'D'.repeat(40)}`, decimals: 6 },
    tickLower: 74000,
    tickUpper: 79000,
    liquidity: '2000000000000',
    rangeLowerPrice: 2000,
    rangeUpperPrice: 3000,
    priceCurrent: 2500,
    currentValueUsd: 2500,
    inRange: true,
  };

  for (const zona of ['center', 'transition', 'edge']) {
    const ratioAplicado = 1 * zoneMultiplier(zona, MULTIPLICADORES);
    const gemelo = computeDeltaNeutralMetrics(snapshot, { volatilePriceUsd: 2500, targetHedgeRatio: ratioAplicado });
    assert.equal(gemelo.eligible, true);
    assert.equal(
      resolveLegacyTargetQty({ deltaQty: gemelo.deltaQty, targetHedgeRatio: 1, zoneState: zona, multipliers: MULTIPLICADORES }),
      gemelo.targetQty,
      `zona ${zona}`,
    );
  }
});

// Trampa heredada de `computeDeltaNeutralMetrics`: alli el ratio pasa por
// `Number(ratio || 1)`, asi que un ratio 0 no apaga la cobertura, la deja al
// 100%. Replicarlo no es un capricho: es lo que hace hoy la ruta real.
test('un multiplicador en cero cae al 100%, igual que en el gemelo', () => {
  const target = resolveLegacyTargetQty({
    deltaQty: 2,
    targetHedgeRatio: 1,
    zoneState: 'center',
    multipliers: { center: 0, transition: 0.85, edge: 1 },
  });
  assert.equal(target, 2);
});

// ── Brazos de disparo ──────────────────────────────────────────────────────

test('el brazo por temporizador dispara cuando la deriva supera su piso', () => {
  const resultado = decideLegacyZones(entrada());
  assert.equal(resultado.decision, 'rebalance');
  assert.equal(resultado.gate, 'timer_and_drift');
  assert.equal(resultado.policyVersion, LEGACY_ZONES_V1);
  assert.equal(resultado.targetQty, 1);
  assert.equal(resultado.errorUsd, 1000);
  assert.equal(resultado.minNotionalUsd, 120);
});

test('por debajo del piso del temporizador la cobertura se queda quieta', () => {
  const resultado = decideLegacyZones(entrada({ minRebalanceNotionalUsd: 2000, urgentMinNotionalUsd: 2000 }));
  assert.equal(resultado.decision, 'hold');
  assert.equal(resultado.gate, 'below_min_notional');
  assert.equal(resultado.timerDue, true);
});

test('con el temporizador sin vencer y el precio quieto, no hay disparo', () => {
  const resultado = decideLegacyZones(entrada({ lastRebalanceAt: AHORA - 60_000 }));
  assert.equal(resultado.decision, 'hold');
  assert.equal(resultado.gate, 'timer_not_due');
  assert.equal(resultado.timerDue, false);
  assert.equal(resultado.urgentTrigger, false);
});

test('el reloj es inyectable: el temporizador vence contra `now`, no contra el reloj del proceso', () => {
  const base = entrada({ lastRebalanceAt: AHORA });
  assert.equal(decideLegacyZones({ ...base, now: AHORA + (3600 * 1000) - 1 }).timerDue, false);
  assert.equal(decideLegacyZones({ ...base, now: AHORA + (3600 * 1000) }).timerDue, true);
});

test('un cruce de borde dispara con el piso urgente aunque el temporizador no haya vencido', () => {
  const resultado = decideLegacyZones(entrada({
    forceReason: 'boundary_cross',
    lastRebalanceAt: AHORA - 60_000,
    minRebalanceNotionalUsd: 2000,
    urgentMinNotionalUsd: 30,
  }));
  assert.equal(resultado.decision, 'rebalance');
  assert.equal(resultado.gate, 'price_band');
  assert.equal(resultado.minNotionalUsd, 30);
});

// La banda de no-trade de las rutas urgentes: un cruce de borde que valga
// centavos paga taker fee + slippage y realiza PnL del hedge sin compensarlo.
test('un cruce de borde por debajo del piso urgente no dispara', () => {
  const resultado = decideLegacyZones(entrada({
    forceReason: 'boundary_cross',
    lastRebalanceAt: AHORA - 60_000,
    minRebalanceNotionalUsd: 2000,
    urgentMinNotionalUsd: 2000,
  }));
  assert.equal(resultado.decision, 'hold');
  assert.equal(resultado.gate, 'urgent_below_min_notional');
  assert.equal(resultado.urgentTrigger, true);
});

test('un movimiento de precio mayor que la banda efectiva tambien es urgente', () => {
  const resultado = decideLegacyZones(entrada({
    currentPrice: 1020,
    referencePrice: 1000,
    lastRebalanceAt: AHORA - 60_000,
    minRebalanceNotionalUsd: INALCANZABLE,
  }));
  assert.equal(resultado.priceMovePct, 2);
  assert.equal(resultado.decision, 'rebalance');
  assert.equal(resultado.gate, 'price_band');
});

test('sin rebalanceo previo no hay referencia de precio y el temporizador esta vencido', () => {
  const resultado = decideLegacyZones(entrada({ lastRebalanceAt: null }));
  assert.equal(resultado.priceMovePct, Infinity);
  assert.equal(resultado.timerDue, true);
  assert.equal(resultado.urgentTrigger, true);
  assert.equal(resultado.decision, 'rebalance');
});

test('el forzado del orquestador manda sobre cualquier piso y sobre el temporizador', () => {
  const resultado = decideLegacyZones(entrada({
    forceRebalance: true,
    forceReason: 'lp_liquidity_changed',
    lastRebalanceAt: AHORA - 60_000,
    minRebalanceNotionalUsd: INALCANZABLE,
    urgentMinNotionalUsd: INALCANZABLE,
  }));
  assert.equal(resultado.decision, 'rebalance');
  assert.equal(resultado.gate, 'forced');
});

test('un target que cae a cero cierra el hedge residual sin mirar pisos', () => {
  const resultado = decideLegacyZones(entrada({
    deltaQty: 0,
    actualQty: 0.5,
    lastRebalanceAt: AHORA - 60_000,
    minRebalanceNotionalUsd: INALCANZABLE,
    urgentMinNotionalUsd: INALCANZABLE,
    bandDecision: 'hold',
  }));
  assert.equal(resultado.decision, 'rebalance');
  assert.equal(resultado.gate, 'reduce_near_zero');
  assert.equal(resultado.forceReduceNearZero, true);
  // El cierre asciende la decision de banda: si no, el motor mantendria
  // 'hold' y el residuo se quedaria abierto para siempre.
  assert.equal(resultado.bandDecision, 'rebalance_full');
});

test('un residuo por debajo del polvo no cuenta como hedge a cerrar', () => {
  const resultado = decideLegacyZones(entrada({
    deltaQty: 0,
    actualQty: 1e-9,
    lastRebalanceAt: AHORA - 60_000,
    minRebalanceNotionalUsd: INALCANZABLE,
    urgentMinNotionalUsd: INALCANZABLE,
  }));
  assert.equal(resultado.forceReduceNearZero, false);
  assert.equal(resultado.decision, 'hold');
});

test('una posicion sin hedge se cubre aunque el temporizador no haya vencido', () => {
  const resultado = decideLegacyZones(entrada({
    hasPosition: false,
    lastRebalanceAt: AHORA - 60_000,
    minRebalanceNotionalUsd: INALCANZABLE,
    urgentMinNotionalUsd: INALCANZABLE,
  }));
  assert.equal(resultado.decision, 'rebalance');
  assert.equal(resultado.gate, 'restart_reconcile');
});

// ── Zona muerta central ────────────────────────────────────────────────────

test('la zona muerta central congela el brazo por temporizador', () => {
  const resultado = decideLegacyZones(entrada({ centerDeadZone: ZONA_MUERTA }));
  assert.equal(resultado.decision, 'hold');
  assert.equal(resultado.gate, 'center_dead_zone');
  assert.equal(resultado.centerDeadZoneBlocks, true);
});

test('la zona muerta central tambien congela el brazo urgente', () => {
  const resultado = decideLegacyZones(entrada({
    centerDeadZone: ZONA_MUERTA,
    forceReason: 'boundary_cross',
    lastRebalanceAt: AHORA - 60_000,
  }));
  assert.equal(resultado.decision, 'hold');
  assert.equal(resultado.gate, 'center_dead_zone');
});

// La zona muerta es una preferencia de COSTO: nunca puede dejar capital
// descubierto ni bloquear una salida.
test('las rutas de seguridad atraviesan la zona muerta', () => {
  const forzado = decideLegacyZones(entrada({ centerDeadZone: ZONA_MUERTA, forceRebalance: true }));
  assert.equal(forzado.decision, 'rebalance');
  assert.equal(forzado.gate, 'forced');

  const cierre = decideLegacyZones(entrada({
    centerDeadZone: ZONA_MUERTA,
    deltaQty: 0,
    actualQty: 0.5,
    minRebalanceNotionalUsd: INALCANZABLE,
    urgentMinNotionalUsd: INALCANZABLE,
  }));
  assert.equal(cierre.decision, 'rebalance');
  assert.equal(cierre.gate, 'reduce_near_zero');

  const huerfano = decideLegacyZones(entrada({
    centerDeadZone: ZONA_MUERTA,
    hasPosition: false,
    lastRebalanceAt: AHORA - 60_000,
    minRebalanceNotionalUsd: INALCANZABLE,
    urgentMinNotionalUsd: INALCANZABLE,
  }));
  assert.equal(huerfano.decision, 'rebalance');
  assert.equal(huerfano.gate, 'restart_reconcile');
});

test('el gate de zona muerta es el mismo que aplica el motor a las demas politicas', () => {
  const comun = { centerDeadZone: ZONA_MUERTA, hasPosition: true, targetQty: 1 };
  assert.equal(isCenterDeadZoneBlocking(comun), true);
  assert.equal(isCenterDeadZoneBlocking({ ...comun, forceRebalance: true }), false);
  assert.equal(isCenterDeadZoneBlocking({ ...comun, forceReduceNearZero: true }), false);
  assert.equal(isCenterDeadZoneBlocking({ ...comun, hasPosition: false }), false);
  assert.equal(isCenterDeadZoneBlocking({ ...comun, centerDeadZone: ZONA_LIBRE }), false);
  // Sin posicion pero sin nada que cubrir, la zona sigue mandando.
  assert.equal(isCenterDeadZoneBlocking({ ...comun, hasPosition: false, targetQty: 0 }), true);
});

// ── Contrato de estado ─────────────────────────────────────────────────────

test('no muta el estado recibido y solo escribe nextState al rebalancear', () => {
  const state = { lastRebalanceAt: AHORA - (2 * HORA_MS), lastSnapshotPrice: 900 };
  const congelado = JSON.stringify(state);

  const hold = decideLegacyZones(entrada({ state, lastRebalanceAt: AHORA - 60_000 }));
  assert.equal(hold.decision, 'hold');
  assert.deepEqual(hold.nextState, state);

  const rebalance = decideLegacyZones(entrada({ state }));
  assert.equal(rebalance.decision, 'rebalance');
  assert.equal(rebalance.nextState.lastRebalanceAt, AHORA);
  assert.equal(rebalance.nextState.lastSnapshotPrice, 1000);
  assert.equal(JSON.stringify(state), congelado, 'la politica no puede mutar su entrada');
});

test('la correccion propuesta es el error completo: legacy nunca corrige a medias', () => {
  const resultado = decideLegacyZones(entrada({ actualQty: 0.25 }));
  assert.equal(resultado.errorQty, 0.75);
  assert.equal(resultado.adjustQty, 0.75);

  const reduccion = decideLegacyZones(entrada({ actualQty: 1.5 }));
  assert.equal(reduccion.adjustQty, -0.5);
  assert.equal(reduccion.errorUsd, 500);
});
