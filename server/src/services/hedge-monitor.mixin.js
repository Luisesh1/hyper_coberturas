/**
 * hedge-monitor.mixin.js
 *
 * Contiene la lógica del monitor periódico de posiciones.
 * Se mezcla en HedgeService.prototype via Object.assign.
 *
 * Todos los métodos usan `this` referenciando la instancia de HedgeService.
 */

const logger = require('./logger.service');
const config = require('../config');

const MONITOR_INTERVAL_MS = config.intervals.hedgeMonitorMs;
const CLOSING_TIMEOUT_MS = config.intervals.hedgeClosingTimeoutMs;

const monitorMethods = {
  _startMonitor() {
    this._monitorInterval = setInterval(() => {
      this._monitorPositions().catch((err) => {
        logger.error('hedge_monitor_error', { userId: this.userId, error: err.message });
      });
    }, MONITOR_INTERVAL_MS);
  },

  stopMonitor() {
    if (this._monitorInterval) {
      clearInterval(this._monitorInterval);
      this._monitorInterval = null;
    }
  },

  async _monitorPositions() {
    const activeHedges = [...this.hedges.values()].filter((hedge) =>
      [
        'entry_pending',
        'entry_filled_pending_sl',
        'open_protected',
        'open',
        'closing',
        'cancel_pending',
      ].includes(hedge.status)
    );
    if (activeHedges.length === 0) return;

    let openOrders = [];
    let openOidSet = new Set();
    let openOrdersAvailable = true;
    try {
      openOrders = await this.hl.getOpenOrders();
      openOidSet = new Set((openOrders || []).map((order) => Number(order.oid)));
    } catch (err) {
      logger.warn('hedge_open_orders_unavailable', { userId: this.userId, error: err.message });
      openOrdersAvailable = false;
    }

    for (const hedge of activeHedges) {
      try {
        hedge.lastReconciledAt = Date.now();

        if (hedge.status === 'cancel_pending') {
          await this._reconcileCancelPending(hedge);
          continue;
        }

        if (hedge.status === 'entry_pending') {
          await this._monitorEntryPending(hedge, { openOrders, openOidSet, openOrdersAvailable });
          continue;
        }

        if (hedge.status === 'entry_filled_pending_sl') {
          await this._monitorPendingSl(hedge, { openOrders, openOidSet, openOrdersAvailable });
          continue;
        }

        if (hedge.status === 'closing') {
          await this._monitorClosing(hedge);
          continue;
        }

        if (hedge.status === 'open') {
          hedge.status = hedge.slOid ? 'open_protected' : 'entry_filled_pending_sl';
        }

        if (hedge.status === 'open_protected') {
          await this._monitorOpenProtected(hedge, { openOrders, openOidSet, openOrdersAvailable });
        }
      } catch (err) {
        logger.error('hedge_monitor_item_error', { hedgeId: hedge.id, error: err.message });
      }
    }
  },

  async _monitorEntryPending(hedge, { openOrders, openOidSet, openOrdersAvailable }) {
    if (this._isEntryTransitionInProgress(hedge)) {
      await this._save(hedge).catch((err) => logger.error('hedge_save_failed', { hedgeId: hedge.id, error: err.message }));
      return;
    }

    if (openOrdersAvailable) {
      const keepEntry = await this._cancelDuplicateEntryOrders(hedge, openOrders, hedge.entryOid);
      if (keepEntry?.oid) {
        hedge.entryOid = Number(keepEntry.oid);
      }
    }

    if (!hedge.entryOid) {
      if (!openOrdersAvailable) {
        await this._save(hedge).catch((err) => logger.error('hedge_save_failed', { hedgeId: hedge.id, error: err.message }));
        return;
      }
      await this._placeEntryOrder(hedge, { openOrders, openOrdersAvailable });
      return;
    }

    if (openOrdersAvailable && !openOidSet.has(Number(hedge.entryOid))) {
      const recovered = await this._recoverEntryFromExchange(hedge);
      if (!recovered) {
        logger.warn('hedge_entry_vanished', { hedgeId: hedge.id });
        hedge.entryOid = null;
        await this._placeEntryOrder(hedge, { openOrders, openOrdersAvailable });
      }
    } else if (openOrdersAvailable) {
      const midsEntry = await this.hl.getAllMids().catch(() => null);
      const midEntry = midsEntry ? parseFloat(midsEntry[hedge.asset]) : null;
      if (this._isEntryConditionMet(hedge, midEntry)) {
        logger.warn('hedge_entry_condition_met', { hedgeId: hedge.id, price: midEntry, entryPrice: hedge.entryPrice });
        await this._reconcileTriggeredEntry(hedge, {
          currentPrice: midEntry,
          openOrders,
          openOrdersAvailable,
          source: 'monitor',
        });
      }
    }
  },

  async _monitorPendingSl(hedge, { openOrders, openOidSet, openOrdersAvailable }) {
    const pos = await this.hl.getPosition(hedge.asset).catch(() => null);
    if (!pos || parseFloat(pos.szi) === 0) {
      const recovered = await this._recoverExitFromExchange(hedge);
      if (!recovered) {
        await this._completeCycleWithoutExitFill(hedge);
      }
      return;
    }
    hedge.positionSize = Math.abs(parseFloat(pos.szi));
    if (await this._handleUnexpectedPositionSize(hedge, hedge.positionSize, 'entry_filled_pending_sl')) {
      return;
    }

    if (openOrdersAvailable) {
      await this._cancelDuplicateEntryOrders(hedge, openOrders, null);
    }

    if (openOrdersAvailable && hedge.slOid && openOidSet.has(Number(hedge.slOid))) {
      hedge.status = 'open_protected';
      await this._emitUpdated(hedge);
      this.notifier.opened(hedge);
      return;
    }

    const mids = await this.hl.getAllMids().catch(() => null);
    const currentPrice = mids ? parseFloat(mids[hedge.asset]) : null;
    const exitBreached = currentPrice && (
      hedge.direction === 'short'
        ? currentPrice >= hedge.exitPrice
        : currentPrice <= hedge.exitPrice
    );
    if (exitBreached) {
      logger.warn('hedge_price_crossed_sl', { hedgeId: hedge.id, currentPrice, exitPrice: hedge.exitPrice });
      hedge.status = 'closing';
      hedge.closingStartedAt = Date.now();
      await this._emitUpdated(hedge);
      await this._closePositionReduceOnly(hedge, pos).catch((err) => {
        logger.warn('hedge_forced_close_failed', { hedgeId: hedge.id, error: err.message });
      });
      return;
    }

    if (!openOrdersAvailable && hedge.slOid) {
      await this._save(hedge).catch((err) => logger.error('hedge_save_failed', { hedgeId: hedge.id, error: err.message }));
      return;
    }

    const SL_GRACE_MS = 30_000;
    if (hedge.slOid && hedge.slPlacedAt && (Date.now() - hedge.slPlacedAt) < SL_GRACE_MS) {
      logger.info('hedge_sl_grace_wait', { hedgeId: hedge.id, slOid: hedge.slOid, ageSec: Math.round((Date.now() - hedge.slPlacedAt) / 1000) });
      return;
    }

    const MAX_SL_RETRIES = 8;
    hedge.slRetryCount = (hedge.slRetryCount || 0) + 1;
    if (hedge.slRetryCount > MAX_SL_RETRIES) {
      hedge.status = 'error';
      hedge.error = `SL falló ${MAX_SL_RETRIES} veces seguidas. Posición desprotegida — intervención manual requerida.`;
      await this._emitUpdated(hedge);
      this.notifier.protectionMissing(hedge);
      logger.error('hedge_sl_max_retries', { hedgeId: hedge.id, retries: MAX_SL_RETRIES });
      return;
    }

    try {
      const { transitioned } = await this._ensureStopLoss(hedge);
      if (transitioned) {
        hedge.slRetryCount = 0;
        this.notifier.opened(hedge);
      }
    } catch (err) {
      hedge.error = `SL pendiente (intento ${hedge.slRetryCount}/${MAX_SL_RETRIES}): ${err.message}`;
      await this._emitUpdated(hedge);
      this.notifier.protectionMissing(hedge);
    }
  },

  async _monitorClosing(hedge) {
    const pos = await this.hl.getPosition(hedge.asset).catch(() => null);
    if (!pos || parseFloat(pos.szi) === 0) {
      const recovered = await this._recoverExitFromExchange(hedge);
      if (!recovered) {
        await this._completeCycleWithoutExitFill(hedge);
      }
      return;
    }
    hedge.positionSize = Math.abs(parseFloat(pos.szi));

    if (hedge.closingStartedAt && Date.now() - hedge.closingStartedAt > CLOSING_TIMEOUT_MS) {
      await this._closePositionReduceOnly(hedge, pos).catch((err) => {
        logger.warn('hedge_close_rescue_failed', { hedgeId: hedge.id, error: err.message });
      });
    }
    await this._save(hedge).catch((err) => logger.error('hedge_save_failed', { hedgeId: hedge.id, error: err.message }));
  },

  async _monitorOpenProtected(hedge, { openOrders, openOidSet, openOrdersAvailable }) {
    const pos = await this.hl.getPosition(hedge.asset).catch(() => null);
    if (!pos || parseFloat(pos.szi) === 0) {
      const recovered = await this._recoverExitFromExchange(hedge);
      if (!recovered) {
        await this._completeCycleWithoutExitFill(hedge);
      }
      return;
    }
    hedge.positionSize = Math.abs(parseFloat(pos.szi));
    if (await this._handleUnexpectedPositionSize(hedge, hedge.positionSize, 'open_protected')) {
      return;
    }

    if (openOrdersAvailable) {
      await this._cancelDuplicateEntryOrders(hedge, openOrders, null);
    }

    const prevPnl = hedge.unrealizedPnl;
    hedge.unrealizedPnl = parseFloat(pos.unrealizedPnl || 0);
    if (pos.cumFunding?.sinceOpen !== undefined) {
      hedge.fundingAccum = parseFloat(pos.cumFunding.sinceOpen || 0);
    }

    if (prevPnl !== hedge.unrealizedPnl) {
      await this._emitUpdated(hedge);
    } else {
      await this._save(hedge).catch((err) => logger.error('hedge_save_failed', { hedgeId: hedge.id, error: err.message }));
    }

    // Validación en tiempo real: ¿ya cruzó el precio de salida?
    const midsRT = await this.hl.getAllMids().catch(() => null);
    const currentPriceRT = midsRT ? parseFloat(midsRT[hedge.asset]) : null;
    if (currentPriceRT && hedge.exitPrice) {
      const exitBreachedRT = hedge.direction === 'short'
        ? currentPriceRT >= parseFloat(hedge.exitPrice)
        : currentPriceRT <= parseFloat(hedge.exitPrice);

      if (exitBreachedRT) {
        logger.warn('hedge_exit_breached_rt', { hedgeId: hedge.id, currentPrice: currentPriceRT, exitPrice: hedge.exitPrice });

        if (openOrdersAvailable && hedge.slOid && openOidSet.has(Number(hedge.slOid))) {
          logger.info('hedge_cancel_sl_before_close', { hedgeId: hedge.id, slOid: hedge.slOid });
          await this.hl.cancelOrder(hedge.assetIndex, hedge.slOid).catch((e) =>
            logger.warn('hedge_cancel_sl_failed', { hedgeId: hedge.id, error: e.message })
          );
          hedge.slOid = null;
        }

        hedge.status = 'closing';
        hedge.closingStartedAt = Date.now();
        await this._emitUpdated(hedge);
        await this._closePositionReduceOnly(hedge, pos).catch((e) =>
          logger.error('hedge_market_close_failed', { hedgeId: hedge.id, error: e.message })
        );
        return;
      }
    }

    if (!openOrdersAvailable) {
      await this._save(hedge).catch((err) => logger.error('hedge_save_failed', { hedgeId: hedge.id, error: err.message }));
      return;
    }

    if (!hedge.slOid || !openOidSet.has(Number(hedge.slOid))) {
      const recovered = await this._recoverExitFromExchange(hedge);
      if (!recovered) {
        logger.warn('hedge_sl_vanished', { hedgeId: hedge.id });
        hedge.slOid = null;
        try {
          await this._ensureStopLoss(hedge);
        } catch (err) {
          hedge.status = 'entry_filled_pending_sl';
          hedge.error = `SL pendiente: ${err.message}`;
          await this._emitUpdated(hedge);
          this.notifier.protectionMissing(hedge);
        }
      }
    }
  },
};

module.exports = { monitorMethods };
