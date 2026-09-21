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
// Mismos umbrales que usa la politica legacy para su `forceReduceNearZero`:
// por debajo de esto el LP no tiene delta que cubrir, y por encima de aquello
// lo que queda en el exchange es una posicion, no polvo de redondeo.
const NEAR_ZERO_TARGET_QTY = 1e-6;
const RESIDUAL_ACTUAL_QTY = 1e-8;
// El cero tiene que sostenerse antes de creerle. Mismo tramo que la histeresis
// superior usa para confirmar una salida: un mal snapshot dura un tick, una
// salida de rango dura.
const ZERO_TARGET_CONFIRM_MS = UPPER_HYSTERESIS_CONFIRM_MS;

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

  // `upper_exit_latched` ya NO frena.
  //
  // Sostener el hedge al confirmar la salida por arriba es lo que convirtio la
  // cobertura de pp27 en un short direccional: el delta del LP cayo a ~0 y el
  // short se quedo en 0.0226 ETH, $53.90 desnudos durante ~72 h. El `hold` se
  // conserva solo en los dos tramos de CONFIRMACION —que es para lo que existe
  // la histeresis— y no despues: confirmada la salida, se redimensiona.
  if (upperHysteresis?.gate && upperHysteresis.gate !== 'upper_exit_latched') {
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

  // Desarme por objetivo agotado.
  //
  // Cuando el LP se queda sin delta, el short deja de cubrir nada y pasa a ser
  // una posicion direccional. Las compuertas porcentuales de mas abajo no
  // pueden verlo: con `targetQty` en 0 el `errorPct` es 0 y TODO parece dentro
  // de banda, por grande que sea el short. Por eso el desarme va aqui arriba y
  // se expresa en cantidad, no en porcentaje.
  //
  // Se conserva la desconfianza original ante una lectura puntual de 0 —tirar
  // el hedge entero por un mal snapshot seria peor— pero con reloj: pasado el
  // tiempo de confirmacion, el cero es real. Eso es lo que le faltaba al viejo
  // `normal_zero_target`, que holdeaba para siempre sin caducidad.
  const targetExhausted = targetQty <= NEAR_ZERO_TARGET_QTY && actual > RESIDUAL_ACTUAL_QTY;
  if (targetExhausted && !isTerminalClose) {
    const zeroSince = finite(stateAfterHysteresis?.zeroTargetSince);
    if (zeroSince == null) {
      return {
        decision: 'hold',
        gate: 'zero_target_confirming',
        targetQty,
        errorQty,
        errorUsd,
        minNotionalUsd,
        nextState: { ...stateAfterHysteresis, zeroTargetSince: now },
        ...thresholds,
      };
    }
    if (now - zeroSince < ZERO_TARGET_CONFIRM_MS) {
      return {
        decision: 'hold',
        gate: 'zero_target_confirming',
        targetQty,
        errorQty,
        errorUsd,
        minNotionalUsd,
        nextState: stateAfterHysteresis,
        ...thresholds,
      };
    }
    // Dwell y cooldown se respetan tambien aqui: si el exchange deja polvo, el
    // reintento no puede volverse un martilleo por tick.
    const unwindFills = activeFillTimestamps(stateAfterHysteresis, now);
    const unwindLastFillAt = finite(stateAfterHysteresis?.lastFillAt);
    if (unwindLastFillAt != null && now - unwindLastFillAt < DWELL_MS) {
      return {
        decision: 'hold', gate: 'dwell', targetQty, errorQty, errorUsd, minNotionalUsd,
        fillTimestamps: unwindFills, nextState: stateAfterHysteresis, ...thresholds,
      };
    }
    const unwindCooldownUntil = finite(stateAfterHysteresis?.cooldownUntil);
    if (unwindCooldownUntil != null && unwindCooldownUntil > now) {
      return {
        decision: 'hold', gate: 'cooldown', targetQty, errorQty, errorUsd, minNotionalUsd,
        fillTimestamps: unwindFills, nextState: stateAfterHysteresis, ...thresholds,
      };
    }
    return {
      decision: 'rebalance',
      gate: 'zero_target_unwind',
      targetQty,
      errorQty,
      errorUsd,
      minNotionalUsd,
      // Cierre COMPLETO, no la correccion parcial del 75%: lo que se desmonta
      // ya no es un desvio de cobertura, es exposicion pura.
      adjustQty: round(-actual),
      fillTimestamps: unwindFills,
      nextState: {
        ...stateAfterHysteresis,
        zeroTargetSince: null,
        fillTimestamps: [...unwindFills, now],
        lastFillAt: now,
        cooldownUntil: now + COOLDOWN_MS,
      },
      ...thresholds,
    };
  }

  if (targetQty <= 0 && !isTerminalClose) {
    // Sin posicion que desmontar no hay nada que hacer: el caso de arriba ya
    // se ocupo de la que si existe.
    return {
      decision: 'hold',
      gate: 'normal_zero_target',
      targetQty,
      errorQty,
      errorUsd,
      minNotionalUsd,
      nextState: { ...stateAfterHysteresis, zeroTargetSince: null },
      ...thresholds,
    };
  }
  // Estado que TODA compuerta de aqui en adelante debe devolver.
  //
  // Antes estos `hold` retornaban sin `nextState`, y el motor hace
  // `netProfitDecision.nextState || estadoPrevio`: cualquier actualizacion que
  // `resolveUpperHysteresis` acabara de hacer —por ejemplo limpiar
  // `upperExitStartedAt` porque el precio volvio dentro— se perdia al salir por
  // una de ellas. Una mecha que amagaba con salir y retrocedia dejaba el
  // marcador puesto, y el cruce siguiente confirmaba al instante con una marca
  // de tiempo vieja. Tambien es lo que limpia `zeroTargetSince`.
  const baseState = { ...stateAfterHysteresis, zeroTargetSince: null };

  if (errorPct <= thresholds.outerPct) {
    return { decision: 'hold', gate: 'inside_outer', targetQty, errorQty, errorUsd, minNotionalUsd, nextState: baseState, ...thresholds };
  }

  const fills = activeFillTimestamps(stateAfterHysteresis, now);
  if (fills.length >= MAX_FILLS_PER_WINDOW) {
    return { decision: 'hold', gate: 'fill_cap', targetQty, errorQty, errorUsd, minNotionalUsd, fillTimestamps: fills, nextState: baseState, ...thresholds };
  }
  const lastFillAt = finite(stateAfterHysteresis?.lastFillAt);
  if (lastFillAt != null && now - lastFillAt < DWELL_MS) {
    return { decision: 'hold', gate: 'dwell', targetQty, errorQty, errorUsd, minNotionalUsd, fillTimestamps: fills, nextState: baseState, ...thresholds };
  }
  const cooldownUntil = finite(stateAfterHysteresis?.cooldownUntil);
  if (cooldownUntil != null && cooldownUntil > now) {
    return { decision: 'hold', gate: 'cooldown', targetQty, errorQty, errorUsd, minNotionalUsd, fillTimestamps: fills, nextState: baseState, ...thresholds };
  }
  if (errorUsd < minNotionalUsd && !isTerminalClose) {
    return { decision: 'hold', gate: 'min_notional', targetQty, errorQty, errorUsd, minNotionalUsd, fillTimestamps: fills, nextState: baseState, ...thresholds };
  }

  const lpValue = finite(lpValueUsd, 0);
  const riskToInner = lpValue > 0 && errorUsd / lpValue >= RISK_TO_INNER_PCT;
  const budgetDay = Math.floor(now / DAY_MS);
  const sameBudgetDay = Number(stateAfterHysteresis?.rotationBudgetDay) === budgetDay;
  const rotationBudgetCount = sameBudgetDay ? Math.max(0, finite(stateAfterHysteresis?.rotationBudgetCount, 0)) : 0;
  if (policyVersion === NET_PROFIT_V2 && !riskToInner && rotationBudgetCount >= V2_MAX_REBALANCES_PER_DAY) {
    return { decision: 'hold', gate: 'daily_rotation_budget', targetQty, errorQty, errorUsd, minNotionalUsd, fillTimestamps: fills, nextState: baseState, ...thresholds };
  }
  const adjustAbsQty = riskToInner
    ? Math.max(0, errorAbsQty - (targetQty * thresholds.innerPct))
    : Math.min(
      Math.max(0, errorAbsQty - (targetQty * thresholds.innerPct)),
      errorAbsQty * (policyVersion === NET_PROFIT_V2 ? 0.75 : 0.5),
    );
  if (adjustAbsQty <= 0) {
    return { decision: 'hold', gate: 'inner', targetQty, errorQty, errorUsd, minNotionalUsd, fillTimestamps: fills, nextState: baseState, ...thresholds };
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
      nextState: baseState,
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
      ...baseState,
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
