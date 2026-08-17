const config = require('../config');
const db = require('../db');
const logger = require('./logger.service');
const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');
const deltaRebalanceLogRepository = require('../repositories/protected-pool-delta-rebalance.repository');
const decisionLogRepository = require('../repositories/protection-decision-log.repository');
const timeInRangeService = require('./time-in-range.service');
const uniswapService = require('./uniswap.service');
const hlRegistry = require('./hyperliquid.registry');
const { getTradingService } = require('./trading.factory');
const marketService = require('./market.service');
const hyperliquidStreamService = require('./hyperliquid-stream.service');
const rpcBudgetManager = require('./rpc-budget-manager.service');
const settingsService = require('./settings.service');
const telegramRegistry = require('./telegram.registry');
const {
  computeSnapshotHash,
  normalizeProtectionSnapshot,
  validateNormalizedProtectionSnapshot,
} = require('./delta-neutral-snapshot.service');
const BLOCK_NOTIFICATION_THROTTLE_MS = 15 * 60_000;
const BLOCK_NOTIFICATION_DEDUPE_MS = 2 * 60_000;
const POSITION_MISSING_CONFIRMATION_COUNT = 2;
const POSITION_MISSING_GRACE_MS = 15 * 60_000;
// Dust tolerance al verificar cierre en desactivación. Residuos por debajo de
// max($1, 1% del tamaño original) se consideran polvo y no bloquean deactivate.
const DEACTIVATION_RESIDUAL_DUST_USD = 1;
const DEACTIVATION_RESIDUAL_PCT = 0.01;
const DELTA_NEUTRAL_LOCK_NAMESPACE = 0x444e;
const {
  DEFAULT_BAND_MODE,
  DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT,
  DEFAULT_REBALANCE_INTERVAL_SEC,
  DEFAULT_TARGET_HEDGE_RATIO,
  DEFAULT_MIN_REBALANCE_NOTIONAL_PCT,
  resolveMinRebalanceNotionalUsd,
  DEFAULT_MAX_SLIPPAGE_BPS,
  DEFAULT_TWAP_MIN_NOTIONAL_USD,
  DEFAULT_EXECUTION_MODE,
  DEFAULT_MAX_SPREAD_BPS,
  DEFAULT_MAX_EXECUTION_FEE_USD,
  DEFAULT_MAX_AUTO_TOPUPS_PER_24H,
  DEFAULT_MIN_AUTO_TOPUP_CAP_USD,
  DEFAULT_AUTO_TOPUP_CAP_PCT_OF_INITIAL,
  DEFAULT_MIN_AUTO_TOPUP_FLOOR_USD,
  DEFAULT_RISK_PAUSE_LIQ_DISTANCE_PCT,
  DEFAULT_MARGIN_TOP_UP_LIQ_DISTANCE_PCT,
  resolveMinOrderNotionalUsd,
  getCurrentBoundarySide,
  distanceToRangePct,
  buildInitialStrategyState,
  normalizeStrategyState,
  isCooldownActive,
  deriveBandSettings,
  computeVolatilityStats,
} = require('./protected-pool-delta-neutral.helpers');
const { marginMethods } = require('./protected-pool-delta-neutral/margin');
const { pricingMethods } = require('./protected-pool-delta-neutral/pricing');
const { executionMethods } = require('./protected-pool-delta-neutral/execution');
const { evaluateMethods } = require('./protected-pool-delta-neutral/evaluate');

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
    // Inyectable a proposito (no leer `config` en el punto de uso): un test que
    // afirme sobre este umbral leyendo el .env real pasa en CI limpio y falla en
    // la maquina de prod. Ya paso con los multiplicadores de zona (619cfd4).
    this.urgentMinRebalanceNotionalPct = deps.urgentMinRebalanceNotionalPct
      ?? config.deltaNeutral.urgentMinRebalanceNotionalPct;
    // Multiplicadores del hedge ratio por zona (configurables). El "vigente" es
    // el que se ejecuta; el "shadow" es el propuesto que se loguea sin ejecutar
    // cuando `shadowMode` está activo. Ver config.deltaNeutral.zoneHedge*.
    this.zoneHedgeMultipliers = deps.zoneHedgeMultipliers || {
      center: config.deltaNeutral.zoneHedgeMultiplierCenter,
      transition: config.deltaNeutral.zoneHedgeMultiplierTransition,
      edge: config.deltaNeutral.zoneHedgeMultiplierEdge,
    };
    this.shadowMode = deps.shadowMode != null ? deps.shadowMode : config.deltaNeutral.shadowMode;
    this.shadowZoneHedgeMultipliers = deps.shadowZoneHedgeMultipliers || {
      center: config.deltaNeutral.shadowZoneHedgeMultiplierCenter,
      transition: config.deltaNeutral.shadowZoneHedgeMultiplierTransition,
      edge: config.deltaNeutral.shadowZoneHedgeMultiplierEdge,
    };
    this.bandTightening = deps.bandTightening || {
      intervalTightenFactor: config.deltaNeutral.bandIntervalTightenFactor,
      bandTightenFactor: config.deltaNeutral.bandPriceTightenFactor,
    };
    // Inyectable para tests: fallback a db real si no se pasa.
    this._db = deps.db || db;
    this.useDistributedLocks = deps.useDistributedLocks != null
      ? deps.useDistributedLocks
      : Boolean(process.env.DATABASE_URL || (process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE));
    this.interval = null;
    this.running = false;
    this.lastEvalAt = new Map();
    this.twapSessions = new Map();
    this.rvCache = new Map();
    this.blockNotifLastSentAt = new Map();
    // Cache de `getUserFills` por address: el endpoint pesa 20 del budget
    // HL y se llamaba cada tick por protección (≈ 95% de utilización del
    // límite, dominado por userFills). Con TTL de 30 s el drop es ~15×
    // sin perder reconciliación útil porque los fills llegan en ráfagas
    // tras una ejecución, no de forma continua.
    this.userFillsCache = new Map();
    this.evaluationLocks = new Map();
    this.shadowStates = new Map();
    this.hybridStats = {
      marketTicks: 0,
      truthRefreshes: 0,
      inspectRefreshes: 0,
      fullScans: 0,
      truthRefreshDeferred: 0,
    };
  }

  /**
   * Ejecuta fn dentro de una transacción DB cuando el `db` inyectado la
   * soporta. Para tests con stubs sin `transaction`, ejecuta fn(undefined)
   * como fallback (modo no-transaccional — los repos lo aceptan).
   */
  async _withTransaction(fn) {
    if (this._db && typeof this._db.transaction === 'function') {
      return this._db.transaction(fn);
    }
    return fn(undefined);
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

  _zoneMultiplier(zoneState, multipliers = this.zoneHedgeMultipliers) {
    if (zoneState === 'center') return multipliers.center;
    if (zoneState === 'transition') return multipliers.transition;
    return multipliers.edge;
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
  /**
   * Wrap de `hl.getUserFills()` con cache por address. TTL 30 s cubre el
   * caso feliz (ningún cambio → seguir con el mismo array) sin sacrificar
   * la reconciliación: después de cada ejecución llamamos
   * `_invalidateUserFillsCache(hl)` para forzar un refetch en el próximo
   * tick. Devuelve `null` cuando el fetch falla (para que el caller
   * retorne early sin lanzar).
   */
  async _getUserFillsCached(hl, protection) {
    const USER_FILLS_TTL_MS = 30_000;
    const address = String(hl?.address || '').toLowerCase();
    const now = Date.now();
    if (address) {
      const cached = this.userFillsCache.get(address);
      if (cached && (now - cached.cachedAt) < USER_FILLS_TTL_MS) {
        return cached.fills;
      }
    }
    try {
      // El cliente `hl` ya está vinculado a la cuenta Hyperliquid correcta.
      // Si forzamos `protection.walletAddress` aquí, terminamos consultando
      // la wallet del LP y no la cuenta de trading del hedge. En ese caso los
      // fills del short no aparecen y el PnL realizado queda falsamente en 0.
      const fills = await hl.getUserFills();
      const safeFills = Array.isArray(fills) ? fills : [];
      if (address) {
        this.userFillsCache.set(address, { fills: safeFills, cachedAt: now });
      }
      return safeFills;
    } catch (err) {
      this.logger.warn('hedge_fills_fetch_failed', {
        protectionId: protection?.id,
        asset: protection?.inferredAsset,
        queriedAddress: hl?.address || null,
        error: err.message,
      });
      return null;
    }
  }

  _invalidateUserFillsCache(hl) {
    const address = String(hl?.address || '').toLowerCase();
    if (!address) return;
    this.userFillsCache.delete(address);
  }

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

    const fills = await this._getUserFillsCached(hl, protection);
    if (fills === null) {
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
    actualQty = 0,
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
    let resolvedAccountState = accountState || await hl.getClearinghouseState().catch((err) => {
      this.logger.warn('hl_clearinghouse_preflight_failed', {
        protectionId: protection.id,
        accountId: protection.accountId,
        error: err.message,
      });
      return null;
    });
    const hasProtectionCooldownReason = Boolean(protection)
      && Object.prototype.hasOwnProperty.call(protection, 'cooldownReason');
    const cooldownReason = ((hasProtectionCooldownReason ? protection.cooldownReason : strategyState.cooldownReason) || '').trim();
    const targetIncreaseQty = Math.max(Number(tracking.trackingErrorQty || 0), 0);
    const increaseNotionalUsd = targetIncreaseQty * currentPrice;
    const leverage = Math.max(Number(protection.leverage || 1), 1);
    let requiredMarginUsd = increaseNotionalUsd / leverage;
    let withdrawable = Number(resolvedAccountState?.withdrawable || 0);
    const cooldownActive = isCooldownActive(protection, strategyState);
    const snapshotStatus = protection.snapshotStatus || 'ready';
    const resolvedAssetContext = assetContext || (() => null)();

    // Cached clearinghouse state from the WS stream can lag reality: si el
    // slot isolated fue fondeado recientemente, `assetPositions` viene sin la
    // posición o con un `marginUsed` obsoleto. Forzamos re-lectura fresca vía
    // HTTP cuando intentamos crecer la cobertura y la cache se ve incompleta
    // (withdrawable==0, sin assetPositions, o sin el asset objetivo), no solo
    // cuando withdrawable<=0. Sin esto, `existingMarginUsd` quedaba en 0 y el
    // preflight marcaba `insufficient_margin` aunque el slot estuviera
    // sobre-colateralizado.
    const asset = String(protection.inferredAsset || '').toUpperCase();
    const hasAssetPositionInCache = Array.isArray(resolvedAccountState?.assetPositions)
      && resolvedAccountState.assetPositions.some((p) => String(p?.position?.coin || '').toUpperCase() === asset);
    const cacheLooksStale = !resolvedAccountState
      || !Array.isArray(resolvedAccountState.assetPositions)
      || (Number(actualQty || 0) > 0 && !hasAssetPositionInCache);
    const shouldRefresh = targetIncreaseQty > 0 && (withdrawable <= 0 || cacheLooksStale);
    if (shouldRefresh) {
      const freshAccountState = await hl.getClearinghouseState().catch((err) => {
        this.logger.warn('hl_clearinghouse_preflight_refresh_failed', {
          protectionId: protection.id,
          accountId: protection.accountId,
          error: err.message,
        });
        return null;
      });
      if (freshAccountState) {
        const freshWithdrawable = Number(freshAccountState.withdrawable || 0);
        const freshHasAsset = Array.isArray(freshAccountState.assetPositions)
          && freshAccountState.assetPositions.some((p) => String(p?.position?.coin || '').toUpperCase() === asset);
        this.logger.info?.('delta_neutral_withdrawable_refreshed', {
          protectionId: protection.id,
          accountId: protection.accountId,
          asset: protection.inferredAsset,
          cachedWithdrawable: withdrawable,
          freshWithdrawable,
          cacheHadAsset: hasAssetPositionInCache,
          freshHasAsset,
        });
        resolvedAccountState = freshAccountState;
        withdrawable = freshWithdrawable;
      }
    }

    // En isolated margin, la posición ya tiene `marginUsed` bloqueado. Para
    // crecer la posición sólo se necesita margen ADICIONAL cuando el nuevo
    // requerimiento supera al que ya está aparcado en el aislado. Sin este
    // ajuste, una posición sobre-colateralizada (donde el marginUsed excede
    // lo que la nueva size requeriría) disparaba `insufficient_margin` aunque
    // el incremento fuera perfectamente viable sin añadir dinero.
    // IMPORTANTE: leer `existingMarginUsd` DESPUÉS del refresh para no usar
    // datos stale cuando el stream devuelve una snapshot incompleta.
    const positionEntry = (resolvedAccountState?.assetPositions || []).find(
      (p) => String(p.position?.coin || '').toUpperCase() === asset
    );
    const existingMarginUsd = Number(positionEntry?.position?.marginUsed || 0);
    const slotRawUsd = Number(positionEntry?.position?.leverage?.rawUsd || 0);
    const newTotalSize = Math.abs(Number(actualQty || 0)) + targetIncreaseQty;
    const newTotalRequiredMarginUsd = (newTotalSize * currentPrice) / leverage;
    const extraMarginNeededUsd = Math.max(0, newTotalRequiredMarginUsd - existingMarginUsd);
    // HL exige margen del `withdrawable` para el INCREMENTO; el excedente
    // del slot isolated no se auto-usa. Por eso aquí calculamos la capacidad
    // total disponible = withdrawable + surplus extraíble del slot
    // (rawUsd − marginUsed × safetyBuffer). `_ensureIsolatedMarginBuffer`
    // ejecuta la extracción antes del placeOrder cuando hace falta.
    const SAFETY_BUFFER_FACTOR = 1.2;
    const slotSurplusExtractableUsd = Math.max(0, slotRawUsd - existingMarginUsd * SAFETY_BUFFER_FACTOR);
    const incrementMarginUsd = (targetIncreaseQty * currentPrice) / leverage;
    const availableForIncrementUsd = withdrawable + slotSurplusExtractableUsd;

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
    if (cooldownActive && !(marginCooldownActive && (targetIncreaseQty <= 0 || incrementMarginUsd <= availableForIncrementUsd))) {
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
    const effectiveMinOrderNotionalUsd = resolveMinOrderNotionalUsd(protection);
    // Bypass del mínimo notional cuando es un reduce-only que cierra la
    // posición por completo: Hyperliquid acepta reduceOnly sub-mínimo si
    // deja la posición en 0. Sin este bypass, residuos entre $0 y $11
    // quedan atascados indefinidamente.
    const isFullCloseReduce = Number(tracking.trackingErrorQty || 0) < 0
      && actualQty > 0
      && Math.abs(Number(tracking.trackingErrorQty || 0)) + 1e-8 >= actualQty;
    if (decision !== 'hold' && tracking.trackingErrorUsd < effectiveMinOrderNotionalUsd && !isFullCloseReduce) {
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
    // `incrementMarginUsd` (margen requerido para la NUEVA size) debe caber en
    // `withdrawable + slotSurplusExtractable`. Así el block real ocurre solo
    // cuando ni cross ni la extracción del slot pueden cubrir el incremento.
    if (targetIncreaseQty > 0 && incrementMarginUsd > availableForIncrementUsd) {
      return {
        ok: false,
        status: 'margin_pending',
        reason: 'insufficient_margin',
        executionSkippedBecause: 'insufficient_margin',
        extraMarginNeededUsd,
        existingMarginUsd,
        slotRawUsd,
        slotSurplusExtractableUsd,
        incrementMarginUsd,
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

    const closeResult = await tradingService.closePosition({
      asset: protection.inferredAsset,
      size: actualQty,
    });

    // Verificar que quedó realmente cerrado. Si hay residuo no dust, NO
    // marcamos la protección como inactive — dejamos que el siguiente tick
    // o una llamada posterior a forceCloseHedge lo termine.
    const verifyPrice = Number(closeResult?.closePrice || 0);
    const residualCheck = await this._verifyHedgeClosed(protection, hl, {
      expectedPrice: verifyPrice,
      originalQty: actualQty,
    });
    if (!residualCheck.closed) {
      this.logger.warn('force_close_hedge_partial_residual', {
        protectionId: protection.id,
        asset: protection.inferredAsset,
        originalQty: actualQty,
        residualQty: residualCheck.residualQty,
        residualUsd: residualCheck.residualUsd,
      });
      return {
        closed: false,
        partial: true,
        actualQty,
        residualQty: residualCheck.residualQty,
        residualUsd: residualCheck.residualUsd,
        reason: 'partial_fill',
      };
    }

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
      || strategyState.truthPending === true
      // Una senal forzada esperando a que venza el min-dwell no puede quedarse
      // a merced de la cadencia larga: es capital descubierto.
      || strategyState.pendingForceReason != null;

    if (!evalDue && !crossedBoundary && !nearBoundary) return;

    this._recordHybridStat('marketTicks');
    this.lastEvalAt.set(protection.id, now);
    await this.evaluateProtection(protection, {
      marketContext,
      forceReason: crossedBoundary ? 'boundary_cross' : nearBoundary ? 'boundary_watch' : null,
    });
  }

  async evaluateProtection(protection, options = {}) {
    const protectionId = Number(protection?.id);
    if (!Number.isInteger(protectionId) || protectionId <= 0) return null;
    const existing = this.evaluationLocks.get(protectionId);
    if (existing) return existing;

    const evaluation = this._withProtectionEvaluationLock(protection, options)
      .finally(() => this.evaluationLocks.delete(protectionId));
    this.evaluationLocks.set(protectionId, evaluation);
    return evaluation;
  }

  async _withProtectionEvaluationLock(protection, options) {
    const pool = this._db?.pool;
    if (!this.useDistributedLocks || !pool || typeof pool.connect !== 'function') {
      return this._evaluateProtectionUnlocked(protection, options);
    }

    const client = await pool.connect();
    let acquired = false;
    try {
      const { rows } = await client.query(
        'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired',
        [DELTA_NEUTRAL_LOCK_NAMESPACE, Number(protection.id)]
      );
      acquired = rows[0]?.acquired === true;
      if (!acquired) {
        this.logger.info?.('delta_neutral_evaluation_lock_busy', {
          protectionId: protection.id,
          userId: protection.userId,
        });
        return null;
      }
      return await this._evaluateProtectionUnlocked(protection, options);
    } finally {
      if (acquired) {
        await client.query(
          'SELECT pg_advisory_unlock($1::integer, $2::integer)',
          [DELTA_NEUTRAL_LOCK_NAMESPACE, Number(protection.id)]
        ).catch((err) => this.logger.error('delta_neutral_evaluation_unlock_failed', {
          protectionId: protection.id,
          error: err.message,
        }));
      }
      client.release();
    }
  }

  async _continueDeactivation(protection, context = {}) {
    const strategyState = normalizeStrategyState(protection.strategyState);
    const tradingService = context.tradingService || await this.getTradingService(protection.userId, protection.accountId);
    const hl = context.hl || await this.hlRegistry.getOrCreate(protection.userId, protection.accountId);

    // Lectura de posición robusta: si el contexto ya la trae (desde el tick
    // principal) la usamos; si no (p. ej. desde requestDeactivate) pasamos por
    // _observeHedgePosition, que reintenta y aplica fallback a lastActualQty
    // ante fallos de red. Evita el bug de "HL.getPosition falla → actualQty=0
    // → desactivamos sin cerrar el short".
    let actualQty;
    if (context.actualQty != null) {
      actualQty = context.actualQty;
    } else {
      const observation = await this._observeHedgePosition({
        protection,
        hl,
        strategyState,
        forceReason: 'deactivation',
      }).catch((err) => {
        logger.warn('observeHedgePosition failed in deactivation', { poolId: protection.id, asset: protection.inferredAsset, error: err.message });
        return null;
      });
      if (observation?.positionMissingUnconfirmed) {
        // Lectura no confirmada: no desactivamos; reintentamos en el siguiente tick.
        const nextState = {
          ...strategyState,
          status: 'deactivation_pending',
          lastError: 'Lectura de posición no confirmada; se reintenta cierre antes de desactivar.',
        };
        await this.repo.updateStrategyState(protection.userId, protection.id, { strategyState: nextState });
        return nextState;
      }
      actualQty = Number(observation?.effectiveActualQty || 0);
    }

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
      // Commit atómico de desactivación: sin hedge activo en HL (nada on-chain
      // que revertir), pero deactivate + strategyState deben ir juntos para
      // que un siguiente tick no intente re-abrir por lectura parcial.
      await this._withTransaction(async (client) => {
        await this.repo.deactivate(protection.userId, protection.id, {
          deactivatedAt,
          ...(finalRangeMetrics ? {
            ...finalRangeMetrics,
            poolSnapshot: timeInRangeService.applyRangeMetricsToSnapshot(protection.poolSnapshot || {}, finalRangeMetrics),
          } : {}),
        }, client);
        await this.repo.updateStrategyState(protection.userId, protection.id, {
          strategyState: {
            ...strategyState,
            status: 'deactivating',
            lastActualQty: 0,
          },
        }, client);
      }).catch((err) => logger.warn('deactivate_tx_failed', { poolId: protection.id, error: err.message }));
      return this.repo.getById(protection.userId, protection.id);
    }

    try {
      const closeResult = await tradingService.closePosition({
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

      // Verificar que la posición realmente quedó cerrada. Los fills
      // parciales de IOC pueden dejar un residuo silencioso — sin este
      // check el short quedaba huérfano tras repo.deactivate().
      const verifyPrice = Number(closeResult?.closePrice || context.currentPrice || 0);
      const residualCheck = await this._verifyHedgeClosed(protection, hl, {
        expectedPrice: verifyPrice,
        originalQty: actualQty,
      });
      if (!residualCheck.closed) {
        const nextState = {
          ...strategyState,
          status: 'deactivation_pending',
          lastActualQty: residualCheck.residualQty,
          lastError: `Cierre parcial: residuo ${residualCheck.residualQty.toFixed(8)} (${residualCheck.residualUsd.toFixed(2)} USD). Reintentando.`,
        };
        await this.repo.updateStrategyState(protection.userId, protection.id, { strategyState: nextState });
        this.logger.warn('deactivation_close_partial_residual', {
          protectionId: protection.id,
          asset: protection.inferredAsset,
          originalQty: actualQty,
          residualQty: residualCheck.residualQty,
          residualUsd: residualCheck.residualUsd,
          closedSize: closeResult?.closedSize,
          requestedSize: closeResult?.requestedSize,
        });
        return nextState;
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

  /**
   * Verifica que el hedge haya quedado cerrado tras una llamada a closePosition.
   * Tolera dust (residuos por debajo de max($1, 1% del tamaño original)).
   * Devuelve { closed, residualQty, residualUsd }.
   */
  async _verifyHedgeClosed(protection, hl, { expectedPrice = 0, originalQty = 0 } = {}) {
    const rawPosition = await hl.getPosition(protection.inferredAsset).catch((err) => {
      logger.warn('verifyHedgeClosed_getPosition_failed', { poolId: protection.id, asset: protection.inferredAsset, error: err.message });
      return undefined; // undefined = read failed, conservador
    });
    if (rawPosition === undefined) {
      // Lectura falló: NO asumir cerrado. Mejor reintentar en el siguiente tick.
      return { closed: false, residualQty: originalQty, residualUsd: originalQty * expectedPrice, readFailed: true };
    }
    const residualQty = rawPosition && Number(rawPosition.szi) < 0
      ? Math.abs(Number(rawPosition.szi))
      : 0;
    const price = Number.isFinite(expectedPrice) && expectedPrice > 0
      ? expectedPrice
      : Number(rawPosition?.entryPx) || 0;
    const residualUsd = residualQty * price;
    const originalUsd = originalQty * price;
    const dustThresholdUsd = Math.max(DEACTIVATION_RESIDUAL_DUST_USD, originalUsd * DEACTIVATION_RESIDUAL_PCT);
    const closed = residualQty <= 0 || residualUsd <= dustThresholdUsd;
    return { closed, residualQty, residualUsd };
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

// Bloques de comportamiento extraídos a `protected-pool-delta-neutral/`. Se
// componen sobre el prototipo para que sigan siendo métodos de la clase: el
// corte es puramente de fichero, no cambia quién es `this` ni la API.
Object.assign(ProtectedPoolDeltaNeutralService.prototype, pricingMethods, evaluateMethods, executionMethods, marginMethods);

module.exports = new ProtectedPoolDeltaNeutralService();
module.exports.ProtectedPoolDeltaNeutralService = ProtectedPoolDeltaNeutralService;
module.exports.DEFAULT_BAND_MODE = DEFAULT_BAND_MODE;
module.exports.DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT = DEFAULT_BASE_REBALANCE_PRICE_MOVE_PCT;
module.exports.DEFAULT_REBALANCE_INTERVAL_SEC = DEFAULT_REBALANCE_INTERVAL_SEC;
module.exports.DEFAULT_TARGET_HEDGE_RATIO = DEFAULT_TARGET_HEDGE_RATIO;
module.exports.DEFAULT_MIN_REBALANCE_NOTIONAL_PCT = DEFAULT_MIN_REBALANCE_NOTIONAL_PCT;
module.exports.resolveMinRebalanceNotionalUsd = resolveMinRebalanceNotionalUsd;
module.exports.DEFAULT_MAX_SLIPPAGE_BPS = DEFAULT_MAX_SLIPPAGE_BPS;
module.exports.DEFAULT_TWAP_MIN_NOTIONAL_USD = DEFAULT_TWAP_MIN_NOTIONAL_USD;
module.exports.DEFAULT_MAX_AUTO_TOPUPS_PER_24H = DEFAULT_MAX_AUTO_TOPUPS_PER_24H;
module.exports.DEFAULT_EXECUTION_MODE = DEFAULT_EXECUTION_MODE;
module.exports.buildInitialStrategyState = buildInitialStrategyState;
module.exports.computeVolatilityStats = computeVolatilityStats;
module.exports.deriveBandSettings = deriveBandSettings;
module.exports.normalizeStrategyState = normalizeStrategyState;
