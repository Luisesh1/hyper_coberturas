/**
 * Política de cobertura v1, sin IO ni dependencias del motor legacy.
 *
 * El nombre versionado forma parte del contrato de persistencia: la ausencia
 * deliberadamente conserva `legacy_zones_v1` para que una fila histórica no
 * cambie de comportamiento al desplegar esta versión.
 */
const LEGACY_ZONES_V1 = 'legacy_zones_v1';
const NET_PROFIT_V1 = 'net_profit_v1';
const NET_PROFIT_V2 = 'net_profit_v2';

const DWELL_MS = 5 * 60_000;
const COOLDOWN_MS = 10 * 60_000;
const FILL_WINDOW_MS = 15 * 60_000;
const MAX_FILLS_PER_WINDOW = 2;
const RISK_TO_INNER_PCT = 0.15;
const FALLBACK_FEE_RATE = 0.0005;
const UPPER_HYSTERESIS_CONFIRM_MS = 120_000;
const DAY_MS = 24 * 60 * 60_000;
const V2_MAX_REBALANCES_PER_DAY = 4;

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
  return [NET_PROFIT_V1, NET_PROFIT_V2].includes(record.policyVersion) ? record.policyVersion : LEGACY_ZONES_V1;
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
  policyVersion = NET_PROFIT_V1,
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
  const budgetDay = Math.floor(now / DAY_MS);
  const sameBudgetDay = Number(stateAfterHysteresis?.rotationBudgetDay) === budgetDay;
  const rotationBudgetCount = sameBudgetDay ? Math.max(0, finite(stateAfterHysteresis?.rotationBudgetCount, 0)) : 0;
  if (policyVersion === NET_PROFIT_V2 && !riskToInner && rotationBudgetCount >= V2_MAX_REBALANCES_PER_DAY) {
    return { decision: 'hold', gate: 'daily_rotation_budget', targetQty, errorQty, errorUsd, minNotionalUsd, fillTimestamps: fills, ...thresholds };
  }
  const adjustAbsQty = riskToInner
    ? Math.max(0, errorAbsQty - (targetQty * thresholds.innerPct))
    : Math.min(
      Math.max(0, errorAbsQty - (targetQty * thresholds.innerPct)),
      errorAbsQty * (policyVersion === NET_PROFIT_V2 ? 0.75 : 0.5),
    );
  if (adjustAbsQty <= 0) {
    return { decision: 'hold', gate: 'inner', targetQty, errorQty, errorUsd, minNotionalUsd, fillTimestamps: fills, ...thresholds };
  }
  // El minimo se mide sobre la ORDEN, no sobre el drift.
  //
  // El gate de arriba compara el drift COMPLETO contra el minimo, pero esta
  // politica corrige solo una parte (hasta el 75% en V2, 50% en V1, y menos si
  // manda el recorte por `innerPct`). Con drift de $11.50 la orden sale de
  // $8.63: pasaba el gate, decidia rebalancear, y el exchange la rechazaba
  // abajo por debajo del minimo — un tick perdido y una alerta de Telegram en
  // cada iteracion mientras el drift siguiera en esa franja. Para el 75% de V2
  // esa franja es todo el tramo [minimo, minimo/0.75), o sea $11-$14.67 con
  // los defaults: ahi la orden NUNCA podia salir.
  //
  // Se sostiene quieto hasta que el drift crezca lo suficiente para que su
  // correccion parcial supere el minimo. No cambia lo que se ejecuta —esa
  // orden no se enviaba igual—, solo deja de decidir lo imposible.
  const adjustNotionalUsd = adjustAbsQty * price;
  if (adjustNotionalUsd < minNotionalUsd && !isTerminalClose) {
    return {
      decision: 'hold',
      gate: 'min_notional_adjust',
      targetQty,
      errorQty,
      errorUsd,
      minNotionalUsd,
      adjustNotionalUsd,
      fillTimestamps: fills,
      ...thresholds,
    };
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
    nextState: {
      ...stateAfterHysteresis,
      fillTimestamps: [...fills, now], lastFillAt: now, cooldownUntil: now + COOLDOWN_MS,
      ...(policyVersion === NET_PROFIT_V2 ? { rotationBudgetDay: budgetDay, rotationBudgetCount: rotationBudgetCount + 1 } : {}),
    },
    ...thresholds,
  };
}

/**
 * Normaliza un estado de sombra, sirviendo a la vez de constructor en frío y
 * de rehidratador.
 *
 * Ojo con los defaults: `simulateShadowFill` pasa por aquí su propio estado
 * previo en cada tick. Cuando esta función descartaba los acumulados, la
 * contabilidad de la sombra no acumulaba nada — las comisiones y el funding
 * reflejaban solo el último tick, y `averageEntryPrice` se vaciaba en el
 * segundo (el estado guarda `averageEntryPrice`, no `markPrice`), que es la
 * única vía por la que se calcula el PnL realizado. El contrafactual salía
 * plano por construcción.
 */
function createShadowState({
  actualQty = 0,
  markPrice = null,
  averageEntryPrice = null,
  realizedPnlUsd = 0,
  unrealizedPnlUsd = 0,
  executionFeesUsd = 0,
  slippageUsd = 0,
  slippageEwmaBps = 0,
  fundingUsd = 0,
  lastSnapshotAt = null,
} = {}) {
  return {
    actualQty: Math.max(0, finite(actualQty, 0)),
    // Un estado previo trae `averageEntryPrice`; una apertura en frío solo
    // conoce el `markPrice` del momento.
    averageEntryPrice: finite(averageEntryPrice, finite(markPrice)),
    realizedPnlUsd: finite(realizedPnlUsd, 0),
    unrealizedPnlUsd: finite(unrealizedPnlUsd, 0),
    executionFeesUsd: finite(executionFeesUsd, 0),
    slippageUsd: finite(slippageUsd, 0),
    slippageEwmaBps: finite(slippageEwmaBps, 0),
    fundingUsd: finite(fundingUsd, 0),
    lastSnapshotAt: finite(lastSnapshotAt),
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
  // Mark-to-market del short contrafactual con la misma convención que el
  // motor legacy (`hedgeUnrealizedPnlUsd`): un short gana cuando el precio
  // baja. Sin esta pata la comparación sombra vs real estaba sesgada en
  // contra de la sombra, que reportaba siempre 0 de latente.
  const nextEntryPrice = nextTarget > 0 ? nextEntry : null;
  const unrealized = nextTarget > 0 && nextEntryPrice != null && mid > 0
    ? (nextEntryPrice - mid) * nextTarget
    : 0;

  return {
    ...previous,
    actualQty: nextTarget,
    averageEntryPrice: nextEntryPrice,
    unrealizedPnlUsd: unrealized,
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
  NET_PROFIT_V2,
  DWELL_MS,
  COOLDOWN_MS,
  UPPER_HYSTERESIS_CONFIRM_MS,
  V2_MAX_REBALANCES_PER_DAY,
  resolveProtectionPolicy,
  resolveThresholds,
  decideNetProfitV1,
  createShadowState,
  simulateShadowFill,
};
