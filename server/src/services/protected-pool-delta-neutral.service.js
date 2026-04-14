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
  buildSyntheticLpState,
} = require('./delta-neutral-math.service');
const hyperliquidStreamService = require('./hyperliquid-stream.service');
const rpcBudgetManager = require('./rpc-budget-manager.service');
const settingsService = require('./settings.service');
const telegramRegistry = require('./telegram.registry');
const {
  computeSnapshotHash,
  normalizeProtectionSnapshot,
  validateNormalizedProtectionSnapshot,
} = require('./delta-neutral-snapshot.service');
const MAX_SNAPSHOT_FALLBACK_AGE_MS = 2 * 60_000;
const BLOCK_NOTIFICATION_THROTTLE_MS = 15 * 60_000;
const BLOCK_NOTIFICATION_DEDUPE_MS = 2 * 60_000;
const NEAR_ZERO_TARGET_QTY = 1e-6;
const POSITION_MISSING_CONFIRMATION_COUNT = 2;
const POSITION_MISSING_GRACE_MS = 15 * 60_000;
const {
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
  DEFAULT_MAX_AUTO_TOPUPS_PER_24H,
  DEFAULT_MIN_AUTO_TOPUP_CAP_USD,
  DEFAULT_AUTO_TOPUP_CAP_PCT_OF_INITIAL,
  DEFAULT_MIN_AUTO_TOPUP_FLOOR_USD,
  DEFAULT_RISK_PAUSE_LIQ_DISTANCE_PCT,
  DEFAULT_MARGIN_TOP_UP_LIQ_DISTANCE_PCT,
  EXCHANGE_MIN_NOTIONAL_USD,
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
    this.hyperliquidStreamService = deps.hyperliquidStreamService || hyperliquidStreamService;
    this.rpcBudgetManager = deps.rpcBudgetManager || rpcBudgetManager;
    this.settingsService = deps.settingsService || settingsService;
    this.telegramRegistry = deps.telegramRegistry || telegramRegistry;
    this.logger = deps.logger || logger;
    this.loopMs = deps.loopMs || config.intervals.deltaNeutralLoopMs || 2_000;
    this.fullEvalMs = deps.fullEvalMs || config.intervals.deltaNeutralEvalMs || 30_000;
    this.trackingMode = deps.trackingMode || config.deltaNeutral.trackingMode || 'hybrid';
    this.truthRefreshNormalMs = deps.truthRefreshNormalMs || config.deltaNeutral.truthRefreshNormalMs;
    this.truthRefreshEdgeMs = deps.truthRefreshEdgeMs || config.deltaNeutral.truthRefreshEdgeMs;
    this.fullScanTtlMs = deps.fullScanTtlMs || config.deltaNeutral.fullScanTtlMs;
    this.basisGuardBps = deps.basisGuardBps || config.deltaNeutral.basisGuardBps;
    this.lowConfidenceBasisBps = deps.lowConfidenceBasisBps || config.deltaNeutral.lowConfidenceBasisBps;
    this.minDwellMs = deps.minDwellMs || config.deltaNeutral.minDwellMs;
    this.interval = null;
    this.running = false;
    this.lastEvalAt = new Map();
    this.twapSessions = new Map();
    this.rvCache = new Map();
    this.blockNotifLastSentAt = new Map();
    this.hybridStats = {
      marketTicks: 0,
      truthRefreshes: 0,
      inspectRefreshes: 0,
      fullScans: 0,
      truthRefreshDeferred: 0,
    };
  }

  async _getRiskControls(userId) {
    const controls = await this.settingsService.getDeltaNeutralRiskControls(userId).catch((err) => {
      this.logger.warn('delta_neutral_risk_controls_load_failed', { userId, error: err.message });
      return null;
    });
    return {
      riskPauseLiqDistancePct: Number(controls?.riskPauseLiqDistancePct) || DEFAULT_RISK_PAUSE_LIQ_DISTANCE_PCT,
      marginTopUpLiqDistancePct: Number(controls?.marginTopUpLiqDistancePct) || DEFAULT_MARGIN_TOP_UP_LIQ_DISTANCE_PCT,
      maxAutoTopUpsPer24h: Number(controls?.maxAutoTopUpsPer24h) || DEFAULT_MAX_AUTO_TOPUPS_PER_24H,
      minAutoTopUpCapUsd: Number(controls?.minAutoTopUpCapUsd) || DEFAULT_MIN_AUTO_TOPUP_CAP_USD,
      autoTopUpCapPctOfInitial: Number(controls?.autoTopUpCapPctOfInitial) || DEFAULT_AUTO_TOPUP_CAP_PCT_OF_INITIAL,
      minAutoTopUpFloorUsd: Number(controls?.minAutoTopUpFloorUsd) >= 0 ? Number(controls.minAutoTopUpFloorUsd) : DEFAULT_MIN_AUTO_TOPUP_FLOOR_USD,
    };
  }

  _computeAutoTopUpCapUsd(protection, riskControls) {
    return Math.max(
      Number(riskControls?.minAutoTopUpCapUsd) || DEFAULT_MIN_AUTO_TOPUP_CAP_USD,
      (Number(riskControls?.autoTopUpCapPctOfInitial) || DEFAULT_AUTO_TOPUP_CAP_PCT_OF_INITIAL) / 100
        * Number(protection.initialConfiguredHedgeNotionalUsd || protection.configuredHedgeNotionalUsd || 0)
    );
  }

  start() {
    if (this.interval) return;
    this.hyperliquidStreamService.start?.();
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
    this.hyperliquidStreamService.stop?.();
  }

  getHybridDiagnostics() {
    return {
      trackingMode: this.trackingMode,
      stats: { ...this.hybridStats },
      rpcBudget: this.rpcBudgetManager.getSnapshot?.() || null,
      stream: this.hyperliquidStreamService.getDiagnostics?.() || null,
    };
  }

  _recordHybridStat(key) {
    this.hybridStats[key] = Number(this.hybridStats[key] || 0) + 1;
  }

  _trackProtection(protection) {
    this.hyperliquidStreamService.trackProtection?.(protection);
  }

  _deriveZoneState(protection, currentPrice) {
    const distancePct = Number(distanceToRangePct(protection, currentPrice));
    if (!Number.isFinite(distancePct)) return 'center';
    const currentBoundarySide = getCurrentBoundarySide(protection, currentPrice);
    if (currentBoundarySide && currentBoundarySide !== 'inside') return 'outside';
    if (distancePct <= 0.5) return 'edge';
    if (distancePct <= 2) return 'transition';
    return 'center';
  }

  _zoneMultiplier(zoneState) {
    if (zoneState === 'center') return 0.6;
    if (zoneState === 'transition') return 0.85;
    return 1;
  }

  _hasRealtimeMarketPrice(marketContext = null) {
    const source = String(marketContext?.source || '').trim().toLowerCase();
    const price = Number(marketContext?.hlPrice);
    return Number.isFinite(price) && price > 0 && source.startsWith('hl_ws_');
  }

  _computeBasisSpreadBps(currentPrice, truthPrice) {
    const current = Number(currentPrice);
    const truth = Number(truthPrice);
    if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(truth) || truth <= 0) return null;
    return Math.abs((current - truth) / truth) * 10_000;
  }

  _resolveModelConfidence({ truthAgeMs, basisSpreadBps, zoneState, truthPending = false }) {
    if (truthPending) return 'low';
    if (Number.isFinite(basisSpreadBps) && basisSpreadBps >= this.lowConfidenceBasisBps) return 'low';
    if (Number.isFinite(truthAgeMs) && truthAgeMs > Math.max(this.truthRefreshNormalMs * 2, this.truthRefreshEdgeMs * 3)) {
      return 'low';
    }
    if (zoneState === 'edge' || zoneState === 'outside') {
      if (Number.isFinite(truthAgeMs) && truthAgeMs <= this.truthRefreshEdgeMs && (!Number.isFinite(basisSpreadBps) || basisSpreadBps <= this.basisGuardBps)) {
        return 'high';
      }
      return 'medium';
    }
    if (Number.isFinite(truthAgeMs) && truthAgeMs <= this.truthRefreshNormalMs && (!Number.isFinite(basisSpreadBps) || basisSpreadBps <= this.basisGuardBps)) {
      return 'high';
    }
    return 'medium';
  }

  async _getHybridMarketContext(protection) {
    this._trackProtection(protection);
    const user = protection?.account?.address || protection?.walletAddress;
    const [mid, bbo, assetContext, clearinghouseState] = await Promise.all([
      this.hyperliquidStreamService.getMidPrice(protection.inferredAsset).catch(() => null),
      this.hyperliquidStreamService.getBbo(protection.inferredAsset).catch(() => null),
      this.hyperliquidStreamService.getActiveAssetCtx(protection.inferredAsset).catch(() => null),
      this.hyperliquidStreamService.getClearinghouseState(user).catch(() => null),
    ]);
    const hlPrice = Number(bbo?.mid ?? mid?.price ?? assetContext?.midPx ?? assetContext?.markPx);
    let source = 'unavailable';
    if (bbo?.mid != null) source = bbo.source === 'http' ? 'hl_http_bbo' : 'hl_ws_bbo';
    else if (mid?.price != null) source = mid.source === 'http' ? 'hl_http_mid' : 'hl_ws_mid';
    else if (assetContext?.midPx != null || assetContext?.markPx != null) source = assetContext.source === 'http' ? 'hl_http_asset_ctx' : 'hl_ws_asset_ctx';

    return {
      hlPrice: Number.isFinite(hlPrice) && hlPrice > 0 ? hlPrice : null,
      source,
      mid,
      bbo,
      assetContext,
      clearinghouseState: clearinghouseState?.state || clearinghouseState || null,
    };
  }

  _buildDigitalTwin(protection, marketContext) {
    const snapshot = safeJsonClone(protection?.poolSnapshot || {});
    const baseTwin = buildSyntheticLpState(snapshot, {
      volatilePriceUsd: marketContext?.hlPrice,
      targetHedgeRatio: protection.targetHedgeRatio ?? DEFAULT_TARGET_HEDGE_RATIO,
    });
    if (!baseTwin?.eligible) {
      return {
        ...baseTwin,
        zoneState: 'center',
        targetHedgeRatioApplied: protection.targetHedgeRatio ?? DEFAULT_TARGET_HEDGE_RATIO,
      };
    }

    const zoneState = this._deriveZoneState(protection, baseTwin.syntheticPriceCurrent);
    const targetHedgeRatioApplied = Number(protection.targetHedgeRatio ?? DEFAULT_TARGET_HEDGE_RATIO) * this._zoneMultiplier(zoneState);
    const tunedTwin = buildSyntheticLpState(snapshot, {
      volatilePriceUsd: marketContext?.hlPrice,
      targetHedgeRatio: targetHedgeRatioApplied,
    });

    return {
      ...tunedTwin,
      zoneState,
      targetHedgeRatioApplied,
    };
  }

  async _resolvePricingContext(protection, snapshotMeta, liveMarket) {
    const marketTwin = this._buildDigitalTwin(protection, liveMarket);
    const marketPrice = Number(marketTwin?.syntheticPriceCurrent);
    const liveSource = liveMarket?.source || 'unavailable';

    if (this._hasRealtimeMarketPrice(liveMarket) && marketTwin?.eligible && Number.isFinite(marketPrice) && marketPrice > 0) {
      return {
        currentPrice: marketPrice,
        twin: marketTwin,
        spotSource: liveSource,
        spotFailureReason: null,
      };
    }

    const snapshotPrice = Number(protection?.poolSnapshot?.priceCurrent ?? protection?.priceCurrent);
    const snapshotAgeMs = Math.max(Date.now() - Number(snapshotMeta?.snapshotFreshAt || protection?.snapshotFreshAt || 0), 0);
    if (Number.isFinite(snapshotPrice) && snapshotPrice > 0 && snapshotAgeMs <= MAX_SNAPSHOT_FALLBACK_AGE_MS) {
      return {
        currentPrice: snapshotPrice,
        twin: this._buildDigitalTwin(protection, { hlPrice: snapshotPrice }),
        spotSource: 'snapshot',
        spotFailureReason: null,
      };
    }

    const spot = await this._fetchSpot(protection).catch(() => null);
    const spotPrice = Number(spot?.priceCurrent);
    if (Number.isFinite(spotPrice) && spotPrice > 0) {
      return {
        currentPrice: spotPrice,
        twin: this._buildDigitalTwin(protection, { hlPrice: spotPrice }),
        spotSource: 'pool_spot',
        spotFailureReason: null,
      };
    }

    return {
      currentPrice: null,
      twin: marketTwin,
      spotSource: liveSource,
      spotFailureReason: 'No se pudo obtener el precio actual del pool.',
    };
  }

  _shouldRefreshTruth({
    protection,
    strategyState,
    forceReason,
    zoneState,
    truthAgeMs,
    basisSpreadBps,
    modelConfidence,
  }) {
    if (!protection?.poolSnapshot) {
      return { refresh: true, reason: 'missing_snapshot', urgent: true, useFullScan: true };
    }
    if (forceReason === 'restart_reconcile') {
      return { refresh: true, reason: 'restart_reconcile', urgent: true, useFullScan: false };
    }
    if (forceReason === 'boundary_cross') {
      return { refresh: true, reason: 'boundary_cross', urgent: true, useFullScan: false };
    }
    if (strategyState.truthPending) {
      return { refresh: true, reason: 'truth_pending', urgent: true, useFullScan: false };
    }
    if (Number.isFinite(basisSpreadBps) && basisSpreadBps >= this.lowConfidenceBasisBps) {
      return { refresh: true, reason: 'basis_high', urgent: true, useFullScan: false };
    }
    if (modelConfidence === 'low') {
      return { refresh: true, reason: 'low_confidence', urgent: true, useFullScan: false };
    }
    const lastFullScanAt = Number(strategyState.lastFullScanAt || 0);
    if (lastFullScanAt > 0 && Date.now() - lastFullScanAt >= this.fullScanTtlMs) {
      return { refresh: true, reason: 'maintenance_full_scan', urgent: false, useFullScan: true };
    }
    if ((zoneState === 'edge' || zoneState === 'outside') && truthAgeMs >= this.truthRefreshEdgeMs) {
      return { refresh: true, reason: 'near_edge_truth_refresh', urgent: true, useFullScan: false };
    }
    if (truthAgeMs >= this.truthRefreshNormalMs) {
      return { refresh: true, reason: 'normal_truth_refresh', urgent: false, useFullScan: false };
    }
    return { refresh: false, reason: null, urgent: false, useFullScan: false };
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
      // El cliente `hl` ya está vinculado a la cuenta Hyperliquid correcta.
      // Si forzamos `protection.walletAddress` aquí, terminamos consultando
      // la wallet del LP y no la cuenta de trading del hedge. En ese caso los
      // fills del short no aparecen y el PnL realizado queda falsamente en 0.
      fills = await hl.getUserFills();
    } catch (err) {
      this.logger.warn('hedge_fills_fetch_failed', {
        protectionId: protection?.id,
        asset: protection?.inferredAsset,
        queriedAddress: hl?.address || null,
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

  _normalizeBlockReason(reason = '') {
    const normalized = String(reason || '').trim().toLowerCase();
    if (!normalized) return 'unknown';
    if (normalized.includes('insufficient_margin') || normalized.includes('insufficient margin') || normalized.includes('margen insuficiente')) {
      return 'insufficient_margin';
    }
    if (normalized.includes('cooldown_active') || normalized.includes('cooldown activo')) {
      return 'cooldown_active';
    }
    return normalized.replace(/\s+/g, '_');
  }

  _serializePositionSnapshot(position) {
    if (!position) return null;
    return {
      coin: position.coin || null,
      szi: position.szi != null ? Number(position.szi) : null,
      liquidationPx: position.liquidationPx != null ? Number(position.liquidationPx) : null,
      unrealizedPnl: position.unrealizedPnl != null ? Number(position.unrealizedPnl) : null,
      leverage: position.leverage || null,
      cumFunding: position.cumFunding || null,
    };
  }

  _hasRecentSuccessfulExecution(strategyState, now = Date.now()) {
    const outcome = String(strategyState?.lastExecutionOutcome || '').trim().toLowerCase();
    const recentAttemptAt = Number(strategyState?.lastExecutionAttemptAt || strategyState?.lastRebalanceAt || 0);
    if (!recentAttemptAt || !['success', 'partial', 'pending'].includes(outcome)) return false;
    return (now - recentAttemptAt) <= POSITION_MISSING_GRACE_MS;
  }

  _hasRecentFillEvidence(strategyState, now = Date.now()) {
    const lastReconciledFillsAt = Number(strategyState?.lastReconciledFillsAt || 0);
    if (!lastReconciledFillsAt) return false;
    return (now - lastReconciledFillsAt) <= POSITION_MISSING_GRACE_MS;
  }

  _extractShortQty(position) {
    return position && Number(position.szi) < 0 ? Math.abs(Number(position.szi)) : 0;
  }

  async _readPositionAttempt(hl, protection, label) {
    try {
      const position = await hl.getPosition(protection.inferredAsset);
      return { position, error: null, label };
    } catch (err) {
      this.logger.warn('delta_neutral_get_position_failed', {
        protectionId: protection.id,
        accountId: protection.accountId,
        asset: protection.inferredAsset,
        readLabel: label,
        error: err.message,
      });
      return { position: null, error: err, label };
    }
  }

  async _observeHedgePosition({ protection, hl, strategyState, forceReason = null }) {
    const now = Date.now();
    const fallbackActualQty = Math.max(Number(
      strategyState?.lastActualQty
      ?? protection?.hedgeSize
      ?? 0
    ) || 0, 0);
    const first = await this._readPositionAttempt(hl, protection, 'primary');
    const firstActualQty = this._extractShortQty(first.position);

    if (first.position) {
      return {
        position: first.position,
        rawPosition: first.position,
        actualQtyRaw: firstActualQty,
        effectiveActualQty: firstActualQty,
        positionObserved: true,
        positionMissingUnconfirmed: false,
        positionMissingConfirmed: false,
        positionMissingSince: null,
        positionMissingConsecutiveCount: 0,
        lastPositionReadAt: now,
        lastPositionReadSource: firstActualQty > 0 ? 'short_position' : 'non_short_position',
        readCount: 1,
        fallbackActualQty,
      };
    }

    const missingHints = {
      lastActualQty: fallbackActualQty > 1e-8,
      recentExecution: this._hasRecentSuccessfulExecution(strategyState, now),
      recentFills: this._hasRecentFillEvidence(strategyState, now),
    };
    const shouldVerifyMissing = Object.values(missingHints).some(Boolean);
    const priorMissingCount = Number(strategyState?.positionMissingConsecutiveCount || 0);
    const missingSince = Number(strategyState?.positionMissingSince || now);

    if (!shouldVerifyMissing) {
      return {
        position: null,
        rawPosition: null,
        actualQtyRaw: 0,
        effectiveActualQty: 0,
        positionObserved: false,
        positionMissingUnconfirmed: false,
        positionMissingConfirmed: true,
        positionMissingSince: missingSince,
        positionMissingConsecutiveCount: priorMissingCount + 1,
        lastPositionReadAt: now,
        lastPositionReadSource: 'missing_without_recent_evidence',
        readCount: 1,
        fallbackActualQty,
      };
    }

    const second = await this._readPositionAttempt(hl, protection, 'retry');
    const secondActualQty = this._extractShortQty(second.position);
    if (second.position) {
      return {
        position: second.position,
        rawPosition: second.position,
        actualQtyRaw: secondActualQty,
        effectiveActualQty: secondActualQty,
        positionObserved: true,
        positionMissingUnconfirmed: false,
        positionMissingConfirmed: false,
        positionMissingSince: null,
        positionMissingConsecutiveCount: 0,
        lastPositionReadAt: now,
        lastPositionReadSource: secondActualQty > 0 ? 'retry_short_position' : 'retry_non_short_position',
        readCount: 2,
        fallbackActualQty,
      };
    }

    const consecutiveMissing = priorMissingCount + 1;
    const positionMissingConfirmed = consecutiveMissing >= POSITION_MISSING_CONFIRMATION_COUNT
      || forceReason === 'restart_reconcile';
    return {
      position: null,
      rawPosition: null,
      actualQtyRaw: 0,
      effectiveActualQty: positionMissingConfirmed ? 0 : fallbackActualQty,
      positionObserved: false,
      positionMissingUnconfirmed: !positionMissingConfirmed,
      positionMissingConfirmed,
      positionMissingSince: missingSince,
      positionMissingConsecutiveCount: consecutiveMissing,
      lastPositionReadAt: now,
      lastPositionReadSource: positionMissingConfirmed ? 'missing_confirmed_after_retry' : 'missing_unconfirmed_after_retry',
      readCount: 2,
      fallbackActualQty,
      missingHints,
    };
  }

  async _notifyBlock(protection, { blockType, reason, detail, extra = {} }) {
    const normalizedReason = this._normalizeBlockReason(reason || detail || blockType);
    const semanticKey = `semantic:${protection.id}:${normalizedReason}`;
    const throttleKey = `block:${protection.id}:${blockType}:${normalizedReason}`;
    const now = Date.now();
    const lastSemanticSent = this.blockNotifLastSentAt.get(semanticKey) || 0;
    const lastSent = this.blockNotifLastSentAt.get(throttleKey) || 0;
    if (
      blockType === 'cooldown_active'
      && normalizedReason === 'insufficient_margin'
      && (now - lastSemanticSent) < BLOCK_NOTIFICATION_DEDUPE_MS
    ) {
      return;
    }
    if ((now - lastSent) < BLOCK_NOTIFICATION_THROTTLE_MS) return;

    this.blockNotifLastSentAt.set(throttleKey, now);
    this.blockNotifLastSentAt.set(semanticKey, now);

    if (this.blockNotifLastSentAt.size > 500) {
      const cutoff = now - 60 * 60_000;
      for (const [k, ts] of this.blockNotifLastSentAt) {
        if (ts < cutoff) this.blockNotifLastSentAt.delete(k);
      }
    }

    try {
      const tg = await this.telegramRegistry.getOrCreate(protection.userId);
      if (tg && tg.enabled) {
        await tg.notifyDeltaNeutralBlock({ protection, blockType, reason, detail, extra });
      }
    } catch (err) {
      this.logger.warn('delta_neutral_block_telegram_failed', {
        protectionId: protection.id,
        blockType,
        error: err.message,
      });
    }
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

  async _refreshProtectionTruth(protection, {
    strategyState = normalizeStrategyState(protection?.strategyState),
    reason = 'normal_truth_refresh',
    urgent = false,
    useFullScan = false,
  } = {}) {
    const weight = useFullScan ? 25 : 3;
    const budget = this.rpcBudgetManager.canSpend?.({ weight, urgent }) || { allowed: true, snapshot: null };
    if (!budget.allowed) {
      this._recordHybridStat('truthRefreshDeferred');
      return {
        protection,
        refreshed: false,
        deferred: true,
        reason: budget.reason,
        budget: budget.snapshot || null,
      };
    }

    const persistSuccessState = async (freshProtection, nextStrategyState = {}) => {
      await this.repo.updateStrategyState(freshProtection.userId, freshProtection.id, {
        strategyState: {
          ...normalizeStrategyState(freshProtection.strategyState),
          ...nextStrategyState,
          trackingMode: this.trackingMode,
          lastTruthAt: Date.now(),
          lastTruthPrice: Number(freshProtection.poolSnapshot?.priceCurrent ?? freshProtection.priceCurrent ?? 0) || null,
          lastTruthReason: reason,
          truthPending: false,
          consecutiveTruthFailures: 0,
          consecutiveInspectFailures: 0,
          rpcBudgetState: budget.snapshot || this.rpcBudgetManager.getSnapshot?.() || null,
          ...(useFullScan ? { lastFullScanAt: Date.now() } : {}),
        },
      });
      return this.repo.getById(freshProtection.userId, freshProtection.id);
    };

    try {
      this.rpcBudgetManager.record?.({
        kind: useFullScan ? 'truth_full_scan' : 'truth_direct_inspect',
        protectionId: protection.id,
        urgent,
        weight,
      });

      if (useFullScan) {
        this._recordHybridStat('truthRefreshes');
        this._recordHybridStat('fullScans');
        const refreshedProtection = await this._refreshProtectionSnapshot(protection);
        if (!refreshedProtection) {
          throw new Error('No se pudo refrescar el snapshot via full scan.');
        }
        return {
          protection: await persistSuccessState(refreshedProtection),
          refreshed: true,
          source: 'full_scan',
        };
      }

      this._recordHybridStat('truthRefreshes');
      this._recordHybridStat('inspectRefreshes');
      const freshPool = await this.uniswapService.inspectPositionByIdentifier({
        userId: protection.userId,
        wallet: protection.walletAddress,
        network: protection.network,
        version: protection.version,
        positionIdentifier: protection.positionIdentifier,
        lightweight: true,
      });

      if (!freshPool) {
        const nextFailures = Number(strategyState.consecutiveInspectFailures || 0) + 1;
        await this.repo.updateStrategyState(protection.userId, protection.id, {
          strategyState: {
            ...strategyState,
            trackingMode: this.trackingMode,
            truthPending: true,
            lastTruthReason: `${reason}:position_missing`,
            consecutiveInspectFailures: nextFailures,
            consecutiveTruthFailures: Number(strategyState.consecutiveTruthFailures || 0),
            rpcBudgetState: budget.snapshot || this.rpcBudgetManager.getSnapshot?.() || null,
          },
        });
        if (urgent || nextFailures >= 2) {
          return this._refreshProtectionTruth(protection, {
            strategyState: {
              ...strategyState,
              consecutiveInspectFailures: nextFailures,
            },
            reason: `${reason}:fallback_full_scan`,
            urgent,
            useFullScan: true,
          });
        }
        return {
          protection,
          refreshed: false,
          missing: true,
          source: 'direct_inspect',
        };
      }

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

      const refreshedProtection = await this.repo.getById(protection.userId, protection.id);
      return {
        protection: await persistSuccessState(refreshedProtection),
        refreshed: true,
        source: 'direct_inspect',
      };
    } catch (err) {
      const nextFailures = Number(strategyState.consecutiveTruthFailures || 0) + 1;
      await this.repo.updateStrategyState(protection.userId, protection.id, {
        strategyState: {
          ...strategyState,
          trackingMode: this.trackingMode,
          truthPending: true,
          lastTruthReason: `${reason}:failed`,
          consecutiveTruthFailures: nextFailures,
          rpcBudgetState: budget.snapshot || this.rpcBudgetManager.getSnapshot?.() || null,
        },
      });
      this.logger.warn('protected_pool_truth_refresh_failed', {
        protectionId: protection.id,
        reason,
        useFullScan,
        error: err.message,
      });
      if (!useFullScan && (urgent || nextFailures >= 2)) {
        return this._refreshProtectionTruth(protection, {
          strategyState: {
            ...strategyState,
            consecutiveTruthFailures: nextFailures,
          },
          reason: `${reason}:full_scan_after_failure`,
          urgent,
          useFullScan: true,
        });
      }
      return {
        protection,
        refreshed: false,
        failed: true,
        source: useFullScan ? 'full_scan' : 'direct_inspect',
      };
    }
  }

  async _buildPreflight({
    protection,
    hl,
    strategyState,
    actualQty: _actualQty,
    currentPrice,
    tracking,
    bands,
    decision,
    accountState = null,
    assetContext = null,
    bbo = null,
    positionObserved = false,
    positionReadSource = null,
    positionMissingUnconfirmed = false,
  }) {
    let resolvedAccountState = accountState || await hl.getClearinghouseState().catch(() => null);
    const hasProtectionCooldownReason = Boolean(protection)
      && Object.prototype.hasOwnProperty.call(protection, 'cooldownReason');
    const cooldownReason = ((hasProtectionCooldownReason ? protection.cooldownReason : strategyState.cooldownReason) || '').trim();
    const targetIncreaseQty = Math.max(Number(tracking.trackingErrorQty || 0), 0);
    const increaseNotionalUsd = targetIncreaseQty * currentPrice;
    let requiredMarginUsd = increaseNotionalUsd / Math.max(Number(protection.leverage || 1), 1);
    let withdrawable = Number(resolvedAccountState?.withdrawable || 0);
    const cooldownActive = isCooldownActive(protection, strategyState);
    const snapshotStatus = protection.snapshotStatus || 'ready';
    const resolvedAssetContext = assetContext || (() => null)();

    if (targetIncreaseQty > 0 && withdrawable <= 0) {
      const freshAccountState = await hl.getClearinghouseState().catch(() => null);
      const freshWithdrawable = Number(freshAccountState?.withdrawable || 0);
      if (freshAccountState && freshWithdrawable !== withdrawable) {
        this.logger.info?.('delta_neutral_withdrawable_refreshed', {
          protectionId: protection.id,
          accountId: protection.accountId,
          asset: protection.inferredAsset,
          cachedWithdrawable: withdrawable,
          freshWithdrawable,
        });
        resolvedAccountState = freshAccountState;
        withdrawable = freshWithdrawable;
      }
    }

    if (snapshotStatus !== 'ready') {
      return {
        ok: false,
        status: 'snapshot_invalid',
        reason: `snapshot_${snapshotStatus}`,
        executionSkippedBecause: `snapshot_${snapshotStatus}`,
        withdrawable,
        requiredMarginUsd,
        positionObserved,
        positionReadSource,
        positionMissingUnconfirmed,
      };
    }
    const marginCooldownActive = cooldownActive && cooldownReason === 'insufficient_margin';
    if (cooldownActive && !(marginCooldownActive && (targetIncreaseQty <= 0 || requiredMarginUsd <= withdrawable))) {
      return {
        ok: false,
        status: strategyState.status || 'tracking',
        reason: 'cooldown_active',
        executionSkippedBecause: cooldownReason || 'cooldown_active',
        withdrawable,
        requiredMarginUsd,
        positionObserved,
        positionReadSource,
        positionMissingUnconfirmed,
      };
    }
    const effectiveMinOrderNotionalUsd = Math.max(
      Number(protection.minOrderNotionalUsd || DEFAULT_MIN_ORDER_NOTIONAL_USD),
      EXCHANGE_MIN_NOTIONAL_USD,
    );
    if (decision !== 'hold' && tracking.trackingErrorUsd < effectiveMinOrderNotionalUsd) {
      return {
        ok: false,
        status: 'tracking',
        reason: 'below_min_order_notional',
        executionSkippedBecause: 'below_min_order_notional',
        withdrawable,
        requiredMarginUsd,
        positionObserved,
        positionReadSource,
        positionMissingUnconfirmed,
      };
    }
    if (targetIncreaseQty > 0 && requiredMarginUsd > withdrawable) {
      return {
        ok: false,
        status: 'margin_pending',
        reason: 'insufficient_margin',
        executionSkippedBecause: 'insufficient_margin',
        withdrawable,
        requiredMarginUsd,
        positionObserved,
        positionReadSource,
        positionMissingUnconfirmed,
      };
    }
    if (Number.isFinite(Number(bbo?.spreadBps)) && Number(bbo.spreadBps) > Number(protection.maxSpreadBps ?? DEFAULT_MAX_SPREAD_BPS)) {
      return {
        ok: false,
        status: 'tracking',
        reason: 'spread_too_wide',
        executionSkippedBecause: 'spread_too_wide',
        withdrawable,
        requiredMarginUsd,
        positionObserved,
        positionReadSource,
        positionMissingUnconfirmed,
      };
    }
    if (Number(bands?.estimatedCostUsd || 0) > Number(protection.maxExecutionFeeUsd ?? DEFAULT_MAX_EXECUTION_FEE_USD)) {
      return {
        ok: false,
        status: 'tracking',
        reason: 'estimated_execution_fee_too_high',
        executionSkippedBecause: 'estimated_execution_fee_too_high',
        withdrawable,
        requiredMarginUsd,
        positionObserved,
        positionReadSource,
        positionMissingUnconfirmed,
      };
    }

    return {
      ok: true,
      status: 'rebalance_pending',
      reason: 'preflight_ok',
      executionSkippedBecause: null,
      withdrawable,
      requiredMarginUsd,
      fundingRate: resolvedAssetContext?.fundingRate != null ? Number(resolvedAssetContext.fundingRate) : null,
      spreadBps: Number.isFinite(Number(bbo?.spreadBps)) ? Number(bbo.spreadBps) : null,
      estimatedExecutionCostUsd: bands.estimatedCostUsd,
      positionObserved,
      positionReadSource,
      positionMissingUnconfirmed,
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
    const strategyState = normalizeStrategyState(protection.strategyState);
    const marketContext = await this._getHybridMarketContext(protection).catch(() => null);
    const twin = this._buildDigitalTwin(protection, marketContext);
    const currentPrice = Number(twin?.syntheticPriceCurrent ?? protection.poolSnapshot?.priceCurrent ?? protection.priceCurrent);
    const currentBoundarySide = getCurrentBoundarySide(protection, currentPrice);
    const lastBoundarySide = strategyState.lastObservedBoundarySide || 'inside';
    const crossedBoundary = currentBoundarySide && lastBoundarySide !== currentBoundarySide;
    const zoneState = this._deriveZoneState(protection, currentPrice);
    const nearBoundary = zoneState === 'edge' || zoneState === 'outside';
    const evalDue = (now - (this.lastEvalAt.get(protection.id) || 0)) >= this.fullEvalMs
      || normalizeStrategyState(protection.strategyState).truthPending === true;

    if (!evalDue && !crossedBoundary && !nearBoundary) return;

    this._recordHybridStat('marketTicks');
    this.lastEvalAt.set(protection.id, now);
    await this.evaluateProtection(protection, {
      marketContext,
      forceReason: crossedBoundary ? 'boundary_cross' : nearBoundary ? 'boundary_watch' : null,
    });
  }

  async evaluateProtection(protection, { marketContext = null, forceReason = null, forceRebalance = false } = {}) {
    const current = await this.repo.getById(protection.userId, protection.id);
    if (!current || current.status !== 'active' || current.protectionMode !== 'delta_neutral') {
      return null;
    }

    const strategyState = normalizeStrategyState(current.strategyState);
    let activeProtection = current;
    if ((current.snapshotStatus && current.snapshotStatus !== 'ready') || !current.poolSnapshot) {
      const refreshed = await this._refreshProtectionTruth(current, {
        strategyState,
        reason: 'bootstrap_missing_snapshot',
        urgent: true,
        useFullScan: true,
      }).catch(() => null);
      activeProtection = refreshed?.protection || current;
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
      this._notifyBlock(current, {
        blockType: 'snapshot_invalid',
        reason: invalidState.lastError,
        detail: snapshotMeta.validation.reasons.join(', '),
      }).catch(() => {});
      return null;
    }

    const hl = await this.hlRegistry.getOrCreate(activeProtection.userId, activeProtection.accountId);
    const tradingService = await this.getTradingService(activeProtection.userId, activeProtection.accountId);
    let liveMarket = marketContext || await this._getHybridMarketContext(activeProtection).catch(() => null);
    if (!liveMarket?.clearinghouseState) {
      const fallbackAccountState = await hl.getClearinghouseState().catch(() => null);
      if (fallbackAccountState) {
        liveMarket = {
          ...(liveMarket || {}),
          clearinghouseState: fallbackAccountState,
        };
      }
    }
    let {
      currentPrice,
      twin,
      spotSource,
      spotFailureReason,
    } = await this._resolvePricingContext(activeProtection, snapshotMeta, liveMarket);
    let truthAgeMs = Math.max(
      Date.now() - Number(strategyState.lastTruthAt || snapshotMeta.snapshotFreshAt || activeProtection.snapshotFreshAt || 0),
      0,
    );
    let basisSpreadBps = this._computeBasisSpreadBps(
      currentPrice,
      Number(strategyState.lastTruthPrice || activeProtection.poolSnapshot?.priceCurrent || activeProtection.priceCurrent),
    );
    let zoneState = twin?.zoneState || this._deriveZoneState(activeProtection, currentPrice);
    let modelConfidence = this._resolveModelConfidence({
      truthAgeMs,
      basisSpreadBps,
      zoneState,
      truthPending: strategyState.truthPending,
    });
    const refreshPolicy = this._shouldRefreshTruth({
      protection: activeProtection,
      strategyState,
      forceReason,
      zoneState,
      truthAgeMs,
      basisSpreadBps,
      modelConfidence,
    });
    if (refreshPolicy.refresh) {
      const refreshed = await this._refreshProtectionTruth(activeProtection, {
        strategyState,
        reason: refreshPolicy.reason,
        urgent: refreshPolicy.urgent,
        useFullScan: refreshPolicy.useFullScan,
      }).catch(() => null);
      if (refreshed?.protection) {
        activeProtection = refreshed.protection;
        snapshotMeta = this._normalizeSnapshot(activeProtection, activeProtection.poolSnapshot);
        liveMarket = await this._getHybridMarketContext(activeProtection).catch(() => liveMarket);
        if (!liveMarket?.clearinghouseState) {
          const fallbackAccountState = await hl.getClearinghouseState().catch(() => null);
          if (fallbackAccountState) {
            liveMarket = {
              ...(liveMarket || {}),
              clearinghouseState: fallbackAccountState,
            };
          }
        }
        ({
          currentPrice,
          twin,
          spotSource,
          spotFailureReason,
        } = await this._resolvePricingContext(activeProtection, snapshotMeta, liveMarket));
        truthAgeMs = Math.max(
          Date.now() - Number(activeProtection.strategyState?.lastTruthAt || snapshotMeta.snapshotFreshAt || 0),
          0,
        );
        basisSpreadBps = this._computeBasisSpreadBps(
          currentPrice,
          Number(activeProtection.strategyState?.lastTruthPrice || activeProtection.poolSnapshot?.priceCurrent || activeProtection.priceCurrent),
        );
        zoneState = twin?.zoneState || this._deriveZoneState(activeProtection, currentPrice);
        modelConfidence = this._resolveModelConfidence({
          truthAgeMs,
          basisSpreadBps,
          zoneState,
          truthPending: normalizeStrategyState(activeProtection.strategyState).truthPending,
        });
      }
    }

    if (!Number.isFinite(currentPrice) || currentPrice <= 0 || !twin?.eligible) {
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
      inRange: twin.syntheticInRange === true,
    };
    const metrics = twin;
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
    const positionObservation = await this._observeHedgePosition({
      protection: activeProtection,
      hl,
      strategyState,
      forceReason,
    });
    const position = positionObservation.position;
    const actualQty = positionObservation.effectiveActualQty;
    const currentBoundarySide = getCurrentBoundarySide(activeProtection, currentPrice);
    const riskControls = await this._getRiskControls(activeProtection.userId);
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
      positionMissingSince: positionObservation.positionMissingConfirmed || positionObservation.positionMissingUnconfirmed
        ? positionObservation.positionMissingSince
        : null,
      positionMissingConsecutiveCount: positionObservation.positionMissingConfirmed || positionObservation.positionMissingUnconfirmed
        ? positionObservation.positionMissingConsecutiveCount
        : 0,
      lastPositionReadAt: positionObservation.lastPositionReadAt,
      lastPositionReadSource: positionObservation.lastPositionReadSource,
      topUpMaxCount24h: Number(riskControls.maxAutoTopUpsPer24h) || DEFAULT_MAX_AUTO_TOPUPS_PER_24H,
      topUpCapUsd: this._computeAutoTopUpCapUsd(activeProtection, riskControls),
      lastObservedBoundarySide: currentBoundarySide,
      trackingMode: this.trackingMode,
      truthAgeMs,
      lastTruthAt: Number(activeProtection.strategyState?.lastTruthAt || strategyState.lastTruthAt || snapshotMeta.snapshotFreshAt || activeProtection.snapshotFreshAt || Date.now()),
      lastTruthPrice: Number(activeProtection.strategyState?.lastTruthPrice || strategyState.lastTruthPrice || activeProtection.poolSnapshot?.priceCurrent || activeProtection.priceCurrent || currentPrice),
      lastModelAt: Date.now(),
      lastModelPrice: currentPrice,
      modelConfidence,
      basisSpreadBps,
      consecutiveTruthFailures: Number((activeProtection.strategyState?.consecutiveTruthFailures ?? strategyState.consecutiveTruthFailures) || 0),
      consecutiveInspectFailures: Number((activeProtection.strategyState?.consecutiveInspectFailures ?? strategyState.consecutiveInspectFailures) || 0),
      zoneState,
      lastTrackedMidPrice: Number(liveMarket?.hlPrice || strategyState.lastTrackedMidPrice || 0) || null,
      lastBboSpreadBps: Number.isFinite(Number(liveMarket?.bbo?.spreadBps)) ? Number(liveMarket.bbo.spreadBps) : null,
      rpcBudgetState: this.rpcBudgetManager.getSnapshot?.() || strategyState.rpcBudgetState || null,
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
    nextState.truthPending = normalizeStrategyState(activeProtection.strategyState).truthPending === true;

    this.logger.info?.('delta_neutral_position_observed', {
      protectionId: activeProtection.id,
      accountId: activeProtection.accountId,
      asset: activeProtection.inferredAsset,
      forceReason: forceReason || null,
      positionObserved: positionObservation.positionObserved,
      positionReadSource: positionObservation.lastPositionReadSource,
      positionReadCount: positionObservation.readCount,
      positionMissingUnconfirmed: positionObservation.positionMissingUnconfirmed,
      positionMissingConfirmed: positionObservation.positionMissingConfirmed,
      actualQtyRaw: positionObservation.actualQtyRaw,
      actualQtyEffective: actualQty,
      lastActualQty: Number(strategyState.lastActualQty || 0),
      lastExecutionOutcome: strategyState.lastExecutionOutcome || null,
      lastReconciledFillsAt: Number(strategyState.lastReconciledFillsAt || 0) || null,
      rawPosition: this._serializePositionSnapshot(positionObservation.rawPosition),
    });

    if (positionObservation.positionMissingUnconfirmed) {
      nextState.status = 'reconciling';
      nextState.truthPending = true;
      nextState.lastError = 'Lectura de posicion no confirmada; se reintentara antes de reabrir el hedge.';
      nextState.lastDecision = 'hold';
      nextState.lastDecisionReason = 'position_unconfirmed';
      nextState.nextEligibleAttemptAt = null;
      nextState.cooldownReason = null;
      nextState.lastMissingDetectedAt = Date.now();

      this.logger.warn?.('delta_neutral_position_gap_unconfirmed', {
        protectionId: activeProtection.id,
        accountId: activeProtection.accountId,
        asset: activeProtection.inferredAsset,
        forceReason: forceReason || null,
        positionReadSource: positionObservation.lastPositionReadSource,
        positionMissingConsecutiveCount: positionObservation.positionMissingConsecutiveCount,
        fallbackActualQty: positionObservation.fallbackActualQty,
        targetQty: metrics.targetQty,
        trackingErrorUsd: tracking.trackingErrorUsd,
      });

      await this.repo.updateStrategyState(activeProtection.userId, activeProtection.id, {
        strategyState: nextState,
        priceCurrent: currentPrice,
        hedgeSize: actualQty,
        hedgeNotionalUsd: actualQty * currentPrice,
        snapshotStatus: snapshotMeta.validation.status,
        snapshotFreshAt: snapshotMeta.snapshotFreshAt,
        snapshotHash: snapshotMeta.snapshotHash,
        nextEligibleAttemptAt: null,
        cooldownReason: null,
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
        executionSkippedBecause: 'position_unconfirmed',
        executionMode: activeProtection.executionMode || DEFAULT_EXECUTION_MODE,
        estimatedCostUsd: rebalanceDecision.bands.estimatedCostUsd,
        targetQty: metrics.targetQty,
        actualQty,
        trackingErrorQty: tracking.trackingErrorQty,
        trackingErrorUsd: tracking.trackingErrorUsd,
        currentPrice,
        finalStrategyStatus: nextState.status,
        riskGateTriggered: false,
        liquidationDistancePct: distanceToLiqPct,
        modelConfidence: nextState.modelConfidence,
        basisSpreadBps: nextState.basisSpreadBps,
        zoneState: nextState.zoneState,
      });
      return nextState;
    }

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
      const riskBlockType = !marginModeVerified ? 'risk_paused_margin_mode' : 'risk_paused_manual_long';
      this._notifyBlock(activeProtection, {
        blockType: riskBlockType,
        reason: nextState.lastError,
        extra: { liquidationDistancePct: distanceToLiqPct },
      }).catch(() => {});
      return nextState;
    }

    if (nextState.status === 'deactivating' || nextState.status === 'deactivation_pending') {
      return this._continueDeactivation({ ...activeProtection, strategyState: nextState }, { tradingService, hl, actualQty, currentPrice });
    }

    if (Number.isFinite(distanceToLiqPct)) {
      if (distanceToLiqPct <= riskControls.riskPauseLiqDistancePct) {
        forcedStatus = 'risk_paused';
        nextState.lastError = 'La distancia a liquidacion es demasiado baja.';
        riskGateTriggered = true;
        riskGateReason = nextState.lastError;
      } else if (distanceToLiqPct <= riskControls.marginTopUpLiqDistancePct) {
        const toppedUp = await this._maybeTopUpMargin({
          protection: activeProtection,
          hl,
          currentPrice,
          actualQty,
          strategyState: nextState,
          riskControls,
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
    const isReduceOnlyPath = driftQty < -1e-8;
    const forceReduceNearZero = metrics.targetQty <= NEAR_ZERO_TARGET_QTY && actualQty > 1e-8;
    const minDwellActive = Number.isFinite(Number(nextState.minDwellUntil)) && Date.now() < Number(nextState.minDwellUntil);
    const confidenceBlocksIncrease = nextState.modelConfidence === 'low' && driftQty > 0;
    const timerDue = !nextState.lastRebalanceAt
      || ((Date.now() - Number(nextState.lastRebalanceAt || 0)) >= (band.intervalSec * 1000));
    const shouldRebalance = forceRebalance
      || forceReduceNearZero
      || forceReason === 'boundary_cross'
      || priceMovePct >= band.effectiveBandPct
      || (timerDue && driftUsd >= (activeProtection.minRebalanceNotionalUsd ?? DEFAULT_MIN_REBALANCE_NOTIONAL_USD))
      || (!position && metrics.targetQty > 0.0000001);

    if (!position && metrics.targetQty > 0.0000001) {
      this.logger.info?.('delta_neutral_restart_reconcile_candidate', {
        protectionId: activeProtection.id,
        accountId: activeProtection.accountId,
        asset: activeProtection.inferredAsset,
        positionReadSource: positionObservation.lastPositionReadSource,
        positionMissingConfirmed: positionObservation.positionMissingConfirmed,
        targetQty: metrics.targetQty,
        actualQty,
        trackingErrorUsd: tracking.trackingErrorUsd,
      });
    }

    if (forceReduceNearZero && rebalanceDecision.decision === 'hold') {
      rebalanceDecision.decision = 'rebalance_full';
    }

    const preflight = await this._buildPreflight({
      protection: activeProtection,
      hl,
      strategyState: nextState,
      actualQty,
      currentPrice,
      tracking,
      bands: rebalanceDecision.bands,
      decision: rebalanceDecision.decision,
      accountState: liveMarket?.clearinghouseState || null,
      assetContext: liveMarket?.assetContext || null,
      bbo: liveMarket?.bbo || null,
      positionObserved: positionObservation.positionObserved,
      positionReadSource: positionObservation.lastPositionReadSource,
      positionMissingUnconfirmed: positionObservation.positionMissingUnconfirmed,
    });
    const effectiveShouldRebalance = shouldRebalance && !minDwellActive && !confidenceBlocksIncrease;

    this.logger.info?.('delta_neutral_preflight_result', {
      protectionId: activeProtection.id,
      accountId: activeProtection.accountId,
      asset: activeProtection.inferredAsset,
      forceReason: forceReason || null,
      positionObserved: positionObservation.positionObserved,
      positionReadSource: positionObservation.lastPositionReadSource,
      positionMissingUnconfirmed: positionObservation.positionMissingUnconfirmed,
      actualQty,
      targetQty: metrics.targetQty,
      trackingErrorUsd: tracking.trackingErrorUsd,
      withdrawable: preflight.withdrawable ?? null,
      requiredMarginUsd: preflight.requiredMarginUsd ?? null,
      preflightOk: preflight.ok,
      preflightReason: preflight.reason,
      executionSkippedBecause: preflight.executionSkippedBecause,
    });
    if (preflight.reason === 'insufficient_margin') {
      this.logger.warn?.('delta_neutral_insufficient_margin_blocked', {
        protectionId: activeProtection.id,
        accountId: activeProtection.accountId,
        asset: activeProtection.inferredAsset,
        positionObserved: positionObservation.positionObserved,
        positionReadSource: positionObservation.lastPositionReadSource,
        actualQty,
        targetQty: metrics.targetQty,
        trackingErrorUsd: tracking.trackingErrorUsd,
        withdrawable: preflight.withdrawable ?? null,
        requiredMarginUsd: preflight.requiredMarginUsd ?? null,
      });
    }

    nextState.status = normalizeEvaluationStatus({
      decision: rebalanceDecision.decision,
      trackingErrorUsd: tracking.trackingErrorUsd,
      riskStatus: forcedStatus,
      preflightStatus: preflight.ok ? null : preflight.status,
      shouldRebalance: effectiveShouldRebalance,
      preflightOk: preflight.ok,
    });
    nextState.lastDecision = rebalanceDecision.decision;
    nextState.lastDecisionReason = forceReason
      || (rebalanceDecision.decision === 'hold' ? 'within_cost_aware_band' : 'drift_exceeds_cost_aware_band');
    if (confidenceBlocksIncrease) {
      nextState.lastDecision = 'refresh_snapshot';
      nextState.lastDecisionReason = 'low_confidence_model';
      nextState.truthPending = true;
    } else if (minDwellActive && shouldRebalance) {
      nextState.lastDecision = 'hold';
      nextState.lastDecisionReason = 'min_dwell_active';
    }
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
      if ((forcedStatus === 'risk_paused' || forcedStatus === 'margin_pending') && isReduceOnlyPath) {
        nextState.lastDecision = 'risk_paused_reduce';
        nextState.lastDecisionReason = 'risk_paused_reduce_only';
      } else {
        nextState.lastDecision = 'hold';
        nextState.lastDecisionReason = forcedStatus === 'risk_paused' ? 'risk_paused' : 'margin_pending';
      }
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

    const riskPausedCanReduce = (forcedStatus === 'risk_paused' || forcedStatus === 'margin_pending') && isReduceOnlyPath;

    await this._persistDecision(activeProtection, {
      decision: nextState.lastDecision,
      reason: nextState.lastDecisionReason,
      strategyStatus: nextState.status,
      spotSource,
      snapshotStatus: snapshotMeta.validation.status,
      snapshotFreshnessMs: Math.max(Date.now() - Number(snapshotMeta.snapshotFreshAt || Date.now()), 0),
      executionSkippedBecause: (forcedStatus && !riskPausedCanReduce) ? riskGateReason : (preflight.ok ? null : preflight.executionSkippedBecause),
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
      modelConfidence: nextState.modelConfidence,
      basisSpreadBps: nextState.basisSpreadBps,
      zoneState: nextState.zoneState,
      marketSpreadBps: preflight.spreadBps ?? null,
    });

    // --- Block notifications ---
    if (riskGateTriggered && forcedStatus) {
      const riskBlockType = forcedStatus === 'risk_paused'
        ? 'risk_paused_liq_distance'
        : 'margin_pending_topup';
      this._notifyBlock(activeProtection, {
        blockType: riskBlockType,
        reason: riskGateReason,
        extra: { liquidationDistancePct: distanceToLiqPct },
      }).catch(() => {});
    }
    if (!preflight.ok && effectiveShouldRebalance && rebalanceDecision.decision !== 'hold') {
      const preflightExtra = {};
      if (preflight.reason === 'insufficient_margin') {
        preflightExtra.withdrawable = preflight.withdrawable;
        preflightExtra.requiredMargin = preflight.requiredMarginUsd ?? ((Math.max(Number(tracking.trackingErrorQty || 0), 0) * currentPrice)
          / Math.max(Number(activeProtection.leverage || 1), 1));
        preflightExtra.positionObserved = positionObservation.positionObserved;
        preflightExtra.actualQty = actualQty;
        preflightExtra.targetQty = metrics.targetQty;
        preflightExtra.positionReadSource = positionObservation.lastPositionReadSource;
      }
      if (preflight.reason === 'spread_too_wide') {
        preflightExtra.spreadBps = liveMarket?.bbo?.spreadBps;
        preflightExtra.maxSpreadBps = activeProtection.maxSpreadBps ?? DEFAULT_MAX_SPREAD_BPS;
      }
      if (preflight.reason === 'estimated_execution_fee_too_high') {
        preflightExtra.estimatedCost = rebalanceDecision.bands?.estimatedCostUsd;
        preflightExtra.maxCost = activeProtection.maxExecutionFeeUsd ?? DEFAULT_MAX_EXECUTION_FEE_USD;
      }
      if (preflight.reason === 'cooldown_active') {
        preflightExtra.cooldownReason = preflight.executionSkippedBecause;
      }
      if (preflight.reason === 'below_min_order_notional') {
        preflightExtra.driftUsd = tracking.trackingErrorUsd;
        preflightExtra.minNotionalUsd = Math.max(
          Number(activeProtection.minOrderNotionalUsd || DEFAULT_MIN_ORDER_NOTIONAL_USD),
          EXCHANGE_MIN_NOTIONAL_USD,
        );
      }
      this._notifyBlock(activeProtection, {
        blockType: preflight.reason === 'estimated_execution_fee_too_high' ? 'execution_fee_too_high' : preflight.reason,
        reason: preflight.executionSkippedBecause,
        extra: preflightExtra,
      }).catch(() => {});
    }

    if (riskPausedCanReduce) {
      if (!preflight.ok) return nextState;
      // Reduce permitido — fall through a _executeRebalance
    } else if (forcedStatus || !effectiveShouldRebalance || rebalanceDecision.decision === 'hold' || !preflight.ok) {
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
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      this.logger.error('delta_neutral_execute_rebalance_invalid_price', {
        protectionId: protection.id,
        currentPrice,
      });
      return strategyState;
    }
    const driftQty = Number(metrics.targetQty) - Number(actualQty);
    const driftUsd = Math.abs(driftQty) * currentPrice;
    if (!Number.isFinite(driftQty) || Math.abs(driftQty) < 1e-8) {
      return strategyState;
    }
    if (strategyState.status === 'risk_paused' && driftQty > 0) {
      return strategyState;
    }
    const minNotionalUsd = Math.max(
      Number(protection.minOrderNotionalUsd || DEFAULT_MIN_ORDER_NOTIONAL_USD),
      EXCHANGE_MIN_NOTIONAL_USD,
    );
    if (driftUsd < minNotionalUsd) {
      this.logger.info?.('delta_neutral_drift_below_exchange_minimum', {
        protectionId: protection.id,
        asset: protection.inferredAsset,
        driftQty,
        driftUsd,
        minNotionalUsd,
      });
      this._notifyBlock(protection, {
        blockType: 'below_min_order_notional',
        reason: `Drift $${driftUsd.toFixed(2)} < minimo $${minNotionalUsd}`,
        extra: { driftUsd, minNotionalUsd },
      }).catch(() => {});
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
        minDwellUntil: Date.now() + this.minDwellMs,
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
      const execBlockType = cooldown.status === 'rate_limited' ? 'rate_limited'
        : cooldown.status === 'margin_pending' ? 'margin_pending_execution'
        : cooldown.status === 'spot_stale' ? 'spot_stale'
        : null;
      if (execBlockType) {
        this._notifyBlock(protection, {
          blockType: execBlockType,
          reason: cooldown.cooldownReason,
          detail: err.message,
        }).catch(() => {});
      }
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
      minDwellUntil: Date.now() + this.minDwellMs,
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
      const executedQty = result.filledQty != null ? result.filledQty : driftQty;
      return {
        partial: result.filledQty != null && result.filledQty < driftQty * 0.99,
        fillPrice,
        executedQty,
        executionFeeUsd: Math.abs(fillPrice * executedQty * ESTIMATED_TAKER_FEE_RATE),
        slippageUsd: Math.abs(fillPrice - currentPrice) * executedQty,
      };
    }

    const reduceQty = Math.abs(driftQty);
    const result = await tradingService.closePosition({
      asset: protection.inferredAsset,
      size: reduceQty,
    });
    const fillPrice = Number(result.closePrice || currentPrice);
    const executedQty = result.filledQty != null ? result.filledQty : reduceQty;
    return {
      partial: result.filledQty != null && result.filledQty < reduceQty * 0.99,
      fillPrice,
      executedQty,
      executionFeeUsd: Math.abs(fillPrice * executedQty * ESTIMATED_TAKER_FEE_RATE),
      slippageUsd: Math.abs(fillPrice - currentPrice) * executedQty,
    };
  }

  async _runTwap({ protection, tradingService, hl, currentPrice, driftQty, actualQty = 0 }) {
    const direction = driftQty > 0 ? 'increase' : 'decrease';
    const totalQty = Math.abs(driftQty);
    const slicesPlanned = Math.max(
      1,
      Math.floor(Number(protection.twapSlices ?? DEFAULT_TWAP_SLICES) || DEFAULT_TWAP_SLICES)
    );
    const sliceQty = totalQty / slicesPlanned;
    const twapDurationSec = Math.max(
      0,
      Number(protection.twapDurationSec ?? DEFAULT_TWAP_DURATION_SEC) || DEFAULT_TWAP_DURATION_SEC
    );
    const sliceDelayMs = Math.floor((twapDurationSec * 1000) / Math.max(slicesPlanned - 1, 1));
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
        const actualSliceQty = sliceResult.filledQty != null ? sliceResult.filledQty : qty;
        totalFees += Math.abs(lastFillPrice * actualSliceQty * ESTIMATED_TAKER_FEE_RATE);
        totalSlippage += Math.abs(lastFillPrice - currentPrice) * actualSliceQty;
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
      // Reconciliar fills pendientes incluso si la posición ya está cerrada:
      // el cierre pudo haber ocurrido en un tick anterior o manualmente y los
      // fills (closedPnl, fees) podrían no haberse capturado todavía.
      try {
        const wasNeverReconciled = !strategyState.lastReconciledFillsAt;
        const fillsSince = Number(strategyState.lastReconciledFillsAt || protection.createdAt || 0);
        const reconciled = await this._reconcileHedgeFills(protection, hl, fillsSince);
        if (reconciled.fillsCount > 0 || reconciled.realizedDelta !== 0) {
          Object.assign(strategyState, {
            hedgeRealizedPnlUsd: wasNeverReconciled
              ? reconciled.realizedDelta
              : Number(strategyState.hedgeRealizedPnlUsd || 0) + reconciled.realizedDelta,
            executionFeesUsd: wasNeverReconciled
              ? reconciled.feeDelta
              : Number(strategyState.executionFeesUsd || 0) + reconciled.feeDelta,
            hedgeUnrealizedPnlUsd: 0,
            lastReconciledFillsAt: reconciled.lastFillTime,
          });
        }
      } catch (reconcileErr) {
        this.logger.warn('hedge_fills_reconcile_on_deactivation_no_position', {
          protectionId: protection.id, error: reconcileErr.message,
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

  async _maybeTopUpMargin({ protection, hl, currentPrice, actualQty, strategyState, riskControls = null }) {
    const refreshed = this._refreshTopUpWindow(strategyState);
    const topUpCount24h = refreshed.topUpCount24h;
    const topUpUsd24h = refreshed.topUpUsd24h;
    const currentHedgeNotionalUsd = actualQty * currentPrice;
    const minFloorUsd = Number(riskControls?.minAutoTopUpFloorUsd) >= 0 ? Number(riskControls.minAutoTopUpFloorUsd) : DEFAULT_MIN_AUTO_TOPUP_FLOOR_USD;
    const topUpUsd = Math.max(minFloorUsd, 0.1 * currentHedgeNotionalUsd);
    const maxAutoTopUpsPer24h = Number(riskControls?.maxAutoTopUpsPer24h) || DEFAULT_MAX_AUTO_TOPUPS_PER_24H;
    const maxAutoTopUpUsdPer24h = this._computeAutoTopUpCapUsd(protection, riskControls);

    if (topUpCount24h >= maxAutoTopUpsPer24h) {
      return {
        allowed: false,
        success: false,
        reason: 'Se alcanzo el maximo de auto top-ups en 24h.',
        strategyState: {
          ...refreshed,
          topUpMaxCount24h: maxAutoTopUpsPer24h,
          topUpCapUsd: maxAutoTopUpUsdPer24h,
        },
      };
    }
    if ((topUpUsd24h + topUpUsd) > maxAutoTopUpUsdPer24h) {
      return {
        allowed: false,
        success: false,
        reason: 'Se alcanzo el cap diario de auto top-up.',
        strategyState: {
          ...refreshed,
          topUpMaxCount24h: maxAutoTopUpsPer24h,
          topUpCapUsd: maxAutoTopUpUsdPer24h,
        },
      };
    }
    if (strategyState.lastTopUpAt && (Date.now() - Number(strategyState.lastTopUpAt)) < 15 * 60_000) {
      return {
        allowed: true,
        success: false,
        reason: 'Cooldown de auto top-up activo.',
        strategyState: {
          ...refreshed,
          topUpMaxCount24h: maxAutoTopUpsPer24h,
          topUpCapUsd: maxAutoTopUpUsdPer24h,
        },
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
          topUpMaxCount24h: maxAutoTopUpsPer24h,
          topUpCapUsd: maxAutoTopUpUsdPer24h,
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
        strategyState: {
          ...refreshed,
          topUpMaxCount24h: maxAutoTopUpsPer24h,
          topUpCapUsd: maxAutoTopUpUsdPer24h,
        },
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
