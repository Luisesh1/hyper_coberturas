/**
 * Motor de sombra multi-politica.
 *
 * En cada tick una sola politica opera de verdad; las otras dos se simulan
 * sobre EXACTAMENTE los mismos datos que ya se cargaron para la viva (precio,
 * BBO, fee rate, funding y posicion). Aqui dentro no hay IO de ninguna clase:
 * es aritmetica pura mas un Map en memoria. Esa es la garantia de que evaluar
 * tres politicas no anade latencia al tick de 2 s.
 *
 * Ninguna de estas ramas toca `TradingService` ni devuelve nada que la
 * ejecucion consuma: el resultado solo alimenta el log y el snapshot.
 */
const {
  LEGACY_ZONES_V1,
  NET_PROFIT_V1,
  NET_PROFIT_V2,
  createShadowState,
  decideNetProfitV1,
  simulateShadowFill,
} = require('../net-profit-policy.service');
const { decideLegacyZones } = require('../legacy-zones-policy.service');
const { RANGE_EXIT_V1, decideRangeExitV1 } = require('../range-exit-policy.service');
const {
  estimateExecutionCostUsd,
  resolveMinOrderNotionalUsd,
} = require('../protected-pool-delta-neutral.helpers');

const ALL_POLICIES = [LEGACY_ZONES_V1, NET_PROFIT_V1, NET_PROFIT_V2, RANGE_EXIT_V1];
const NET_PROFIT_POLICIES = [NET_PROFIT_V1, NET_PROFIT_V2];
// Mismo throttle de escritura que tenia el snapshot unico.
const SHADOW_SNAPSHOT_THROTTLE_MS = 30_000;
// Polvo: por debajo de esto la posicion contrafactual se considera cerrada.
const RESIDUAL_ACTUAL_QTY = 1e-8;
const FALLBACK_TAKER_FEE_RATE = 0.0005;

/**
 * La politica que EJECUTA. Una proteccion creada como net_profit pero con
 * intencion `shadow` sigue ejecutando con la logica legacy: la viva es legacy
 * y su propia net_profit es una de las dos sombras.
 */
function resolveLivePolicy({ policyVersion, executionIntent } = {}) {
  return NET_PROFIT_POLICIES.includes(policyVersion) && executionIntent === 'live'
    ? policyVersion
    : LEGACY_ZONES_V1;
}

function resolveShadowPolicies(livePolicy) {
  return ALL_POLICIES.filter((policy) => policy !== livePolicy);
}

/**
 * Rehidrata la sombra de una politica desde lo persistido.
 *
 * El formato viejo era un `shadowSnapshot` SINGULAR sin nombre de politica.
 * Pertenecia a la net_profit declarada en la proteccion, que era la unica que
 * se simulaba. Se le devuelve a esa politica y a ninguna otra: lo que no se
 * midio es hueco, y rellenar las otras dos con ese mismo snapshot (o con cero)
 * inventaria historia que nadie observo.
 */
function readPersistedShadow(strategyState, policy, declaredPolicy) {
  const byPolicy = strategyState?.shadowSnapshots;
  const entry = byPolicy && typeof byPolicy === 'object' ? byPolicy[policy] : null;
  if (entry && typeof entry === 'object') return entry;

  const singular = strategyState?.shadowSnapshot;
  if (!singular || typeof singular !== 'object' || declaredPolicy !== policy) return null;
  return {
    ...singular,
    shadowPolicyState: strategyState.shadowPolicyState || {},
    shadowFundingSourceUsd: strategyState.shadowFundingSourceUsd,
  };
}

function decideShadow(policy, {
  previous,
  deltaQty,
  currentPrice,
  now,
  policyState,
  rangeLowerPrice,
  rangeUpperPrice,
  lpValueUsd,
  targetHedgeRatio,
  zoneState,
  multipliers,
  effectiveBandPct,
  intervalSec,
  minRebalanceNotionalUsd,
  urgentMinNotionalUsd,
  centerDeadZone,
  forceReason,
  forceRebalance,
}) {
  if (policy === RANGE_EXIT_V1) {
    // No recibe banda, temporizador ni zona muerta: esta politica no los
    // consulta. Su unica entrada es donde esta el precio respecto al rango,
    // que es exactamente lo que la hace barata de evaluar y de auditar.
    return decideRangeExitV1({
      deltaQty,
      actualQty: previous.actualQty,
      currentPrice,
      rangeLowerPrice,
      rangeUpperPrice,
      state: policyState,
      now,
      forceRebalance,
    });
  }

  if (NET_PROFIT_POLICIES.includes(policy)) {
    return decideNetProfitV1({
      policyVersion: policy,
      deltaQty,
      actualQty: previous.actualQty,
      currentPrice,
      rangeLowerPrice,
      rangeUpperPrice,
      lpValueUsd,
      // El MISMO estimador que usa la ruta viva de net_profit. Con uno propio
      // (la sombra usaba 0.0005 contra los 0.00025 de la viva) el piso de
      // notional salia al doble y la misma politica decidia distinto segun
      // estuviera viva o en sombra: la comparativa medi­ria el estimador, no la
      // politica.
      expectedCostUsd: estimateExecutionCostUsd(deltaQty - previous.actualQty, currentPrice),
      state: policyState,
      now,
    });
  }
  return decideLegacyZones({
    // SIN `targetQty`: la sombra legacy deriva el suyo desde el delta, el ratio
    // de la proteccion y el escalon de su zona. Pasarle el target del motor la
    // convertiria en una copia de la politica viva —bajo net_profit ese target
    // viene con ratio 1 y sin escalones— y la comparativa saldria empatada por
    // construccion, sin que ningun test lo delate.
    deltaQty,
    targetHedgeRatio,
    zoneState,
    multipliers,
    actualQty: previous.actualQty,
    currentPrice,
    // Su propia foto de precio, no la del motor: la sombra mide el movimiento
    // desde SU ultimo rebalanceo simulado.
    referencePrice: policyState.lastSnapshotPrice ?? currentPrice,
    hasPosition: previous.actualQty > RESIDUAL_ACTUAL_QTY,
    effectiveBandPct,
    intervalSec,
    minRebalanceNotionalUsd,
    urgentMinNotionalUsd,
    centerDeadZone,
    // El `lastRebalanceAt` de la sombra vive en SU policyState, nunca en la
    // raiz de `strategy_state_json`: alli lo escribe la ejecucion real cuando
    // una orden se llena, y confundirlos haria que la sombra heredara el reloj
    // de una orden que ella no mando.
    lastRebalanceAt: policyState.lastRebalanceAt ?? null,
    forceReason,
    forceRebalance,
    now,
    state: policyState,
  });
}

/**
 * Gates de EJECUCION que la ruta viva aplica DESPUES de que la politica dice
 * "rebalancea". Sin ellos la sombra no simula "esta politica corriendo viva"
 * sino "esta politica si nada la frenara": rebalancearia de mas, pagaria mas
 * comisiones y luciria un tracking que la version real nunca consigue.
 *
 * Se replican dos, los que mas frenan en la practica:
 *
 * - `min_dwell_active`: tras un fill hay un dwell minimo. En vivo lo escribe la
 *   ejecucion (`execution.js`); aqui cada politica lleva el suyo en su
 *   policyState.
 * - `within_cost_aware_band`: la banda de coste de `deriveDecisionBandUsd`.
 *   OJO con la asimetria, que es fiel al vivo y no un olvido: en la ruta viva
 *   esta banda solo gatea a legacy. Bajo net_profit, `rebalanceDecision` se
 *   sintetiza de la propia decision de la politica y su equivalente economico
 *   ya vive dentro de `decideNetProfitV1` (gate `min_notional`). Aplicarsela
 *   ademas a las sombras net_profit las volveria mas conservadoras que su
 *   version viva, que es exactamente el sesgo que esto viene a quitar.
 *
 * FUERA de alcance por decision de producto: preflight, margen, spread,
 * `confidenceBlocksIncrease` y `risk_paused`. Las sombras no los sufren, asi
 * que siguen siendo un limite SUPERIOR de lo que su politica habria logrado.
 */
function resolveExecutionGate({
  policy,
  decision,
  previous,
  policyState,
  currentPrice,
  now,
  minOrderNotionalUsd,
  forceReason,
  forceRebalance,
}) {
  if (decision.decision !== 'rebalance') return null;

  const minDwellUntil = Number(policyState?.minDwellUntil);
  if (Number.isFinite(minDwellUntil) && now < minDwellUntil) return 'min_dwell_active';

  // Un forzado del orquestador y el cruce de borde se saltan la banda, igual
  // que en `resolveRebalanceDecision`.
  if (forceRebalance || forceReason === 'boundary_cross') return null;
  // Tercer escape, el que se me habia pasado: el cierre a cero. En vivo lo hace
  // `evaluate.js` ascendiendo la decision a `rebalance_full` cuando
  // `forceReduceNearZero`, y el preflight lo remata con el bypass
  // `isFullCloseReduce` del minimo notional. Sin el, una sombra que baja a
  // polvo queda ATRAPADA para siempre: el drift de cerrar un residuo de
  // $2,50 nunca supera el piso de $11, asi que arrastraria funding y latente
  // abiertos justo en `legacy_zones_v1`, la politica que esta comparativa
  // existe para juzgar. Se mira el campo y no el gate porque con un forzado
  // simultaneo el gate seria 'forced'.
  if (decision.forceReduceNearZero === true) return null;
  if (policy !== LEGACY_ZONES_V1) return null;

  const targetQty = Number(decision.targetQty);
  const driftUsd = Math.abs(targetQty - previous.actualQty) * currentPrice;
  const holdBandUsd = Math.max(
    minOrderNotionalUsd,
    estimateExecutionCostUsd(targetQty, currentPrice) * 3,
  );
  return driftUsd < holdBandUsd ? 'within_cost_aware_band' : null;
}

/**
 * Reparte el funding real entre las posiciones contrafactuales.
 *
 * El funding se cobra sobre el NOTIONAL, asi que imputarle a una sombra el
 * funding integro de la posicion viva la premia o la castiga por un tamano que
 * no tiene. Con el hedge legacy sub-cubriendo en centro (0.6x) el error es
 * determinista y siempre a favor de quien cubre menos — justo el incumbente
 * que esta comparativa existe para poner a prueba.
 *
 * Con la posicion viva en cero no hay funding observado que repartir: el
 * factor es 0. Es una subestimacion conocida (una sombra con posicion abierta
 * mientras la viva esta plana si pagaria funding), pero sin tasa observada la
 * alternativa seria inventarla.
 */
function scaleFundingToShadow(fundingDeltaUsd, shadowQty, liveActualQty) {
  const delta = Number(fundingDeltaUsd);
  if (!Number.isFinite(delta) || delta === 0) return 0;
  const live = Math.abs(Number(liveActualQty));
  if (!Number.isFinite(live) || live <= 0) return 0;
  return delta * (Math.abs(Number(shadowQty)) / live);
}

/**
 * Simula un tick de cada politica no viva y devuelve su estado actualizado.
 *
 * @returns {Array<{policyVersion, decision, gate, targetQty, state, policyState, fundingSourceUsd, log}>}
 */
function runShadowPolicies({
  protectionId,
  memory,
  strategyState = {},
  declaredPolicy = null,
  livePolicy,
  liveActualQty = 0,
  deltaQty,
  currentPrice,
  bid,
  ask,
  feeRate,
  realFundingUsd = null,
  now = Date.now(),
  rangeLowerPrice = null,
  rangeUpperPrice = null,
  lpValueUsd = null,
  targetHedgeRatio = 1,
  zoneState = 'center',
  multipliers = {},
  effectiveBandPct,
  intervalSec,
  minRebalanceNotionalUsd,
  urgentMinNotionalUsd,
  centerDeadZone = null,
  forceReason = null,
  forceRebalance = false,
  minOrderNotionalUsd = resolveMinOrderNotionalUsd(null),
  minDwellMs = 0,
} = {}) {
  const delta = Number(deltaQty);
  const price = Number(currentPrice);
  if (!Number.isFinite(delta) || !Number.isFinite(price) || price <= 0) return [];

  const results = [];
  for (const policy of resolveShadowPolicies(livePolicy)) {
    const key = `${protectionId}:${policy}`;
    const persisted = memory?.get(key) || readPersistedShadow(strategyState, policy, declaredPolicy);
    // En frio la sombra arranca desde la posicion viva: desde este tick en
    // adelante diverge, pero no se inventa una apertura que no ocurrio.
    const previous = createShadowState(persisted || { actualQty: liveActualQty, markPrice: price });
    const policyState = persisted?.shadowPolicyState || {};
    const fundingSourceUsd = Number(persisted?.shadowFundingSourceUsd) || 0;

    const decision = decideShadow(policy, {
      previous,
      deltaQty: delta,
      currentPrice: price,
      now,
      policyState,
      rangeLowerPrice,
      rangeUpperPrice,
      lpValueUsd,
      targetHedgeRatio,
      zoneState,
      multipliers,
      effectiveBandPct,
      intervalSec,
      minRebalanceNotionalUsd,
      urgentMinNotionalUsd,
      centerDeadZone,
      forceReason,
      forceRebalance,
    });
    const executionGate = resolveExecutionGate({
      policy,
      decision,
      previous,
      policyState,
      currentPrice: price,
      now,
      minOrderNotionalUsd,
      forceReason,
      forceRebalance,
    });
    const fills = decision.decision === 'rebalance' && !executionGate;
    const filledTargetQty = fills
      ? previous.actualQty + Number(decision.adjustQty || 0)
      : previous.actualQty;
    const nextFundingSourceUsd = Number(realFundingUsd);
    const state = simulateShadowFill(previous, {
      targetQty: filledTargetQty,
      bid: Number(bid ?? price),
      ask: Number(ask ?? price),
      feeRate: Number(feeRate) || FALLBACK_TAKER_FEE_RATE,
      now,
      // El funding se devenga sobre la posicion que se TENIA en la ventana, no
      // sobre la que se acaba de abrir.
      fundingUsd: scaleFundingToShadow(
        nextFundingSourceUsd - fundingSourceUsd,
        previous.actualQty,
        liveActualQty,
      ),
    });
    // Un gate de ejecucion no deja avanzar el estado de la politica: en vivo
    // tampoco se consume cooldown ni presupuesto por una orden que no se mando.
    const nextPolicyState = fills ? (decision.nextState || policyState) : policyState;
    const entry = {
      policyVersion: policy,
      decision: executionGate ? 'hold' : decision.decision,
      gate: executionGate || decision.gate || null,
      targetQty: Number(decision.targetQty),
      // Piso economico que la politica REPORTA. Se expone para que la
      // comparativa pueda mostrar con que umbral decidio cada una y para que un
      // test pueda fijar el estimador de coste que lo alimenta.
      minNotionalUsd: decision.minNotionalUsd ?? null,
      state,
      policyState: fills
        ? { ...nextPolicyState, minDwellUntil: now + Number(minDwellMs || 0) }
        : nextPolicyState,
      fundingSourceUsd: Number.isFinite(nextFundingSourceUsd) ? nextFundingSourceUsd : fundingSourceUsd,
    };
    memory?.set(key, {
      ...state,
      shadowPolicyState: entry.policyState,
      shadowFundingSourceUsd: entry.fundingSourceUsd,
    });
    entry.log = {
      livePolicy,
      policyVersion: policy,
      zoneState,
      deltaQty: delta,
      currentPrice: price,
      shadowDecision: entry.decision,
      shadowGate: entry.gate,
      shadowTargetQty: entry.targetQty,
      shadowActualQty: state.actualQty,
      shadowExecutionFeesUsd: state.executionFeesUsd,
      shadowSlippageUsd: state.slippageUsd,
      shadowSlippageEwmaBps: state.slippageEwmaBps,
      shadowFundingUsd: state.fundingUsd,
      shadowMtmUsd: state.realizedPnlUsd + state.unrealizedPnlUsd,
    };
    results.push(entry);
  }
  return results;
}

/**
 * Estructura persistida: `shadowSnapshots` indexado por politica, cada una con
 * su propio `shadowPolicyState` y su `shadowFundingSourceUsd`. Solo contiene
 * las politicas no vivas; la viva no se simula porque ya se midio.
 */
function buildShadowSnapshots(results = []) {
  const snapshots = {};
  for (const result of results) {
    snapshots[result.policyVersion] = {
      ...result.state,
      shadowPolicyState: result.policyState,
      shadowFundingSourceUsd: result.fundingSourceUsd,
    };
  }
  return snapshots;
}

module.exports = {
  ALL_POLICIES,
  SHADOW_SNAPSHOT_THROTTLE_MS,
  resolveLivePolicy,
  resolveShadowPolicies,
  readPersistedShadow,
  resolveExecutionGate,
  scaleFundingToShadow,
  runShadowPolicies,
  buildShadowSnapshots,
};
