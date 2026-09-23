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
  'naked_exposure',
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

/**
 * Politicas que viven sobre el 100% del delta y NO heredan los escalones de
 * zona legacy.
 *
 * Importa que esto sea UNA sola lista: si una politica corre viva sin estar
 * aca, `pricing.js` le aplica `zoneMultiplier` y la sub-cubre en silencio —
 * hasta un 40% en centro con los defaults historicos. El selector diria una
 * cosa y el hedge haria otra, que es el peor modo de fallo posible.
 *
 * Lista de literales a proposito: `range-exit-policy.service.js` importa de
 * este modulo, asi que importar de vuelta cerraria un ciclo.
 */
const FULL_DELTA_POLICIES = ['net_profit_v1', 'net_profit_v2', 'range_exit_v1'];

function policyOwnsFullDelta(policyVersion, executionIntent) {
  return FULL_DELTA_POLICIES.includes(policyVersion) && executionIntent === 'live';
}

/**
 * Politicas que se pueden ELEGIR para operar de verdad. Todo lo demas —una
 * politica desconocida, o una elegida con intencion `shadow`— sigue ejecutando
 * con las zonas legacy.
 *
 * Misma lista de literales y por el mismo motivo que `FULL_DELTA_POLICIES`:
 * importar las constantes desde los modulos de politica cerraria un ciclo.
 */
const SELECTABLE_LIVE_POLICIES = ['net_profit_v1', 'net_profit_v2', 'range_exit_v1'];

/**
 * La politica que EJECUTA, que no es siempre la declarada. Una proteccion
 * creada como net_profit pero con intencion `shadow` sigue rebalanceando con
 * la logica legacy: la viva es legacy y su net_profit es una de las sombras.
 *
 * Es la unica definicion: el motor de sombra, la persistencia, las metricas y
 * el encabezado del orquestador la comparten. Dos criterios distintos para
 * "que politica corre" es como la UI termina diciendo una cosa y el hedge
 * haciendo otra.
 */
function resolveLivePolicy({ policyVersion, executionIntent } = {}) {
  return SELECTABLE_LIVE_POLICIES.includes(policyVersion) && executionIntent === 'live'
    ? policyVersion
    : 'legacy_zones_v1';
}

/**
 * Politicas que respetan la zona muerta central.
 *
 * `range_exit_v1` no la usa —espeja la rama de `evaluate.js` que la fija en
 * `false`: esa politica ya se queda quieta DENTRO del rango por diseno, y
 * cuando decide es en el borde, que nunca es centro.
 */
function policyHonorsCenterDeadZone(livePolicy) {
  return livePolicy != null && livePolicy !== 'range_exit_v1';
}

/**
 * El tramo del rango donde la cobertura NO opera, tal como lo produce la
 * politica que esta corriendo. Es lo que dibuja la tarjeta del orquestador.
 *
 *   center     -> banda central de `pct`% del rango (zonas legacy y net profit)
 *   full_range -> el rango entero (`range_exit_v1`: dentro del rango no toca
 *                 el hedge; solo reajusta al salir y al volver a entrar)
 *   none       -> la cobertura sigue al delta en todo el rango
 *
 * Se decide aca y no en el cliente porque es la misma pregunta que
 * `resolveLivePolicy`: que hace el motor que esta corriendo. Un `kind` en vez
 * de un booleano evita que la vista tenga que conocer los nombres de las
 * politicas para saber que dibujar.
 */
function resolveNoOpZone(livePolicy, centerDeadZonePct) {
  if (livePolicy == null) return null;
  if (!policyHonorsCenterDeadZone(livePolicy)) return { kind: 'full_range', pct: 100 };
  // La misma trampa que documenta `resolveCenterDeadZone`: `Number(null)` da 0,
  // que es finito. Sin este corte, una proteccion que todavia no resolvio su
  // zona se dibujaria como "sin zona muerta" —una configuracion deliberada y
  // distinta— en vez de no dibujar nada.
  if (centerDeadZonePct == null) return null;
  const pct = Number(centerDeadZonePct);
  if (!Number.isFinite(pct)) return null;
  if (pct <= 0) return { kind: 'none', pct: 0 };
  return { kind: 'center', pct: Math.min(MAX_CENTER_DEAD_ZONE_PCT, pct) };
}

/**
 * Lo mismo, pero leyendo una fila de `protected_uniswap_pools` tal cual sale
 * del repositorio. Replica el orden de precedencia de `evaluate.js`: la
 * columna manda sobre el estado, y el estado sobre nada. Los registros
 * anteriores a la columna solo tienen `strategyState.policyVersion`.
 */
function resolveProtectionLivePolicy(protection) {
  if (!protection) return null;
  const state = protection.strategyState || null;
  return resolveLivePolicy({
    policyVersion: protection.policyVersion || state?.policyVersion || null,
    executionIntent: state?.executionIntent || null,
  });
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

// Exposicion direccional: lo que queda SIN CUBRIR, medido en USD.
//
// Deliberadamente NO se usa el ratio actual/target. Cuando el precio sale del
// rango el delta del LP tiende a 0 y el ratio se dispara a 40x-290x sin que
// pase nada anomalo — es el comportamiento normal de `range_exit_v1`. Un
// umbral por ratio la marcaria rota todo el tiempo. El notional en USD sigue
// siendo finito y comparable cuando el denominador se va a cero.
const NAKED_EXPOSURE_MIN_USD = 15;
const NAKED_EXPOSURE_MIN_PCT_OF_POOL = 0.05;
// Severidad por duracion. Se notifica al CRUZAR un escalon, no por tick: un
// episodio largo produce 3 avisos, no uno cada 2 segundos.
const NAKED_EXPOSURE_TIERS = [
  { afterMs: 15 * 60_000, severity: 'warning' },
  { afterMs: 60 * 60_000, severity: 'high' },
  { afterMs: 6 * 60 * 60_000, severity: 'critical' },
];

function resolveNakedExposure({
  nakedNotionalUsd,
  poolValueUsd,
  now = Date.now(),
  priorSince = null,
  priorTier = -1,
  minUsd = NAKED_EXPOSURE_MIN_USD,
  minPctOfPool = NAKED_EXPOSURE_MIN_PCT_OF_POOL,
} = {}) {
  const usd = Math.abs(Number(nakedNotionalUsd) || 0);
  const pool = Number(poolValueUsd) || 0;
  // Las dos condiciones a la vez: el piso en USD evita alarmar por centavos en
  // un pool grande, y el porcentaje evita alarmar por un monto que el propio
  // tamano de la posicion vuelve irrelevante.
  const material = usd >= minUsd && (pool > 0 ? (usd / pool) >= minPctOfPool : true);
  if (!material) {
    return { material: false, since: null, elapsedMs: 0, tier: -1, severity: null, escalated: false };
  }
  const prevSince = Number(priorSince);
  const since = Number.isFinite(prevSince) && prevSince > 0 ? prevSince : now;
  const elapsedMs = Math.max(0, now - since);
  const prevTier = Number.isFinite(Number(priorTier)) ? Number(priorTier) : -1;
  let tier = -1;
  for (let i = 0; i < NAKED_EXPOSURE_TIERS.length; i += 1) {
    if (elapsedMs >= NAKED_EXPOSURE_TIERS[i].afterMs) tier = i;
  }
  return {
    material: true,
    since,
    elapsedMs,
    tier,
    severity: tier >= 0 ? NAKED_EXPOSURE_TIERS[tier].severity : null,
    escalated: tier >= 0 && tier > prevTier,
  };
}

// Tope de exposicion direccional. Es un limite de RIESGO, no una decision de
// cobertura: vive por encima de las politicas y las sobrescribe.
//
// Por que ademas de magnitud exige DURACION. Una divergencia grande no es por
// si sola una anomalia: `range_exit_v1` paga divergencia a proposito para no
// pagar comisiones, y dentro del rango puede apartarse bastante del delta antes
// de que el cruce de borde la cierre. Recortarla por magnitud instantanea seria
// destruir la politica — la misma trampa que el cap por ratio que este plan ya
// descarto, con otra aritmetica.
//
// Lo que distingue a pp27 no es que su exposicion fuera grande, es que era
// grande Y NO SE CERRABA: 72 h creciendo porque el delta ya no existia. La
// duracion es el discriminador, no el tamano.
const DEFAULT_NAKED_CAP_PCT_OF_POOL = 15;
const DEFAULT_NAKED_CAP_FLOOR_USD = 30;
// Escalon minimo de `resolveNakedExposure` (1 = 1 h) antes de que el tope
// actue. Por debajo se avisa, no se interviene.
const DEFAULT_NAKED_CAP_MIN_TIER = 1;

function resolveNakedNotionalCapUsd(protection, poolValueUsd) {
  const pct = Number(protection?.nakedNotionalCapPctOfPool);
  const floor = Number(protection?.nakedNotionalCapFloorUsd);
  const effectivePct = Number.isFinite(pct) && pct > 0 ? pct : DEFAULT_NAKED_CAP_PCT_OF_POOL;
  const effectiveFloor = Number.isFinite(floor) && floor >= 0 ? floor : DEFAULT_NAKED_CAP_FLOOR_USD;
  const pool = Number(poolValueUsd) || 0;
  return Math.max(effectiveFloor, (effectivePct / 100) * pool);
}

// Que fraccion del cap se deja como descubierto tras un recorte.
//
// No se recorta hasta el BORDE del cap: con la divergencia justo por encima,
// esa orden seria de centavos —$1.55 en el episodio real de pp28— y quedaria
// por debajo del minimo del exchange, inejecutable y disparando otra vez al
// instante. El 50% deja holgura antes del siguiente disparo y garantiza que
// cualquier recorte sea una orden enviable.
const NAKED_CAP_TRIM_RETAIN = 0.5;

/**
 * A donde llevar el hedge cuando el cap interviene.
 *
 * El cap es un limite de RIESGO: dice "el descubierto no puede pasar de X". La
 * primera version rebalanceaba al delta completo, o sea imponia descubierto
 * CERO — eso no es hacer cumplir el limite, es imponer el objetivo de otra
 * politica, y bajo `range_exit_v1` tiene un coste concreto: re-ancla la
 * cobertura donde el cap la interrumpio.
 *
 * Paso de verdad en pp28 el 2026-09-23. El cap corto en un maximo local (ETH
 * 2774), donde el delta estaba en su valor mas bajo; el precio revirtio a 2754
 * y la politica, que congela dentro del rango, quedo pegada al extremo:
 *
 *   corte al delta completo   short 0.0933 -> 0.0642   luego infra-cubierto $44
 *   recorte parcial           short 0.0933 -> 0.0785   luego casi clavado
 *
 * Devuelve `targetQty` sin tocar cuando el recorte no aplica, para que el
 * llamador pueda usarlo sin ramificar.
 */
function resolveCapTrimTarget({
  actualQty,
  targetQty,
  currentPrice,
  capUsd,
  retain = NAKED_CAP_TRIM_RETAIN,
} = {}) {
  const held = Number(actualQty);
  const target = Number(targetQty);
  const price = Number(currentPrice);
  const cap = Number(capUsd);
  if (![held, target, price, cap].every(Number.isFinite) || price <= 0 || cap <= 0) return target;

  const divergenceQty = target - held;
  const divergenceUsd = Math.abs(divergenceQty) * price;
  if (divergenceUsd <= cap) return target;

  const allowedQty = (cap * Math.min(Math.max(retain, 0), 1)) / price;
  if (allowedQty >= Math.abs(divergenceQty)) return target;

  // Mover `held` hacia `target`, pero parando a `allowedQty` de distancia.
  return target - Math.sign(divergenceQty) * allowedQty;
}

/**
 * ¿Hay que intervenir por encima de lo que diga la politica?
 *
 * `tier` viene de `resolveNakedExposure`: -1 sin severidad, 0 a partir de 15
 * min, 1 a partir de 1 h, 2 a partir de 6 h.
 */
function resolveNakedNotionalBreach({
  nakedNotionalUsd,
  poolValueUsd,
  tier = -1,
  protection = null,
  minTier = DEFAULT_NAKED_CAP_MIN_TIER,
} = {}) {
  const usd = Math.abs(Number(nakedNotionalUsd) || 0);
  const capUsd = resolveNakedNotionalCapUsd(protection, poolValueUsd);
  const sustained = Number(tier) >= minTier;
  return {
    capUsd,
    nakedNotionalUsd: usd,
    sustained,
    breached: sustained && usd > capUsd,
  };
}

// Piso de margen: cuanto colateral hace falta para cubrir el delta objetivo,
// con holgura.
//
// El 1.3 no es decoracion. El `hedgeRealizedPnl` se descuenta del MISMO margen
// aislado que dimensiona el hedge y no existe via de reposicion: un hedge que
// pierde reduce su propia capacidad de cubrir. La holgura es lo que absorbe ese
// drawdown antes de que la cobertura se quede sin balas — que es como la cuenta
// de pp18 paso de $31.76 a $20.38 y se murio en silencio.
const DEFAULT_MARGIN_FLOOR_BUFFER = 1.3;

function resolveMarginFloor({
  targetQty,
  currentPrice,
  leverage,
  availableMarginUsd,
  bufferFactor = DEFAULT_MARGIN_FLOOR_BUFFER,
} = {}) {
  const qty = Math.max(0, Number(targetQty) || 0);
  const price = Math.max(0, Number(currentPrice) || 0);
  const lev = Math.max(1, Number(leverage) || 1);
  const available = Math.max(0, Number(availableMarginUsd) || 0);
  const buffer = Number(bufferFactor) > 0 ? Number(bufferFactor) : DEFAULT_MARGIN_FLOOR_BUFFER;
  const requiredMarginUsd = ((qty * price) / lev) * buffer;
  return {
    requiredMarginUsd,
    availableMarginUsd: available,
    bufferFactor: buffer,
    satisfied: available >= requiredMarginUsd,
    shortfallUsd: Math.max(0, requiredMarginUsd - available),
  };
}

/**
 * Cuanto LP se puede sostener con el margen que hay.
 *
 * Hoy, si no puede cubrir, el sistema sostiene el LP DESNUDO indefinidamente.
 * Lo correcto es lo contrario: un LP mas chico y cubierto domina a uno grande y
 * descubierto. Esto calcula hasta donde habria que encogerlo.
 *
 * Devuelve una RECOMENDACION. Reducir un LP es una accion de capital
 * irreversible y no se ejecuta sola.
 */
function resolveDeleverageTarget({
  poolValueUsd,
  targetQty,
  currentPrice,
  leverage,
  availableMarginUsd,
  bufferFactor = DEFAULT_MARGIN_FLOOR_BUFFER,
} = {}) {
  const floor = resolveMarginFloor({ targetQty, currentPrice, leverage, availableMarginUsd, bufferFactor });
  const pool = Math.max(0, Number(poolValueUsd) || 0);
  const qty = Math.max(0, Number(targetQty) || 0);
  if (floor.satisfied || qty <= 0) {
    return { needed: false, coverableFraction: 1, suggestedPoolValueUsd: pool, reduceByUsd: 0, ...floor };
  }
  // El delta de un LP concentrado escala con su tamano, asi que la fraccion
  // cubrible del delta es la fraccion sostenible del LP.
  const coverableFraction = Math.max(0, Math.min(1, floor.requiredMarginUsd > 0
    ? floor.availableMarginUsd / floor.requiredMarginUsd
    : 1));
  const suggestedPoolValueUsd = pool * coverableFraction;
  return {
    needed: true,
    coverableFraction,
    suggestedPoolValueUsd,
    reduceByUsd: Math.max(0, pool - suggestedPoolValueUsd),
    ...floor,
  };
}

function normalizeEvaluationStatus({
  decision,
  trackingErrorUsd,
  riskStatus,
  preflightStatus,
  shouldRebalance,
  preflightOk,
  nakedExposureSustained = false,
}) {
  if (riskStatus) return riskStatus;
  if (preflightStatus && preflightStatus !== 'tracking') return preflightStatus;
  if (shouldRebalance && decision !== 'hold' && preflightOk) return 'rebalance_pending';
  // Sostener exposicion direccional no es "tracking". `tracking` dice "voy
  // siguiendo al delta", y aqui justamente se dejo de seguirlo: pp27 paso 3
  // dias reportandose `tracking` con $53.90 de short desnudo, `fallos: 0` y
  // `ult_error` vacio. Va despues de `rebalance_pending` a proposito — si ya
  // hay una correccion en curso, eso es lo informativo.
  if (nakedExposureSustained) return 'naked_exposure';
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
  FULL_DELTA_POLICIES,
  policyOwnsFullDelta,
  SELECTABLE_LIVE_POLICIES,
  resolveLivePolicy,
  resolveProtectionLivePolicy,
  policyHonorsCenterDeadZone,
  resolveNoOpZone,
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
  resolveNakedExposure,
  resolveNakedNotionalBreach,
  resolveMarginFloor,
  resolveDeleverageTarget,
  resolveNakedNotionalCapUsd,
  resolveCapTrimTarget,
  NAKED_CAP_TRIM_RETAIN,
  NAKED_EXPOSURE_TIERS,
  deriveBandSettings,
  computeVolatilityStats,
};
