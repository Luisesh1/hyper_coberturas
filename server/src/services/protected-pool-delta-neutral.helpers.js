const {
  asFiniteNumber,
  buildBandPreset,
} = require('./delta-neutral-math.service');

const DEFAULT_BAND_MODE = 'adaptive';
const DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT = 3;
const DEFAULT_REBALANCE_INTERVAL_SEC = 6 * 60 * 60;
const DEFAULT_TARGET_HEDGE_RATIO = 1;
const DEFAULT_MIN_REBALANCE_NOTIONAL_USD = 50;
const DEFAULT_MAX_SLIPPAGE_BPS = 20;
const DEFAULT_TWAP_MIN_NOTIONAL_USD = 10_000;
const DEFAULT_EXECUTION_MODE = 'auto';
const DEFAULT_MAX_SPREAD_BPS = 30;
const DEFAULT_MAX_EXECUTION_FEE_USD = 25;
const DEFAULT_MIN_ORDER_NOTIONAL_USD = 11;
const DEFAULT_TWAP_SLICES = 5;
const DEFAULT_TWAP_DURATION_SEC = 60;
const DEFAULT_EMERGENCY_IOC_NOTIONAL_USD = 250;
const DEFAULT_GAMMA_TIGHTEN_THRESHOLD = 0.2;
const DEFAULT_MAX_AUTO_TOPUPS_PER_24H = 3;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const STALE_SPOT_COOLDOWN_MS = 60_000;
const MARGIN_COOLDOWN_MS = 2 * 60_000;
const ESTIMATED_TAKER_FEE_RATE = 0.0005;
const DELTA_NEUTRAL_STATUSES = new Set([
  'bootstrapping',
  'healthy',
  'tracking',
  'rebalance_pending',
  'executing',
  'boundary_watch',
  'partial_hedge_warning',
  'degraded_partial',
  'rate_limited',
  'margin_pending',
  'spot_stale',
  'snapshot_invalid',
  'risk_paused',
  'reconciling',
  'deactivating',
  'deactivation_pending',
  'inactive',
]);

function clampNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeStatus(status) {
  return DELTA_NEUTRAL_STATUSES.has(status) ? status : 'healthy';
}

function safeJsonClone(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function getCurrentBoundarySide(protection, currentPrice) {
  const lower = Number(protection.rangeLowerPrice);
  const upper = Number(protection.rangeUpperPrice);
  const price = Number(currentPrice);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(price)) return null;
  if (price < Math.min(lower, upper)) return 'below';
  if (price > Math.max(lower, upper)) return 'above';
  return 'inside';
}

function distanceToRangePct(protection, currentPrice) {
  const lower = Number(protection.rangeLowerPrice);
  const upper = Number(protection.rangeUpperPrice);
  const price = Number(currentPrice);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(price) || price <= 0) return null;
  const min = Math.min(lower, upper);
  const max = Math.max(lower, upper);
  if (price >= min && price <= max) {
    return Math.min(
      ((price - min) / min) * 100,
      ((max - price) / max) * 100
    );
  }
  if (price < min) return ((min - price) / min) * 100;
  return ((price - max) / max) * 100;
}

function isIsolatedPosition(position) {
  if (!position?.leverage) return true;
  const leverage = position.leverage;
  if (typeof leverage === 'string') return leverage.toLowerCase() !== 'cross';
  if (typeof leverage?.type === 'string') return leverage.type.toLowerCase() !== 'cross';
  if (typeof leverage?.mode === 'string') return leverage.mode.toLowerCase() !== 'cross';
  return true;
}

function computeLiquidationDistancePct(position, currentPrice) {
  const liq = Number(position?.liquidationPx);
  const price = Number(currentPrice);
  if (!Number.isFinite(liq) || liq <= 0 || !Number.isFinite(price) || price <= 0) return null;
  if (Number(position?.szi || 0) < 0) {
    return ((liq - price) / price) * 100;
  }
  return ((price - liq) / price) * 100;
}

function buildInitialStrategyState({
  currentPrice,
  deltaQty,
  gamma,
  targetQty,
  actualQty = 0,
  effectiveBandPct = DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT,
  rv4hPct = 0,
  rv24hPct = 0,
} = {}) {
  return {
    status: 'bootstrapping',
    lastSnapshotPrice: currentPrice ?? null,
    lastDeltaQty: deltaQty ?? null,
    lastGamma: gamma ?? null,
    lastTargetQty: targetQty ?? null,
    lastActualQty: actualQty ?? null,
    lastRebalanceAt: null,
    lastRebalanceReason: null,
    effectiveBandPct,
    rv4hPct,
    rv24hPct,
    fundingAccumUsd: 0,
    distanceToLiqPct: null,
    topUpCount24h: 0,
    topUpUsd24h: 0,
    marginModeVerified: true,
    hedgeRealizedPnlUsd: 0,
    hedgeUnrealizedPnlUsd: 0,
    executionFeesUsd: 0,
    slippageUsd: 0,
    lpPnlUsd: 0,
    netProtectionPnlUsd: 0,
    lastObservedBoundarySide: null,
    lastTopUpAt: null,
    topUpWindowStartedAt: Date.now(),
    lastError: null,
    deactivationRequestedAt: null,
    lastDecision: null,
    lastDecisionReason: null,
    lastExecutionAttemptAt: null,
    lastExecutionOutcome: null,
    nextEligibleAttemptAt: null,
    cooldownReason: null,
    trackingErrorQty: null,
    trackingErrorUsd: null,
    trackingMode: 'hybrid',
    truthAgeMs: null,
    lastTruthAt: null,
    lastTruthPrice: null,
    lastModelAt: null,
    lastModelPrice: null,
    modelConfidence: 'low',
    basisSpreadBps: null,
    consecutiveTruthFailures: 0,
    consecutiveInspectFailures: 0,
    consecutiveMissingDetections: 0,
    rpcBudgetState: null,
    zoneState: 'center',
    minDwellUntil: null,
    lastTruthReason: null,
    truthPending: false,
    lastSyntheticInRange: null,
    lastBboSpreadBps: null,
    lastTrackedMidPrice: null,
    lastFullScanAt: null,
    lastMissingDetectedAt: null,
  };
}

function normalizeStrategyState(state = {}) {
  const safeState = state || {};
  const topUpWindowStartedAt = Number(safeState.topUpWindowStartedAt || Date.now());
  return {
    ...buildInitialStrategyState(),
    ...safeState,
    status: normalizeStatus(safeState.status),
    topUpCount24h: clampNonNegative(safeState.topUpCount24h),
    topUpUsd24h: clampNonNegative(safeState.topUpUsd24h),
    topUpWindowStartedAt,
    marginModeVerified: safeState.marginModeVerified !== false,
    nextEligibleAttemptAt: safeState.nextEligibleAttemptAt != null ? Number(safeState.nextEligibleAttemptAt) : null,
  };
}

function isCooldownActive(protection, strategyState, now = Date.now()) {
  const nextEligibleAttemptAt = Number(
    protection?.nextEligibleAttemptAt
    ?? strategyState?.nextEligibleAttemptAt
    ?? 0
  );
  return Number.isFinite(nextEligibleAttemptAt) && nextEligibleAttemptAt > now;
}

function estimateExecutionCostUsd(qty, currentPrice) {
  const size = Math.abs(Number(qty) || 0);
  const price = Number(currentPrice) || 0;
  return size * price * ESTIMATED_TAKER_FEE_RATE;
}

function buildTrackingMetrics(metrics, actualQty, currentPrice) {
  const targetQty = Number(metrics?.targetQty || 0);
  const actual = Number(actualQty || 0);
  const trackingErrorQty = targetQty - actual;
  return {
    trackingErrorQty,
    trackingErrorUsd: Math.abs(trackingErrorQty) * Number(currentPrice || 0),
    lpDeltaUsd: Number(metrics?.deltaQty || 0) * Number(currentPrice || 0),
    hedgeDeltaUsd: -actual * Number(currentPrice || 0),
    netProtectedExposureUsd: trackingErrorQty * Number(currentPrice || 0),
  };
}

function deriveDecisionBandUsd(protection, metrics, currentPrice) {
  const minRebalanceUsd = Number(
    protection?.minOrderNotionalUsd
    ?? protection?.minRebalanceNotionalUsd
    ?? DEFAULT_MIN_REBALANCE_NOTIONAL_USD
  );
  const targetQty = Number(metrics?.targetQty || 0);
  const estimatedCost = estimateExecutionCostUsd(targetQty, currentPrice);
  const floor = Math.max(minRebalanceUsd, estimatedCost * 3);
  return {
    holdBandUsd: floor,
    fullBandUsd: floor * 2,
    estimatedCostUsd: estimatedCost,
  };
}

function resolveRebalanceDecision({ protection, metrics, actualQty, currentPrice, forceReason, forceRebalance }) {
  const tracking = buildTrackingMetrics(metrics, actualQty, currentPrice);
  const bands = deriveDecisionBandUsd(protection, metrics, currentPrice);
  const absoluteDriftUsd = Math.abs(tracking.trackingErrorUsd);

  if (forceRebalance || forceReason === 'boundary_cross') {
    return { decision: 'rebalance_full', tracking, bands };
  }
  if (absoluteDriftUsd < bands.holdBandUsd) {
    return { decision: 'hold', tracking, bands };
  }
  if (absoluteDriftUsd < bands.fullBandUsd) {
    return { decision: 'rebalance_partial', tracking, bands };
  }
  return { decision: 'rebalance_full', tracking, bands };
}

function buildCooldown(error, strategyState, { fallbackMs = RATE_LIMIT_COOLDOWN_MS } = {}) {
  const message = String(error?.message || error || '').trim();
  if (!message) {
    return {
      nextEligibleAttemptAt: null,
      cooldownReason: null,
      status: strategyState?.status || 'partial_hedge_warning',
    };
  }

  const lowered = message.toLowerCase();
  if (lowered.includes('too many cumulative requests sent') || lowered.includes('rate limit')) {
    return {
      nextEligibleAttemptAt: Date.now() + RATE_LIMIT_COOLDOWN_MS,
      cooldownReason: message,
      status: 'rate_limited',
    };
  }
  if (lowered.includes('margen insuficiente')) {
    return {
      nextEligibleAttemptAt: Date.now() + MARGIN_COOLDOWN_MS,
      cooldownReason: message,
      status: 'margin_pending',
    };
  }
  if (lowered.includes('precio actual del pool') || lowered.includes('spot')) {
    return {
      nextEligibleAttemptAt: Date.now() + STALE_SPOT_COOLDOWN_MS,
      cooldownReason: message,
      status: 'spot_stale',
    };
  }
  return {
    nextEligibleAttemptAt: Date.now() + fallbackMs,
    cooldownReason: message,
    status: strategyState?.status || 'partial_hedge_warning',
  };
}

function normalizeEvaluationStatus({
  decision,
  trackingErrorUsd,
  riskStatus,
  preflightStatus,
  shouldRebalance,
  preflightOk,
}) {
  if (riskStatus) return riskStatus;
  if (preflightStatus && preflightStatus !== 'tracking') return preflightStatus;
  if (shouldRebalance && decision !== 'hold' && preflightOk) return 'rebalance_pending';
  if (decision === 'hold') {
    return Math.abs(Number(trackingErrorUsd || 0)) > 0 ? 'tracking' : 'healthy';
  }
  return 'tracking';
}

function deriveBandSettings(protection, rvStats, metrics, currentPrice) {
  const bandMode = protection.bandMode || DEFAULT_BAND_MODE;
  const rv4hPct = asFiniteNumber(rvStats.rv4hPct) || 0;
  const rv24hPct = asFiniteNumber(rvStats.rv24hPct) || 0;
  const effectiveRvPct = Math.max(rv4hPct, rv24hPct);
  const adaptivePreset = buildBandPreset(effectiveRvPct);
  const baseBandPct = bandMode === 'fixed'
    ? (asFiniteNumber(protection.baseRebalancePriceMovePct) || DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT)
    : adaptivePreset.priceMovePct;
  const intervalSec = bandMode === 'fixed'
    ? (asFiniteNumber(protection.rebalanceIntervalSec) || DEFAULT_REBALANCE_INTERVAL_SEC)
    : adaptivePreset.intervalSec;
  let effectiveBandPct = baseBandPct;
  const distancePct = distanceToRangePct(protection, currentPrice);
  if (
    (Number.isFinite(distancePct) && distancePct <= 1)
    || (Number(metrics?.normalizedGamma) >= DEFAULT_GAMMA_TIGHTEN_THRESHOLD)
  ) {
    effectiveBandPct = baseBandPct * 0.5;
  }

  return {
    rv4hPct,
    rv24hPct,
    effectiveRvPct,
    intervalSec,
    baseBandPct,
    effectiveBandPct,
  };
}

function computeVolatilityStats(candles = []) {
  const closes = candles
    .map((item) => Number(item?.close ?? item?.c ?? item?.mid))
    .filter((value) => Number.isFinite(value) && value > 0);
  const returns = [];
  for (let index = 1; index < closes.length; index += 1) {
    returns.push(Math.log(closes[index] / closes[index - 1]));
  }
  if (returns.length === 0) {
    return { rv4hPct: 0, rv24hPct: 0 };
  }

  const annualize = (series) => {
    if (!series.length) return 0;
    const mean = series.reduce((acc, value) => acc + value, 0) / series.length;
    const variance = series.reduce((acc, value) => acc + ((value - mean) ** 2), 0) / series.length;
    return Math.sqrt(variance) * Math.sqrt(24 * 365) * 100;
  };

  return {
    rv4hPct: annualize(returns.slice(-4)),
    rv24hPct: annualize(returns.slice(-24)),
  };
}

module.exports = {
  DEFAULT_BAND_MODE,
  DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT,
  DEFAULT_REBALANCE_INTERVAL_SEC,
  DEFAULT_TARGET_HEDGE_RATIO,
  DEFAULT_MIN_REBALANCE_NOTIONAL_USD,
  DEFAULT_MAX_SLIPPAGE_BPS,
  DEFAULT_TWAP_MIN_NOTIONAL_USD,
  DEFAULT_EXECUTION_MODE,
  DEFAULT_MAX_SPREAD_BPS,
  DEFAULT_MAX_EXECUTION_FEE_USD,
  DEFAULT_MIN_ORDER_NOTIONAL_USD,
  DEFAULT_TWAP_SLICES,
  DEFAULT_TWAP_DURATION_SEC,
  DEFAULT_EMERGENCY_IOC_NOTIONAL_USD,
  DEFAULT_GAMMA_TIGHTEN_THRESHOLD,
  DEFAULT_MAX_AUTO_TOPUPS_PER_24H,
  ESTIMATED_TAKER_FEE_RATE,
  MARGIN_COOLDOWN_MS,
  clampNonNegative,
  estimateExecutionCostUsd,
  safeJsonClone,
  getCurrentBoundarySide,
  distanceToRangePct,
  isIsolatedPosition,
  computeLiquidationDistancePct,
  buildInitialStrategyState,
  normalizeStrategyState,
  isCooldownActive,
  resolveRebalanceDecision,
  buildCooldown,
  normalizeEvaluationStatus,
  deriveBandSettings,
  computeVolatilityStats,
};
