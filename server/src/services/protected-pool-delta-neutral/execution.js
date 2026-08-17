/**
 * Ejecucion del rebalanceo del hedge: orden unica, TWAP por tramos y el
 * cierre de las decisiones que llegan desde la evaluacion.
 *
 * Se compone sobre el prototipo del servicio (ver margin.js).
 */
const crypto = require('node:crypto');
const logger = require('../logger.service');
const {
  DEFAULT_EMERGENCY_IOC_NOTIONAL_USD,
  DEFAULT_EXECUTION_MODE,
  DEFAULT_TWAP_DURATION_SEC,
  DEFAULT_TWAP_MIN_NOTIONAL_USD,
  DEFAULT_TWAP_SLICES,
  ESTIMATED_TAKER_FEE_RATE,
  buildCooldown,
  estimateExecutionCostUsd,
  resolveMinOrderNotionalUsd,
} = require('../protected-pool-delta-neutral.helpers');

const executionMethods = {
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
    if (typeof hl?.getPosition === 'function') {
      let latestPosition = await hl.getPosition(protection.inferredAsset);
      if (!latestPosition && Number(actualQty) > 0) {
        latestPosition = await hl.getPosition(protection.inferredAsset);
        if (!latestPosition) {
          const err = new Error('No se pudo confirmar la posición justo antes de ejecutar; se bloquea el rebalanceo.');
          err.code = 'POSITION_RECONCILIATION_REQUIRED';
          throw err;
        }
      }
      const latestSignedQty = Number(latestPosition?.szi || 0);
      if (latestSignedQty > 0) {
        const err = new Error(`Existe una posición long inesperada en ${protection.inferredAsset}; se requiere reconciliación.`);
        err.code = 'UNEXPECTED_HEDGE_DIRECTION';
        throw err;
      }
      actualQty = latestSignedQty < 0 ? Math.abs(latestSignedQty) : 0;
    }

    const policyTargetQty = Number(metrics.policyTargetQty ?? metrics.targetQty);
    const driftQty = Number(metrics.targetQty) - Number(actualQty);
    const driftUsd = Math.abs(driftQty) * currentPrice;
    if (!Number.isFinite(driftQty) || Math.abs(driftQty) < 1e-8) {
      return strategyState;
    }
    if (strategyState.status === 'risk_paused' && driftQty > 0) {
      return strategyState;
    }
    const minNotionalUsd = resolveMinOrderNotionalUsd(protection);
    // Bypass del mínimo cuando el drift es un reduce-only que cierra la
    // posición completa (targetQty≈0 y actualQty>0). Permite desmontar
    // residuos que de otro modo se acumularían indefinidamente.
    const isFullCloseReduce = driftQty < 0
      && Number(actualQty) > 0
      && Math.abs(driftQty) + 1e-8 >= Number(actualQty);
    if (driftUsd < minNotionalUsd && !isFullCloseReduce) {
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
      targetQtyBefore: policyTargetQty,
      deltaQtyBefore: Number(metrics.deltaQty),
      gammaBefore: Number(metrics.gamma),
      driftUsd,
    };

    const unresolvedExecution = ['pending', 'unknown'].includes(strategyState.lastExecutionOutcome)
      && strategyState.pendingExecutionId;
    const executionId = unresolvedExecution || crypto.randomUUID();
    let executionSummary;
    try {
      await this.repo.updateStrategyState(protection.userId, protection.id, {
        strategyState: {
          ...strategyState,
          status: 'executing',
          lastExecutionAttemptAt: Date.now(),
          lastExecutionOutcome: 'pending',
          pendingExecutionId: executionId,
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
          executionId,
        });
      } else {
        executionSummary = await this._runSingleAdjustment({
          protection,
          tradingService,
          hl,
          currentPrice,
          driftQty,
          actualQty,
          executionId,
        });
      }
      // Los fills recién ejecutados no aparecerán en el cache de 30 s, así
      // que lo invalidamos para que el siguiente `_reconcileHedgeFills`
      // los capture sin esperar al TTL.
      this._invalidateUserFillsCache(hl);
    } catch (err) {
      this._invalidateUserFillsCache(hl);
      const outcomeUnknown = /timeout|timed out|econnreset|socket hang up|network|fetch failed/i
        .test(String(err?.message || ''));
      const failedState = {
        ...strategyState,
        status: executionMode === 'TWAP' ? 'degraded_partial' : 'partial_hedge_warning',
        lastError: err.message,
        lastExecutionAttemptAt: Date.now(),
        lastExecutionOutcome: outcomeUnknown ? 'unknown' : 'failed',
        pendingExecutionId: outcomeUnknown ? executionId : null,
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
        trackingErrorQty: policyTargetQty - Number(actualQty),
        trackingErrorUsd: Math.abs(policyTargetQty - Number(actualQty)) * currentPrice,
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
        targetQty: policyTargetQty,
        actualQty,
        trackingErrorQty: policyTargetQty - Number(actualQty),
        trackingErrorUsd: Math.abs(policyTargetQty - Number(actualQty)) * currentPrice,
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
      lastTargetQty: Number(metrics.policyTargetQty ?? metrics.targetQty),
      lastSnapshotPrice: currentPrice,
      lastError: executionSummary.partial ? 'El rebalance TWAP quedo parcial.' : null,
      lastExecutionAttemptAt: Date.now(),
      lastExecutionOutcome: executionSummary.partial ? 'partial' : 'success',
      pendingExecutionId: null,
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
      trackingErrorQty: policyTargetQty - Number(actualQtyAfter),
      trackingErrorUsd: Math.abs(policyTargetQty - Number(actualQtyAfter)) * currentPrice,
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
      targetQtyAfter: policyTargetQty,
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
      targetQty: policyTargetQty,
      actualQty: actualQtyAfter,
      trackingErrorQty: policyTargetQty - Number(actualQtyAfter),
      trackingErrorUsd: Math.abs(policyTargetQty - Number(actualQtyAfter)) * currentPrice,
      currentPrice,
      finalStrategyStatus: updatedState.status,
      riskGateTriggered: false,
      liquidationDistancePct: updatedState.distanceToLiqPct,
    });

    return updatedState;
  },

  _executionCloid(executionId, step) {
    return `0x${crypto.createHash('sha256')
      .update(`delta-neutral:${executionId}:${step}`)
      .digest('hex')
      .slice(0, 32)}`;
  },

  async _runSingleAdjustment({
    protection,
    tradingService,
    hl,
    currentPrice,
    driftQty,
    actualQty = 0,
    executionId = crypto.randomUUID(),
    step = 'ioc',
  }) {
    if (driftQty > 0) {
      await this._ensureIsolatedMarginBuffer(protection, hl, currentPrice, driftQty, actualQty);
      const result = await tradingService.openPosition({
        asset: protection.inferredAsset,
        side: 'short',
        size: driftQty,
        leverage: protection.leverage,
        marginMode: 'isolated',
        maxSlippageBps: protection.maxSlippageBps,
        cloid: this._executionCloid(executionId, `${step}:increase`),
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
      maxSlippageBps: protection.maxSlippageBps,
      cloid: this._executionCloid(executionId, `${step}:decrease`),
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
  },

  async _runTwap({
    protection,
    tradingService,
    hl,
    currentPrice,
    driftQty,
    actualQty = 0,
    executionId = crypto.randomUUID(),
  }) {
    const direction = driftQty > 0 ? 'increase' : 'decrease';
    const totalQty = Math.abs(driftQty);
    const slicesPlanned = Math.max(
      1,
      Math.floor(Number(protection.twapSlices ?? DEFAULT_TWAP_SLICES) || DEFAULT_TWAP_SLICES)
    );
    const twapDurationSec = Math.max(
      0,
      Number(protection.twapDurationSec ?? DEFAULT_TWAP_DURATION_SEC) || DEFAULT_TWAP_DURATION_SEC
    );
    const sliceDelayMs = Math.floor((twapDurationSec * 1000) / Math.max(slicesPlanned - 1, 1));
    const session = { cancelRequested: false };
    this.twapSessions.set(protection.id, session);

    let completed = 0;
    let executedQtyReal = 0;
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
        // Usar ejecución real acumulada (no la planeada) para calcular
        // cuánto queda. Así los fills parciales de slices anteriores no se
        // convierten en "dinero perdido" del plan.
        const remainingQty = Math.max(totalQty - executedQtyReal, 0);
        if (remainingQty <= 1e-9) break;
        const slicesLeft = Math.max(slicesPlanned - index, 1);
        const qty = index === slicesPlanned - 1 ? remainingQty : Math.min(remainingQty, remainingQty / slicesLeft);
        if (direction === 'increase') {
          await this._ensureIsolatedMarginBuffer(protection, hl, currentPrice, qty, actualQty + executedQtyReal);
        }
        const sliceResult = direction === 'increase'
          ? await tradingService.openPosition({
            asset: protection.inferredAsset,
            side: 'short',
            size: qty,
            leverage: protection.leverage,
            marginMode: 'isolated',
            maxSlippageBps: protection.maxSlippageBps,
            cloid: this._executionCloid(executionId, `twap:${index}:increase`),
          })
          : await tradingService.closePosition({
            asset: protection.inferredAsset,
            size: qty,
            maxSlippageBps: protection.maxSlippageBps,
            cloid: this._executionCloid(executionId, `twap:${index}:decrease`),
          });
        lastFillPrice = Number(sliceResult.fillPrice || sliceResult.closePrice || currentPrice);
        const actualSliceQty = Number.isFinite(Number(sliceResult.filledQty)) ? Number(sliceResult.filledQty) : qty;
        executedQtyReal += actualSliceQty;
        totalFees += Math.abs(lastFillPrice * actualSliceQty * ESTIMATED_TAKER_FEE_RATE);
        totalSlippage += Math.abs(lastFillPrice - currentPrice) * actualSliceQty;
        completed += 1;
      }
    } catch (err) {
      this.twapSessions.delete(protection.id);
      const remainingQty = Math.max(totalQty - executedQtyReal, 0);
      if ((remainingQty * currentPrice) >= DEFAULT_EMERGENCY_IOC_NOTIONAL_USD) {
        try {
          const emergency = await this._runSingleAdjustment({
            protection,
            tradingService,
            hl,
            currentPrice,
            driftQty: direction === 'increase' ? remainingQty : -remainingQty,
            actualQty: actualQty + executedQtyReal,
            executionId,
            step: 'twap-emergency',
          });
          totalFees += Number(emergency.executionFeeUsd || 0);
          totalSlippage += Number(emergency.slippageUsd || 0);
          lastFillPrice = Number(emergency.fillPrice || lastFillPrice);
          const emergencyExecuted = Number.isFinite(Number(emergency.executedQty)) ? Number(emergency.executedQty) : 0;
          executedQtyReal += emergencyExecuted;
          return {
            partial: executedQtyReal + 1e-9 < totalQty,
            fillPrice: lastFillPrice,
            executedQty: executedQtyReal,
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
        executedQty: executedQtyReal,
        executionFeeUsd: totalFees,
        slippageUsd: totalSlippage,
        twapSlicesPlanned: slicesPlanned,
        twapSlicesCompleted: completed,
      };
    } finally {
      this.twapSessions.delete(protection.id);
    }

    return {
      partial: executedQtyReal + 1e-9 < totalQty,
      fillPrice: lastFillPrice,
      executedQty: executedQtyReal,
      executionFeeUsd: totalFees,
      slippageUsd: totalSlippage,
      twapSlicesPlanned: slicesPlanned,
      twapSlicesCompleted: completed,
    };
  },
};

module.exports = { executionMethods };
