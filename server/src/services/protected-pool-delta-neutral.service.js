const config = require('../config');
const logger = require('./logger.service');
const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');
const deltaRebalanceLogRepository = require('../repositories/protected-pool-delta-rebalance.repository');
const decisionLogRepository = require('../repositories/protection-decision-log.repository');
const timeInRangeService = require('./time-in-range.service');
const uniswapService = require('./uniswap.service');
const hlRegistry = require('./hyperliquid.registry');
const { getTradingService } = require('./trading.factory');
const marketService = require('./market.service');
const {
  computeDeltaNeutralMetrics,
  networkSentinelIntervalMs,
} = require('./delta-neutral-math.service');
const {
  computeSnapshotHash,
  normalizeProtectionSnapshot,
  validateNormalizedProtectionSnapshot,
} = require('./delta-neutral-snapshot.service');
const MAX_SNAPSHOT_FALLBACK_AGE_MS = 2 * 60_000;
const {
  DEFAULT_BAND_MODE,
  DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT,
  DEFAULT_REBALANCE_INTERVAL_SEC,
  DEFAULT_TARGET_HEDGE_RATIO,
  DEFAULT_MIN_REBALANCE_NOTIONAL_USD,
  DEFAULT_MAX_SLIPPAGE_BPS,
  DEFAULT_TWAP_MIN_NOTIONAL_USD,
  DEFAULT_EXECUTION_MODE,
  DEFAULT_MIN_ORDER_NOTIONAL_USD,
  DEFAULT_TWAP_SLICES,
  DEFAULT_TWAP_DURATION_SEC,
  DEFAULT_EMERGENCY_IOC_NOTIONAL_USD,
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
} = require('./protected-pool-delta-neutral.helpers');

class ProtectedPoolDeltaNeutralService {
  constructor(deps = {}) {
    this.repo = deps.protectedPoolRepository || protectedPoolRepository;
    this.deltaLogRepo = deps.deltaRebalanceLogRepository || deltaRebalanceLogRepository;
    this.decisionLogRepo = deps.protectionDecisionLogRepository || decisionLogRepository;
    this.uniswapService = deps.uniswapService || uniswapService;
    this.hlRegistry = deps.hlRegistry || hlRegistry;
    this.getTradingService = deps.getTradingService || getTradingService;
    this.marketService = deps.marketService || marketService;
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

  /**
   * Reconcilia los acumuladores de PnL realizado, fees y funding del hedge
   * a partir del historial de fills de Hyperliquid. Esto cubre TODOS los
   * caminos de cierre (rebalance interno, deactivation, cierre manual,
   * liquidación o margin call) — el motor antes solo capturaba realized
   * cuando ejecutaba un rebalance, así que pérdidas en cierres por otra
   * vía quedaban huérfanas (visibles en el balance de la cuenta pero no
   * en `strategy_state_json.hedgeRealizedPnlUsd`).
   *
   * Devuelve los deltas a aplicar y el timestamp del último fill leído,
   * para que el caller pueda persistir `lastReconciledFillsAt` y evitar
   * doble conteo en ticks futuros.
   *
   * @param {object} protection
   * @param {object} hl - cliente Hyperliquid de la cuenta
   * @param {number} sinceMs - timestamp del último fill ya contabilizado
   * @returns {Promise<{ realizedDelta: number, feeDelta: number, lastFillTime: number, fillsCount: number }>}
   */
  async _reconcileHedgeFills(protection, hl, sinceMs) {
    if (!hl || typeof hl.getUserFills !== 'function') {
      return { realizedDelta: 0, feeDelta: 0, lastFillTime: Number(sinceMs || 0), fillsCount: 0 };
    }
    // Fallback: si nunca reconciliamos antes (lastReconciledFillsAt está
    // unset), tomamos como cursor inicial el `createdAt` de la protección.
    // Esto permite que protecciones legacy capturen automáticamente todos
    // los fills históricos sin necesidad de migración.
    let since = Number(sinceMs || 0);
    if (!since && protection?.createdAt) {
      since = Number(protection.createdAt);
    }

    let fills = [];
    try {
      fills = await hl.getUserFills(protection.walletAddress);
    } catch (err) {
      this.logger.warn('hedge_fills_fetch_failed', {
        protectionId: protection?.id,
        asset: protection?.inferredAsset,
        error: err.message,
      });
      return { realizedDelta: 0, feeDelta: 0, lastFillTime: since, fillsCount: 0 };
    }
    if (!Array.isArray(fills) || fills.length === 0) {
      return { realizedDelta: 0, feeDelta: 0, lastFillTime: since, fillsCount: 0 };
    }

    const asset = String(protection?.inferredAsset || '').toUpperCase();
    let realizedDelta = 0;
    let feeDelta = 0;
    let lastFillTime = since;
    let fillsCount = 0;

    for (const fill of fills) {
      const t = Number(fill?.time || 0);
      if (!Number.isFinite(t) || t <= since) continue;
      if (asset && String(fill?.coin || '').toUpperCase() !== asset) continue;
      const closedPnl = Number(fill?.closedPnl || 0);
      const fee = Number(fill?.fee || 0);
      if (Number.isFinite(closedPnl)) realizedDelta += closedPnl;
      if (Number.isFinite(fee)) feeDelta += fee;
      if (t > lastFillTime) lastFillTime = t;
      fillsCount += 1;
    }

    return { realizedDelta, feeDelta, lastFillTime, fillsCount };
  }

  _normalizeSnapshot(protection, snapshot = null) {
    const source = snapshot || protection?.poolSnapshot || {};
    const normalizedSnapshot = normalizeProtectionSnapshot(source, {
      network: protection?.network || source.network,
      version: protection?.version || source.version,
      positionIdentifier: protection?.positionIdentifier || source.positionIdentifier || source.identifier,
      poolAddress: source.poolAddress || protection?.poolAddress,
      poolId: source.poolId || protection?.positionIdentifier,
      owner: source.owner || source.creator || protection?.walletAddress,
      snapshotFreshAt: source.snapshotFreshAt || protection?.snapshotFreshAt || Date.now(),
    });
    const validation = validateNormalizedProtectionSnapshot(normalizedSnapshot);
    return {
      normalizedSnapshot,
      validation,
      snapshotFreshAt: normalizedSnapshot.snapshotFreshAt,
      snapshotHash: computeSnapshotHash(normalizedSnapshot),
    };
  }

  async _persistDecision(protection, payload) {
    await this.decisionLogRepo.create({
      protectedPoolId: protection.id,
      ...payload,
    }).catch((err) => {
      this.logger.warn('protected_pool_delta_decision_log_write_failed', {
        protectionId: protection.id,
        error: err.message,
      });
    });
  }

  async _refreshProtectionSnapshot(protection) {
    const scanResult = await this.uniswapService.scanPoolsCreatedByWallet({
      userId: protection.userId,
      wallet: protection.walletAddress,
      network: protection.network,
      version: protection.version,
    });
    const freshPool = (scanResult?.pools || []).find((pool) => (
      String(pool.identifier || '').trim() === String(protection.positionIdentifier || '').trim()
    ));
    if (!freshPool) return null;

    const rangeMetrics = await timeInRangeService.computeIncrementalRangeMetrics(protection, {
      endAt: Date.now(),
      poolSnapshot: freshPool,
      asset: protection.inferredAsset,
    }).catch(() => null);
    const poolSnapshot = rangeMetrics
      ? timeInRangeService.applyRangeMetricsToSnapshot(freshPool, rangeMetrics)
      : freshPool;
    const snapshotMeta = this._normalizeSnapshot(protection, poolSnapshot);

    await this.repo.updateSnapshot(protection.userId, protection.id, {
      poolAddress: freshPool.poolAddress || protection.poolAddress,
      token0Symbol: freshPool.token0?.symbol || protection.token0Symbol,
      token1Symbol: freshPool.token1?.symbol || protection.token1Symbol,
      token0Address: freshPool.token0Address || protection.token0Address,
      token1Address: freshPool.token1Address || protection.token1Address,
      rangeLowerPrice: freshPool.rangeLowerPrice,
      rangeUpperPrice: freshPool.rangeUpperPrice,
      priceCurrent: freshPool.priceCurrent,
      poolSnapshot,
      snapshotStatus: snapshotMeta.validation.status,
      snapshotFreshAt: snapshotMeta.snapshotFreshAt,
      snapshotHash: snapshotMeta.snapshotHash,
      updatedAt: Date.now(),
      isCurrentlyInRange: freshPool.inRange === true,
      ...(rangeMetrics || {}),
    });

    return this.repo.getById(protection.userId, protection.id);
  }

  async _buildPreflight({ protection, hl, strategyState, actualQty: _actualQty, currentPrice, tracking, bands, decision }) {
    const accountState = await hl.getClearinghouseState().catch(() => null);
    const withdrawable = Number(accountState?.withdrawable || 0);
    const targetIncreaseQty = Math.max(Number(tracking.trackingErrorQty || 0), 0);
    const increaseNotionalUsd = targetIncreaseQty * currentPrice;
    const requiredMarginUsd = increaseNotionalUsd / Math.max(Number(protection.leverage || 1), 1);
    const cooldownActive = isCooldownActive(protection, strategyState);
    const snapshotStatus = protection.snapshotStatus || 'ready';
    const priceContext = await this.marketService.getAssetContexts().catch(() => []);
    const assetContext = Array.isArray(priceContext)
      ? priceContext.find((item) => String(item.name || '').toUpperCase() === String(protection.inferredAsset || '').toUpperCase())
      : null;

    if (snapshotStatus !== 'ready') {
      return {
        ok: false,
        status: 'snapshot_invalid',
        reason: `snapshot_${snapshotStatus}`,
        executionSkippedBecause: `snapshot_${snapshotStatus}`,
      };
    }
    if (cooldownActive) {
      return {
        ok: false,
        status: strategyState.status || 'tracking',
        reason: 'cooldown_active',
        executionSkippedBecause: protection.cooldownReason || strategyState.cooldownReason || 'cooldown_active',
      };
    }
    if (decision !== 'hold' && tracking.trackingErrorUsd < Number(protection.minOrderNotionalUsd || DEFAULT_MIN_ORDER_NOTIONAL_USD)) {
      return {
        ok: false,
        status: 'tracking',
        reason: 'below_min_order_notional',
        executionSkippedBecause: 'below_min_order_notional',
      };
    }
    if (targetIncreaseQty > 0 && requiredMarginUsd > withdrawable) {
      return {
        ok: false,
        status: 'margin_pending',
        reason: 'insufficient_margin',
        executionSkippedBecause: 'insufficient_margin',
      };
    }

    return {
      ok: true,
      status: 'rebalance_pending',
      reason: 'preflight_ok',
      executionSkippedBecause: null,
      withdrawable,
      fundingRate: assetContext?.fundingRate != null ? Number(assetContext.fundingRate) : null,
      estimatedExecutionCostUsd: bands.estimatedCostUsd,
    };
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
    if (current.status !== 'active') {
      this.logger.warn('protected_pool_delta_neutral_bootstrap_inactive', {
        protectionId: current.id,
        status: current.status,
      });
      return current;
    }
    try {
      await this.evaluateProtection(current, { forceReason: 'restart_reconcile', forceRebalance: true });
    } catch (err) {
      this.logger.error('protected_pool_delta_neutral_bootstrap_failed', {
        protectionId: current.id,
        error: err.message,
      });
    }
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

  /**
   * Force-close del short del hedge. Útil cuando una protección quedó en
   * `inactive` (en BD) pero la posición short en Hyperliquid sigue abierta
   * — típicamente porque un flujo legacy de close-LP marcó la protección
   * como inactiva sin cerrar el hedge. Detecta el size actual on-chain y
   * llama directamente a `closePosition` + reconcilia los fills.
   *
   * Este método NO requiere que la protección esté `active`: funciona
   * sobre cualquier registro de protected_pool y la dejará deactivated.
   */
  async forceCloseHedge(protection) {
    const strategyState = normalizeStrategyState(protection.strategyState);
    const hl = await this.hlRegistry.getOrCreate(protection.userId, protection.accountId);
    const tradingService = await this.getTradingService(protection.userId, protection.accountId);
    const position = await hl.getPosition(protection.inferredAsset).catch((err) => {
      logger.warn('forceCloseHedge_getPosition_failed', { protectionId: protection.id, asset: protection.inferredAsset, error: err.message });
      return null;
    });
    const actualQty = position && Number(position.szi) < 0 ? Math.abs(Number(position.szi)) : 0;

    if (actualQty <= 0) {
      this.logger.info('force_close_hedge_no_position', {
        protectionId: protection.id,
        asset: protection.inferredAsset,
      });
      return { closed: false, reason: 'no_open_position', actualQty: 0 };
    }

    await tradingService.closePosition({
      asset: protection.inferredAsset,
      size: actualQty,
    });

    // Reconcilia fills para que los costos del cierre queden contabilizados.
    try {
      const wasNeverReconciled = !strategyState.lastReconciledFillsAt;
      const fillsSince = Number(strategyState.lastReconciledFillsAt || 0);
      const reconciled = await this._reconcileHedgeFills(protection, hl, fillsSince);
      await this.repo.updateStrategyState(protection.userId, protection.id, {
        strategyState: {
          ...strategyState,
          hedgeRealizedPnlUsd: wasNeverReconciled
            ? reconciled.realizedDelta
            : Number(strategyState.hedgeRealizedPnlUsd || 0) + reconciled.realizedDelta,
          executionFeesUsd: wasNeverReconciled
            ? reconciled.feeDelta
            : Number(strategyState.executionFeesUsd || 0) + reconciled.feeDelta,
          hedgeUnrealizedPnlUsd: 0,
          lastReconciledFillsAt: reconciled.lastFillTime,
          lastActualQty: 0,
          status: 'inactive',
          lastError: null,
        },
      });
    } catch (reconcileErr) {
      this.logger.warn('force_close_hedge_reconcile_failed', {
        protectionId: protection.id,
        error: reconcileErr.message,
      });
    }

    // Asegura que la protección quede como inactive si todavía está activa.
    if (protection.status === 'active') {
      await this.repo.deactivate(protection.userId, protection.id, {
        deactivatedAt: Date.now(),
      }).catch((err) => logger.warn('force_close_hedge_deactivate_failed', { protectionId: protection.id, error: err.message }));
    }

    this.logger.info('force_close_hedge_completed', {
      protectionId: protection.id,
      asset: protection.inferredAsset,
      closedQty: actualQty,
    });
    return { closed: true, actualQty };
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

    const strategyState = normalizeStrategyState(current.strategyState);
    let activeProtection = current;
    if ((current.snapshotStatus && current.snapshotStatus !== 'ready') || !current.poolSnapshot) {
      activeProtection = await this._refreshProtectionSnapshot(current).catch(() => current);
    }

    let snapshotMeta = this._normalizeSnapshot(activeProtection, activeProtection.poolSnapshot);
    if (!snapshotMeta.validation.valid) {
      const invalidState = {
        ...strategyState,
        status: 'snapshot_invalid',
        lastError: `Snapshot invalido: ${snapshotMeta.validation.reasons.join(', ')}`,
        lastDecision: 'refresh_snapshot',
        lastDecisionReason: 'snapshot_invalid',
      };
      await this.repo.updateStrategyState(current.userId, current.id, {
        strategyState: invalidState,
        snapshotStatus: snapshotMeta.validation.status,
        snapshotFreshAt: snapshotMeta.snapshotFreshAt,
        snapshotHash: snapshotMeta.snapshotHash,
        lastDecision: invalidState.lastDecision,
        lastDecisionReason: invalidState.lastDecisionReason,
      });
      await this._persistDecision(current, {
        decision: 'refresh_snapshot',
        reason: 'snapshot_invalid',
        strategyStatus: invalidState.status,
        spotSource: 'snapshot',
        snapshotStatus: snapshotMeta.validation.status,
        executionSkippedBecause: invalidState.lastError,
        finalStrategyStatus: invalidState.status,
        riskGateTriggered: false,
        createdAt: Date.now(),
      });
      return null;
    }

    const hl = await this.hlRegistry.getOrCreate(activeProtection.userId, activeProtection.accountId);
    const tradingService = await this.getTradingService(activeProtection.userId, activeProtection.accountId);
    let liveSpot = spot || await this._fetchSpot(activeProtection).catch((err) => {
      logger.warn('_fetchSpot failed in evaluateProtection', { poolId: activeProtection.id, error: err.message });
      return null;
    });
    let spotSource = liveSpot ? 'chain' : 'unavailable';
    let currentPrice = Number(liveSpot?.priceCurrent);
    let spotFailureReason = null;

    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      const refreshedProtection = await this._refreshProtectionSnapshot(activeProtection).catch(() => null);
      if (refreshedProtection) {
        activeProtection = refreshedProtection;
        snapshotMeta = this._normalizeSnapshot(activeProtection, activeProtection.poolSnapshot);
      }
      const snapshotAgeMs = Math.max(
        Date.now() - Number(snapshotMeta.snapshotFreshAt || activeProtection.snapshotFreshAt || activeProtection.updatedAt || Date.now()),
        0
      );
      const snapshotPrice = Number(activeProtection.poolSnapshot?.priceCurrent ?? activeProtection.priceCurrent);
      if (Number.isFinite(snapshotPrice) && snapshotPrice > 0 && snapshotAgeMs <= MAX_SNAPSHOT_FALLBACK_AGE_MS) {
        currentPrice = snapshotPrice;
        spotSource = 'snapshot';
        spotFailureReason = liveSpot ? null : 'chain_spot_unavailable_using_fresh_snapshot';
      } else {
        spotFailureReason = 'No se pudo obtener el precio actual del pool.';
      }
    }

    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      const cooldown = buildCooldown('No se pudo obtener el precio actual del pool.', strategyState);
      const staleState = {
        ...strategyState,
        status: cooldown.status,
        lastError: 'No se pudo obtener el precio actual del pool.',
        lastDecision: 'refresh_snapshot',
        lastDecisionReason: 'spot_stale',
        nextEligibleAttemptAt: cooldown.nextEligibleAttemptAt,
        cooldownReason: cooldown.cooldownReason,
        lastSpotFailureAt: Date.now(),
        lastSpotFailureReason: 'No se pudo obtener el precio actual del pool.',
      };
      await this.repo.updateStrategyState(activeProtection.userId, activeProtection.id, {
        strategyState: staleState,
        snapshotStatus: snapshotMeta.validation.status,
        snapshotFreshAt: snapshotMeta.snapshotFreshAt,
        snapshotHash: snapshotMeta.snapshotHash,
        nextEligibleAttemptAt: cooldown.nextEligibleAttemptAt,
        cooldownReason: cooldown.cooldownReason,
        lastDecision: staleState.lastDecision,
        lastDecisionReason: staleState.lastDecisionReason,
      });
      await this._persistDecision(activeProtection, {
        decision: 'refresh_snapshot',
        reason: 'spot_stale',
        strategyStatus: staleState.status,
        spotSource,
        snapshotStatus: snapshotMeta.validation.status,
        executionSkippedBecause: staleState.lastError,
        finalStrategyStatus: staleState.status,
        riskGateTriggered: false,
        createdAt: Date.now(),
      });
      return null;
    }

    const snapshot = {
      ...(safeJsonClone(activeProtection.poolSnapshot) || {}),
      ...snapshotMeta.normalizedSnapshot,
      priceCurrent: currentPrice,
    };
    const metrics = computeDeltaNeutralMetrics(snapshot, {
      targetHedgeRatio: activeProtection.targetHedgeRatio ?? DEFAULT_TARGET_HEDGE_RATIO,
    });
    if (!metrics.eligible) {
      const degradedState = {
        ...strategyState,
        status: 'degraded_partial',
        lastError: metrics.reason,
        lastDecision: 'hold',
        lastDecisionReason: 'metrics_ineligible',
      };
      await this.repo.updateStrategyState(activeProtection.userId, activeProtection.id, {
        strategyState: degradedState,
        priceCurrent: currentPrice,
        snapshotStatus: snapshotMeta.validation.status,
        snapshotFreshAt: snapshotMeta.snapshotFreshAt,
        snapshotHash: snapshotMeta.snapshotHash,
        lastDecision: degradedState.lastDecision,
        lastDecisionReason: degradedState.lastDecisionReason,
      });
      await this._persistDecision(activeProtection, {
        decision: 'hold',
        reason: 'metrics_ineligible',
        strategyStatus: degradedState.status,
        spotSource,
        snapshotStatus: snapshotMeta.validation.status,
        executionSkippedBecause: metrics.reason,
        currentPrice,
        finalStrategyStatus: degradedState.status,
        riskGateTriggered: false,
      });
      return null;
    }

    const rvStats = await this._getVolatilityStats(hl, activeProtection.inferredAsset);
    const band = deriveBandSettings(activeProtection, rvStats, metrics, currentPrice);
    const position = await hl.getPosition(activeProtection.inferredAsset).catch((err) => { logger.warn('getPosition failed in rebalance check', { poolId: activeProtection.id, asset: activeProtection.inferredAsset, error: err.message }); return null; });
    const actualQty = position && Number(position.szi) < 0 ? Math.abs(Number(position.szi)) : 0;
    const currentBoundarySide = getCurrentBoundarySide(activeProtection, currentPrice);
    const marginModeVerified = position ? isIsolatedPosition(position) : true;
    const distanceToLiqPct = computeLiquidationDistancePct(position, currentPrice);
    const fundingAccumUsd = position?.cumFunding?.sinceOpen != null ? Number(position.cumFunding.sinceOpen) : clampNonNegative(strategyState.fundingAccumUsd, 0);
    const hedgeUnrealizedPnlUsd = position?.unrealizedPnl != null ? Number(position.unrealizedPnl) : 0;
    const lpPnlUsd = Number(snapshot.pnlTotalUsd || 0);
    const topUpState = this._refreshTopUpWindow(strategyState);
    const referencePrice = Number(strategyState.lastSnapshotPrice || currentPrice);

    // Reconcilia los acumuladores realizados (PnL realized + fees) leyendo
    // fills nuevos desde Hyperliquid. Esto cubre cierres por cualquier vía
    // (rebalance interno, deactivation, manual, liquidación) ya que el motor
    // antes solo capturaba realized en `_executeRebalance` y los $ perdidos
    // en otros caminos quedaban huérfanos en el balance de la cuenta.
    //
    // Si nunca reconciliamos antes, tratamos los acumuladores actuales como
    // estimaciones legacy y los REEMPLAZAMOS por la suma de fills históricos
    // (fuente de verdad). En ticks subsecuentes acumulamos sólo el delta.
    const wasNeverReconciled = !strategyState.lastReconciledFillsAt;
    const fillsSince = Number(strategyState.lastReconciledFillsAt || 0);
    const reconciled = await this._reconcileHedgeFills(activeProtection, hl, fillsSince);
    const reconciledRealizedPnlUsd = wasNeverReconciled
      ? reconciled.realizedDelta
      : Number(strategyState.hedgeRealizedPnlUsd || 0) + reconciled.realizedDelta;
    const reconciledExecutionFeesUsd = wasNeverReconciled
      ? reconciled.feeDelta
      : Number(strategyState.executionFeesUsd || 0) + reconciled.feeDelta;

    const nextState = {
      ...strategyState,
      ...topUpState,
      status: strategyState.status === 'deactivation_pending' ? 'deactivation_pending' : 'tracking',
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
      hedgeRealizedPnlUsd: reconciledRealizedPnlUsd,
      executionFeesUsd: reconciledExecutionFeesUsd,
      lastReconciledFillsAt: reconciled.lastFillTime,
      lpPnlUsd,
      distanceToLiqPct,
      marginModeVerified,
      topUpCapUsd: Math.max(300, 0.25 * Number(activeProtection.initialConfiguredHedgeNotionalUsd || activeProtection.configuredHedgeNotionalUsd || 0)),
      lastObservedBoundarySide: currentBoundarySide,
      netProtectionPnlUsd:
        lpPnlUsd
        + reconciledRealizedPnlUsd
        + hedgeUnrealizedPnlUsd
        + fundingAccumUsd
        - reconciledExecutionFeesUsd
        - Number(strategyState.slippageUsd || 0),
      lastError: null,
      cooldownReason: null,
    };

    const rebalanceDecision = resolveRebalanceDecision({
      protection: activeProtection,
      metrics,
      actualQty,
      currentPrice,
      forceReason,
      forceRebalance,
    });
    const tracking = rebalanceDecision.tracking;
    nextState.trackingErrorQty = tracking.trackingErrorQty;
    nextState.trackingErrorUsd = tracking.trackingErrorUsd;
    nextState.lastSpotFailureAt = spotFailureReason ? Date.now() : (strategyState.lastSpotFailureAt || null);
    nextState.lastSpotFailureReason = spotFailureReason || null;

    let riskGateTriggered = false;
    let riskGateReason = null;
    let forcedStatus = null;

    if (!marginModeVerified || (position && Number(position.szi) > 0)) {
      nextState.status = 'risk_paused';
      nextState.lastError = !marginModeVerified
        ? 'La posicion dejo de estar en isolated margin.'
        : 'Se detecto una posicion long manual en el activo cubierto.';
      nextState.lastDecision = 'hold';
      nextState.lastDecisionReason = 'risk_paused';
      riskGateTriggered = true;
      riskGateReason = nextState.lastError;
      await this.repo.updateStrategyState(activeProtection.userId, activeProtection.id, {
        strategyState: nextState,
        priceCurrent: currentPrice,
        hedgeSize: actualQty,
        hedgeNotionalUsd: actualQty * currentPrice,
        snapshotStatus: snapshotMeta.validation.status,
        snapshotFreshAt: snapshotMeta.snapshotFreshAt,
        snapshotHash: snapshotMeta.snapshotHash,
        lastDecision: nextState.lastDecision,
        lastDecisionReason: nextState.lastDecisionReason,
        trackingErrorQty: tracking.trackingErrorQty,
        trackingErrorUsd: tracking.trackingErrorUsd,
      });
      await this._persistDecision(activeProtection, {
        decision: nextState.lastDecision,
        reason: nextState.lastDecisionReason,
        strategyStatus: nextState.status,
        spotSource,
        snapshotStatus: snapshotMeta.validation.status,
        executionSkippedBecause: nextState.lastError,
        targetQty: metrics.targetQty,
        actualQty,
        trackingErrorQty: tracking.trackingErrorQty,
        trackingErrorUsd: tracking.trackingErrorUsd,
        currentPrice,
        finalStrategyStatus: nextState.status,
        riskGateTriggered,
        liquidationDistancePct: distanceToLiqPct,
      });
      return nextState;
    }

    if (nextState.status === 'deactivating' || nextState.status === 'deactivation_pending') {
      return this._continueDeactivation({ ...activeProtection, strategyState: nextState }, { tradingService, hl, actualQty, currentPrice });
    }

    if (Number.isFinite(distanceToLiqPct)) {
      if (distanceToLiqPct <= 7) {
        forcedStatus = 'risk_paused';
        nextState.lastError = 'La distancia a liquidacion es demasiado baja.';
        riskGateTriggered = true;
        riskGateReason = nextState.lastError;
      } else if (distanceToLiqPct <= 10) {
        const toppedUp = await this._maybeTopUpMargin({
          protection: activeProtection,
          hl,
          currentPrice,
          actualQty,
          strategyState: nextState,
        });
        if (!toppedUp.allowed && !toppedUp.success) {
          forcedStatus = 'risk_paused';
          nextState.lastError = toppedUp.reason;
          riskGateTriggered = true;
          riskGateReason = toppedUp.reason;
        } else if (!toppedUp.success) {
          forcedStatus = 'margin_pending';
          nextState.lastError = toppedUp.reason || 'Top-up no ejecutado; distancia a liquidacion baja.';
          Object.assign(nextState, toppedUp.strategyState);
          riskGateTriggered = true;
          riskGateReason = nextState.lastError;
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
      || (timerDue && driftUsd >= (activeProtection.minRebalanceNotionalUsd ?? DEFAULT_MIN_REBALANCE_NOTIONAL_USD))
      || (!position && metrics.targetQty > 0.0000001);

    const preflight = await this._buildPreflight({
      protection: activeProtection,
      hl,
      strategyState: nextState,
      actualQty,
      currentPrice,
      tracking,
      bands: rebalanceDecision.bands,
      decision: rebalanceDecision.decision,
    });

    nextState.status = normalizeEvaluationStatus({
      decision: rebalanceDecision.decision,
      trackingErrorUsd: tracking.trackingErrorUsd,
      riskStatus: forcedStatus,
      preflightStatus: preflight.ok ? null : preflight.status,
      shouldRebalance,
      preflightOk: preflight.ok,
    });
    nextState.lastDecision = rebalanceDecision.decision;
    nextState.lastDecisionReason = forceReason
      || (rebalanceDecision.decision === 'hold' ? 'within_cost_aware_band' : 'drift_exceeds_cost_aware_band');
    if (forcedStatus === 'margin_pending') {
      nextState.nextEligibleAttemptAt = Date.now() + MARGIN_COOLDOWN_MS;
      nextState.cooldownReason = riskGateReason;
    } else if (preflight.ok) {
      nextState.nextEligibleAttemptAt = null;
      nextState.cooldownReason = null;
    } else {
      nextState.nextEligibleAttemptAt = preflight.status === 'margin_pending'
        ? Date.now() + MARGIN_COOLDOWN_MS
        : strategyState.nextEligibleAttemptAt;
      nextState.cooldownReason = preflight.executionSkippedBecause;
    }
    if (forcedStatus) {
      nextState.lastDecision = 'hold';
      nextState.lastDecisionReason = forcedStatus === 'risk_paused' ? 'risk_paused' : 'margin_pending';
    }

    await this.repo.updateStrategyState(activeProtection.userId, activeProtection.id, {
      strategyState: nextState,
      priceCurrent: currentPrice,
      hedgeSize: actualQty,
      hedgeNotionalUsd: actualQty * currentPrice,
      snapshotStatus: snapshotMeta.validation.status,
      snapshotFreshAt: snapshotMeta.snapshotFreshAt,
      snapshotHash: snapshotMeta.snapshotHash,
      nextEligibleAttemptAt: nextState.nextEligibleAttemptAt,
      cooldownReason: nextState.cooldownReason,
      lastDecision: nextState.lastDecision,
      lastDecisionReason: nextState.lastDecisionReason,
      trackingErrorQty: tracking.trackingErrorQty,
      trackingErrorUsd: tracking.trackingErrorUsd,
      executionMode: activeProtection.executionMode || DEFAULT_EXECUTION_MODE,
    });

    await this._persistDecision(activeProtection, {
      decision: nextState.lastDecision,
      reason: nextState.lastDecisionReason,
      strategyStatus: nextState.status,
      spotSource,
      snapshotStatus: snapshotMeta.validation.status,
      snapshotFreshnessMs: Math.max(Date.now() - Number(snapshotMeta.snapshotFreshAt || Date.now()), 0),
      executionSkippedBecause: forcedStatus ? riskGateReason : (preflight.ok ? null : preflight.executionSkippedBecause),
      executionMode: activeProtection.executionMode || DEFAULT_EXECUTION_MODE,
      estimatedCostUsd: rebalanceDecision.bands.estimatedCostUsd,
      targetQty: metrics.targetQty,
      actualQty,
      trackingErrorQty: tracking.trackingErrorQty,
      trackingErrorUsd: tracking.trackingErrorUsd,
      currentPrice,
      finalStrategyStatus: nextState.status,
      riskGateTriggered,
      liquidationDistancePct: distanceToLiqPct,
    });

    if (forcedStatus || !shouldRebalance || rebalanceDecision.decision === 'hold' || !preflight.ok) {
      return nextState;
    }

    const reason = forceReason
      || (!position && metrics.targetQty > 0.0000001 ? 'restart_reconcile' : priceMovePct >= band.effectiveBandPct ? 'price_band' : 'timer_and_drift');
    return this._executeRebalance({
      protection: activeProtection,
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
    position: _position,
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

    const configuredMode = String(protection.executionMode || DEFAULT_EXECUTION_MODE).toLowerCase();
    const executionMode = configuredMode === 'twap'
      ? 'TWAP'
      : configuredMode === 'ioc'
        ? 'IOC'
        : driftUsd >= (protection.twapMinNotionalUsd ?? DEFAULT_TWAP_MIN_NOTIONAL_USD)
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
      await this.repo.updateStrategyState(protection.userId, protection.id, {
        strategyState: {
          ...strategyState,
          status: 'executing',
          lastExecutionAttemptAt: Date.now(),
          lastExecutionOutcome: 'pending',
        },
        priceCurrent: currentPrice,
        executionMode,
      });
      if (executionMode === 'TWAP') {
        executionSummary = await this._runTwap({
          protection,
          tradingService,
          hl,
          currentPrice,
          driftQty,
          actualQty,
        });
      } else {
        executionSummary = await this._runSingleAdjustment({
          protection,
          tradingService,
          hl,
          currentPrice,
          driftQty,
          actualQty,
        });
      }
    } catch (err) {
      const failedState = {
        ...strategyState,
        status: executionMode === 'TWAP' ? 'degraded_partial' : 'partial_hedge_warning',
        lastError: err.message,
        lastExecutionAttemptAt: Date.now(),
        lastExecutionOutcome: 'failed',
      };
      const cooldown = buildCooldown(err, failedState);
      failedState.status = cooldown.status;
      failedState.nextEligibleAttemptAt = cooldown.nextEligibleAttemptAt;
      failedState.cooldownReason = cooldown.cooldownReason;
      await this.repo.updateStrategyState(protection.userId, protection.id, {
        strategyState: failedState,
        priceCurrent: currentPrice,
        nextEligibleAttemptAt: cooldown.nextEligibleAttemptAt,
        cooldownReason: cooldown.cooldownReason,
        lastDecision: strategyState.lastDecision || 'rebalance_full',
        lastDecisionReason: strategyState.lastDecisionReason || reason,
        trackingErrorQty: Number(metrics.targetQty) - Number(actualQty),
        trackingErrorUsd: Math.abs(Number(metrics.targetQty) - Number(actualQty)) * currentPrice,
        executionMode,
      });
      await this._persistDecision(protection, {
        decision: strategyState.lastDecision || 'rebalance_full',
        reason,
        strategyStatus: failedState.status,
        snapshotStatus: protection.snapshotStatus || 'ready',
        executionSkippedBecause: err.message,
        executionMode,
        estimatedCostUsd: estimateExecutionCostUsd(driftQty, currentPrice),
        targetQty: metrics.targetQty,
        actualQty,
        trackingErrorQty: Number(metrics.targetQty) - Number(actualQty),
        trackingErrorUsd: Math.abs(Number(metrics.targetQty) - Number(actualQty)) * currentPrice,
        currentPrice,
        finalStrategyStatus: failedState.status,
        riskGateTriggered: false,
      });
      throw err;
    }

    const refreshedPosition = await hl.getPosition(protection.inferredAsset).catch((err) => { logger.warn('getPosition failed after rebalance', { poolId: protection.id, asset: protection.inferredAsset, error: err.message }); return null; });
    const actualQtyAfter = refreshedPosition && Number(refreshedPosition.szi) < 0 ? Math.abs(Number(refreshedPosition.szi)) : 0;
    // Reconcilia el realized PnL y fees del fill recién ejecutado leyendo de
    // getUserFills (fuente de verdad). Esto reemplaza el viejo estimador
    // `_estimateRealizedPnl` que solo cubría reduce-shorts y dependía de un
    // fillPrice estimado — además NO doble-cuenta porque usa
    // `lastReconciledFillsAt` como cursor.
    const wasNeverReconciledExec = !strategyState.lastReconciledFillsAt;
    const fillsSinceExec = Number(strategyState.lastReconciledFillsAt || 0);
    const reconciledExec = await this._reconcileHedgeFills(protection, hl, fillsSinceExec);
    const updatedState = {
      ...strategyState,
      status: executionSummary.partial ? 'partial_hedge_warning' : 'healthy',
      hedgeRealizedPnlUsd: wasNeverReconciledExec
        ? reconciledExec.realizedDelta
        : Number(strategyState.hedgeRealizedPnlUsd || 0) + reconciledExec.realizedDelta,
      executionFeesUsd: wasNeverReconciledExec
        ? reconciledExec.feeDelta
        : Number(strategyState.executionFeesUsd || 0) + reconciledExec.feeDelta,
      lastReconciledFillsAt: reconciledExec.lastFillTime,
      // Slippage NO viene en getUserFills — lo seguimos calculando como
      // |fillPrice - currentPrice| * qty desde el executionSummary local.
      slippageUsd: Number(strategyState.slippageUsd || 0) + Number(executionSummary.slippageUsd || 0),
      lastRebalanceAt: Date.now(),
      lastRebalanceReason: reason,
      lastActualQty: actualQtyAfter,
      lastTargetQty: Number(metrics.targetQty),
      lastSnapshotPrice: currentPrice,
      lastError: executionSummary.partial ? 'El rebalance TWAP quedo parcial.' : null,
      lastExecutionAttemptAt: Date.now(),
      lastExecutionOutcome: executionSummary.partial ? 'partial' : 'success',
      nextEligibleAttemptAt: null,
      cooldownReason: null,
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
      nextEligibleAttemptAt: null,
      cooldownReason: null,
      lastDecision: strategyState.lastDecision || 'rebalance_full',
      lastDecisionReason: strategyState.lastDecisionReason || reason,
      trackingErrorQty: Number(metrics.targetQty) - Number(actualQtyAfter),
      trackingErrorUsd: Math.abs(Number(metrics.targetQty) - Number(actualQtyAfter)) * currentPrice,
      executionMode,
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

    await this._persistDecision(protection, {
      decision: strategyState.lastDecision || 'rebalance_full',
      reason,
      strategyStatus: updatedState.status,
      snapshotStatus: protection.snapshotStatus || 'ready',
      executionMode,
      estimatedCostUsd: estimateExecutionCostUsd(driftQty, currentPrice),
      realizedCostUsd: Number(executionSummary.executionFeeUsd || 0) + Number(executionSummary.slippageUsd || 0),
      targetQty: metrics.targetQty,
      actualQty: actualQtyAfter,
      trackingErrorQty: Number(metrics.targetQty) - Number(actualQtyAfter),
      trackingErrorUsd: Math.abs(Number(metrics.targetQty) - Number(actualQtyAfter)) * currentPrice,
      currentPrice,
      finalStrategyStatus: updatedState.status,
      riskGateTriggered: false,
      liquidationDistancePct: updatedState.distanceToLiqPct,
    });

    return updatedState;
  }

  async _runSingleAdjustment({ protection, tradingService, hl, currentPrice, driftQty, actualQty = 0 }) {
    if (driftQty > 0) {
      await this._ensureIsolatedMarginBuffer(protection, hl, currentPrice, driftQty, actualQty);
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

  async _runTwap({ protection, tradingService, hl, currentPrice, driftQty, actualQty = 0 }) {
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
          await this._ensureIsolatedMarginBuffer(protection, hl, currentPrice, qty, actualQty + (completed * sliceQty));
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
            actualQty: actualQty + completedQty,
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
      : await hl.getPosition(protection.inferredAsset).catch((err) => { logger.warn('getPosition failed in deactivation', { poolId: protection.id, asset: protection.inferredAsset, error: err.message }); return null; });
    const actualQty = context.actualQty != null
      ? context.actualQty
      : position && Number(position.szi) < 0 ? Math.abs(Number(position.szi)) : 0;

    if (actualQty <= 0) {
      const deactivatedAt = Date.now();
      const finalRangeMetrics = await timeInRangeService.computeIncrementalRangeMetrics(protection, {
        endAt: deactivatedAt,
        rangeFrozenAt: deactivatedAt,
      });
      await this.repo.deactivate(protection.userId, protection.id, {
        deactivatedAt,
        ...(finalRangeMetrics ? {
          ...finalRangeMetrics,
          poolSnapshot: timeInRangeService.applyRangeMetricsToSnapshot(protection.poolSnapshot || {}, finalRangeMetrics),
        } : {}),
      });
      await this.repo.updateStrategyState(protection.userId, protection.id, {
        strategyState: {
          ...strategyState,
          status: 'deactivating',
          lastActualQty: 0,
        },
      }).catch((err) => logger.warn('updateStrategyState on deactivation failed', { poolId: protection.id, error: err.message }));
      return this.repo.getById(protection.userId, protection.id);
    }

    try {
      await tradingService.closePosition({
        asset: protection.inferredAsset,
        size: actualQty,
      });
      // Reconciliar el realized PnL del cierre antes de marcar como
      // desactivado: los $ perdidos en el close van al accounting del
      // orquestador en el siguiente tick.
      try {
        const wasNeverReconciledClose = !strategyState.lastReconciledFillsAt;
        const fillsSince = Number(strategyState.lastReconciledFillsAt || 0);
        const reconciled = await this._reconcileHedgeFills(protection, hl, fillsSince);
        if (reconciled.fillsCount > 0 || reconciled.lastFillTime > fillsSince) {
          await this.repo.updateStrategyState(protection.userId, protection.id, {
            strategyState: {
              ...strategyState,
              hedgeRealizedPnlUsd: wasNeverReconciledClose
                ? reconciled.realizedDelta
                : Number(strategyState.hedgeRealizedPnlUsd || 0) + reconciled.realizedDelta,
              executionFeesUsd: wasNeverReconciledClose
                ? reconciled.feeDelta
                : Number(strategyState.executionFeesUsd || 0) + reconciled.feeDelta,
              hedgeUnrealizedPnlUsd: 0,
              lastReconciledFillsAt: reconciled.lastFillTime,
              lastActualQty: 0,
            },
          });
        }
      } catch (reconcileErr) {
        this.logger.warn('hedge_fills_reconcile_on_deactivation_failed', {
          protectionId: protection.id,
          error: reconcileErr.message,
        });
      }
      const deactivatedAt = Date.now();
      const finalRangeMetrics = await timeInRangeService.computeIncrementalRangeMetrics(protection, {
        endAt: deactivatedAt,
        rangeFrozenAt: deactivatedAt,
      });
      await this.repo.deactivate(protection.userId, protection.id, {
        deactivatedAt,
        ...(finalRangeMetrics ? {
          ...finalRangeMetrics,
          poolSnapshot: timeInRangeService.applyRangeMetricsToSnapshot(protection.poolSnapshot || {}, finalRangeMetrics),
        } : {}),
      });
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

  async _ensureIsolatedMarginBuffer(protection, hl, currentPrice, qtyToAdd, actualQty = 0) {
    const assetMeta = await hl.getAssetMeta(protection.inferredAsset);
    await hl.updateLeverage(assetMeta.index, false, protection.leverage);
    if (Number(actualQty || 0) <= 0) {
      return;
    }
    const notionalUsd = Math.abs(qtyToAdd) * currentPrice;
    const marginUsd = Math.ceil((notionalUsd / Math.max(Number(protection.leverage || 1), 1)) * 1.2);
    if (marginUsd > 0) {
      await hl.updateIsolatedMargin(assetMeta.index, false, marginUsd).catch((err) => logger.warn('updateIsolatedMargin failed', { poolId: protection.id, asset: protection.inferredAsset, marginUsd, error: err.message }));
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
module.exports.DEFAULT_EXECUTION_MODE = DEFAULT_EXECUTION_MODE;
module.exports.buildInitialStrategyState = buildInitialStrategyState;
module.exports.computeVolatilityStats = computeVolatilityStats;
module.exports.deriveBandSettings = deriveBandSettings;
module.exports.normalizeStrategyState = normalizeStrategyState;
