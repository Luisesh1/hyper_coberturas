const { ethers } = require('ethers');
const db = require('../db');
const hedgeRegistry = require('./hedge.registry');
const marketService = require('./market.service');
const hyperliquidAccountsService = require('./hyperliquid-accounts.service');
const hedgeRepository = require('../repositories/hedge.repository');
const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');
const logger = require('./logger.service');
const timeInRangeService = require('./time-in-range.service');
const { formatPrice } = require('../utils/format');
const { ValidationError, NotFoundError } = require('../errors/app-error');
const protectedPoolDeltaNeutralService = require('./protected-pool-delta-neutral.service');
const { getTradingService } = require('./trading.factory');
const {
  computeDeltaNeutralMetrics,
  resolveDeltaNeutralOrientation,
} = require('./delta-neutral-math.service');
const {
  computeSnapshotHash,
  normalizeProtectionSnapshot,
  validateNormalizedProtectionSnapshot,
} = require('./delta-neutral-snapshot.service');
const {
  DEFAULT_BAND_MODE,
  DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT,
  DEFAULT_REBALANCE_INTERVAL_SEC,
  DEFAULT_TARGET_HEDGE_RATIO,
  DEFAULT_MIN_REBALANCE_NOTIONAL_USD,
  DEFAULT_MAX_SLIPPAGE_BPS,
  DEFAULT_TWAP_MIN_NOTIONAL_USD,
  buildInitialStrategyState,
} = require('./protected-pool-delta-neutral.service');
const SHORTCUT_MULTIPLIERS = [1.25, 1.5, 2, 3, 4];
const STOP_LOSS_DIFFERENCE_DEFAULT_PCT = 0.05;
const DYNAMIC_REENTRY_BUFFER_DEFAULT_PCT = 0.01;
const DYNAMIC_FLIP_COOLDOWN_DEFAULT_SEC = 15;
const DYNAMIC_MAX_SEQUENTIAL_FLIPS_DEFAULT = 6;
const DYNAMIC_BREAKOUT_CONFIRM_DISTANCE_DEFAULT_PCT = 0.5;
const DYNAMIC_BREAKOUT_CONFIRM_DURATION_DEFAULT_SEC = 600;
const DEFAULT_EXECUTION_MODE = 'auto';
const DEFAULT_MAX_SPREAD_BPS = 30;
const DEFAULT_MAX_EXECUTION_FEE_USD = 25;
const DEFAULT_MIN_ORDER_NOTIONAL_USD = 25;
const DEFAULT_TWAP_SLICES = 5;
const DEFAULT_TWAP_DURATION_SEC = 60;
const WRAPPED_TOKEN_EQUIVALENTS = new Map([
  ['WBTC', 'BTC'],
  ['WETH', 'ETH'],
]);

const ACTIVE_HEDGE_STATUSES = new Set([
  'waiting',
  'entry_pending',
  'entry_filled_pending_sl',
  'open',
  'open_protected',
  'closing',
  'cancel_pending',
  'executing_open',
  'executing_close',
]);

function asPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeMaybeAddress(value) {
  if (!value) return null;
  try {
    return ethers.getAddress(String(value).trim());
  } catch {
    return String(value).trim();
  }
}

function normalizeCoverageSymbol(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return '';
  return WRAPPED_TOKEN_EQUIVALENTS.get(normalized) || normalized;
}

function normalizePoolSnapshot(pool) {
  if (!pool || typeof pool !== 'object') {
    throw new ValidationError('pool es requerido');
  }
  if (pool.mode !== 'lp_position' || !['v3', 'v4'].includes(pool.version)) {
    throw new ValidationError('Solo se pueden proteger posiciones LP de Uniswap V3/V4');
  }

  const rangeLowerPrice = asPositiveNumber(pool.rangeLowerPrice);
  const rangeUpperPrice = asPositiveNumber(pool.rangeUpperPrice);
  const currentValueUsd = asPositiveNumber(pool.currentValueUsd);
  const owner = normalizeMaybeAddress(pool.owner || pool.creator);
  const identifier = String(pool.identifier || '').trim();

  if (!rangeLowerPrice || !rangeUpperPrice) {
    throw new ValidationError('El pool no tiene un rango valido para crear la proteccion');
  }
  if (!currentValueUsd) {
    throw new ValidationError('No se pudo calcular el valor actual USD del pool');
  }
  if (!owner) {
    throw new ValidationError('No se pudo identificar la wallet propietaria del pool');
  }
  if (!identifier) {
    throw new ValidationError('No se pudo identificar la posicion del pool');
  }
  if (!pool.token0?.symbol || !pool.token1?.symbol) {
    throw new ValidationError('El pool no contiene metadata suficiente de tokens');
  }

  // Calcular priceCurrent si no se proporciona (usa el punto medio del rango como aproximación)
  let priceCurrent = null;
  if (pool.priceCurrent != null) {
    priceCurrent = Number(pool.priceCurrent);
  } else if (Number.isFinite(rangeLowerPrice) && Number.isFinite(rangeUpperPrice)) {
    // Aproximación: punto medio del rango
    priceCurrent = (rangeLowerPrice + rangeUpperPrice) / 2;
  }

  return {
    ...pool,
    owner,
    creator: owner,
    identifier,
    token0Address: normalizeMaybeAddress(pool.token0Address),
    token1Address: normalizeMaybeAddress(pool.token1Address),
    poolAddress: normalizeMaybeAddress(pool.poolAddress),
    rangeLowerPrice,
    rangeUpperPrice,
    priceCurrent,
    currentValueUsd,
    inRange: pool.inRange === true,
  };
}

function buildSnapshotMetadata(snapshot) {
  const normalizedSnapshot = normalizeProtectionSnapshot(snapshot, {
    network: snapshot.network,
    version: snapshot.version,
    positionIdentifier: snapshot.identifier,
    poolAddress: snapshot.poolAddress,
    poolId: snapshot.poolId,
    owner: snapshot.owner || snapshot.creator,
    snapshotFreshAt: Date.now(),
  });
  const validation = validateNormalizedProtectionSnapshot(normalizedSnapshot);
  return {
    normalizedSnapshot,
    snapshotStatus: validation.status,
    snapshotValidation: validation,
    snapshotFreshAt: normalizedSnapshot.snapshotFreshAt,
    snapshotHash: computeSnapshotHash(normalizedSnapshot),
  };
}

function buildProtectionKey({ walletAddress, network, version, positionIdentifier }) {
  return [
    String(walletAddress || '').trim().toLowerCase(),
    String(network || '').trim().toLowerCase(),
    String(version || '').trim().toLowerCase(),
    String(positionIdentifier || '').trim(),
  ].join('::');
}

function resolveMatchingAssets(pool, availableAssets) {
  const tokenSymbols = [
    normalizeCoverageSymbol(pool.token0?.symbol),
    normalizeCoverageSymbol(pool.token1?.symbol),
  ].filter(Boolean);
  const matches = availableAssets.filter((asset) => (
    tokenSymbols.includes(normalizeCoverageSymbol(asset.name))
  ));
  const uniqueMatches = matches.filter((asset, index, arr) => (
    arr.findIndex((candidate) => normalizeCoverageSymbol(candidate.name) === normalizeCoverageSymbol(asset.name)) === index
  ));

  return uniqueMatches;
}

function buildCandidateFromMarket(pool, availableAssets, mids) {
  const normalizedPool = normalizePoolSnapshot(pool);
  const baseNotionalUsd = normalizedPool.currentValueUsd;
  const deltaNeutral = buildDeltaNeutralCandidate(normalizedPool, availableAssets, mids);
  const baseCandidate = {
    baseNotionalUsd,
    suggestedNotionalUsd: baseNotionalUsd,
    shortcutMultipliers: SHORTCUT_MULTIPLIERS,
    hedgeNotionalUsd: baseNotionalUsd,
    stopLossDifferenceDefaultPct: STOP_LOSS_DIFFERENCE_DEFAULT_PCT,
    breakoutConfirmDistancePct: DYNAMIC_BREAKOUT_CONFIRM_DISTANCE_DEFAULT_PCT,
    breakoutConfirmDurationSec: DYNAMIC_BREAKOUT_CONFIRM_DURATION_DEFAULT_SEC,
    valueMode: 'usd',
    marginMode: 'isolated',
    deltaNeutralEligible: deltaNeutral.deltaNeutralEligible,
    deltaNeutralReason: deltaNeutral.deltaNeutralReason,
    deltaNeutralAsset: deltaNeutral.deltaNeutralAsset,
    stableTokenSymbol: deltaNeutral.stableTokenSymbol,
    volatileTokenSymbol: deltaNeutral.volatileTokenSymbol,
    estimatedInitialHedgeQty: deltaNeutral.estimatedInitialHedgeQty,
    deltaQty: deltaNeutral.deltaQty,
    gamma: deltaNeutral.gamma,
    bandMode: DEFAULT_BAND_MODE,
    baseRebalancePriceMovePct: DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT,
    rebalanceIntervalSec: DEFAULT_REBALANCE_INTERVAL_SEC,
    targetHedgeRatio: DEFAULT_TARGET_HEDGE_RATIO,
    minRebalanceNotionalUsd: DEFAULT_MIN_REBALANCE_NOTIONAL_USD,
    maxSlippageBps: DEFAULT_MAX_SLIPPAGE_BPS,
    twapMinNotionalUsd: DEFAULT_TWAP_MIN_NOTIONAL_USD,
  };

  if (!normalizedPool.inRange) {
    return {
      eligible: false,
      reason: 'Solo puedes iniciar la proteccion cuando el pool este dentro de rango',
      inferredAsset: null,
      hedgeSize: null,
      midPrice: null,
      maxLeverage: null,
      defaultLeverage: null,
      ...baseCandidate,
    };
  }

  const matches = resolveMatchingAssets(normalizedPool, availableAssets);

  if (matches.length === 0) {
    return {
      eligible: false,
      reason: 'Ningun token del pool coincide con un activo soportado en Hyperliquid',
      inferredAsset: null,
      hedgeSize: null,
      midPrice: null,
      maxLeverage: null,
      defaultLeverage: null,
      ...baseCandidate,
    };
  }

  if (matches.length > 1) {
    return {
      eligible: false,
      reason: 'Ambos tokens del pool existen en Hyperliquid; el activo a cubrir es ambiguo',
      inferredAsset: null,
      hedgeSize: null,
      midPrice: null,
      maxLeverage: null,
      defaultLeverage: null,
      ...baseCandidate,
    };
  }

  const asset = matches[0];
  const inferredAsset = String(asset.name || '').toUpperCase();
  const midPrice = asPositiveNumber(mids?.[inferredAsset]);

  if (!midPrice) {
    return {
      eligible: false,
      reason: `No hay precio mid disponible para ${inferredAsset} en Hyperliquid`,
      inferredAsset,
      hedgeSize: null,
      midPrice: null,
      maxLeverage: Number(asset.maxLeverage) || null,
      defaultLeverage: null,
      ...baseCandidate,
    };
  }

  const hedgeSize = baseNotionalUsd / midPrice;
  const maxLeverage = Number(asset.maxLeverage) || null;

  return {
    eligible: Number.isFinite(hedgeSize) && hedgeSize > 0,
    reason: Number.isFinite(hedgeSize) && hedgeSize > 0
      ? null
      : 'No se pudo calcular el tamano de cobertura para este pool',
    inferredAsset,
    hedgeSize,
    midPrice,
    maxLeverage,
    defaultLeverage: maxLeverage ? Math.min(10, maxLeverage) : 10,
    ...baseCandidate,
  };
}

function buildDeltaNeutralCandidate(pool, availableAssets, mids) {
  const orientation = resolveDeltaNeutralOrientation(pool);
  if (!orientation.eligible) {
    return {
      deltaNeutralEligible: false,
      deltaNeutralReason: orientation.reason,
      deltaNeutralAsset: null,
      stableTokenSymbol: null,
      volatileTokenSymbol: null,
      estimatedInitialHedgeQty: null,
      deltaQty: null,
      gamma: null,
    };
  }

  const asset = availableAssets.find((item) => (
    String(item?.name || '').trim().toUpperCase() === orientation.volatileTokenSymbol
  ));
  if (!asset) {
    return {
      deltaNeutralEligible: false,
      deltaNeutralReason: `El token volatil ${orientation.volatileTokenSymbol} no existe en Hyperliquid.`,
      deltaNeutralAsset: null,
      stableTokenSymbol: orientation.stableTokenSymbol,
      volatileTokenSymbol: orientation.volatileTokenSymbol,
      estimatedInitialHedgeQty: null,
      deltaQty: null,
      gamma: null,
    };
  }

  const metrics = computeDeltaNeutralMetrics(pool, {
    targetHedgeRatio: DEFAULT_TARGET_HEDGE_RATIO,
  });
  if (!metrics.eligible) {
    return {
      deltaNeutralEligible: false,
      deltaNeutralReason: metrics.reason,
      deltaNeutralAsset: asset.name,
      stableTokenSymbol: orientation.stableTokenSymbol,
      volatileTokenSymbol: orientation.volatileTokenSymbol,
      estimatedInitialHedgeQty: null,
      deltaQty: null,
      gamma: null,
    };
  }

  return {
    deltaNeutralEligible: true,
    deltaNeutralReason: null,
    deltaNeutralAsset: String(asset.name || '').toUpperCase(),
    stableTokenSymbol: orientation.stableTokenSymbol,
    volatileTokenSymbol: orientation.volatileTokenSymbol,
    estimatedInitialHedgeQty: metrics.targetQty,
    deltaQty: metrics.deltaQty,
    gamma: metrics.gamma,
    midPrice: asPositiveNumber(mids?.[String(asset.name || '').toUpperCase()]) || metrics.volatilePriceUsd,
  };
}

async function buildProtectionCandidate(pool, deps = {}) {
  const availableAssets = deps.availableAssets || await marketService.getAvailableAssets();
  const mids = deps.mids || await marketService.getAllPrices();
  return buildCandidateFromMarket(pool, availableAssets, mids);
}

async function annotatePoolsWithProtection({ userId, pools }, deps = {}) {
  if (!Array.isArray(pools) || pools.length === 0) return [];

  const [availableAssets, mids, activeProtections] = await Promise.all([
    deps.availableAssets || marketService.getAvailableAssets(),
    deps.mids || marketService.getAllPrices(),
    deps.activeProtections || protectedPoolRepository.listActiveByUser(userId),
  ]);

  const protectionMap = new Map(
    activeProtections.map((item) => [
      buildProtectionKey({
        walletAddress: item.walletAddress,
        network: item.network,
        version: item.version,
        positionIdentifier: item.positionIdentifier,
      }),
      item,
    ])
  );

  return pools.map((pool) => {
    if (pool?.mode !== 'lp_position' || !['v3', 'v4'].includes(pool?.version)) {
      return { ...pool, protection: null };
    }

    let candidate;
    try {
      candidate = buildCandidateFromMarket(pool, availableAssets, mids);
    } catch (err) {
      candidate = {
        eligible: false,
        reason: err.message,
        inferredAsset: null,
        hedgeNotionalUsd: null,
        hedgeSize: null,
        midPrice: null,
        maxLeverage: null,
        defaultLeverage: null,
        stopLossDifferenceDefaultPct: STOP_LOSS_DIFFERENCE_DEFAULT_PCT,
        breakoutConfirmDistancePct: DYNAMIC_BREAKOUT_CONFIRM_DISTANCE_DEFAULT_PCT,
        breakoutConfirmDurationSec: DYNAMIC_BREAKOUT_CONFIRM_DURATION_DEFAULT_SEC,
        marginMode: 'isolated',
      };
    }

    const protection = protectionMap.get(buildProtectionKey({
      walletAddress: pool.owner || pool.creator,
      network: pool.network,
      version: pool.version,
      positionIdentifier: pool.identifier,
    })) || null;

    return {
      ...pool,
      protection: protection
        ? {
            id: protection.id,
            status: 'active',
            inferredAsset: protection.inferredAsset,
            hedgeSize: protection.hedgeSize,
            hedgeNotionalUsd: protection.hedgeNotionalUsd,
            configuredHedgeNotionalUsd: protection.configuredHedgeNotionalUsd,
            valueMultiplier: protection.valueMultiplier,
            stopLossDifferencePct: protection.stopLossDifferencePct,
            protectionMode: protection.protectionMode || 'static',
            reentryBufferPct: protection.reentryBufferPct ?? null,
            flipCooldownSec: protection.flipCooldownSec ?? null,
            maxSequentialFlips: protection.maxSequentialFlips ?? null,
            breakoutConfirmDistancePct: protection.breakoutConfirmDistancePct ?? null,
            breakoutConfirmDurationSec: protection.breakoutConfirmDurationSec ?? null,
            dynamicState: protection.dynamicState ?? null,
            bandMode: protection.bandMode ?? null,
            baseRebalancePriceMovePct: protection.baseRebalancePriceMovePct ?? null,
            rebalanceIntervalSec: protection.rebalanceIntervalSec ?? null,
            targetHedgeRatio: protection.targetHedgeRatio ?? null,
            minRebalanceNotionalUsd: protection.minRebalanceNotionalUsd ?? null,
            maxSlippageBps: protection.maxSlippageBps ?? null,
            twapMinNotionalUsd: protection.twapMinNotionalUsd ?? null,
            strategyState: protection.strategyState ?? null,
            initialConfiguredHedgeNotionalUsd: protection.initialConfiguredHedgeNotionalUsd ?? null,
            valueMode: protection.valueMode,
            leverage: protection.leverage,
            accountId: protection.accountId,
          }
        : null,
      protectionCandidate: candidate,
    };
  });
}

function normalizeRequestedLeverage(leverage, maxLeverage) {
  const parsed = Number(leverage);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ValidationError('leverage debe ser un entero positivo');
  }
  if (maxLeverage && parsed > maxLeverage) {
    throw new ValidationError(`leverage excede el maximo permitido para el activo (${maxLeverage}x)`);
  }
  return parsed;
}

function normalizeConfiguredNotionalUsd(configuredNotionalUsd, baseNotionalUsd) {
  const parsed = configuredNotionalUsd == null
    ? Number(baseNotionalUsd)
    : Number(configuredNotionalUsd);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ValidationError('configuredNotionalUsd debe ser un numero positivo');
  }
  return parsed;
}

function normalizeValueMultiplier(valueMultiplier) {
  if (valueMultiplier == null) return null;
  const parsed = Number(valueMultiplier);
  if (!SHORTCUT_MULTIPLIERS.includes(parsed)) {
    throw new ValidationError(`valueMultiplier invalido. Usa uno de: ${SHORTCUT_MULTIPLIERS.join(', ')}`);
  }
  return parsed;
}

function normalizeStopLossDifferencePct(stopLossDifferencePct) {
  if (stopLossDifferencePct == null) return STOP_LOSS_DIFFERENCE_DEFAULT_PCT;
  const parsed = Number(stopLossDifferencePct);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) {
    throw new ValidationError('stopLossDifferencePct debe ser un porcentaje positivo menor que 100. Ejemplo: 0.05 = 0.05%');
  }
  return parsed;
}

function normalizeProtectionMode(protectionMode) {
  if (protectionMode == null || protectionMode === '') return 'static';
  const normalized = String(protectionMode).trim().toLowerCase();
  if (!['static', 'dynamic', 'delta_neutral'].includes(normalized)) {
    throw new ValidationError('protectionMode invalido. Usa static, dynamic o delta_neutral');
  }
  return normalized;
}

function normalizeReentryBufferPct(reentryBufferPct, protectionMode) {
  if (protectionMode !== 'dynamic') return null;
  if (reentryBufferPct == null) return DYNAMIC_REENTRY_BUFFER_DEFAULT_PCT;
  const parsed = Number(reentryBufferPct);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    throw new ValidationError('reentryBufferPct debe ser un numero positivo menor que 1. Usa formato decimal, por ejemplo 0.01 = 1%');
  }
  return parsed;
}

function normalizeFlipCooldownSec(flipCooldownSec, protectionMode) {
  if (protectionMode !== 'dynamic') return null;
  if (flipCooldownSec == null) return DYNAMIC_FLIP_COOLDOWN_DEFAULT_SEC;
  const parsed = Number(flipCooldownSec);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ValidationError('flipCooldownSec debe ser un entero mayor o igual a 0');
  }
  return parsed;
}

function normalizeMaxSequentialFlips(maxSequentialFlips, protectionMode) {
  if (protectionMode !== 'dynamic') return null;
  if (maxSequentialFlips == null) return DYNAMIC_MAX_SEQUENTIAL_FLIPS_DEFAULT;
  const parsed = Number(maxSequentialFlips);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ValidationError('maxSequentialFlips debe ser un entero positivo');
  }
  return parsed;
}

function normalizeBreakoutConfirmDistancePct(breakoutConfirmDistancePct, protectionMode) {
  if (protectionMode !== 'dynamic') return null;
  if (breakoutConfirmDistancePct == null) return DYNAMIC_BREAKOUT_CONFIRM_DISTANCE_DEFAULT_PCT;
  const parsed = Number(breakoutConfirmDistancePct);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 100) {
    throw new ValidationError('breakoutConfirmDistancePct debe ser un porcentaje mayor o igual a 0 y menor que 100. Ejemplo: 0.5 = 0.5%');
  }
  return parsed;
}

function normalizeBreakoutConfirmDurationSec(breakoutConfirmDurationSec, protectionMode) {
  if (protectionMode !== 'dynamic') return null;
  if (breakoutConfirmDurationSec == null) return DYNAMIC_BREAKOUT_CONFIRM_DURATION_DEFAULT_SEC;
  const parsed = Number(breakoutConfirmDurationSec);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ValidationError('breakoutConfirmDurationSec debe ser un entero mayor o igual a 0');
  }
  return parsed;
}

function roundUsd(value) {
  return Math.round(Number(value) * 100) / 100;
}

function buildStopLossExitPrices(snapshot, stopLossDifferencePct) {
  const pctRatio = Number(stopLossDifferencePct) / 100;
  return {
    downsideExitPrice: snapshot.rangeLowerPrice * (1 + pctRatio),
    upsideExitPrice: snapshot.rangeUpperPrice * (1 - pctRatio),
  };
}

function toWireNumber(value) {
  const wire = formatPrice(Number(value));
  const parsed = Number(wire);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateDynamicSpacing({
  rangeLowerPrice,
  rangeUpperPrice,
  stopLossDifferencePct,
  reentryBufferPct,
  protectionMode,
}) {
  if (protectionMode !== 'dynamic') return;

  const pctRatio = Number(stopLossDifferencePct) / 100;
  const lowerCloseWire = toWireNumber(Number(rangeLowerPrice) * (1 + pctRatio));
  const lowerOpenWire = toWireNumber(Number(rangeLowerPrice) * (1 + Number(reentryBufferPct)));
  const upperCloseWire = toWireNumber(Number(rangeUpperPrice) * (1 - pctRatio));
  const upperOpenWire = toWireNumber(Number(rangeUpperPrice) * (1 - Number(reentryBufferPct)));

  if (!Number.isFinite(lowerCloseWire) || !Number.isFinite(lowerOpenWire) ||
      !Number.isFinite(upperCloseWire) || !Number.isFinite(upperOpenWire)) {
    throw new ValidationError('No se pudo validar la separacion segura de la proteccion dinamica');
  }

  if (!(lowerCloseWire < lowerOpenWire)) {
    throw new ValidationError(
      'Configuracion dinamica insegura: el cierre SHORT inferior queda demasiado cerca o despues de la apertura LONG rearmada.'
    );
  }
  if (!(upperCloseWire > upperOpenWire)) {
    throw new ValidationError(
      'Configuracion dinamica insegura: el cierre LONG superior queda demasiado cerca o antes de la apertura SHORT rearmada.'
    );
  }
}

function buildStoredPoolSnapshot({
  snapshot,
  candidate,
  protectionId,
  accountId,
  normalizedNotionalUsd,
  normalizedValueMultiplier,
  normalizedStopLossDifferencePct,
  protectionMode,
  reentryBufferPct,
  flipCooldownSec,
  maxSequentialFlips,
  breakoutConfirmDistancePct,
  breakoutConfirmDurationSec,
  dynamicState,
  bandMode,
  baseRebalancePriceMovePct,
  rebalanceIntervalSec,
  targetHedgeRatio,
  minRebalanceNotionalUsd,
  maxSlippageBps,
  twapMinNotionalUsd,
  strategyState,
  initialConfiguredHedgeNotionalUsd,
  normalizedLeverage,
  hedgeSize,
}) {
  return {
    ...snapshot,
    protection: {
      id: protectionId,
      status: 'active',
      inferredAsset: candidate.inferredAsset,
      hedgeSize,
      hedgeNotionalUsd: normalizedNotionalUsd,
      configuredHedgeNotionalUsd: normalizedNotionalUsd,
      valueMultiplier: normalizedValueMultiplier,
      stopLossDifferencePct: normalizedStopLossDifferencePct,
      protectionMode,
      reentryBufferPct,
      flipCooldownSec,
      maxSequentialFlips,
      breakoutConfirmDistancePct,
      breakoutConfirmDurationSec,
      dynamicState,
      bandMode,
      baseRebalancePriceMovePct,
      rebalanceIntervalSec,
      targetHedgeRatio,
      minRebalanceNotionalUsd,
      maxSlippageBps,
      twapMinNotionalUsd,
      strategyState,
      initialConfiguredHedgeNotionalUsd,
      valueMode: 'usd',
      leverage: normalizedLeverage,
      accountId,
    },
    protectionCandidate: {
      ...candidate,
      hedgeSize,
      hedgeNotionalUsd: normalizedNotionalUsd,
      stopLossDifferenceDefaultPct: normalizedStopLossDifferencePct,
      protectionMode,
      reentryBufferPct,
      flipCooldownSec,
      maxSequentialFlips,
      breakoutConfirmDistancePct,
      breakoutConfirmDurationSec,
      bandMode,
      baseRebalancePriceMovePct,
      rebalanceIntervalSec,
      targetHedgeRatio,
      minRebalanceNotionalUsd,
      maxSlippageBps,
      twapMinNotionalUsd,
      defaultLeverage: Math.min(10, candidate.maxLeverage),
    },
  };
}

async function computeInitialRangeMetrics({ existing, snapshot, asset, computedAt, deps = {} }) {
  const service = deps.timeInRangeService || timeInRangeService;

  if (existing?.status === 'inactive' && (
    Number(existing.timeTrackedMs || 0) > 0
    || existing.timeInRangePct != null
    || existing.rangeComputedAt != null
  )) {
    const timeTrackedMs = Number(existing.timeTrackedMs || 0);
    const timeInRangeMs = Number(existing.timeInRangeMs || 0);
    return {
      timeInRangeMs,
      timeTrackedMs,
      timeInRangePct: existing.timeInRangePct != null
        ? Number(existing.timeInRangePct)
        : timeTrackedMs > 0
          ? Number(((timeInRangeMs / timeTrackedMs) * 100).toFixed(4))
          : null,
      rangeLastStateInRange: snapshot.inRange === true,
      rangeLastStateAt: computedAt,
      rangeComputedAt: computedAt,
      rangeFrozenAt: null,
      rangeResolution: null,
    };
  }

  const metrics = await service.computeRangeMetricsForPool({
    ...snapshot,
    inferredAsset: asset,
  }, {
    asset,
    endAt: computedAt,
  });

  if (metrics) return metrics;

  return {
    timeInRangeMs: 0,
    timeTrackedMs: 0,
    timeInRangePct: null,
    rangeLastStateInRange: snapshot.inRange === true,
    rangeLastStateAt: computedAt,
    rangeComputedAt: computedAt,
    rangeFrozenAt: null,
    rangeResolution: null,
  };
}

function applyRangeMetricsToPoolSnapshot(snapshot, metrics, deps = {}) {
  const service = deps.timeInRangeService || timeInRangeService;
  return service.applyRangeMetricsToSnapshot(snapshot, metrics);
}

function buildInitialDynamicState(snapshot, {
  reentryBufferPct,
  breakoutConfirmDistancePct,
  breakoutConfirmDurationSec,
}) {
  return {
    phase: 'neutral',
    regime: 'neutral',
    activeSide: null,
    recoveryStatus: null,
    transition: null,
    reentryBufferPct,
    breakoutConfirmDistancePct,
    breakoutConfirmDurationSec,
    upperReentryPrice: snapshot.rangeUpperPrice * (1 - reentryBufferPct),
    lowerReentryPrice: snapshot.rangeLowerPrice * (1 + reentryBufferPct),
    upperBreakoutConfirmPrice: snapshot.rangeUpperPrice * (1 + (breakoutConfirmDistancePct / 100)),
    lowerBreakoutConfirmPrice: snapshot.rangeLowerPrice * (1 - (breakoutConfirmDistancePct / 100)),
    pendingBreakoutEdge: null,
    pendingBreakoutSince: null,
    pendingBreakoutPrice: null,
    lastEvaluatedPrice: snapshot.priceCurrent != null ? Number(snapshot.priceCurrent) : null,
    lastTransitionAt: Date.now(),
  };
}

function normalizeBandMode(bandMode) {
  if (bandMode == null || bandMode === '') return DEFAULT_BAND_MODE;
  const normalized = String(bandMode).trim().toLowerCase();
  if (!['adaptive', 'fixed'].includes(normalized)) {
    throw new ValidationError('bandMode invalido. Usa adaptive o fixed');
  }
  return normalized;
}

function normalizeBaseRebalancePriceMovePct(value) {
  if (value == null) return DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) {
    throw new ValidationError('baseRebalancePriceMovePct debe ser un porcentaje mayor que 0 y menor que 100.');
  }
  return parsed;
}

function normalizeRebalanceIntervalSec(value) {
  if (value == null) return DEFAULT_REBALANCE_INTERVAL_SEC;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 60) {
    throw new ValidationError('rebalanceIntervalSec debe ser un entero de al menos 60 segundos.');
  }
  return parsed;
}

function normalizeTargetHedgeRatio(value) {
  if (value == null) return DEFAULT_TARGET_HEDGE_RATIO;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 2) {
    throw new ValidationError('targetHedgeRatio debe ser un numero mayor que 0 y menor o igual a 2.');
  }
  return parsed;
}

function normalizeMinRebalanceNotionalUsd(value) {
  if (value == null) return DEFAULT_MIN_REBALANCE_NOTIONAL_USD;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ValidationError('minRebalanceNotionalUsd debe ser un numero positivo.');
  }
  return parsed;
}

function normalizeMaxSlippageBps(value) {
  if (value == null) return DEFAULT_MAX_SLIPPAGE_BPS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new ValidationError('maxSlippageBps debe estar entre 1 y 500 bps.');
  }
  return parsed;
}

function normalizeTwapMinNotionalUsd(value) {
  if (value == null) return DEFAULT_TWAP_MIN_NOTIONAL_USD;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ValidationError('twapMinNotionalUsd debe ser un numero positivo.');
  }
  return parsed;
}

async function createDeltaNeutralProtectedPool({
  userId,
  snapshot,
  candidate,
  accountId,
  leverage,
  configuredNotionalUsd,
  valueMultiplier,
  stopLossDifferencePct,
  bandMode,
  baseRebalancePriceMovePct,
  rebalanceIntervalSec,
  targetHedgeRatio,
  minRebalanceNotionalUsd,
  maxSlippageBps,
  twapMinNotionalUsd,
}, deps = {}) {
  if (!candidate.deltaNeutralEligible) {
    throw new ValidationError(candidate.deltaNeutralReason || 'El pool no es elegible para delta-neutral');
  }

  const normalizedNotionalUsd = normalizeConfiguredNotionalUsd(
    configuredNotionalUsd,
    candidate.baseNotionalUsd
  );
  const normalizedValueMultiplier = normalizeValueMultiplier(valueMultiplier);
  if (normalizedValueMultiplier != null) {
    const expectedNotionalUsd = roundUsd(candidate.baseNotionalUsd * normalizedValueMultiplier);
    if (Math.abs(roundUsd(normalizedNotionalUsd) - expectedNotionalUsd) > 0.01) {
      throw new ValidationError('configuredNotionalUsd no coincide con el valueMultiplier seleccionado');
    }
  }

  const normalizedLeverage = normalizeRequestedLeverage(leverage, candidate.maxLeverage);
  const normalizedBandMode = normalizeBandMode(bandMode);
  const normalizedBaseBandPct = normalizeBaseRebalancePriceMovePct(baseRebalancePriceMovePct);
  const normalizedRebalanceIntervalSec = normalizeRebalanceIntervalSec(rebalanceIntervalSec);
  const normalizedTargetHedgeRatio = normalizeTargetHedgeRatio(targetHedgeRatio);
  const normalizedMinRebalanceNotionalUsd = normalizeMinRebalanceNotionalUsd(minRebalanceNotionalUsd);
  const normalizedMaxSlippageBps = normalizeMaxSlippageBps(maxSlippageBps);
  const normalizedTwapMinNotionalUsd = normalizeTwapMinNotionalUsd(twapMinNotionalUsd);

  const deltaMetrics = computeDeltaNeutralMetrics(snapshot, {
    targetHedgeRatio: normalizedTargetHedgeRatio,
  });
  if (!deltaMetrics.eligible || !Number.isFinite(Number(deltaMetrics.targetQty))) {
    throw new ValidationError(deltaMetrics.reason || 'No se pudo calcular el hedge inicial delta-neutral');
  }

  const account = await (deps.hyperliquidAccountsService || hyperliquidAccountsService)
    .resolveAccount(userId, accountId);
  const repository = deps.protectedPoolRepository || protectedPoolRepository;
  const existing = await repository.findReusableByIdentity(userId, {
    network: snapshot.network,
    version: snapshot.version,
    walletAddress: snapshot.owner,
    positionIdentifier: snapshot.identifier,
  });
  if (existing?.status === 'active') {
    throw new ValidationError('Este pool ya tiene una proteccion activa');
  }

  const activeForUser = await repository.listActiveByUser(userId).catch(() => []);
  const assetConflict = activeForUser.find((item) => (
    Number(item.accountId) === Number(account.id)
    && String(item.inferredAsset || '').toUpperCase() === String(candidate.deltaNeutralAsset || '').toUpperCase()
    && item.status === 'active'
    && item.id !== existing?.id
  ));
  if (assetConflict) {
    throw new ValidationError(`Ya existe otra proteccion activa en ${candidate.deltaNeutralAsset} para esta cuenta.`);
  }

  const createdAt = Date.now();
  const snapshotMeta = buildSnapshotMetadata(snapshot);
  const strategyState = buildInitialStrategyState({
    currentPrice: deltaMetrics.volatilePriceUsd,
    deltaQty: deltaMetrics.deltaQty,
    gamma: deltaMetrics.gamma,
    targetQty: deltaMetrics.targetQty,
    actualQty: 0,
    effectiveBandPct: normalizedBaseBandPct,
  });
  strategyState.status = snapshotMeta.snapshotValidation.valid
    ? 'bootstrapping'
    : snapshotMeta.snapshotStatus === 'unsupported_pool_shape'
      ? 'snapshot_invalid'
      : 'snapshot_invalid';
  strategyState.lastDecision = snapshotMeta.snapshotValidation.valid ? 'bootstrap' : 'refresh_snapshot';
  strategyState.lastDecisionReason = snapshotMeta.snapshotValidation.valid
    ? 'initial_delta_neutral_bootstrap'
    : `snapshot_${snapshotMeta.snapshotValidation.reasons.join(',')}`;
  strategyState.lastExecutionOutcome = null;
  strategyState.lastExecutionAttemptAt = null;
  strategyState.nextEligibleAttemptAt = null;
  strategyState.cooldownReason = null;
  strategyState.trackingErrorQty = Number(deltaMetrics.targetQty);
  strategyState.trackingErrorUsd = Number(deltaMetrics.targetQty) * Number(snapshot.priceCurrent || deltaMetrics.volatilePriceUsd || 0);
  const baseRecord = {
    userId,
    accountId: account.id,
    network: snapshot.network,
    version: snapshot.version,
    walletAddress: snapshot.owner,
    poolAddress: snapshot.poolAddress,
    positionIdentifier: snapshot.identifier,
    token0Symbol: snapshot.token0.symbol,
    token1Symbol: snapshot.token1.symbol,
    token0Address: snapshot.token0Address,
    token1Address: snapshot.token1Address,
    rangeLowerPrice: snapshot.rangeLowerPrice,
    rangeUpperPrice: snapshot.rangeUpperPrice,
    priceCurrent: snapshot.priceCurrent,
    inferredAsset: candidate.deltaNeutralAsset,
    hedgeSize: deltaMetrics.targetQty,
    hedgeNotionalUsd: deltaMetrics.hedgeNotionalUsd,
    configuredHedgeNotionalUsd: normalizedNotionalUsd,
    initialConfiguredHedgeNotionalUsd: normalizedNotionalUsd,
    valueMultiplier: normalizedValueMultiplier,
    stopLossDifferencePct: stopLossDifferencePct ?? STOP_LOSS_DIFFERENCE_DEFAULT_PCT,
    protectionMode: 'delta_neutral',
    dynamicState: null,
    bandMode: normalizedBandMode,
    baseRebalancePriceMovePct: normalizedBaseBandPct,
    rebalanceIntervalSec: normalizedRebalanceIntervalSec,
    targetHedgeRatio: normalizedTargetHedgeRatio,
    minRebalanceNotionalUsd: normalizedMinRebalanceNotionalUsd,
    maxSlippageBps: normalizedMaxSlippageBps,
    twapMinNotionalUsd: normalizedTwapMinNotionalUsd,
    strategyEngineVersion: 'v2',
    snapshotStatus: snapshotMeta.snapshotStatus,
    snapshotFreshAt: snapshotMeta.snapshotFreshAt,
    snapshotHash: snapshotMeta.snapshotHash,
    lastDecision: strategyState.lastDecision,
    lastDecisionReason: strategyState.lastDecisionReason,
    trackingErrorQty: strategyState.trackingErrorQty,
    trackingErrorUsd: strategyState.trackingErrorUsd,
    executionMode: DEFAULT_EXECUTION_MODE,
    maxSpreadBps: DEFAULT_MAX_SPREAD_BPS,
    maxExecutionFeeUsd: DEFAULT_MAX_EXECUTION_FEE_USD,
    minOrderNotionalUsd: DEFAULT_MIN_ORDER_NOTIONAL_USD,
    twapSlices: DEFAULT_TWAP_SLICES,
    twapDurationSec: DEFAULT_TWAP_DURATION_SEC,
    strategyState,
    valueMode: 'usd',
    leverage: normalizedLeverage,
    marginMode: 'isolated',
    createdAt,
  };

  let protectionId = existing?.id || null;
  const snapshotArgs = {
    snapshot,
    candidate: {
      ...candidate,
      inferredAsset: candidate.deltaNeutralAsset,
    },
    accountId: account.id,
    normalizedNotionalUsd,
    normalizedValueMultiplier,
    normalizedStopLossDifferencePct: stopLossDifferencePct ?? STOP_LOSS_DIFFERENCE_DEFAULT_PCT,
    protectionMode: 'delta_neutral',
    reentryBufferPct: null,
    flipCooldownSec: null,
    maxSequentialFlips: null,
    breakoutConfirmDistancePct: null,
    breakoutConfirmDurationSec: null,
    dynamicState: null,
    bandMode: normalizedBandMode,
    baseRebalancePriceMovePct: normalizedBaseBandPct,
    rebalanceIntervalSec: normalizedRebalanceIntervalSec,
    targetHedgeRatio: normalizedTargetHedgeRatio,
    minRebalanceNotionalUsd: normalizedMinRebalanceNotionalUsd,
    maxSlippageBps: normalizedMaxSlippageBps,
    twapMinNotionalUsd: normalizedTwapMinNotionalUsd,
    strategyState,
    initialConfiguredHedgeNotionalUsd: normalizedNotionalUsd,
    normalizedLeverage,
    hedgeSize: deltaMetrics.targetQty,
  };
  const initialRangeMetrics = await computeInitialRangeMetrics({
    existing,
    snapshot,
    asset: candidate.deltaNeutralAsset,
    computedAt: createdAt,
    deps,
  });
  const poolSnapshot = applyRangeMetricsToPoolSnapshot(
    buildStoredPoolSnapshot({ ...snapshotArgs, protectionId }),
    initialRangeMetrics,
    deps
  );

  if (protectionId) {
    await repository.reactivate(userId, protectionId, {
      ...baseRecord,
      poolSnapshot,
      ...initialRangeMetrics,
      updatedAt: createdAt,
    });
  } else {
    protectionId = await repository.create({
      ...baseRecord,
      poolSnapshot,
      ...initialRangeMetrics,
    });
    await repository.updateSnapshot(userId, protectionId, {
      poolAddress: snapshot.poolAddress,
      token0Symbol: snapshot.token0.symbol,
      token1Symbol: snapshot.token1.symbol,
      token0Address: snapshot.token0Address,
      token1Address: snapshot.token1Address,
      rangeLowerPrice: snapshot.rangeLowerPrice,
      rangeUpperPrice: snapshot.rangeUpperPrice,
      priceCurrent: snapshot.priceCurrent,
      poolSnapshot: applyRangeMetricsToPoolSnapshot(
        buildStoredPoolSnapshot({ ...snapshotArgs, protectionId }),
        initialRangeMetrics,
        deps
      ),
      snapshotStatus: snapshotMeta.snapshotStatus,
      snapshotFreshAt: snapshotMeta.snapshotFreshAt,
      snapshotHash: snapshotMeta.snapshotHash,
      ...initialRangeMetrics,
      updatedAt: createdAt,
    });
  }

  const created = await repository.getById(userId, protectionId);
  if (snapshotMeta.snapshotValidation.valid) {
    await (deps.protectedPoolDeltaNeutralService || protectedPoolDeltaNeutralService)
      .bootstrapProtection(created);
  }
  return repository.getById(userId, protectionId);
}

async function createProtectedPool({
  userId,
  pool,
  accountId,
  leverage,
  configuredNotionalUsd,
  valueMultiplier,
  stopLossDifferencePct,
  protectionMode,
  reentryBufferPct,
  flipCooldownSec,
  maxSequentialFlips,
  breakoutConfirmDistancePct,
  breakoutConfirmDurationSec,
  bandMode,
  baseRebalancePriceMovePct,
  rebalanceIntervalSec,
  targetHedgeRatio,
  minRebalanceNotionalUsd,
  maxSlippageBps,
  twapMinNotionalUsd,
}, deps = {}) {
  const snapshot = normalizePoolSnapshot(pool);
  const candidate = await buildProtectionCandidate(snapshot, deps);

  if (!candidate.eligible || !candidate.inferredAsset || !candidate.maxLeverage) {
    throw new ValidationError(candidate.reason || 'El pool no es elegible para proteccion automatica');
  }

  const normalizedNotionalUsd = normalizeConfiguredNotionalUsd(
    configuredNotionalUsd,
    candidate.baseNotionalUsd
  );
  const normalizedValueMultiplier = normalizeValueMultiplier(valueMultiplier);
  if (normalizedValueMultiplier != null) {
    const expectedNotionalUsd = roundUsd(candidate.baseNotionalUsd * normalizedValueMultiplier);
    if (Math.abs(roundUsd(normalizedNotionalUsd) - expectedNotionalUsd) > 0.01) {
      throw new ValidationError('configuredNotionalUsd no coincide con el valueMultiplier seleccionado');
    }
  }
  const normalizedStopLossDifferencePct = normalizeStopLossDifferencePct(stopLossDifferencePct);
  const normalizedProtectionMode = normalizeProtectionMode(protectionMode);
  if (normalizedProtectionMode === 'delta_neutral') {
    return createDeltaNeutralProtectedPool({
      userId,
      snapshot,
      candidate,
      accountId,
      leverage,
      configuredNotionalUsd,
      valueMultiplier,
      stopLossDifferencePct: normalizedStopLossDifferencePct,
      bandMode,
      baseRebalancePriceMovePct,
      rebalanceIntervalSec,
      targetHedgeRatio,
      minRebalanceNotionalUsd,
      maxSlippageBps,
      twapMinNotionalUsd,
    }, deps);
  }
  const normalizedReentryBufferPct = normalizeReentryBufferPct(reentryBufferPct, normalizedProtectionMode);
  const normalizedFlipCooldownSec = normalizeFlipCooldownSec(flipCooldownSec, normalizedProtectionMode);
  const normalizedMaxSequentialFlips = normalizeMaxSequentialFlips(maxSequentialFlips, normalizedProtectionMode);
  const normalizedBreakoutConfirmDistancePct = normalizeBreakoutConfirmDistancePct(
    breakoutConfirmDistancePct,
    normalizedProtectionMode
  );
  const normalizedBreakoutConfirmDurationSec = normalizeBreakoutConfirmDurationSec(
    breakoutConfirmDurationSec,
    normalizedProtectionMode
  );
  validateDynamicSpacing({
    rangeLowerPrice: snapshot.rangeLowerPrice,
    rangeUpperPrice: snapshot.rangeUpperPrice,
    stopLossDifferencePct: normalizedStopLossDifferencePct,
    reentryBufferPct: normalizedReentryBufferPct,
    protectionMode: normalizedProtectionMode,
  });
  const { downsideExitPrice, upsideExitPrice } = buildStopLossExitPrices(
    snapshot,
    normalizedStopLossDifferencePct
  );
  const hedgeSize = normalizedNotionalUsd / candidate.midPrice;

  if (!Number.isFinite(hedgeSize) || hedgeSize <= 0) {
    throw new ValidationError('No se pudo calcular el tamano de cobertura para el valor configurado');
  }

  const normalizedLeverage = normalizeRequestedLeverage(leverage, candidate.maxLeverage);
  const account = await (deps.hyperliquidAccountsService || hyperliquidAccountsService)
    .resolveAccount(userId, accountId);
  const repository = deps.protectedPoolRepository || protectedPoolRepository;
  const linkedHedgeRepository = deps.hedgeRepository || hedgeRepository;
  const existing = await repository.findReusableByIdentity(
    userId,
    {
      network: snapshot.network,
      version: snapshot.version,
      walletAddress: snapshot.owner,
      positionIdentifier: snapshot.identifier,
    }
  );
  if (existing?.status === 'active') {
    throw new ValidationError('Este pool ya tiene una proteccion activa');
  }

  const hedgeSvc = await (deps.hedgeRegistry || hedgeRegistry).getOrCreate(userId, account.id);
  hedgeSvc.validateCreateRequest({
    asset: candidate.inferredAsset,
    direction: 'short',
    entryPrice: snapshot.rangeLowerPrice,
    exitPrice: downsideExitPrice,
    size: hedgeSize,
    leverage: normalizedLeverage,
  });
  hedgeSvc.validateCreateRequest({
    asset: candidate.inferredAsset,
    direction: 'long',
    entryPrice: snapshot.rangeUpperPrice,
    exitPrice: upsideExitPrice,
    size: hedgeSize,
    leverage: normalizedLeverage,
  });

  const createdAt = Date.now();
  const dynamicState = normalizedProtectionMode === 'dynamic'
    ? buildInitialDynamicState(snapshot, {
        reentryBufferPct: normalizedReentryBufferPct,
        breakoutConfirmDistancePct: normalizedBreakoutConfirmDistancePct,
        breakoutConfirmDurationSec: normalizedBreakoutConfirmDurationSec,
      })
    : null;
  const executor = deps.db || db;
  const baseRecord = {
    userId,
    accountId: account.id,
    network: snapshot.network,
    version: snapshot.version,
    walletAddress: snapshot.owner,
    poolAddress: snapshot.poolAddress,
    positionIdentifier: snapshot.identifier,
    token0Symbol: snapshot.token0.symbol,
    token1Symbol: snapshot.token1.symbol,
    token0Address: snapshot.token0Address,
    token1Address: snapshot.token1Address,
    rangeLowerPrice: snapshot.rangeLowerPrice,
    rangeUpperPrice: snapshot.rangeUpperPrice,
    priceCurrent: snapshot.priceCurrent,
    inferredAsset: candidate.inferredAsset,
    hedgeSize,
    hedgeNotionalUsd: normalizedNotionalUsd,
    configuredHedgeNotionalUsd: normalizedNotionalUsd,
    valueMultiplier: normalizedValueMultiplier,
    stopLossDifferencePct: normalizedStopLossDifferencePct,
    protectionMode: normalizedProtectionMode,
    reentryBufferPct: normalizedReentryBufferPct,
    flipCooldownSec: normalizedFlipCooldownSec,
    maxSequentialFlips: normalizedMaxSequentialFlips,
    breakoutConfirmDistancePct: normalizedBreakoutConfirmDistancePct,
    breakoutConfirmDurationSec: normalizedBreakoutConfirmDurationSec,
    dynamicState,
    valueMode: 'usd',
    leverage: normalizedLeverage,
    marginMode: 'isolated',
    strategyEngineVersion: normalizedProtectionMode === 'delta_neutral' ? 'v2' : 'v1',
    snapshotStatus: 'ready',
    snapshotFreshAt: Date.now(),
    snapshotHash: computeSnapshotHash(normalizeProtectionSnapshot(snapshot, {
      network: snapshot.network,
      version: snapshot.version,
      positionIdentifier: snapshot.identifier,
      poolAddress: snapshot.poolAddress,
      poolId: snapshot.poolId,
      owner: snapshot.owner,
    })),
    createdAt,
  };
  const initialRangeMetrics = await computeInitialRangeMetrics({
    existing,
    snapshot,
    asset: candidate.inferredAsset,
    computedAt: createdAt,
    deps,
  });

  let protectionId = existing?.id || null;
  const baseStoredSnapshot = buildStoredPoolSnapshot({
    snapshot,
    candidate,
    protectionId,
    accountId: account.id,
    normalizedNotionalUsd,
    normalizedValueMultiplier,
    normalizedStopLossDifferencePct,
    protectionMode: normalizedProtectionMode,
    reentryBufferPct: normalizedReentryBufferPct,
    flipCooldownSec: normalizedFlipCooldownSec,
    maxSequentialFlips: normalizedMaxSequentialFlips,
    breakoutConfirmDistancePct: normalizedBreakoutConfirmDistancePct,
    breakoutConfirmDurationSec: normalizedBreakoutConfirmDurationSec,
    dynamicState,
    normalizedLeverage,
    hedgeSize,
  });
  const poolSnapshot = applyRangeMetricsToPoolSnapshot(baseStoredSnapshot, initialRangeMetrics, deps);

  if (protectionId) {
    await repository.reactivate(userId, protectionId, {
      ...baseRecord,
      poolSnapshot,
      ...initialRangeMetrics,
      updatedAt: createdAt,
    }, executor);
  } else {
    protectionId = await repository.create({
      ...baseRecord,
      poolSnapshot,
      ...initialRangeMetrics,
    }, executor);
    await repository.updateSnapshot(userId, protectionId, {
      poolAddress: snapshot.poolAddress,
      token0Symbol: snapshot.token0.symbol,
      token1Symbol: snapshot.token1.symbol,
      token0Address: snapshot.token0Address,
      token1Address: snapshot.token1Address,
      rangeLowerPrice: snapshot.rangeLowerPrice,
      rangeUpperPrice: snapshot.rangeUpperPrice,
      priceCurrent: snapshot.priceCurrent,
      poolSnapshot: applyRangeMetricsToPoolSnapshot(
        buildStoredPoolSnapshot({
          snapshot,
          candidate,
          protectionId,
          accountId: account.id,
          normalizedNotionalUsd,
          normalizedValueMultiplier,
          normalizedStopLossDifferencePct,
          protectionMode: normalizedProtectionMode,
          reentryBufferPct: normalizedReentryBufferPct,
          flipCooldownSec: normalizedFlipCooldownSec,
          maxSequentialFlips: normalizedMaxSequentialFlips,
          breakoutConfirmDistancePct: normalizedBreakoutConfirmDistancePct,
          breakoutConfirmDurationSec: normalizedBreakoutConfirmDurationSec,
          dynamicState,
          normalizedLeverage,
          hedgeSize,
        }),
        initialRangeMetrics,
        deps
      ),
      ...initialRangeMetrics,
      updatedAt: createdAt,
    }, executor);
  }

  let downside = null;

  try {
    const baseLabel = `${snapshot.token0.symbol}/${snapshot.token1.symbol} ${snapshot.version.toUpperCase()} #${snapshot.identifier}`;
    downside = await hedgeSvc.createHedge({
      asset: candidate.inferredAsset,
      direction: 'short',
      entryPrice: snapshot.rangeLowerPrice,
      exitPrice: downsideExitPrice,
      size: hedgeSize,
      leverage: normalizedLeverage,
      label: `${baseLabel} · Proteccion baja`,
      marginMode: 'isolated',
      protectedPoolId: protectionId,
      protectedRole: 'downside',
    });
    await hedgeSvc.createHedge({
      asset: candidate.inferredAsset,
      direction: 'long',
      entryPrice: snapshot.rangeUpperPrice,
      exitPrice: upsideExitPrice,
      size: hedgeSize,
      leverage: normalizedLeverage,
      label: `${baseLabel} · Proteccion alza`,
      marginMode: 'isolated',
      protectedPoolId: protectionId,
      protectedRole: 'upside',
    });
  } catch (err) {
    if (downside?.id && ACTIVE_HEDGE_STATUSES.has(downside.status)) {
      await hedgeSvc.cancelHedge(downside.id).catch((e) => {
        logger.error('create_protected_pool_rollback_cancel_failed', { hedgeId: downside.id, error: e.message });
      });
    }
    await repository
      .deactivate(userId, protectionId, { deactivatedAt: Date.now() }, executor)
      .catch((e) => {
        logger.error('create_protected_pool_rollback_deactivate_failed', { protectionId, error: e.message });
      });
    await linkedHedgeRepository
      .unlinkByProtectedPoolId(protectionId)
      .catch((e) => {
        logger.error('create_protected_pool_rollback_unlink_failed', { protectionId, error: e.message });
      });
    throw err;
  }

  return repository.getById(userId, protectionId, executor);
}

async function listProtectedPools(userId, deps = {}) {
  return (deps.protectedPoolRepository || protectedPoolRepository).listByUser(userId);
}

async function deactivateProtectedPool(userId, protectionId, deps = {}) {
  const repository = deps.protectedPoolRepository || protectedPoolRepository;
  const linkedHedgeRepository = deps.hedgeRepository || hedgeRepository;
  const protection = await repository.getById(userId, protectionId);
  if (!protection) {
    throw new NotFoundError('Pool protegido no encontrado');
  }
  if (protection.status !== 'active') {
    return protection;
  }

  if (protection.protectionMode === 'delta_neutral') {
    return (deps.protectedPoolDeltaNeutralService || protectedPoolDeltaNeutralService)
      .requestDeactivate(protection);
  }

  const hedgeSvc = await (deps.hedgeRegistry || hedgeRegistry).getOrCreate(userId, protection.accountId);
  const linkedHedges = [protection.hedges.downside, protection.hedges.upside].filter(Boolean);

  for (const hedge of linkedHedges) {
    if (!ACTIVE_HEDGE_STATUSES.has(hedge.status)) continue;
    await hedgeSvc.cancelHedge(hedge.id);
  }

  const deactivatedAt = Date.now();
  const finalRangeMetrics = await (deps.timeInRangeService || timeInRangeService)
    .computeIncrementalRangeMetrics(protection, {
      endAt: deactivatedAt,
      rangeFrozenAt: deactivatedAt,
    });

  await repository.deactivate(userId, protectionId, {
    deactivatedAt,
    ...(finalRangeMetrics ? {
      ...finalRangeMetrics,
      poolSnapshot: applyRangeMetricsToPoolSnapshot(protection.poolSnapshot || {}, finalRangeMetrics, deps),
    } : {}),
  });
  await linkedHedgeRepository.unlinkByProtectedPoolId(protectionId);
  return repository.getById(userId, protectionId);
}

async function diagnoseDeltaNeutral(userId, protectionId, deps = {}) {
  const repo = deps.protectedPoolRepository || protectedPoolRepository;
  const decisionLogRepository = deps.protectionDecisionLogRepository || require('../repositories/protection-decision-log.repository');
  const deltaLogRepository = deps.deltaRebalanceLogRepository || require('../repositories/protected-pool-delta-rebalance.repository');
  const protection = await repo.getById(userId, protectionId);

  if (!protection) {
    throw new NotFoundError('Proteccion no encontrada');
  }
  if (protection.protectionMode !== 'delta_neutral') {
    throw new ValidationError('Esta proteccion no es delta-neutral');
  }

  const diagnostics = {
    id: protection.id,
    protectionMode: protection.protectionMode,
    status: protection.status,
    createdAt: protection.createdAt,
    strategyState: protection.strategyState || {},
    snapshot: {
      status: protection.snapshotStatus || 'unknown',
      freshAt: protection.snapshotFreshAt,
      hash: protection.snapshotHash,
      engineVersion: protection.strategyEngineVersion || 'v1',
    },
    hedge: {
      size: protection.hedgeSize || 0,
      notionalUsd: protection.hedgeNotionalUsd || 0,
      leverage: protection.leverage,
      marginMode: protection.marginMode,
    },
    pool: {
      asset: protection.inferredAsset,
      network: protection.network,
      version: protection.version,
      token0: protection.token0Symbol,
      token1: protection.token1Symbol,
      rangeLowerPrice: protection.rangeLowerPrice,
      rangeUpperPrice: protection.rangeUpperPrice,
      priceCurrent: protection.priceCurrent,
    },
    configuration: {
      bandMode: protection.bandMode,
      baseRebalancePriceMovePct: protection.baseRebalancePriceMovePct,
      rebalanceIntervalSec: protection.rebalanceIntervalSec,
      targetHedgeRatio: protection.targetHedgeRatio,
      minRebalanceNotionalUsd: protection.minRebalanceNotionalUsd,
      maxSlippageBps: protection.maxSlippageBps,
      twapMinNotionalUsd: protection.twapMinNotionalUsd,
      configuredNotionalUsd: protection.configuredHedgeNotionalUsd,
      executionMode: protection.executionMode || DEFAULT_EXECUTION_MODE,
      maxSpreadBps: protection.maxSpreadBps ?? DEFAULT_MAX_SPREAD_BPS,
      maxExecutionFeeUsd: protection.maxExecutionFeeUsd ?? DEFAULT_MAX_EXECUTION_FEE_USD,
      minOrderNotionalUsd: protection.minOrderNotionalUsd ?? DEFAULT_MIN_ORDER_NOTIONAL_USD,
      twapSlices: protection.twapSlices ?? DEFAULT_TWAP_SLICES,
      twapDurationSec: protection.twapDurationSec ?? DEFAULT_TWAP_DURATION_SEC,
    },
    checks: {},
    warnings: [],
  };

  // Check: Pool snapshot validity
  const normalizedSnapshot = normalizeProtectionSnapshot(protection.poolSnapshot || {}, {
    network: protection.network,
    version: protection.version,
    positionIdentifier: protection.positionIdentifier,
    poolAddress: protection.poolAddress,
    poolId: protection.poolSnapshot?.poolId,
    owner: protection.walletAddress,
    snapshotFreshAt: protection.snapshotFreshAt || protection.updatedAt,
  });
  const snapshotValidation = validateNormalizedProtectionSnapshot(normalizedSnapshot);
  diagnostics.checks.poolSnapshot = {
    exists: !!protection.poolSnapshot,
    hasPriceCurrent: !!protection.poolSnapshot?.priceCurrent,
    liquidity: protection.poolSnapshot?.liquidity,
    status: protection.snapshotStatus || snapshotValidation.status,
    valid: snapshotValidation.valid,
    reasons: snapshotValidation.reasons,
    freshAt: protection.snapshotFreshAt,
  };

  // Check: Strategy state
  const strategyState = protection.strategyState || {};
  diagnostics.checks.strategyState = {
    status: strategyState.status || 'unknown',
    lastRebalanceAt: strategyState.lastRebalanceAt,
    lastTargetQty: strategyState.lastTargetQty,
    lastActualQty: strategyState.lastActualQty,
    lastError: strategyState.lastError,
    distanceToLiqPct: strategyState.distanceToLiqPct,
    marginModeVerified: strategyState.marginModeVerified,
    lastDecision: protection.lastDecision || strategyState.lastDecision || null,
    lastDecisionReason: protection.lastDecisionReason || strategyState.lastDecisionReason || null,
    nextEligibleAttemptAt: protection.nextEligibleAttemptAt || strategyState.nextEligibleAttemptAt || null,
    cooldownReason: protection.cooldownReason || strategyState.cooldownReason || null,
    lastSpotFailureAt: strategyState.lastSpotFailureAt || null,
    lastSpotFailureReason: strategyState.lastSpotFailureReason || null,
  };

  // Check: Metrics computation
  if (protection.poolSnapshot) {
    try {
      const metrics = computeDeltaNeutralMetrics(protection.poolSnapshot, {
        targetHedgeRatio: protection.targetHedgeRatio || DEFAULT_TARGET_HEDGE_RATIO,
      });
      diagnostics.checks.metrics = {
        eligible: metrics.eligible,
        reason: metrics.reason,
        targetQty: metrics.targetQty,
        deltaQty: metrics.deltaQty,
        gamma: metrics.gamma,
        volatilePriceUsd: metrics.volatilePriceUsd,
        poolValueUsd: metrics.poolValueUsd,
      };
    } catch (err) {
      diagnostics.checks.metrics = {
        eligible: false,
        error: err.message,
      };
    }
  }

  diagnostics.recentRebalances = await deltaLogRepository
    .listByProtectedPoolId(protection.id, { limit: 5 })
    .catch(() => []);
  diagnostics.recentDecisions = await decisionLogRepository
    .listByProtectedPoolId(protection.id, { limit: 10 })
    .catch(() => []);

  const latestDecision = diagnostics.recentDecisions[0] || null;
  const snapshotFreshAt = Number(protection.snapshotFreshAt || 0) || null;
  diagnostics.spot = {
    source: latestDecision?.spotSource
      || (strategyState.lastSpotFailureReason ? 'unavailable' : 'chain'),
    snapshotFreshnessMs: snapshotFreshAt ? Math.max(Date.now() - snapshotFreshAt, 0) : null,
    lastSpotFailureAt: strategyState.lastSpotFailureAt || null,
    lastSpotFailureReason: strategyState.lastSpotFailureReason || null,
  };
  diagnostics.checks.riskGate = {
    triggered: latestDecision?.riskGateTriggered === true
      || ['risk_paused', 'margin_pending'].includes(strategyState.status || ''),
    finalStrategyStatus: latestDecision?.finalStrategyStatus || strategyState.status || null,
    liquidationDistancePct: latestDecision?.liquidationDistancePct ?? strategyState.distanceToLiqPct ?? null,
  };

  // Check: Hyperliquid account and position
  const tradingFactory = deps.getTradingService || getTradingService;
  try {
    const hl = await (deps.hyperliquidRegistry || require('./hyperliquid.registry'))
      .getOrCreate(userId, protection.accountId);
    const trading = await tradingFactory(userId, protection.accountId);
    const [accountStateResult, openOrdersResult, positionResult] = await Promise.allSettled([
      trading.getAccountState({ force: true }),
      trading.getOpenOrders({ force: true }),
      hl.getPosition(protection.inferredAsset),
    ]);

    const hyperliquidWarnings = [];
    const accountState = accountStateResult.status === 'fulfilled' ? accountStateResult.value : null;
    const openOrdersState = openOrdersResult.status === 'fulfilled' ? openOrdersResult.value : null;
    let position = null;

    if (accountState?.positions?.length) {
      position = accountState.positions.find((item) => (
        String(item.asset || '').toUpperCase() === String(protection.inferredAsset || '').toUpperCase()
      )) || null;
    }
    if (!position && positionResult.status === 'fulfilled') {
      position = positionResult.value || null;
    }

    if (accountStateResult.status === 'rejected') {
      hyperliquidWarnings.push(`account_state_unavailable: ${accountStateResult.reason?.message || accountStateResult.reason}`);
    }
    if (openOrdersResult.status === 'rejected') {
      hyperliquidWarnings.push(`open_orders_unavailable: ${openOrdersResult.reason?.message || openOrdersResult.reason}`);
    }
    if (positionResult.status === 'rejected') {
      hyperliquidWarnings.push(`position_unavailable: ${positionResult.reason?.message || positionResult.reason}`);
    }

    diagnostics.warnings.push(...hyperliquidWarnings);
    diagnostics.checks.hyperliquid = {
      account: accountState ? {
        alias: accountState.account?.alias || null,
        accountValue: accountState.accountValue,
        totalMarginUsed: accountState.totalMarginUsed,
        totalNotionalUsd: accountState.totalNtlPos,
        marginAvailable: accountState.withdrawable,
        lastUpdatedAt: accountState.lastUpdatedAt,
      } : null,
      openOrders: openOrdersState ? {
        count: Array.isArray(openOrdersState.orders) ? openOrdersState.orders.length : 0,
        orders: Array.isArray(openOrdersState.orders) ? openOrdersState.orders : [],
        lastUpdatedAt: openOrdersState.lastUpdatedAt,
      } : null,
      position: position ? {
        asset: position.asset || protection.inferredAsset,
        szi: position.szi ?? position.size ?? null,
        side: position.side || (Number(position.szi ?? position.size ?? 0) < 0 ? 'short' : 'long'),
        leverage: position.leverage,
        marginMode: position.marginMode || position.leverage?.type || null,
        liquidationPx: position.liquidationPx ?? position.liquidationPrice ?? null,
        unrealizedPnl: position.unrealizedPnl ?? null,
        marginUsed: position.marginUsed ?? null,
      } : null,
      warnings: hyperliquidWarnings,
    };
  } catch (err) {
    const warning = `hyperliquid_diagnostics_unavailable: ${err.message}`;
    diagnostics.warnings.push(warning);
    diagnostics.checks.hyperliquid = {
      account: null,
      openOrders: null,
      position: null,
      warnings: [warning],
    };
  }

  return diagnostics;
}

module.exports = {
  ACTIVE_HEDGE_STATUSES,
  SHORTCUT_MULTIPLIERS,
  STOP_LOSS_DIFFERENCE_DEFAULT_PCT,
  DYNAMIC_REENTRY_BUFFER_DEFAULT_PCT,
  DYNAMIC_FLIP_COOLDOWN_DEFAULT_SEC,
  DYNAMIC_MAX_SEQUENTIAL_FLIPS_DEFAULT,
  DEFAULT_BAND_MODE,
  DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT,
  DEFAULT_REBALANCE_INTERVAL_SEC,
  DEFAULT_TARGET_HEDGE_RATIO,
  DEFAULT_MIN_REBALANCE_NOTIONAL_USD,
  DEFAULT_MAX_SLIPPAGE_BPS,
  DEFAULT_TWAP_MIN_NOTIONAL_USD,
  DEFAULT_EXECUTION_MODE,
  annotatePoolsWithProtection,
  buildProtectionCandidate,
  buildProtectionKey,
  buildDeltaNeutralCandidate,
  createProtectedPool,
  deactivateProtectedPool,
  listProtectedPools,
  diagnoseDeltaNeutral,
};
