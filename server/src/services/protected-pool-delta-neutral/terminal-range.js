/**
 * Adaptador de `terminal_range_v1` al motor delta-neutral.
 *
 * La politica (`terminal-range-policy.service.js`) es aritmetica pura y no sabe
 * nada de snapshots, Hyperliquid ni del formato del evaluador. Aqui se traduce
 * en los dos sentidos:
 *
 *   entrada  valoracion del LP REAL (v3/v4, orientacion, ticks, liquidez) con
 *            `calculatePoolValueAtPrice`, y N del ciclo a partir de los
 *            acumulados del hedge que ya reconcilia el motor;
 *   salida   la decision con la forma que consume `evaluate.js`, con el target
 *            de la politica en `executionMetrics` —nunca el delta.
 *
 * Existe para que el evaluador tenga UNA llamada y unas pocas ramas, en vez de
 * repartir la politica por sus 1.500 lineas: las ramas de legacy, net_profit y
 * range_exit quedan intactas.
 */
const {
  calculatePoolValueAtPrice,
  resolveDeltaNeutralOrientation,
} = require('../delta-neutral-math.service');
const {
  TERMINAL_RANGE_V1,
  balancedQty,
  decideTerminalRangeV1,
  normalizeTerminalConfig,
} = require('../terminal-range-policy.service');

// Gates de `hold` en los que la divergencia contra el delta es el producto y no
// una averia: la politica esta quieta a proposito con su ultima orden cumplida.
const DIVERGENCE_BY_DESIGN_GATES = new Set([
  'balanced_hold',
  'terminal_hold',
  'outside_hold',
  'terminal_confirming',
]);

/**
 * `valueAt` / `volatileAt` sobre la posicion real. Memoriza por precio: la
 * politica valora el mismo borde varias veces por tick.
 */
function buildLpValuation(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const orientation = resolveDeltaNeutralOrientation(snapshot);
  if (!orientation?.eligible) return null;
  const cache = new Map();
  const at = (price) => {
    const p = Number(price);
    if (!(p > 0)) return null;
    if (!cache.has(p)) cache.set(p, calculatePoolValueAtPrice(snapshot, orientation, p));
    return cache.get(p);
  };
  return {
    valueAt: (price) => {
      const v = Number(at(price)?.poolValueUsd);
      return Number.isFinite(v) ? v : NaN;
    },
    volatileAt: (price) => {
      const v = Number(at(price)?.volatileAmount);
      return Number.isFinite(v) ? v : NaN;
    },
    liquidity: snapshot.liquidity != null ? String(snapshot.liquidity) : null,
  };
}

/**
 * Neto acumulado del hedge. La misma suma que `netProtectionPnlUsd` sin la
 * parte del LP: la del LP entra aparte como V(E) - B.
 */
function resolveHedgeNetUsd(state = {}) {
  return Number(state.hedgeRealizedPnlUsd || 0)
    + Number(state.hedgeUnrealizedPnlUsd || 0)
    + Number(state.fundingAccumUsd || 0)
    - Number(state.executionFeesUsd || 0)
    - Number(state.slippageUsd || 0);
}

function resolveTerminalConfig(strategyState = {}) {
  return normalizeTerminalConfig(strategyState?.terminalRangeConfig || {});
}

/**
 * Short inicial por secante, para dimensionar el alta (hedgeSize, notional y
 * preflight de margen) con el mismo numero que la politica ordenara en su
 * primer tick. Sin esto el alta mostraria el delta y la primera orden seria
 * otra.
 */
function computeInitialTerminalQty(snapshot, { volatilePriceUsd } = {}) {
  const valuation = buildLpValuation(snapshot);
  const lower = Number(snapshot?.rangeLowerPrice);
  const upper = Number(snapshot?.rangeUpperPrice);
  const spot = Number(volatilePriceUsd);
  if (!valuation || !(lower > 0 && upper > lower && spot > 0)) return null;
  const qty = balancedQty({ valueAt: valuation.valueAt, lower, upper, spot, execPrice: spot });
  return Number.isFinite(qty) ? qty : null;
}

/**
 * Decide un tick en vivo.
 *
 * @returns {{
 *   decision: object,              salida cruda de la politica
 *   rebalanceDecision: object,     {decision, tracking, bands} para el evaluador
 *   executionMetrics: object,      metrics con targetQty = objetivo terminal
 *   executionTracking: object|null,
 *   policyState: object,
 *   divergenceByDesign: boolean,
 * }}
 */
function evaluateTerminalRange({
  snapshot,
  metrics,
  priorPolicyState,
  tickState,
  actualQty,
  currentPrice,
  markPrice,
  rangeLowerPrice,
  rangeUpperPrice,
  forceRebalance = false,
  minOrderNotionalUsd,
  estimatedCostUsd,
  now = Date.now(),
}) {
  const valuation = buildLpValuation(snapshot);
  const lower = Number(rangeLowerPrice);
  const upper = Number(rangeUpperPrice);
  const usable = valuation
    && Number.isFinite(valuation.valueAt(currentPrice))
    && Number.isFinite(valuation.valueAt(lower))
    && Number.isFinite(valuation.valueAt(upper));

  const decision = usable
    ? decideTerminalRangeV1({
      valueAt: valuation.valueAt,
      volatileAt: valuation.volatileAt,
      currentPrice,
      markPrice,
      rangeLowerPrice: lower,
      rangeUpperPrice: upper,
      liquidity: valuation.liquidity,
      actualQty,
      hedgeNetUsd: resolveHedgeNetUsd(tickState),
      state: priorPolicyState || {},
      now,
      forceRebalance,
      config: resolveTerminalConfig(tickState),
      minOrderNotionalUsd,
    })
    : {
      policyVersion: TERMINAL_RANGE_V1,
      decision: 'hold',
      // Sin valoracion no hay objetivo terminal que calcular. Se queda quieta
      // con el estado intacto en vez de caer a otra politica.
      gate: 'valuation_unavailable',
      targetQty: actualQty,
      adjustQty: 0,
      intentId: null,
      nextState: priorPolicyState || {},
    };

  const rebalances = decision.decision === 'rebalance';
  // En `hold` el objetivo de terminal es quedarse en lo que ya comando. Es lo
  // que reciben los mecanismos que pueden actuar sin que ella decida (tope de
  // exposicion, reduccion bajo pausa de riesgo): con el delta aqui, apuntarian
  // al objetivo de otra politica.
  const committed = Number(decision.nextState?.committedTargetQty);
  const target = rebalances
    ? Number(decision.targetQty)
    : (Number.isFinite(committed) ? committed : Number(actualQty));
  const executionMetrics = {
    ...metrics,
    targetQty: target,
    // Lo PRETENDIDO: si el preflight recorta por margen, el ancla y la
    // promocion siguen apuntando al objetivo completo.
    policyTargetQty: target,
    terminalIntentId: rebalances ? (decision.intentId || null) : null,
  };
  const tracking = {
    // Contra SU objetivo, no contra el delta: la divergencia con el delta es el
    // producto de esta politica, no un error de seguimiento.
    trackingErrorQty: target - Number(actualQty),
    trackingErrorUsd: Math.abs(target - Number(actualQty)) * Number(currentPrice),
  };
  return {
    decision,
    rebalanceDecision: {
      decision: rebalances ? 'terminal_range_rebalance' : 'hold',
      tracking,
      // Su piso economico es el propio solver (que ya cuenta costes) y el
      // minimo del preflight; reportar una banda aqui seria inventar un umbral
      // que la politica nunca consulto.
      bands: { holdBandUsd: null, estimatedCostUsd },
    },
    executionMetrics,
    executionTracking: rebalances ? tracking : null,
    reportedTargetQty: target,
    policyState: decision.nextState || priorPolicyState || {},
    divergenceByDesign: DIVERGENCE_BY_DESIGN_GATES.has(decision.gate),
  };
}

module.exports = {
  TERMINAL_RANGE_V1,
  DIVERGENCE_BY_DESIGN_GATES,
  buildLpValuation,
  resolveHedgeNetUsd,
  resolveTerminalConfig,
  computeInitialTerminalQty,
  evaluateTerminalRange,
};
