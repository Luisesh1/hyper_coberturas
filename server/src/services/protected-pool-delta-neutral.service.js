const config = require('../config');
const logger = require('./logger.service');
const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');
const deltaRebalanceLogRepository = require('../repositories/protected-pool-delta-rebalance.repository');
const uniswapService = require('./uniswap.service');
const hlRegistry = require('./hyperliquid.registry');
const { getTradingService } = require('./trading.factory');
const {
  asFiniteNumber,
  buildBandPreset,
  computeDeltaNeutralMetrics,
  networkSentinelIntervalMs,
} = require('./delta-neutral-math.service');

const DEFAULT_BAND_MODE = 'adaptive';
const DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT = 3;
const DEFAULT_REBALANCE_INTERVAL_SEC = 6 * 60 * 60;
const DEFAULT_TARGET_HEDGE_RATIO = 1;
const DEFAULT_MIN_REBALANCE_NOTIONAL_USD = 50;
const DEFAULT_MAX_SLIPPAGE_BPS = 20;
const DEFAULT_TWAP_MIN_NOTIONAL_USD = 10_000;
const DEFAULT_TWAP_SLICES = 5;
const DEFAULT_TWAP_DURATION_SEC = 60;
const DEFAULT_EMERGENCY_IOC_NOTIONAL_USD = 250;
const DEFAULT_GAMMA_TIGHTEN_THRESHOLD = 0.2;
const DEFAULT_MAX_AUTO_TOPUPS_PER_24H = 3;
const DELTA_NEUTRAL_STATUSES = new Set([
  'healthy',
  'boundary_watch',
  'partial_hedge_warning',
  'degraded_partial',
  'risk_paused',
  'reconciling',
  'deactivating',
  'deactivation_pending',
]);
const ESTIMATED_TAKER_FEE_RATE = 0.0005;

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
    status: 'reconciling',
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
  };
}

function normalizeStrategyState(state = {}) {
  const topUpWindowStartedAt = Number(state.topUpWindowStartedAt || Date.now());
  return {
    ...buildInitialStrategyState(),
    ...state,
    status: normalizeStatus(state.status),
    topUpCount24h: clampNonNegative(state.topUpCount24h),
    topUpUsd24h: clampNonNegative(state.topUpUsd24h),
    topUpWindowStartedAt,
    marginModeVerified: state.marginModeVerified !== false,
  };
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

class ProtectedPoolDeltaNeutralService {
  constructor(deps = {}) {
    this.repo = deps.protectedPoolRepository || protectedPoolRepository;
    this.deltaLogRepo = deps.deltaRebalanceLogRepository || deltaRebalanceLogRepository;
    this.uniswapService = deps.uniswapService || uniswapService;
    this.hlRegistry = deps.hlRegistry || hlRegistry;
    this.getTradingService = deps.getTradingService || getTradingService;
    this.logger = deps.logger || logger;
    this.loopMs = deps.loopMs || config.intervals.deltaNeutralLoopMs || 2_000;
    this.fullEvalMs = deps.fullEvalMs || config.intervals.deltaNeutralEvalMs || 30_000;
    this.interval = null;
    this.running = false;
    this.lastSentinelAt = new Map();
    this.lastEvalAt = new Map();
    this.twapSessions = new Map();
    this.rvCache = new Map();
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.evaluateAll().catch((err) => {
        this.logger.error('protected_pool_delta_neutral_unhandled_error', { error: err.message });
      });
    }, this.loopMs);
    this.interval.unref?.();
  }

  stop() {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  async evaluateAll() {
    if (this.running) return;
    this.running = true;
    try {
      const protections = await this.repo.listActiveDeltaNeutral();
      for (const protection of protections) {
        await this._tickProtection(protection).catch((err) => {
          this.logger.warn('protected_pool_delta_neutral_tick_failed', {
            protectionId: protection.id,
            userId: protection.userId,
            error: err.message,
          });
        });
      }
    } finally {
      this.running = false;
    }
  }

  async bootstrapProtection(protection) {
    const current = protection?.poolSnapshot
      ? protection
      : await this.repo.getById(protection.userId, protection.id);
    if (!current || current.protectionMode !== 'delta_neutral') return current;
    await this.evaluateProtection(current, { forceReason: 'restart_reconcile', forceRebalance: true });
    return this.repo.getById(current.userId, current.id);
  }

  async requestDeactivate(protection) {
    const strategyState = normalizeStrategyState(protection.strategyState);
    strategyState.status = 'deactivating';
    strategyState.deactivationRequestedAt = Date.now();
    const session = this.twapSessions.get(protection.id);
    if (session) session.cancelRequested = true;
    await this.repo.updateStrategyState(protection.userId, protection.id, { strategyState });
    return this._continueDeactivation({
      ...protection,
      strategyState,
    });
  }

  async _tickProtection(protection) {
    const now = Date.now();
    const cadence = networkSentinelIntervalMs(protection.network);
    let spot = null;
    if ((now - (this.lastSentinelAt.get(protection.id) || 0)) >= cadence) {
      spot = await this._fetchSpot(protection);
      this.lastSentinelAt.set(protection.id, now);
    }

    const strategyState = normalizeStrategyState(protection.strategyState);
    const currentPrice = Number(spot?.priceCurrent ?? protection.poolSnapshot?.priceCurrent ?? protection.priceCurrent);
    const currentBoundarySide = getCurrentBoundarySide(protection, currentPrice);
    const lastBoundarySide = strategyState.lastObservedBoundarySide || 'inside';
    const crossedBoundary = currentBoundarySide && lastBoundarySide !== currentBoundarySide;
    const nearBoundary = Number(distanceToRangePct(protection, currentPrice)) <= 1;
    const evalDue = (now - (this.lastEvalAt.get(protection.id) || 0)) >= this.fullEvalMs;

    if (!evalDue && !crossedBoundary && !nearBoundary) return;

    this.lastEvalAt.set(protection.id, now);
    await this.evaluateProtection(protection, {
      spot,
      forceReason: crossedBoundary ? 'boundary_cross' : nearBoundary ? 'boundary_watch' : null,
    });
  }

  async evaluateProtection(protection, { spot = null, forceReason = null, forceRebalance = false } = {}) {
    const current = await this.repo.getById(protection.userId, protection.id);
    if (!current || current.status !== 'active' || current.protectionMode !== 'delta_neutral') {
      return null;
    }

    const hl = await this.hlRegistry.getOrCreate(current.userId, current.accountId);
    const tradingService = await this.getTradingService(current.userId, current.accountId);
    const strategyState = normalizeStrategyState(current.strategyState);
    const liveSpot = spot || await this._fetchSpot(current);
    const currentPrice = Number(liveSpot?.priceCurrent ?? current.poolSnapshot?.priceCurrent ?? current.priceCurrent);
    const snapshot = {
      ...(safeJsonClone(current.poolSnapshot) || {}),
      priceCurrent: currentPrice,
    };
    const metrics = computeDeltaNeutralMetrics(snapshot, {
      targetHedgeRatio: current.targetHedgeRatio ?? DEFAULT_TARGET_HEDGE_RATIO,
    });
    if (!metrics.eligible) {
      strategyState.status = 'degraded_partial';
      strategyState.lastError = metrics.reason;
      await this.repo.updateStrategyState(current.userId, current.id, {
        strategyState,
        priceCurrent: currentPrice,
      });
      return null;
    }

    const rvStats = await this._getVolatilityStats(hl, current.inferredAsset);
    const band = deriveBandSettings(current, rvStats, metrics, currentPrice);
    const position = await hl.getPosition(current.inferredAsset).catch(() => null);
    const actualQty = position && Number(position.szi) < 0 ? Math.abs(Number(position.szi)) : 0;
    const currentBoundarySide = getCurrentBoundarySide(current, currentPrice);
    const marginModeVerified = position ? isIsolatedPosition(position) : true;
    const distanceToLiqPct = computeLiquidationDistancePct(position, currentPrice);
    const fundingAccumUsd = position?.cumFunding?.sinceOpen != null ? Number(position.cumFunding.sinceOpen) : clampNonNegative(strategyState.fundingAccumUsd, 0);
    const hedgeUnrealizedPnlUsd = position?.unrealizedPnl != null ? Number(position.unrealizedPnl) : 0;
    const lpPnlUsd = Number(snapshot.pnlTotalUsd || 0);
    const topUpState = this._refreshTopUpWindow(strategyState);
    const referencePrice = Number(strategyState.lastSnapshotPrice || currentPrice);
    const nextState = {
      ...strategyState,
      ...topUpState,
      status: strategyState.status === 'deactivation_pending' ? 'deactivation_pending' : 'healthy',
      lastSnapshotPrice: referencePrice,
      lastDeltaQty: metrics.deltaQty,
      lastGamma: metrics.gamma,
      lastTargetQty: metrics.targetQty,
      lastActualQty: actualQty,
      effectiveBandPct: band.effectiveBandPct,
      rv4hPct: band.rv4hPct,
      rv24hPct: band.rv24hPct,
      fundingAccumUsd,
      hedgeUnrealizedPnlUsd,
      lpPnlUsd,
      distanceToLiqPct,
      marginModeVerified,
      topUpCapUsd: Math.max(300, 0.25 * Number(current.initialConfiguredHedgeNotionalUsd || current.configuredHedgeNotionalUsd || 0)),
      lastObservedBoundarySide: currentBoundarySide,
      netProtectionPnlUsd:
        lpPnlUsd
        + Number(strategyState.hedgeRealizedPnlUsd || 0)
        + hedgeUnrealizedPnlUsd
        + fundingAccumUsd
        - Number(strategyState.executionFeesUsd || 0)
        - Number(strategyState.slippageUsd || 0),
      lastError: null,
    };

    if (!marginModeVerified || (position && Number(position.szi) > 0)) {
      nextState.status = 'risk_paused';
      nextState.lastError = !marginModeVerified
        ? 'La posicion dejo de estar en isolated margin.'
        : 'Se detecto una posicion long manual en el activo cubierto.';
      await this.repo.updateStrategyState(current.userId, current.id, {
        strategyState: nextState,
        priceCurrent: currentPrice,
        hedgeSize: actualQty,
        hedgeNotionalUsd: actualQty * currentPrice,
      });
      return nextState;
    }

    if (nextState.status === 'deactivating' || nextState.status === 'deactivation_pending') {
      return this._continueDeactivation({ ...current, strategyState: nextState }, { tradingService, hl, actualQty, currentPrice });
    }

    if (Number.isFinite(distanceToLiqPct)) {
      if (distanceToLiqPct <= 7) {
        nextState.status = 'risk_paused';
        nextState.lastError = 'La distancia a liquidacion es demasiado baja.';
      } else if (distanceToLiqPct <= 10) {
        const toppedUp = await this._maybeTopUpMargin({
          protection: current,
          hl,
          currentPrice,
          actualQty,
          strategyState: nextState,
        });
        if (!toppedUp.allowed && !toppedUp.success) {
          nextState.status = 'risk_paused';
          nextState.lastError = toppedUp.reason;
        } else if (!toppedUp.success) {
          nextState.status = 'boundary_watch';
          nextState.lastError = toppedUp.reason || 'Top-up no ejecutado; distancia a liquidacion baja.';
          Object.assign(nextState, toppedUp.strategyState);
        } else {
          Object.assign(nextState, toppedUp.strategyState);
        }
      }
    }

    const priceMovePct = nextState.lastRebalanceAt && Number.isFinite(referencePrice)
      ? Math.abs(((currentPrice - referencePrice) / referencePrice) * 100)
      : Infinity;
    const driftQty = Number(metrics.targetQty) - actualQty;
    const driftUsd = Math.abs(driftQty) * currentPrice;
    const timerDue = !nextState.lastRebalanceAt
      || ((Date.now() - Number(nextState.lastRebalanceAt || 0)) >= (band.intervalSec * 1000));
    const shouldRebalance = forceRebalance
      || forceReason === 'boundary_cross'
      || priceMovePct >= band.effectiveBandPct
      || (timerDue && driftUsd >= (current.minRebalanceNotionalUsd ?? DEFAULT_MIN_REBALANCE_NOTIONAL_USD))
      || (!position && metrics.targetQty > 0.0000001);

    await this.repo.updateStrategyState(current.userId, current.id, {
      strategyState: nextState,
      priceCurrent: currentPrice,
      hedgeSize: actualQty,
      hedgeNotionalUsd: actualQty * currentPrice,
    });

    if (!shouldRebalance) {
      return nextState;
    }

    const reason = forceReason
      || (!position && metrics.targetQty > 0.0000001 ? 'restart_reconcile' : priceMovePct >= band.effectiveBandPct ? 'price_band' : 'timer_and_drift');
    return this._executeRebalance({
      protection: current,
      tradingService,
      hl,
      position,
      actualQty,
      currentPrice,
      metrics,
      band,
      strategyState: nextState,
      reason,
    });
  }

  async _executeRebalance({
    protection,
    tradingService,
    hl,
    position,
    actualQty,
    currentPrice,
    metrics,
    band,
    strategyState,
    reason,
  }) {
    const driftQty = Number(metrics.targetQty) - Number(actualQty);
    const driftUsd = Math.abs(driftQty) * currentPrice;
    if (!Number.isFinite(driftQty) || Math.abs(driftQty) < 1e-8) {
      return strategyState;
    }
    if (strategyState.status === 'risk_paused' && driftQty > 0) {
      return strategyState;
    }

    const executionMode = driftUsd >= (protection.twapMinNotionalUsd ?? DEFAULT_TWAP_MIN_NOTIONAL_USD)
      ? 'TWAP'
      : 'IOC';

    const beforeState = {
      actualQtyBefore: actualQty,
      targetQtyBefore: Number(metrics.targetQty),
      deltaQtyBefore: Number(metrics.deltaQty),
      gammaBefore: Number(metrics.gamma),
      driftUsd,
    };

    let executionSummary;
    try {
      if (executionMode === 'TWAP') {
        executionSummary = await this._runTwap({
          protection,
          tradingService,
          hl,
          currentPrice,
          driftQty,
        });
      } else {
        executionSummary = await this._runSingleAdjustment({
          protection,
          tradingService,
          hl,
          currentPrice,
          driftQty,
        });
      }
    } catch (err) {
      const failedState = {
        ...strategyState,
        status: executionMode === 'TWAP' ? 'degraded_partial' : 'partial_hedge_warning',
        lastError: err.message,
      };
      await this.repo.updateStrategyState(protection.userId, protection.id, {
        strategyState: failedState,
        priceCurrent: currentPrice,
      });
      throw err;
    }

    const refreshedPosition = await hl.getPosition(protection.inferredAsset).catch(() => null);
    const actualQtyAfter = refreshedPosition && Number(refreshedPosition.szi) < 0 ? Math.abs(Number(refreshedPosition.szi)) : 0;
    const realizedDelta = this._estimateRealizedPnl(position, executionSummary, driftQty);
    const updatedState = {
      ...strategyState,
      status: executionSummary.partial ? 'partial_hedge_warning' : 'healthy',
      hedgeRealizedPnlUsd: Number(strategyState.hedgeRealizedPnlUsd || 0) + realizedDelta,
      executionFeesUsd: Number(strategyState.executionFeesUsd || 0) + Number(executionSummary.executionFeeUsd || 0),
      slippageUsd: Number(strategyState.slippageUsd || 0) + Number(executionSummary.slippageUsd || 0),
      lastRebalanceAt: Date.now(),
      lastRebalanceReason: reason,
      lastActualQty: actualQtyAfter,
      lastTargetQty: Number(metrics.targetQty),
      lastSnapshotPrice: currentPrice,
      lastError: executionSummary.partial ? 'El rebalance TWAP quedo parcial.' : null,
    };

    updatedState.netProtectionPnlUsd =
      Number(updatedState.lpPnlUsd || 0)
      + Number(updatedState.hedgeRealizedPnlUsd || 0)
      + Number(updatedState.hedgeUnrealizedPnlUsd || 0)
      + Number(updatedState.fundingAccumUsd || 0)
      - Number(updatedState.executionFeesUsd || 0)
      - Number(updatedState.slippageUsd || 0);

    await this.repo.updateStrategyState(protection.userId, protection.id, {
      strategyState: updatedState,
      priceCurrent: currentPrice,
      hedgeSize: actualQtyAfter,
      hedgeNotionalUsd: actualQtyAfter * currentPrice,
    });

    await this.deltaLogRepo.create({
      protectedPoolId: protection.id,
      reason,
      executionMode,
      twapSlicesPlanned: executionSummary.twapSlicesPlanned ?? null,
      twapSlicesCompleted: executionSummary.twapSlicesCompleted ?? null,
      price: currentPrice,
      rv4hPct: band.rv4hPct,
      rv24hPct: band.rv24hPct,
      effectiveBandPct: band.effectiveBandPct,
      deltaQtyBefore: beforeState.deltaQtyBefore,
      gammaBefore: beforeState.gammaBefore,
      targetQtyBefore: beforeState.targetQtyBefore,
      actualQtyBefore: beforeState.actualQtyBefore,
      targetQtyAfter: Number(metrics.targetQty),
      actualQtyAfter,
      driftUsd: beforeState.driftUsd,
      executionFeeUsd: executionSummary.executionFeeUsd,
      slippageUsd: executionSummary.slippageUsd,
      fundingSnapshotUsd: Number(updatedState.fundingAccumUsd || 0),
      distanceToLiqPct: updatedState.distanceToLiqPct,
      createdAt: Date.now(),
    }).catch((err) => {
      this.logger.warn('protected_pool_delta_log_write_failed', {
        protectionId: protection.id,
        error: err.message,
      });
    });

    return updatedState;
  }

  async _runSingleAdjustment({ protection, tradingService, hl, currentPrice, driftQty }) {
    if (driftQty > 0) {
      await this._ensureIsolatedMarginBuffer(protection, hl, currentPrice, driftQty);
      const result = await tradingService.openPosition({
        asset: protection.inferredAsset,
        side: 'short',
        size: driftQty,
        leverage: protection.leverage,
        marginMode: 'isolated',
      });
      const fillPrice = Number(result.fillPrice || currentPrice);
      return {
        partial: false,
        fillPrice,
        executedQty: driftQty,
        executionFeeUsd: Math.abs(fillPrice * driftQty * ESTIMATED_TAKER_FEE_RATE),
        slippageUsd: Math.abs(fillPrice - currentPrice) * driftQty,
      };
    }

    const reduceQty = Math.abs(driftQty);
    const result = await tradingService.closePosition({
      asset: protection.inferredAsset,
      size: reduceQty,
    });
    const fillPrice = Number(result.closePrice || currentPrice);
    return {
      partial: false,
      fillPrice,
      executedQty: reduceQty,
      executionFeeUsd: Math.abs(fillPrice * reduceQty * ESTIMATED_TAKER_FEE_RATE),
      slippageUsd: Math.abs(fillPrice - currentPrice) * reduceQty,
    };
  }

  async _runTwap({ protection, tradingService, hl, currentPrice, driftQty }) {
    const direction = driftQty > 0 ? 'increase' : 'decrease';
    const totalQty = Math.abs(driftQty);
    const slicesPlanned = DEFAULT_TWAP_SLICES;
    const sliceQty = totalQty / slicesPlanned;
    const sliceDelayMs = Math.floor((DEFAULT_TWAP_DURATION_SEC * 1000) / Math.max(slicesPlanned - 1, 1));
    const session = { cancelRequested: false };
    this.twapSessions.set(protection.id, session);

    let completed = 0;
    let totalFees = 0;
    let totalSlippage = 0;
    let lastFillPrice = currentPrice;

    try {
      for (let index = 0; index < slicesPlanned; index += 1) {
        if (session.cancelRequested) {
          throw new Error('TWAP cancelado por desactivacion.');
        }
        if (index > 0 && sliceDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, sliceDelayMs));
        }
        if (session.cancelRequested) {
          throw new Error('TWAP cancelado por desactivacion.');
        }
        const remainingQty = totalQty - (completed * sliceQty);
        const qty = index === slicesPlanned - 1 ? remainingQty : sliceQty;
        if (direction === 'increase') {
          await this._ensureIsolatedMarginBuffer(protection, hl, currentPrice, qty);
        }
        const sliceResult = direction === 'increase'
          ? await tradingService.openPosition({
            asset: protection.inferredAsset,
            side: 'short',
            size: qty,
            leverage: protection.leverage,
            marginMode: 'isolated',
          })
          : await tradingService.closePosition({
            asset: protection.inferredAsset,
            size: qty,
          });
        lastFillPrice = Number(sliceResult.fillPrice || sliceResult.closePrice || currentPrice);
        totalFees += Math.abs(lastFillPrice * qty * ESTIMATED_TAKER_FEE_RATE);
        totalSlippage += Math.abs(lastFillPrice - currentPrice) * qty;
        completed += 1;
      }
    } catch (err) {
      this.twapSessions.delete(protection.id);
      const completedQty = completed * sliceQty;
      const remainingQty = Math.max(totalQty - completedQty, 0);
      if ((remainingQty * currentPrice) >= DEFAULT_EMERGENCY_IOC_NOTIONAL_USD) {
        try {
          const emergency = await this._runSingleAdjustment({
            protection,
            tradingService,
            hl,
            currentPrice,
            driftQty: direction === 'increase' ? remainingQty : -remainingQty,
          });
          totalFees += Number(emergency.executionFeeUsd || 0);
          totalSlippage += Number(emergency.slippageUsd || 0);
          lastFillPrice = Number(emergency.fillPrice || lastFillPrice);
          return {
            partial: completed > 0,
            fillPrice: lastFillPrice,
            executedQty: completedQty + remainingQty,
            executionFeeUsd: totalFees,
            slippageUsd: totalSlippage,
            twapSlicesPlanned: slicesPlanned,
            twapSlicesCompleted: completed,
          };
        } catch {
          // fall through
        }
      }

      return {
        partial: true,
        fillPrice: lastFillPrice,
        executedQty: completedQty,
        executionFeeUsd: totalFees,
        slippageUsd: totalSlippage,
        twapSlicesPlanned: slicesPlanned,
        twapSlicesCompleted: completed,
      };
    } finally {
      this.twapSessions.delete(protection.id);
    }

    return {
      partial: false,
      fillPrice: lastFillPrice,
      executedQty: totalQty,
      executionFeeUsd: totalFees,
      slippageUsd: totalSlippage,
      twapSlicesPlanned: slicesPlanned,
      twapSlicesCompleted: completed,
    };
  }

  async _continueDeactivation(protection, context = {}) {
    const strategyState = normalizeStrategyState(protection.strategyState);
    const tradingService = context.tradingService || await this.getTradingService(protection.userId, protection.accountId);
    const hl = context.hl || await this.hlRegistry.getOrCreate(protection.userId, protection.accountId);
    const position = context.actualQty != null
      ? { szi: String(-Math.abs(context.actualQty)) }
      : await hl.getPosition(protection.inferredAsset).catch(() => null);
    const actualQty = context.actualQty != null
      ? context.actualQty
      : position && Number(position.szi) < 0 ? Math.abs(Number(position.szi)) : 0;

    if (actualQty <= 0) {
      await this.repo.deactivate(protection.userId, protection.id, { deactivatedAt: Date.now() });
      await this.repo.updateStrategyState(protection.userId, protection.id, {
        strategyState: {
          ...strategyState,
          status: 'deactivating',
          lastActualQty: 0,
        },
      }).catch(() => {});
      return this.repo.getById(protection.userId, protection.id);
    }

    try {
      await tradingService.closePosition({
        asset: protection.inferredAsset,
        size: actualQty,
      });
      await this.repo.deactivate(protection.userId, protection.id, { deactivatedAt: Date.now() });
      return this.repo.getById(protection.userId, protection.id);
    } catch (err) {
      const nextState = {
        ...strategyState,
        status: 'deactivation_pending',
        lastError: err.message,
      };
      await this.repo.updateStrategyState(protection.userId, protection.id, {
        strategyState: nextState,
      });
      return nextState;
    }
  }

  _estimateRealizedPnl(positionBefore, executionSummary, driftQty) {
    const entryPrice = Number(positionBefore?.entryPx);
    const fillPrice = Number(executionSummary?.fillPrice);
    const executedQty = Number(executionSummary?.executedQty);
    if (!Number.isFinite(entryPrice) || !Number.isFinite(fillPrice) || !Number.isFinite(executedQty) || executedQty <= 0) {
      return 0;
    }
    if (driftQty >= 0) return 0;
    return (entryPrice - fillPrice) * executedQty;
  }

  async _ensureIsolatedMarginBuffer(protection, hl, currentPrice, qtyToAdd) {
    const assetMeta = await hl.getAssetMeta(protection.inferredAsset);
    await hl.updateLeverage(assetMeta.index, false, protection.leverage);
    const notionalUsd = Math.abs(qtyToAdd) * currentPrice;
    const marginUsd = Math.ceil((notionalUsd / Math.max(Number(protection.leverage || 1), 1)) * 1.2);
    if (marginUsd > 0) {
      await hl.updateIsolatedMargin(assetMeta.index, false, marginUsd).catch(() => {});
    }
  }

  _refreshTopUpWindow(strategyState) {
    const startedAt = Number(strategyState.topUpWindowStartedAt || 0);
    const now = Date.now();
    if (!startedAt || (now - startedAt) >= 86_400_000) {
      return {
        topUpCount24h: 0,
        topUpUsd24h: 0,
        topUpWindowStartedAt: now,
      };
    }
    return {
      topUpCount24h: clampNonNegative(strategyState.topUpCount24h),
      topUpUsd24h: clampNonNegative(strategyState.topUpUsd24h),
      topUpWindowStartedAt: startedAt,
    };
  }

  async _maybeTopUpMargin({ protection, hl, currentPrice, actualQty, strategyState }) {
    const refreshed = this._refreshTopUpWindow(strategyState);
    const topUpCount24h = refreshed.topUpCount24h;
    const topUpUsd24h = refreshed.topUpUsd24h;
    const currentHedgeNotionalUsd = actualQty * currentPrice;
    const topUpUsd = Math.max(100, 0.1 * currentHedgeNotionalUsd);
    const maxAutoTopUpUsdPer24h = Math.max(
      300,
      0.25 * Number(protection.initialConfiguredHedgeNotionalUsd || protection.configuredHedgeNotionalUsd || 0)
    );

    if (topUpCount24h >= DEFAULT_MAX_AUTO_TOPUPS_PER_24H) {
      return {
        allowed: false,
        success: false,
        reason: 'Se alcanzo el maximo de auto top-ups en 24h.',
        strategyState: refreshed,
      };
    }
    if ((topUpUsd24h + topUpUsd) > maxAutoTopUpUsdPer24h) {
      return {
        allowed: false,
        success: false,
        reason: 'Se alcanzo el cap diario de auto top-up.',
        strategyState: refreshed,
      };
    }
    if (strategyState.lastTopUpAt && (Date.now() - Number(strategyState.lastTopUpAt)) < 15 * 60_000) {
      return {
        allowed: true,
        success: false,
        reason: 'Cooldown de auto top-up activo.',
        strategyState: refreshed,
      };
    }

    try {
      const assetMeta = await hl.getAssetMeta(protection.inferredAsset);
      await hl.updateIsolatedMargin(assetMeta.index, false, topUpUsd);
      return {
        allowed: true,
        success: true,
        strategyState: {
          ...strategyState,
          ...refreshed,
          topUpCount24h: topUpCount24h + 1,
          topUpUsd24h: topUpUsd24h + topUpUsd,
          lastTopUpAt: Date.now(),
        },
      };
    } catch (err) {
      return {
        allowed: true,
        success: false,
        reason: err.message,
        strategyState: refreshed,
      };
    }
  }

  async _getVolatilityStats(hl, asset) {
    const cacheKey = String(asset || '').toUpperCase();
    const cached = this.rvCache.get(cacheKey);
    if (cached && (Date.now() - cached.updatedAt) < 5 * 60_000) {
      return cached.value;
    }

    const endTime = Date.now();
    const startTime = endTime - (24 * 60 * 60 * 1000);
    const candles = await hl.getCandleSnapshot({
      asset,
      interval: '1h',
      startTime,
      endTime,
    }).catch(() => []);
    const value = computeVolatilityStats(Array.isArray(candles) ? candles : []);
    this.rvCache.set(cacheKey, { value, updatedAt: Date.now() });
    return value;
  }

  async _fetchSpot(protection) {
    const snapshot = protection.poolSnapshot || {};
    const token0Decimals = Number(snapshot.token0?.decimals ?? 18);
    const token1Decimals = Number(snapshot.token1?.decimals ?? 18);
    if (!snapshot.poolAddress && !snapshot.poolId) return null;
    return this.uniswapService.getPoolSpotData({
      network: protection.network,
      version: protection.version,
      poolAddress: snapshot.poolAddress || protection.poolAddress,
      poolId: snapshot.poolId || protection.positionIdentifier,
      token0Decimals,
      token1Decimals,
    }).catch((err) => {
      this.logger.warn('protected_pool_delta_neutral_spot_failed', {
        protectionId: protection.id,
        error: err.message,
      });
      return null;
    });
  }
}

module.exports = new ProtectedPoolDeltaNeutralService();
module.exports.ProtectedPoolDeltaNeutralService = ProtectedPoolDeltaNeutralService;
module.exports.DEFAULT_BAND_MODE = DEFAULT_BAND_MODE;
module.exports.DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT = DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT;
module.exports.DEFAULT_REBALANCE_INTERVAL_SEC = DEFAULT_REBALANCE_INTERVAL_SEC;
module.exports.DEFAULT_TARGET_HEDGE_RATIO = DEFAULT_TARGET_HEDGE_RATIO;
module.exports.DEFAULT_MIN_REBALANCE_NOTIONAL_USD = DEFAULT_MIN_REBALANCE_NOTIONAL_USD;
module.exports.DEFAULT_MAX_SLIPPAGE_BPS = DEFAULT_MAX_SLIPPAGE_BPS;
module.exports.DEFAULT_TWAP_MIN_NOTIONAL_USD = DEFAULT_TWAP_MIN_NOTIONAL_USD;
module.exports.DEFAULT_MAX_AUTO_TOPUPS_PER_24H = DEFAULT_MAX_AUTO_TOPUPS_PER_24H;
module.exports.buildInitialStrategyState = buildInitialStrategyState;
module.exports.computeVolatilityStats = computeVolatilityStats;
module.exports.deriveBandSettings = deriveBandSettings;
