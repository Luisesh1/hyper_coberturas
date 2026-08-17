/**
 * Evaluacion de una proteccion: contexto de mercado, metricas delta-neutral,
 * gates de riesgo, decision de rebalanceo y gemelo en sombra.
 *
 * Es el corazon del motor y por si solo pesaba un tercio del servicio. Se
 * compone sobre el prototipo (ver margin.js): el cuerpo viaja literal, asi que
 * el corte no cambia comportamiento ni quien es `this`.
 */
const {
  DEFAULT_EXECUTION_MODE,
  DEFAULT_MAX_AUTO_TOPUPS_PER_24H,
  DEFAULT_MAX_EXECUTION_FEE_USD,
  DEFAULT_MAX_SPREAD_BPS,
  MARGIN_COOLDOWN_MS,
  buildCooldown,
  clampNonNegative,
  computeLiquidationDistancePct,
  deriveBandSettings,
  estimateExecutionCostUsd,
  getCurrentBoundarySide,
  isIsolatedPosition,
  normalizeEvaluationStatus,
  normalizeStrategyState,
  resolveMinOrderNotionalUsd,
  resolveMinRebalanceNotionalUsd,
  resolveRebalanceDecision,
  resolveUrgentMinRebalanceNotionalUsd,
  safeJsonClone,
} = require('../protected-pool-delta-neutral.helpers');
const {
  NET_PROFIT_V1,
  createShadowState,
  decideNetProfitV1,
  simulateShadowFill,
} = require('../net-profit-policy.service');

// Por debajo de esta cantidad el target se considera cero: espeja la
// constante del servicio.
const NEAR_ZERO_TARGET_QTY = 1e-6;

const evaluateMethods = {
  async _evaluateProtectionUnlocked(protection, options = {}) {
    const { marketContext = null } = options;
    let { forceReason = null, forceRebalance = false } = options;
    const current = await this.repo.getById(protection.userId, protection.id);
    if (!current || current.status !== 'active' || current.protectionMode !== 'delta_neutral') {
      return null;
    }

    const strategyState = normalizeStrategyState(current.strategyState);

    // Rehidrata una senal forzada que el min-dwell bloqueo en un tick anterior.
    // Quien las emite —el orquestador tras un cambio de liquidez— lo hace una
    // sola vez y sin reintento, asi que sin esto la cobertura se queda colgada
    // hasta que venza el temporizador (hasta 12 h) o el precio salga de banda.
    if (!forceRebalance && strategyState.pendingForceReason) {
      forceReason = forceReason || strategyState.pendingForceReason;
      forceRebalance = true;
    }
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
      const fallbackAccountState = await hl.getClearinghouseState().catch((err) => {
        this.logger.warn('hl_clearinghouse_live_market_fallback_failed', {
          protectionId: activeProtection.id,
          accountId: activeProtection.accountId,
          error: err.message,
        });
        return null;
      });
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
          const fallbackAccountState = await hl.getClearinghouseState().catch((err) => {
            this.logger.warn('hl_clearinghouse_post_truth_refresh_failed', {
              protectionId: activeProtection.id,
              accountId: activeProtection.accountId,
              error: err.message,
            });
            return null;
          });
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
    const band = deriveBandSettings(activeProtection, rvStats, metrics, currentPrice, this.bandTightening);
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
      lastShadowTargetQty: metrics.shadowTargetQty ?? null,
      lastActualQty: actualQty,
      monitorHeartbeatAt: Date.now(),
      coverageRatioPct: Number(metrics.targetQty) > NEAR_ZERO_TARGET_QTY
        ? (actualQty / Number(metrics.targetQty)) * 100
        : actualQty <= NEAR_ZERO_TARGET_QTY ? 100 : null,
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

    const isNetProfitLive = (activeProtection.policyVersion || strategyState.policyVersion) === NET_PROFIT_V1
      && (activeProtection.strategyState?.executionIntent || strategyState.executionIntent) === 'live';
    const expectedPolicyCostUsd = estimateExecutionCostUsd(
      Number(metrics.deltaQty) - actualQty,
      currentPrice
    );
    const netProfitDecision = isNetProfitLive
      ? decideNetProfitV1({
        deltaQty: Number(metrics.deltaQty),
        actualQty,
        currentPrice,
        rangeLowerPrice: activeProtection.rangeLowerPrice,
        rangeUpperPrice: activeProtection.rangeUpperPrice,
        lpValueUsd: Number(metrics.poolValueUsd),
        expectedCostUsd: expectedPolicyCostUsd,
        state: strategyState.netProfitPolicyState || {},
      })
      : null;
    // No modificamos el record para ejecutar: esta vista efímera aplica los
    // límites aprobados a cada IOC y a todos sus reintentos. Riesgo >=15% del
    // LP puede usar 30 bps, pero sigue pasando los mismos gates de snapshot,
    // margen aislado, BBO y cooldown que cualquier ajuste live.
    const executionProtection = isNetProfitLive
      ? {
        ...activeProtection,
        maxSpreadBps: Number.isFinite(Number(activeProtection.maxSpreadBps))
          ? Math.min(Number(activeProtection.maxSpreadBps), 10)
          : 10,
        maxSlippageBps: netProfitDecision?.riskToInner
          ? 30
          : Number.isFinite(Number(activeProtection.maxSlippageBps))
            ? Math.min(Number(activeProtection.maxSlippageBps), 15)
            : 15,
        executionMode: 'ioc',
      }
      : activeProtection;
    // La política calcula el delta completo para medir el riesgo, pero la
    // orden live lleva sólo su corrección parcial. Conservamos ambos targets:
    // `targetQty` para ejecutar y `policyTargetQty` para observabilidad.
    const executionMetrics = isNetProfitLive && netProfitDecision?.decision === 'rebalance'
      ? {
        ...metrics,
        targetQty: actualQty + Number(netProfitDecision.adjustQty || 0),
        policyTargetQty: Number(metrics.deltaQty),
      }
      : metrics;
    const executionTracking = isNetProfitLive && netProfitDecision?.decision === 'rebalance'
      ? {
        trackingErrorQty: Number(executionMetrics.targetQty) - actualQty,
        trackingErrorUsd: Math.abs(Number(executionMetrics.targetQty) - actualQty) * currentPrice,
      }
      : null;
    const rebalanceDecision = isNetProfitLive
      ? {
        decision: netProfitDecision.decision === 'rebalance' ? 'net_profit_rebalance' : 'hold',
        tracking: {
          trackingErrorQty: Number(metrics.deltaQty) - actualQty,
          trackingErrorUsd: Math.abs(Number(metrics.deltaQty) - actualQty) * currentPrice,
        },
        bands: {
          holdBandUsd: netProfitDecision.minNotionalUsd,
          estimatedCostUsd: expectedPolicyCostUsd,
        },
      }
      : resolveRebalanceDecision({
        protection: activeProtection,
        metrics,
        actualQty,
        currentPrice,
        forceReason,
        forceRebalance,
      });
    if (isNetProfitLive) {
      nextState.netProfitPolicyState = netProfitDecision.nextState || strategyState.netProfitPolicyState || {};
      nextState.netProfitPolicyGate = netProfitDecision.gate;
      nextState.netProfitPolicyTargetQty = Number(metrics.deltaQty);
    }
    const tracking = rebalanceDecision.tracking;
    nextState.trackingErrorQty = tracking.trackingErrorQty;
    nextState.trackingErrorUsd = tracking.trackingErrorUsd;
    nextState.lastSpotFailureAt = spotFailureReason ? Date.now() : (strategyState.lastSpotFailureAt || null);
    nextState.lastSpotFailureReason = spotFailureReason || null;
    nextState.truthPending = normalizeStrategyState(activeProtection.strategyState).truthPending === true;

    if (Number.isFinite(nextState.coverageRatioPct)
        && Number(metrics.targetQty) > NEAR_ZERO_TARGET_QTY
        && (nextState.coverageRatioPct < 90 || nextState.coverageRatioPct > 110)) {
      this.logger.warn?.('delta_neutral_coverage_out_of_band', {
        protectionId: activeProtection.id,
        accountId: activeProtection.accountId,
        asset: activeProtection.inferredAsset,
        targetQty: Number(metrics.targetQty),
        actualQty,
        coverageRatioPct: nextState.coverageRatioPct,
      });
    }

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

    // Diagnostico de cobertura (Tarea 6 del plan 2026-08-10). El `hedge_beta`
    // medido sobre snapshots da 0.29-0.50 en los v4 vivos contra 0.87-0.92 que
    // daban los v3, pero `ratio_tgt_delta` sale 1.00 en el log de rebalanceos
    // porque delta/target/actual se escriben del mismo valor: el log no puede
    // detectar un delta mal calculado.
    //
    // La comparacion decisiva es el valor del LP segun el MODELO
    // (`calculatePoolValueAtPrice`, que reconstruye los amounts desde
    // `snapshot.liquidity` + ticks) contra el valor que ya conocemos por otra
    // via. Si divergen, la liquidez de entrada esta mal y el delta hereda el
    // error. `inRange` va incluido porque fuera de rango el delta cae a ~0 de
    // forma legitima y confundiria la lectura.
    const rawSnapshot = activeProtection.poolSnapshot || {};
    const snapshotPoolValueUsd = Number(rawSnapshot.currentValueUsd);
    const modelPoolValueUsd = Number(metrics.poolValueUsd);
    this.logger.info?.('delta_neutral_delta_diagnostic', {
      protectionId: activeProtection.id,
      accountId: activeProtection.accountId,
      asset: activeProtection.inferredAsset,
      version: activeProtection.version || snapshot.version || null,
      inRange: snapshot.inRange === true,
      zoneState: metrics.zoneState || null,
      currentPrice,
      modelPoolValueUsd: Number.isFinite(modelPoolValueUsd) ? modelPoolValueUsd : null,
      snapshotPoolValueUsd: Number.isFinite(snapshotPoolValueUsd) ? snapshotPoolValueUsd : null,
      // ~1.0 esperado. Desviarse es la firma de una liquidez mal leida.
      modelValueRatio: (Number.isFinite(modelPoolValueUsd) && snapshotPoolValueUsd > 0)
        ? modelPoolValueUsd / snapshotPoolValueUsd
        : null,
      deltaQty: Number(metrics.deltaQty),
      targetQty: Number(metrics.targetQty),
      actualQty,
      volatileAmount: Number(metrics.volatileAmount),
      stableAmount: Number(metrics.stableAmount),
      normalizedGamma: Number(metrics.normalizedGamma),
      // OJO: hay que loguear la liquidez CRUDA, que es la que consume
      // `_buildDigitalTwin` (clona `protection.poolSnapshot` sin normalizar).
      // La normalizada pasa por `toPositiveNumber` (delta-neutral-snapshot
      // .service.js:71) y puede diferir o volverse null; loguear esa en vez de
      // la cruda haria que el diagnostico mintiera justo sobre el campo que
      // investiga. Se exponen las dos: divergencia entre ambas ya es la senal.
      liquidity: rawSnapshot.liquidity != null ? String(rawSnapshot.liquidity) : null,
      liquidityNormalized: snapshot.liquidity != null ? String(snapshot.liquidity) : null,
      tickLower: rawSnapshot.tickLower ?? null,
      tickUpper: rawSnapshot.tickUpper ?? null,
    });

    // Shadow mode: registra el residual sin cubrir hoy (deltaQty − targetQty)
    // vs el que dejaría el target propuesto (deltaQty − shadowTargetQty), sin
    // ejecutar. Permite cuantificar la mejora de cobertura sobre plata real
    // antes de adoptar los nuevos multiplicadores. Ver KPIs del plan.
    if ((this.shadowMode || metrics.shadowPolicyVersion === NET_PROFIT_V1) && metrics.shadowTargetQty != null) {
      // El estado vive en memoria durante la sesión: no consulta HL ni muta el
      // hedge real, y nunca se usa para reconciliar. Pero al arrancar hay que
      // recuperarlo del snapshot persistido: sin esto cada reinicio ponía a
      // cero el PnL, las comisiones y el funding acumulados de la sombra y 30 s
      // después sobrescribía el snapshot bueno. La evidencia que justifica
      // promover la política no puede depender de cuánto lleva el proceso vivo.
      const previousShadow = this.shadowStates.get(activeProtection.id)
        || (strategyState.shadowSnapshot
          ? createShadowState(strategyState.shadowSnapshot)
          : createShadowState({ actualQty, markPrice: currentPrice }));
      const shadowDecision = metrics.shadowPolicyVersion === NET_PROFIT_V1
        ? decideNetProfitV1({
          deltaQty: Number(metrics.deltaQty),
          actualQty: previousShadow.actualQty,
          currentPrice,
          rangeLowerPrice: activeProtection.rangeLowerPrice,
          rangeUpperPrice: activeProtection.rangeUpperPrice,
          lpValueUsd: Number(metrics.poolValueUsd),
          expectedCostUsd: Math.max(0.0005 * currentPrice * Math.abs(Number(metrics.deltaQty) - previousShadow.actualQty), 0),
          state: nextState.shadowPolicyState || {},
        })
        : { decision: 'rebalance', targetQty: Number(metrics.shadowTargetQty), adjustQty: Number(metrics.shadowTargetQty) - previousShadow.actualQty };
      const shadowTargetQty = shadowDecision.decision === 'rebalance'
        ? previousShadow.actualQty + Number(shadowDecision.adjustQty || 0)
        : previousShadow.actualQty;
      const shadow = simulateShadowFill(previousShadow, {
        targetQty: shadowTargetQty,
        bid: Number(liveMarket?.bbo?.bid ?? currentPrice),
        ask: Number(liveMarket?.bbo?.ask ?? currentPrice),
        feeRate: Number(liveMarket?.assetContext?.takerFeeRate) || 0.0005,
        fundingUsd: Number(position?.cumFunding?.sinceOpen) - Number(strategyState.shadowFundingSourceUsd || 0),
      });
      this.shadowStates.set(activeProtection.id, shadow);
      nextState.shadowPolicyState = shadowDecision.nextState || nextState.shadowPolicyState || {};
      if (!nextState.lastShadowSnapshotAt || Date.now() - Number(nextState.lastShadowSnapshotAt) >= 30_000) {
        nextState.shadowSnapshot = shadow;
        nextState.lastShadowSnapshotAt = Date.now();
      }
      nextState.shadowFundingSourceUsd = Number(position?.cumFunding?.sinceOpen) || 0;
      const liveResidualUsd = (Number(metrics.deltaQty) - Number(metrics.targetQty)) * currentPrice;
      const shadowResidualUsd = (Number(metrics.deltaQty) - Number(metrics.shadowTargetQty)) * currentPrice;
      this.logger.info?.('delta_neutral_shadow_hedge', {
        protectionId: activeProtection.id,
        accountId: activeProtection.accountId,
        asset: activeProtection.inferredAsset,
        zoneState: metrics.zoneState,
        deltaQty: Number(metrics.deltaQty),
        targetQty: Number(metrics.targetQty),
        shadowTargetQty: Number(metrics.shadowTargetQty),
        shadowDecision: shadowDecision.decision,
        shadowGate: shadowDecision.gate || null,
        actualQty,
        liveResidualUsd,
        shadowResidualUsd,
        residualReductionUsd: Math.abs(liveResidualUsd) - Math.abs(shadowResidualUsd),
        currentPrice,
        shadowExecutionFeesUsd: shadow.executionFeesUsd,
        shadowSlippageUsd: shadow.slippageUsd,
        shadowSlippageEwmaBps: shadow.slippageEwmaBps,
        shadowFundingUsd: shadow.fundingUsd,
        shadowMtmUsd: shadow.realizedPnlUsd + shadow.unrealizedPnlUsd,
      });
    }
    const forceReduceNearZero = !isNetProfitLive
      && metrics.targetQty <= NEAR_ZERO_TARGET_QTY
      && actualQty > 1e-8;
    const minDwellActive = Number.isFinite(Number(nextState.minDwellUntil)) && Date.now() < Number(nextState.minDwellUntil);
    const confidenceBlocksIncrease = nextState.modelConfidence === 'low' && driftQty > 0;
    const timerDue = !nextState.lastRebalanceAt
      || ((Date.now() - Number(nextState.lastRebalanceAt || 0)) >= (band.intervalSec * 1000));
    // Porcentaje del valor VIVO del LP, no un absoluto congelado al crear la
    // proteccion: si el LP crece o mengua, el umbral lo sigue.
    const minRebalanceNotionalUsd = resolveMinRebalanceNotionalUsd(activeProtection, metrics.poolValueUsd);
    // Banda de no-trade de las rutas urgentes. `boundary_cross` y `price_band`
    // disparaban sin ningun piso: cualquier cruce de borde mandaba orden aunque
    // la correccion valiera centavos, y cada orden paga taker fee + slippage y
    // realiza PnL del hedge. Las rutas que SI son de riesgo (reducir a cero,
    // hedge huerfano sin posicion, force manual) siguen sin gate.
    const urgentMinNotionalUsd = resolveUrgentMinRebalanceNotionalUsd(
      activeProtection,
      metrics.poolValueUsd,
      this.urgentMinRebalanceNotionalPct
    );
    const urgentTrigger = !isNetProfitLive && (forceReason === 'boundary_cross'
      || priceMovePct >= band.effectiveBandPct);
    const shouldRebalance = isNetProfitLive
      ? netProfitDecision.decision === 'rebalance'
      : forceRebalance
        || forceReduceNearZero
        || (urgentTrigger && driftUsd >= urgentMinNotionalUsd)
        || (timerDue && driftUsd >= minRebalanceNotionalUsd)
        || (!position && metrics.targetQty > 0.0000001);

    if (urgentTrigger && driftUsd < urgentMinNotionalUsd) {
      this.logger.info?.('delta_neutral_urgent_rebalance_skipped_below_band', {
        protectionId: activeProtection.id,
        accountId: activeProtection.accountId,
        asset: activeProtection.inferredAsset,
        forceReason: forceReason || null,
        priceMovePct,
        effectiveBandPct: band.effectiveBandPct,
        driftUsd,
        urgentMinNotionalUsd,
      });
    }

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
      protection: executionProtection,
      hl,
      strategyState: nextState,
      actualQty,
      currentPrice,
      tracking: executionTracking || tracking,
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
      // Por que NO se ejecuta pese a `preflightOk`. Sin esto, una cobertura
      // congelada por umbral/dwell/temporizador es indistinguible en los logs
      // de una sana: todos los campos de arriba salen en verde.
      shouldRebalance: effectiveShouldRebalance,
      poolValueUsd: metrics.poolValueUsd ?? null,
      minRebalanceNotionalUsd: Number.isFinite(minRebalanceNotionalUsd) ? minRebalanceNotionalUsd : null,
      driftUsd,
      timerDue,
      minDwellActive,
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
        slotRawUsd: preflight.slotRawUsd ?? null,
        slotSurplusExtractableUsd: preflight.slotSurplusExtractableUsd ?? null,
        incrementMarginUsd: preflight.incrementMarginUsd ?? null,
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
    nextState.lastDecisionReason = isNetProfitLive
      ? netProfitDecision.gate
      : forceReason
        || (rebalanceDecision.decision === 'hold' ? 'within_cost_aware_band' : 'drift_exceeds_cost_aware_band');
    if (confidenceBlocksIncrease) {
      nextState.lastDecision = 'refresh_snapshot';
      nextState.lastDecisionReason = 'low_confidence_model';
      nextState.truthPending = true;
    } else if (minDwellActive && shouldRebalance) {
      nextState.lastDecision = 'hold';
      nextState.lastDecisionReason = 'min_dwell_active';
      // Solo las senales forzadas se guardan: un trigger por deriva o por
      // precio se vuelve a evaluar solo en el tick siguiente, y marcarlo como
      // pendiente lo convertiria en un forzado permanente que se salta las
      // bandas de coste.
      if (forceRebalance || forceReason === 'boundary_cross') {
        nextState.pendingForceReason = forceReason || 'forced';
      }
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
    // Manda sobre el "sin cooldown" de arriba: con una senal pendiente hay una
    // fecha concreta en la que vuelve a ser elegible, y el monitor la necesita
    // para no quedarse esperando al temporizador largo.
    if (nextState.pendingForceReason && minDwellActive) {
      nextState.nextEligibleAttemptAt = Number(nextState.minDwellUntil) || null;
      nextState.cooldownReason = 'min_dwell_active';
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
        preflightExtra.maxSpreadBps = executionProtection.maxSpreadBps ?? DEFAULT_MAX_SPREAD_BPS;
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
        preflightExtra.minNotionalUsd = resolveMinOrderNotionalUsd(activeProtection);
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

    const reason = isNetProfitLive
      ? 'net_profit_v1'
      : forceReason
        || (!position && metrics.targetQty > 0.0000001 ? 'restart_reconcile' : priceMovePct >= band.effectiveBandPct ? 'price_band' : 'timer_and_drift');
    // La senal pendiente se cobra aqui: se ejecuta con su motivo original y no
    // debe sobrevivir a su propia ejecucion.
    nextState.pendingForceReason = null;
    return this._executeRebalance({
      protection: executionProtection,
      tradingService,
      hl,
      position,
      actualQty,
      currentPrice,
      metrics: executionMetrics,
      band,
      strategyState: nextState,
      reason,
    });
  },
};

module.exports = { evaluateMethods };
