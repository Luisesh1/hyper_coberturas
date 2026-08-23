const {
  asFiniteNumber,
  buildBandPreset,
} = require('./delta-neutral-math.service');

const DEFAULT_BAND_MODE = 'adaptive';
const DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT = 3;
const DEFAULT_REBALANCE_INTERVAL_SEC = 6 * 60 * 60;
const DEFAULT_TARGET_HEDGE_RATIO = 1;
// Umbral de drift que habilita el brazo por temporizador de `shouldRebalance`,
// expresado como % del valor VIVO del LP protegido. Antes era un absoluto en
// USD congelado al crear la proteccion: en un LP de ~$50 el default de $50
// exigia que el hedge estuviera equivocado al 100% para disparar, asi que ese
// brazo no saltaba nunca y la cobertura se quedaba colgada tras cambiar la
// liquidez. El 12% viene del auto-tune que el wizard ya aplicaba en el cliente.
const DEFAULT_MIN_REBALANCE_NOTIONAL_PCT = 12;
// Por debajo de esto el ajuste no paga ni sus propias comisiones.
const MIN_REBALANCE_NOTIONAL_FLOOR_USD = 2;
// Banda de no-trade para las rutas NO temporizadas (`boundary_cross` y
// `price_band`), que hasta ahora disparaban orden sin ningun piso economico.
// Ese es el origen del churn medido el 2026-08-10: pp10 rebalanceo 3 veces en 4
// minutos con correcciones de delta de ~0.005-0.016 ETH, y el PnL realizado del
// hedge (-8.58) perdia a la vez que la deriva de precio (-10.71) — sintoma de
// re-cubrir contra ruido. Es deliberadamente MAS BAJO que el 12% del brazo por
// temporizador: un cruce de borde es mas urgente que un tick de reloj, asi que
// se frena solo lo economicamente irrelevante sin abrir hueco de cobertura.
const DEFAULT_URGENT_MIN_REBALANCE_NOTIONAL_PCT = 3;
// Techo de obsolescencia del hedge en modo adaptativo. Los presets de baja
// volatilidad llegaban a 12h y el temporizador gatea TAMBIEN el brazo de drift
// (`timerDue && driftUsd >= minRebalanceNotionalUsd`), asi que una cobertura ya
// justificada por drift podia esperar medio dia: medido el 2026-08-11, pp12 y
// pp13 pasaron ~7h con la cobertura en 0.58/0.65 mientras el motor decidia
// `rebalance_full` en cada ciclo sin poder ejecutarlo.
// Acortarlo NO fuerza rebalanceos: el piso de notional sigue decidiendo SI se
// rebalancea, esto solo acota cuanto se tarda en poder hacerlo.
const MAX_ADAPTIVE_REBALANCE_INTERVAL_SEC = 1800;
// Zona central del rango (en % del ancho TOTAL, centrada en el punto medio)
// donde no se rebalancea la cobertura. Con el precio profundo en rango el
// delta se mueve despacio y cada ajuste paga taker fee + slippage y realiza
// PnL del hedge; el 40% central es la parte del rango donde ese costo no se
// recupera. 0 la desactiva. Las rutas de seguridad (force manual, reducir a
// cero, hedge huerfano, cambio de liquidez) la ignoran.
const DEFAULT_CENTER_DEAD_ZONE_PCT = 40;
// Techo duro: por encima de esto la zona muerta se comeria tambien los bordes,
// que es justo donde el delta se acelera y la cobertura tiene que responder.
const MAX_CENTER_DEAD_ZONE_PCT = 90;
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
const DEFAULT_MIN_AUTO_TOPUP_CAP_USD = 300;
const DEFAULT_AUTO_TOPUP_CAP_PCT_OF_INITIAL = 25;
const DEFAULT_MIN_AUTO_TOPUP_FLOOR_USD = 100;
const DEFAULT_RISK_PAUSE_LIQ_DISTANCE_PCT = 7;
const DEFAULT_MARGIN_TOP_UP_LIQ_DISTANCE_PCT = 10;
const EXCHANGE_MIN_NOTIONAL_USD = 10;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const STALE_SPOT_COOLDOWN_MS = 60_000;
const MARGIN_COOLDOWN_MS = 2 * 60_000;
const BELOW_NOTIONAL_COOLDOWN_MS = 30_000;
const ESTIMATED_TAKER_FEE_RATE = 0.00025;
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

/**
 * Posicion del precio dentro del rango, de 0 (borde inferior) a 1 (superior).
 *
 * Se mide en espacio LOGARITMICO porque un rango de Uniswap son ticks, y los
 * ticks son logaritmicos en el precio: el punto medio geometrico
 * `sqrt(lower*upper)` es el centro real del rango — el que la mitad aritmetica
 * corre hacia el borde inferior tanto mas cuanto mas ancho es el rango.
 *
 * Devuelve null si el rango no es utilizable o el precio esta fuera de el.
 */
function rangePositionFraction(protection, currentPrice) {
  const lower = Math.min(Number(protection?.rangeLowerPrice), Number(protection?.rangeUpperPrice));
  const upper = Math.max(Number(protection?.rangeLowerPrice), Number(protection?.rangeUpperPrice));
  const price = Number(currentPrice);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower <= 0 || upper <= lower) return null;
  if (!Number.isFinite(price) || price < lower || price > upper) return null;
  const span = Math.log(upper / lower);
  if (!Number.isFinite(span) || span <= 0) return null;
  return Math.log(price / lower) / span;
}

/**
 * Zona central del rango donde la cobertura NO rebalancea.
 *
 * `pct` es el ancho de la zona como porcentaje del rango completo, centrada en
 * el medio geometrico: 40 => se congela entre el 30% y el 70% del rango. El
 * valor por proteccion manda; si viene null se usa el default del servicio.
 * Cero (o rango/precio no utilizables) la deja inactiva.
 */
function resolveCenterDeadZone(protection, currentPrice, fallbackPct) {
  // Ojo con `Number(null)`: da 0, que es finito. La columna nace NULL en toda
  // proteccion migrada, asi que un `Number.isFinite` a secas apagaba la zona
  // muerta justo en las protecciones que tenian que heredar el default. Es la
  // misma trampa que documenta `resolveMinRebalanceNotionalUsd`.
  const raw = protection?.centerDeadZonePct;
  const configured = raw == null ? NaN : Number(raw);
  const candidate = Number.isFinite(configured)
    ? configured
    : Number(fallbackPct);
  const pct = Number.isFinite(candidate)
    ? Math.min(MAX_CENTER_DEAD_ZONE_PCT, Math.max(0, candidate))
    : DEFAULT_CENTER_DEAD_ZONE_PCT;

  if (pct <= 0) return { pct, active: false, positionPct: null };

  const fraction = rangePositionFraction(protection, currentPrice);
  // Fuera de rango (o sin rango) nunca es zona muerta: ahi el LP esta 100% en
  // un lado del par y la cobertura es justamente lo que hay que respetar.
  if (fraction == null) return { pct, active: false, positionPct: null };

  const halfWidth = pct / 200;
  return {
    pct,
    active: Math.abs(fraction - 0.5) <= halfWidth,
    positionPct: fraction * 100,
  };
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
    topUpMaxCount24h: DEFAULT_MAX_AUTO_TOPUPS_PER_24H,
    topUpCapUsd: DEFAULT_MIN_AUTO_TOPUP_CAP_USD,
    lastError: null,
    deactivationRequestedAt: null,
    lastDecision: null,
    lastDecisionReason: null,
    lastExecutionAttemptAt: null,
    lastExecutionOutcome: null,
    pendingExecutionId: null,
    monitorHeartbeatAt: null,
    coverageRatioPct: null,
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
    // Senal forzada (cambio de liquidez del LP, cruce de frontera) que llego
    // mientras el min-dwell estaba activo. Quien la emite lo hace una sola vez
    // y sin cola, asi que se guarda aqui para que el tick siguiente la cobre.
    pendingForceReason: null,
    lastTruthReason: null,
    truthPending: false,
    lastSyntheticInRange: null,
    lastBboSpreadBps: null,
    lastTrackedMidPrice: null,
    lastFullScanAt: null,
    lastMissingDetectedAt: null,
    positionMissingSince: null,
    positionMissingConsecutiveCount: 0,
    lastPositionReadAt: null,
    lastPositionReadSource: null,
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
    topUpMaxCount24h: clampNonNegative(safeState.topUpMaxCount24h, DEFAULT_MAX_AUTO_TOPUPS_PER_24H),
    topUpCapUsd: clampNonNegative(safeState.topUpCapUsd, DEFAULT_MIN_AUTO_TOPUP_CAP_USD),
    marginModeVerified: safeState.marginModeVerified !== false,
    nextEligibleAttemptAt: safeState.nextEligibleAttemptAt != null ? Number(safeState.nextEligibleAttemptAt) : null,
    positionMissingSince: safeState.positionMissingSince != null ? Number(safeState.positionMissingSince) : null,
    positionMissingConsecutiveCount: clampNonNegative(safeState.positionMissingConsecutiveCount),
    lastPositionReadAt: safeState.lastPositionReadAt != null ? Number(safeState.lastPositionReadAt) : null,
    lastPositionReadSource: safeState.lastPositionReadSource || null,
  };
}

function isCooldownActive(protection, strategyState, now = Date.now()) {
  const hasProtectionCooldownField = Boolean(protection)
    && Object.prototype.hasOwnProperty.call(protection, 'nextEligibleAttemptAt');
  const nextEligibleAttemptAt = Number(
    hasProtectionCooldownField
      ? protection?.nextEligibleAttemptAt
      : strategyState?.nextEligibleAttemptAt
  );
  return Number.isFinite(nextEligibleAttemptAt) && nextEligibleAttemptAt > now;
}

function estimateExecutionCostUsd(qty, currentPrice) {
  const size = Math.abs(Number(qty) || 0);
  const price = Number(currentPrice) || 0;
  return size * price * ESTIMATED_TAKER_FEE_RATE;
}

function resolveMinOrderNotionalUsd(protection) {
  const configured = Number(protection?.minOrderNotionalUsd);
  const minimum = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MIN_ORDER_NOTIONAL_USD;
  return Math.max(minimum, EXCHANGE_MIN_NOTIONAL_USD);
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

/**
 * Umbral de drift (USD) por debajo del cual no vale la pena rebalancear por
 * temporizador. Se deriva del valor vivo del LP para que siga al tamano de la
 * posicion en vez de quedarse congelado en el que se configuro al crearla.
 *
 * Sin valor de LP utilizable devuelve Infinity: el brazo por temporizador se
 * apaga y solo actuan los caminos forzados (cambio de liquidez, cruce de
 * frontera). Es la lectura segura — con datos rotos, `targetQty` puede irse a
 * cero y un umbral bajo desharia el hedge entero.
 */
function resolveMinRebalanceNotionalUsd(protection, poolValueUsd) {
  const value = asFiniteNumber(poolValueUsd);
  if (!Number.isFinite(value) || value <= 0) return Infinity;
  // Ojo con `asFiniteNumber` aqui: convierte null en 0, y como la columna nace
  // NULL en toda proteccion migrada, un `?? DEFAULT` no llegaria a dispararse
  // nunca y el umbral se hundiria hasta el suelo.
  const configuredPct = Number(protection?.minRebalanceNotionalPct);
  const pct = Number.isFinite(configuredPct) && configuredPct > 0
    ? configuredPct
    : DEFAULT_MIN_REBALANCE_NOTIONAL_PCT;
  return Math.max(MIN_REBALANCE_NOTIONAL_FLOOR_USD, (pct / 100) * value);
}

/**
 * Piso economico para las rutas urgentes (`boundary_cross` / `price_band`).
 * Mismo patron que `resolveMinRebalanceNotionalUsd` —porcentaje del valor VIVO
 * del LP con suelo absoluto— pero con su propio porcentaje configurable, mas
 * bajo, porque frena churn sin retrasar una re-cobertura genuina.
 */
function resolveUrgentMinRebalanceNotionalUsd(protection, poolValueUsd, urgentPct) {
  const value = asFiniteNumber(poolValueUsd);
  if (!Number.isFinite(value) || value <= 0) return Infinity;
  // Mismo cuidado que en resolveMinRebalanceNotionalUsd: `asFiniteNumber`
  // convertiria null en 0 y hundiria el umbral hasta el suelo.
  const configured = Number(
    protection?.urgentMinRebalanceNotionalPct ?? urgentPct
  );
  const pct = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_URGENT_MIN_REBALANCE_NOTIONAL_PCT;
  return Math.max(MIN_REBALANCE_NOTIONAL_FLOOR_USD, (pct / 100) * value);
}

function deriveDecisionBandUsd(protection, metrics, currentPrice) {
  // Esta banda debe compartir el mismo minimo que preflight y ejecucion. Las
  // protecciones migradas conservan `minOrderNotionalUsd = null`; usar aqui el
  // viejo fallback de $50 anulaba los umbrales porcentuales de rebalanceo.
  const minRebalanceUsd = resolveMinOrderNotionalUsd(protection);
  const targetQty = Number(metrics?.targetQty || 0);
  const estimatedCost = estimateExecutionCostUsd(targetQty, currentPrice);
  const floor = Math.max(minRebalanceUsd, estimatedCost * 3);
  return {
    holdBandUsd: floor,
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
  if (lowered.includes('margen insuficiente') || lowered.includes('insufficient margin')) {
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
  if (lowered.includes('minimum value') || lowered.includes('order too small')) {
    return {
      nextEligibleAttemptAt: Date.now() + BELOW_NOTIONAL_COOLDOWN_MS,
      cooldownReason: 'below_exchange_minimum_notional',
      status: 'tracking',
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

function deriveBandSettings(protection, rvStats, metrics, currentPrice, opts = {}) {
  // Factores de endurecimiento (config-gated). Default 1 = sin cambio. Solo
  // afectan el modo adaptativo: en modo 'fixed' el usuario fijó intervalo/banda
  // explícitamente y los respetamos. Se clampan a (0, 1] para que nunca
  // aflojen la cadencia por error de configuración.
  const intervalTightenFactor = Math.min(1, Math.max(0.05, asFiniteNumber(opts.intervalTightenFactor) || 1));
  const bandTightenFactor = Math.min(1, Math.max(0.05, asFiniteNumber(opts.bandTightenFactor) || 1));
  const bandMode = protection.bandMode || DEFAULT_BAND_MODE;
  const rv4hPct = asFiniteNumber(rvStats.rv4hPct) || 0;
  const rv24hPct = asFiniteNumber(rvStats.rv24hPct) || 0;
  const effectiveRvPct = Math.max(rv4hPct, rv24hPct);
  const adaptivePreset = buildBandPreset(effectiveRvPct);
  const baseBandPct = bandMode === 'fixed'
    ? (asFiniteNumber(protection.baseRebalancePriceMovePct) || DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT)
    : adaptivePreset.priceMovePct * bandTightenFactor;
  const intervalSec = bandMode === 'fixed'
    ? (asFiniteNumber(protection.rebalanceIntervalSec) || DEFAULT_REBALANCE_INTERVAL_SEC)
    : Math.min(
      MAX_ADAPTIVE_REBALANCE_INTERVAL_SEC,
      Math.round(adaptivePreset.intervalSec * intervalTightenFactor)
    );
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
  DEFAULT_MIN_REBALANCE_NOTIONAL_PCT,
  MIN_REBALANCE_NOTIONAL_FLOOR_USD,
  resolveMinRebalanceNotionalUsd,
  resolveUrgentMinRebalanceNotionalUsd,
  DEFAULT_URGENT_MIN_REBALANCE_NOTIONAL_PCT,
  DEFAULT_CENTER_DEAD_ZONE_PCT,
  MAX_CENTER_DEAD_ZONE_PCT,
  rangePositionFraction,
  resolveCenterDeadZone,
  MAX_ADAPTIVE_REBALANCE_INTERVAL_SEC,
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
  DEFAULT_MIN_AUTO_TOPUP_CAP_USD,
  DEFAULT_AUTO_TOPUP_CAP_PCT_OF_INITIAL,
  DEFAULT_MIN_AUTO_TOPUP_FLOOR_USD,
  DEFAULT_RISK_PAUSE_LIQ_DISTANCE_PCT,
  DEFAULT_MARGIN_TOP_UP_LIQ_DISTANCE_PCT,
  EXCHANGE_MIN_NOTIONAL_USD,
  ESTIMATED_TAKER_FEE_RATE,
  MARGIN_COOLDOWN_MS,
  BELOW_NOTIONAL_COOLDOWN_MS,
  clampNonNegative,
  estimateExecutionCostUsd,
  resolveMinOrderNotionalUsd,
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
