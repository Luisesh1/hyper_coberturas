/**
 * hedge-cycle.mixin.js
 *
 * Contiene la lógica de ciclos (finalizar, resetear, reconstruir sin fill).
 * Se mezcla en HedgeService.prototype via Object.assign.
 *
 * Todos los métodos usan `this` referenciando la instancia de HedgeService.
 */

const logger = require('./logger.service');
const { getTrackedPositionSize } = require('./hedge.state');

const cycleMethods = {
  async _resetAfterCycle(hedge, closePrice, closeTime) {
    hedge.status = 'waiting';
    hedge.cycleCount = hedge.cycles.length;
    hedge.closePrice = closePrice;
    hedge.closedAt = closeTime;
    hedge.dynamicAnchorPrice = hedge.entryPrice;
    hedge.openedAt = null;
    hedge.openPrice = null;
    hedge.positionSize = null;
    hedge.unrealizedPnl = null;
    hedge.slOid = null;
    hedge.entryOid = null;
    hedge.error = null;
    hedge.slPlacedAt = null;
    hedge.closingStartedAt = null;
    hedge.entryFillOid = null;
    hedge.entryFillTime = null;
    hedge.entryFeePaid = 0;
    hedge.fundingAccum = 0;
    hedge.slRetryCount = 0;
    hedge.cancelStartedAt = null;
    hedge.entryPlacedAt = null;
    hedge._priceActionInProgress = false;
    hedge.partialCoverageInfo = null;
  },

  async _finalizeCycle(hedge, cycle) {
    hedge.cycles.push(cycle);
    await this._resetAfterCycle(hedge, cycle.closePrice ?? null, cycle.closedAt);
    await this.repo.saveHedgeWithCycle(hedge, cycle);
    this.notifier.updated(hedge);
    this.notifier.cycleComplete(hedge, cycle);
    await this._placeEntryOrder(hedge);
  },

  async _onSlFill(hedge, fill) {
    const closeTime = fill.time || Date.now();
    hedge.status = 'closing';
    hedge.closingStartedAt = Date.now();
    hedge.lastFillAt = closeTime;
    await this._emitUpdated(hedge);

    const closedPnl = fill.closedPnl != null ? parseFloat(fill.closedPnl) : null;
    const entryFee  = hedge.entryFeePaid ?? 0;
    const exitFee   = parseFloat(fill.fee ?? 0);
    const funding   = hedge.fundingAccum ?? 0;

    const entrySlippage = hedge.openPrice != null
      ? Math.abs(hedge.openPrice - hedge.entryPrice)
      : 0;
    const exitSlippage  = Math.abs(parseFloat(fill.px) - hedge.exitPrice);
    const trackedSize = getTrackedPositionSize(hedge);
    const normalizedFillSize = Math.abs(parseFloat(fill.sz ?? trackedSize ?? 0)) || trackedSize;
    const normalizedTotalSlippage = (entrySlippage + exitSlippage) * normalizedFillSize;

    const netPnl = closedPnl != null
      ? closedPnl - entryFee - exitFee + funding
      : null;

    const cycle = {
      cycleId: hedge.cycles.length + 1,
      openedAt: hedge.openedAt,
      openPrice: hedge.openPrice,
      closedAt: closeTime,
      closePrice: parseFloat(fill.px),
      size: normalizedFillSize,
      entryFee,
      exitFee,
      closedPnl,
      fundingPaid: funding,
      entryFillOid: hedge.entryFillOid ?? null,
      exitFillOid: Number(fill.oid) || hedge.slOid || null,
      entryFillTime: hedge.entryFillTime ?? hedge.openedAt ?? null,
      exitFillTime: closeTime,
      entrySlippage,
      exitSlippage,
      totalSlippage: normalizedTotalSlippage,
      netPnl,
    };

    await this._finalizeCycle(hedge, cycle);
  },

  async _completeCycleWithoutExitFill(hedge) {
    if (!this._hasConfirmedEntry(hedge)) {
      logger.warn('hedge_close_no_entry', { hedgeId: hedge.id });
      await this._resetAfterCycle(hedge, null, null);
      await this._emitUpdated(hedge);
      await this._placeEntryOrder(hedge);
      return;
    }

    const mids = await this.hl.getAllMids().catch(() => null);
    const approxClosePrice = mids ? parseFloat(mids[hedge.asset]) : null;
    const trackedSize = getTrackedPositionSize(hedge);

    let approxPnl = null;
    if (approxClosePrice && hedge.openPrice) {
      approxPnl = hedge.direction === 'short'
        ? (hedge.openPrice - approxClosePrice) * trackedSize
        : (approxClosePrice - hedge.openPrice) * trackedSize;
    }

    const cycle = {
      cycleId: hedge.cycles.length + 1,
      openedAt: hedge.openedAt,
      openPrice: hedge.openPrice,
      closedAt: Date.now(),
      closePrice: approxClosePrice,
      size: trackedSize,
      entryFee: hedge.entryFeePaid ?? 0,
      exitFee: 0,
      closedPnl: approxPnl,
      fundingPaid: hedge.fundingAccum ?? 0,
      entryFillOid: hedge.entryFillOid ?? null,
      exitFillOid: hedge.slOid ?? null,
      entryFillTime: hedge.entryFillTime ?? hedge.openedAt ?? null,
      exitFillTime: null,
      entrySlippage: 0,
      exitSlippage: 0,
      totalSlippage: 0,
      netPnl: approxPnl != null
        ? approxPnl - (hedge.entryFeePaid ?? 0) + (hedge.fundingAccum ?? 0)
        : null,
    };
    logger.warn('hedge_cycle_no_exit_fill', { hedgeId: hedge.id, approxClosePrice });
    await this._finalizeCycle(hedge, cycle);
  },
};

module.exports = { cycleMethods };
