const { ethers } = require('ethers');
const db = require('../db');
const hedgeRegistry = require('./hedge.registry');
const marketService = require('./market.service');
const hyperliquidAccountsService = require('./hyperliquid-accounts.service');
const hedgeRepository = require('../repositories/hedge.repository');
const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');
const logger = require('./logger.service');
const { ValidationError, NotFoundError } = require('../errors/app-error');
const SHORTCUT_MULTIPLIERS = [1.25, 1.5, 2, 3, 4];
const STOP_LOSS_DIFFERENCE_DEFAULT_PCT = 0.05;
const DYNAMIC_REENTRY_BUFFER_DEFAULT_PCT = 0.01;
const DYNAMIC_FLIP_COOLDOWN_DEFAULT_SEC = 15;
const DYNAMIC_MAX_SEQUENTIAL_FLIPS_DEFAULT = 6;
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
    priceCurrent: pool.priceCurrent != null ? Number(pool.priceCurrent) : null,
    currentValueUsd,
    inRange: pool.inRange === true,
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
  const baseCandidate = {
    baseNotionalUsd,
    suggestedNotionalUsd: baseNotionalUsd,
    shortcutMultipliers: SHORTCUT_MULTIPLIERS,
    hedgeNotionalUsd: baseNotionalUsd,
    stopLossDifferenceDefaultPct: STOP_LOSS_DIFFERENCE_DEFAULT_PCT,
    valueMode: 'usd',
    marginMode: 'isolated',
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
            dynamicState: protection.dynamicState ?? null,
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
  if (!['static', 'dynamic'].includes(normalized)) {
    throw new ValidationError('protectionMode invalido. Usa static o dynamic');
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
  dynamicState,
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
      dynamicState,
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
      defaultLeverage: Math.min(10, candidate.maxLeverage),
    },
  };
}

function buildInitialDynamicState(snapshot, {
  reentryBufferPct,
  flipCooldownSec,
  maxSequentialFlips,
}) {
  return {
    phase: 'inside_range',
    activeSide: null,
    armedReentrySide: null,
    lastBrokenEdge: null,
    currentReentryPrice: null,
    lastFlipAt: null,
    sequentialFlipCount: 0,
    recoveryStatus: null,
    transition: null,
    reentryBufferPct,
    flipCooldownSec,
    maxSequentialFlips,
    upperReentryPrice: snapshot.rangeUpperPrice * (1 - reentryBufferPct),
    lowerReentryPrice: snapshot.rangeLowerPrice * (1 + reentryBufferPct),
    lastEvaluatedPrice: snapshot.priceCurrent != null ? Number(snapshot.priceCurrent) : null,
    lastTransitionAt: Date.now(),
  };
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
  const normalizedReentryBufferPct = normalizeReentryBufferPct(reentryBufferPct, normalizedProtectionMode);
  const normalizedFlipCooldownSec = normalizeFlipCooldownSec(flipCooldownSec, normalizedProtectionMode);
  const normalizedMaxSequentialFlips = normalizeMaxSequentialFlips(maxSequentialFlips, normalizedProtectionMode);
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
        flipCooldownSec: normalizedFlipCooldownSec,
        maxSequentialFlips: normalizedMaxSequentialFlips,
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
    dynamicState,
    valueMode: 'usd',
    leverage: normalizedLeverage,
    marginMode: 'isolated',
    createdAt,
  };

  let protectionId = existing?.id || null;
  const poolSnapshot = buildStoredPoolSnapshot({
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
    dynamicState,
    normalizedLeverage,
    hedgeSize,
  });

  if (protectionId) {
    await repository.reactivate(userId, protectionId, {
      ...baseRecord,
      poolSnapshot,
      updatedAt: createdAt,
    }, executor);
  } else {
    protectionId = await repository.create({
      ...baseRecord,
      poolSnapshot,
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
      poolSnapshot: buildStoredPoolSnapshot({
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
        dynamicState,
        normalizedLeverage,
        hedgeSize,
      }),
      updatedAt: createdAt,
    }, executor);
  }

  let downside = null;
  let upside = null;

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
    upside = await hedgeSvc.createHedge({
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

  const hedgeSvc = await (deps.hedgeRegistry || hedgeRegistry).getOrCreate(userId, protection.accountId);
  const linkedHedges = [protection.hedges.downside, protection.hedges.upside].filter(Boolean);

  for (const hedge of linkedHedges) {
    if (!ACTIVE_HEDGE_STATUSES.has(hedge.status)) continue;
    await hedgeSvc.cancelHedge(hedge.id);
  }

  await repository.deactivate(userId, protectionId, { deactivatedAt: Date.now() });
  await linkedHedgeRepository.unlinkByProtectedPoolId(protectionId);
  return repository.getById(userId, protectionId);
}

module.exports = {
  ACTIVE_HEDGE_STATUSES,
  SHORTCUT_MULTIPLIERS,
  STOP_LOSS_DIFFERENCE_DEFAULT_PCT,
  DYNAMIC_REENTRY_BUFFER_DEFAULT_PCT,
  DYNAMIC_FLIP_COOLDOWN_DEFAULT_SEC,
  DYNAMIC_MAX_SEQUENTIAL_FLIPS_DEFAULT,
  annotatePoolsWithProtection,
  buildProtectionCandidate,
  buildProtectionKey,
  createProtectedPool,
  deactivateProtectedPool,
  listProtectedPools,
};
