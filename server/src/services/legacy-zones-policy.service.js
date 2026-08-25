/**
 * Politica de cobertura legacy (`legacy_zones_v1`) como funcion pura.
 *
 * Espeja el contrato de `decideNetProfitV1`: entradas explicitas, reloj
 * inyectable, sin IO y sin mutar nada externo. Vivia repartida dentro de
 * `_evaluateProtectionUnlocked`, mezclada con lecturas de base de datos, la
 * posicion leida de Hyperliquid y `Date.now()`, asi que no habia forma de
 * evaluarla en sombra. El motor la llama en la ruta real y la comparativa la
 * llama en sombra: la politica viva y su gemelo son el mismo codigo.
 */
const LEGACY_ZONES_V1 = 'legacy_zones_v1';

// Por debajo de esta cantidad el target se considera cero y el hedge se cierra.
const NEAR_ZERO_TARGET_QTY = 1e-6;
// Umbral del hedge huerfano. Es distinto del de arriba a proposito: el motor
// legacy siempre uso 1e-7 para decidir "hay algo que cubrir y no hay posicion".
const ORPHAN_TARGET_QTY = 0.0000001;
// Polvo: por debajo de esto no queda hedge que cerrar.
const RESIDUAL_ACTUAL_QTY = 1e-8;

function zoneMultiplier(zoneState, multipliers = {}) {
  if (zoneState === 'center') return multipliers.center;
  if (zoneState === 'transition') return multipliers.transition;
  return multipliers.edge;
}

function resolveLegacyTargetQty({
  deltaQty,
  targetHedgeRatio = 1,
  zoneState = 'center',
  multipliers = {},
} = {}) {
  const ratio = Number(targetHedgeRatio ?? 1) * zoneMultiplier(zoneState, multipliers);
  // `Number(ratio || 1)` viene tal cual de `computeDeltaNeutralMetrics`: alli un
  // ratio 0 significa "sin configurar" y cae al 100%. Replicarlo es obligatorio
  // para que este target sea bit a bit el que ya calcula el gemelo digital.
  return Math.max(0, Number(deltaQty) * Number(ratio || 1));
}

/**
 * Zona central donde el usuario pidio no rebalancear. Se exporta aparte porque
 * el gate no es exclusivo de legacy: es una regla del usuario y las politicas
 * net_profit la respetan igual. Las rutas de seguridad la ignoran — nunca
 * dejamos capital descubierto por una preferencia de costo.
 */
function isCenterDeadZoneBlocking({
  centerDeadZone,
  forceRebalance = false,
  forceReduceNearZero = false,
  hasPosition = true,
  targetQty = 0,
} = {}) {
  const override = forceRebalance
    || forceReduceNearZero
    || (!hasPosition && Number(targetQty) > ORPHAN_TARGET_QTY);
  return centerDeadZone?.active === true && !override;
}

function decideLegacyZones({
  policyVersion = LEGACY_ZONES_V1,
  targetQty: engineTargetQty = null,
  deltaQty,
  targetHedgeRatio = 1,
  zoneState = 'center',
  multipliers = {},
  actualQty,
  currentPrice,
  referencePrice = null,
  hasPosition = true,
  bandDecision = 'rebalance_full',
  effectiveBandPct,
  intervalSec,
  minRebalanceNotionalUsd = Infinity,
  urgentMinNotionalUsd = Infinity,
  centerDeadZone = null,
  lastRebalanceAt = null,
  forceReason = null,
  forceRebalance = false,
  now = Date.now(),
  state = {},
} = {}) {
  // La ruta viva pasa `targetQty` a proposito: la decision tiene que caer sobre
  // EL MISMO numero que despues dimensiona la orden. Derivarlo aqui dejaria al
  // gate opinando sobre un target y a la ejecucion moviendo otro, y el sintoma
  // seria un hold permanente con el hedge infracubierto y sin una sola orden.
  // La sombra lo omite: alli no hay target del motor que respetar y cada
  // politica calcula el suyo.
  const targetQty = engineTargetQty != null
    ? Number(engineTargetQty)
    : resolveLegacyTargetQty({ deltaQty, targetHedgeRatio, zoneState, multipliers });
  const actual = Number(actualQty);
  const price = Number(currentPrice);
  const errorQty = targetQty - actual;
  const errorUsd = Math.abs(errorQty) * price;
  const reference = Number(referencePrice);

  // Sin un rebalanceo previo no hay foto contra la que medir el movimiento:
  // Infinity deja pasar el brazo urgente, que es el comportamiento historico.
  const priceMovePct = lastRebalanceAt && Number.isFinite(reference)
    ? Math.abs(((price - reference) / reference) * 100)
    : Infinity;

  const forceReduceNearZero = targetQty <= NEAR_ZERO_TARGET_QTY && actual > RESIDUAL_ACTUAL_QTY;
  const timerDue = !lastRebalanceAt
    || ((now - Number(lastRebalanceAt || 0)) >= (Number(intervalSec) * 1000));
  const urgentTrigger = forceReason === 'boundary_cross' || priceMovePct >= Number(effectiveBandPct);
  const orphanHedge = !hasPosition && targetQty > ORPHAN_TARGET_QTY;
  const centerDeadZoneBlocks = isCenterDeadZoneBlocking({
    centerDeadZone,
    forceRebalance,
    forceReduceNearZero,
    hasPosition,
    targetQty,
  });

  const trigger = forceRebalance
    ? 'forced'
    : forceReduceNearZero
      ? 'reduce_near_zero'
      : (urgentTrigger && errorUsd >= urgentMinNotionalUsd)
        ? 'price_band'
        : (timerDue && errorUsd >= minRebalanceNotionalUsd)
          ? 'timer_and_drift'
          : orphanHedge
            ? 'restart_reconcile'
            : null;

  const blockedGate = urgentTrigger
    ? 'urgent_below_min_notional'
    : timerDue
      ? 'below_min_notional'
      : 'timer_not_due';
  const gate = centerDeadZoneBlocks ? 'center_dead_zone' : (trigger || blockedGate);
  const decision = !centerDeadZoneBlocks && trigger != null ? 'rebalance' : 'hold';
  // El piso que REALMENTE se aplico, o null si la decision no midio ninguno.
  // Las rutas de seguridad (forzado, cierre a cero, hedge huerfano) y la zona
  // muerta no pasan por umbral economico: reportar uno ahi se leeria como
  // "esta politica respeto el piso" cuando ni siquiera lo consulto.
  const minNotionalUsd = (gate === 'price_band' || gate === 'urgent_below_min_notional')
    ? urgentMinNotionalUsd
    : (gate === 'timer_and_drift' || gate === 'below_min_notional')
      ? minRebalanceNotionalUsd
      : null;

  return {
    policyVersion,
    decision,
    gate,
    targetQty,
    errorQty,
    errorUsd,
    adjustQty: errorQty,
    minNotionalUsd,
    // La banda de coste decide la ETIQUETA de la orden, no si se dispara. Un
    // cierre a cero la asciende: sin esto el residuo se quedaria abierto.
    bandDecision: forceReduceNearZero && bandDecision === 'hold' ? 'rebalance_full' : bandDecision,
    priceMovePct,
    timerDue,
    urgentTrigger,
    forceReduceNearZero,
    orphanHedge,
    centerDeadZone: centerDeadZone || { pct: null, active: false, positionPct: null },
    centerDeadZoneBlocks,
    // La ruta real IGNORA este `nextState`: alli `lastRebalanceAt` y
    // `lastSnapshotPrice` los escribe la ejecucion cuando la orden se llena de
    // verdad. En sombra no hay ejecucion, y este es su sustituto.
    nextState: decision === 'rebalance'
      ? { ...state, lastRebalanceAt: now, lastSnapshotPrice: price }
      : state,
  };
}

module.exports = {
  LEGACY_ZONES_V1,
  NEAR_ZERO_TARGET_QTY,
  ORPHAN_TARGET_QTY,
  zoneMultiplier,
  resolveLegacyTargetQty,
  isCenterDeadZoneBlocking,
  decideLegacyZones,
};
