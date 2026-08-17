/**
 * Política de cobertura v1, sin IO ni dependencias del motor legacy.
 *
 * El nombre versionado forma parte del contrato de persistencia: la ausencia
 * deliberadamente conserva `legacy_zones_v1` para que una fila histórica no
 * cambie de comportamiento al desplegar esta versión.
 */
const LEGACY_ZONES_V1 = 'legacy_zones_v1';
const NET_PROFIT_V1 = 'net_profit_v1';

const DWELL_MS = 5 * 60_000;
const COOLDOWN_MS = 10 * 60_000;
const FILL_WINDOW_MS = 15 * 60_000;
const MAX_FILLS_PER_WINDOW = 2;
const RISK_TO_INNER_PCT = 0.15;
const FALLBACK_FEE_RATE = 0.0005;
const UPPER_HYSTERESIS_CONFIRM_MS = 120_000;

function finite(value, fallback = null) {
  if (value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, decimals = 10) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function resolveProtectionPolicy(record = {}) {
  return record.policyVersion === NET_PROFIT_V1 ? NET_PROFIT_V1 : LEGACY_ZONES_V1;
}

function resolveThresholds({ currentPrice, rangeLowerPrice, rangeUpperPrice }) {
  const price = finite(currentPrice);
  const lower = finite(rangeLowerPrice);
  const upper = finite(rangeUpperPrice);
  if (!(price > 0 && lower > 0 && upper > lower)) {
    return { normalizedEdgeDistance: 0, outerPct: 0.04, innerPct: 0.02 };
  }
  const center = (lower + upper) / 2;
  const halfWidth = Math.max((upper - lower) / 2, Number.EPSILON);
  // 0 en el borde, 1 en el centro; fuera del rango se queda en 0.
  const normalizedEdgeDistance = Math.max(0, Math.min(1, 1 - Math.abs(price - center) / halfWidth));
  const outerPct = 0.04 + (0.04 * normalizedEdgeDistance);
  return { normalizedEdgeDistance, outerPct, innerPct: outerPct / 2 };
}

function activeFillTimestamps(state, now) {
  const fills = Array.isArray(state?.fillTimestamps) ? state.fillTimestamps : [];
  return fills.map(Number).filter((at) => Number.isFinite(at) && at > now - FILL_WINDOW_MS && at <= now);
}

function resolveUpperHysteresis({ currentPrice, rangeLowerPrice, rangeUpperPrice, now, state }) {
  const price = finite(currentPrice);
  const lower = finite(rangeLowerPrice);
  const upper = finite(rangeUpperPrice);
  if (!(price > 0 && lower > 0 && upper > lower)) return null;
  const halfWidth = (upper - lower) / 2;
  const exitConfirmPrice = upper + (halfWidth * 0.10);
  const rearmPrice = upper - (halfWidth * 0.15);
  const prior = state || {};

  if (prior.upperExitConfirmed === true) {
    if (price > rearmPrice) {
      return {
        gate: 'upper_exit_latched',
        nextState: { ...prior, upperRearmStartedAt: null },
      };
    }
    const rearmStartedAt = finite(prior.upperRearmStartedAt);
    if (rearmStartedAt == null) {
      return {
        gate: 'upper_rearm_confirming',
        nextState: { ...prior, upperRearmStartedAt: now },
      };
    }
    if (now - rearmStartedAt < UPPER_HYSTERESIS_CONFIRM_MS) {
      return { gate: 'upper_rearm_confirming', nextState: prior };
    }
    return { gate: null, nextState: { ...prior, upperExitConfirmed: false, upperExitStartedAt: null, upperRearmStartedAt: null } };
  }

  if (price < exitConfirmPrice) {
    return { gate: null, nextState: { ...prior, upperExitStartedAt: null } };
  }
  const exitStartedAt = finite(prior.upperExitStartedAt);
  if (exitStartedAt == null) {
    return { gate: 'upper_exit_confirming', nextState: { ...prior, upperExitStartedAt: now } };
  }
  if (now - exitStartedAt < UPPER_HYSTERESIS_CONFIRM_MS) {
    return { gate: 'upper_exit_confirming', nextState: prior };
  }
  return {
    gate: 'upper_exit_latched',
    nextState: { ...prior, upperExitConfirmed: true, upperExitStartedAt: exitStartedAt, upperRearmStartedAt: null },
  };
}

function decideNetProfitV1({
  deltaQty,
  actualQty,
  currentPrice,
  rangeLowerPrice,
  rangeUpperPrice,
  expectedCostUsd = 0,
  lpValueUsd = null,
  now = Date.now(),
  state = {},
  reason = 'normal',
} = {}) {
  const targetQty = Math.max(0, finite(deltaQty, 0));
  const actual = Math.max(0, finite(actualQty, 0));
  const price = Math.max(0, finite(currentPrice, 0));
  const errorQty = targetQty - actual;
  const errorAbsQty = Math.abs(errorQty);
  const errorPct = targetQty > 0 ? errorAbsQty / targetQty : 0;
  const errorUsd = errorAbsQty * price;
  const thresholds = resolveThresholds({ currentPrice: price, rangeLowerPrice, rangeUpperPrice });
  const minNotionalUsd = Math.max(11, 3 * Math.max(0, finite(expectedCostUsd, 0)));
  const isTerminalClose = ['manual', 'deactivation', 'orphan'].includes(reason);
  const upperHysteresis = !isTerminalClose
    ? resolveUpperHysteresis({ currentPrice: price, rangeLowerPrice, rangeUpperPrice, now, state })
    : null;

  if (upperHysteresis?.gate) {
    return {
      decision: 'hold',
      gate: upperHysteresis.gate,
      targetQty,
      errorQty,
      errorUsd,
      minNotionalUsd,
      nextState: upperHysteresis.nextState,
      ...thresholds,
    };
  }
  const stateAfterHysteresis = upperHysteresis?.nextState || state;

  if (targetQty <= 0 && !isTerminalClose) {
    return { decision: 'hold', gate: 'normal_zero_target', targetQty, errorQty, errorUsd, minNotionalUsd, ...thresholds };
  }
  if (errorPct <= thresholds.outerPct) {
    return { decision: 'hold', gate: 'inside_outer', targetQty, errorQty, errorUsd, minNotionalUsd, ...thresholds };
  }

  const fills = activeFillTimestamps(stateAfterHysteresis, now);
  if (fills.length >= MAX_FILLS_PER_WINDOW) {
    return { decision: 'hold', gate: 'fill_cap', targetQty, errorQty, errorUsd, minNotionalUsd, fillTimestamps: fills, ...thresholds };
  }
  const lastFillAt = finite(stateAfterHysteresis?.lastFillAt);
  if (lastFillAt != null && now - lastFillAt < DWELL_MS) {
    return { decision: 'hold', gate: 'dwell', targetQty, errorQty, errorUsd, minNotionalUsd, fillTimestamps: fills, ...thresholds };
  }
  const cooldownUntil = finite(stateAfterHysteresis?.cooldownUntil);
  if (cooldownUntil != null && cooldownUntil > now) {
    return { decision: 'hold', gate: 'cooldown', targetQty, errorQty, errorUsd, minNotionalUsd, fillTimestamps: fills, ...thresholds };
  }
  if (errorUsd < minNotionalUsd && !isTerminalClose) {
    return { decision: 'hold', gate: 'min_notional', targetQty, errorQty, errorUsd, minNotionalUsd, fillTimestamps: fills, ...thresholds };
  }

  const lpValue = finite(lpValueUsd, 0);
  const riskToInner = lpValue > 0 && errorUsd / lpValue >= RISK_TO_INNER_PCT;
  const adjustAbsQty = riskToInner
    ? Math.max(0, errorAbsQty - (targetQty * thresholds.innerPct))
    : Math.min(
      Math.max(0, errorAbsQty - (targetQty * thresholds.innerPct)),
      errorAbsQty * 0.5,
    );
  if (adjustAbsQty <= 0) {
    return { decision: 'hold', gate: 'inner', targetQty, errorQty, errorUsd, minNotionalUsd, fillTimestamps: fills, ...thresholds };
  }
  return {
    decision: 'rebalance',
    gate: riskToInner ? 'risk_to_inner' : 'outside_outer',
    targetQty,
    errorQty,
    errorUsd,
    minNotionalUsd,
    adjustQty: round(Math.sign(errorQty || 1) * adjustAbsQty),
    riskToInner,
    fillTimestamps: fills,
    nextState: { ...stateAfterHysteresis, fillTimestamps: [...fills, now], lastFillAt: now, cooldownUntil: now + COOLDOWN_MS },
    ...thresholds,
  };
}

function createShadowState({ actualQty = 0, markPrice = null } = {}) {
  return {
    actualQty: Math.max(0, finite(actualQty, 0)),
    averageEntryPrice: finite(markPrice),
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    executionFeesUsd: 0,
    slippageUsd: 0,
    slippageEwmaBps: 0,
    fundingUsd: 0,
    lastSnapshotAt: null,
  };
}

function simulateShadowFill(state, { targetQty, bid, ask, feeRate, now = Date.now(), fundingUsd = 0 } = {}) {
  const previous = createShadowState(state);
  const nextTarget = Math.max(0, finite(targetQty, previous.actualQty));
  const safeBid = finite(bid, previous.averageEntryPrice || 0);
  const safeAsk = finite(ask, previous.averageEntryPrice || 0);
  const mid = safeBid > 0 && safeAsk > 0 ? (safeBid + safeAsk) / 2 : Math.max(safeBid, safeAsk, 0);
  const change = nextTarget - previous.actualQty;
  const fillPrice = change >= 0 ? safeAsk : safeBid;
  const notional = Math.abs(change) * fillPrice;
  const slipBps = mid > 0 && fillPrice > 0 ? Math.abs(fillPrice - mid) / mid * 10_000 : 0;
  const fee = notional * Math.max(0, finite(feeRate, FALLBACK_FEE_RATE));
  const nextEntry = change > 0 && nextTarget > 0
    ? ((previous.actualQty * (previous.averageEntryPrice || fillPrice)) + (change * fillPrice)) / nextTarget
    : previous.averageEntryPrice;
  const realized = change < 0 && previous.averageEntryPrice != null
    ? previous.realizedPnlUsd + ((previous.averageEntryPrice - fillPrice) * Math.abs(change))
    : previous.realizedPnlUsd;
  return {
    ...previous,
    actualQty: nextTarget,
    averageEntryPrice: nextTarget > 0 ? nextEntry : null,
    realizedPnlUsd: realized,
    executionFeesUsd: previous.executionFeesUsd + fee,
    slippageUsd: previous.slippageUsd + Math.abs(fillPrice - mid) * Math.abs(change),
    slippageEwmaBps: previous.slippageEwmaBps ? previous.slippageEwmaBps * 0.8 + slipBps * 0.2 : slipBps,
    fundingUsd: previous.fundingUsd + finite(fundingUsd, 0),
    lastSnapshotAt: now,
  };
}

module.exports = {
  LEGACY_ZONES_V1,
  NET_PROFIT_V1,
  DWELL_MS,
  COOLDOWN_MS,
  UPPER_HYSTERESIS_CONFIRM_MS,
  resolveProtectionPolicy,
  resolveThresholds,
  decideNetProfitV1,
  createShadowState,
  simulateShadowFill,
};
