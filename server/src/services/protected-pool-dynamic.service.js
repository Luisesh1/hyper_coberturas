const config = require('../config');
const logger = require('./logger.service');
const marketService = require('./market.service');
const hedgeRegistry = require('./hedge.registry');
const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');

const OPEN_HEDGE_STATUSES = new Set(['open', 'open_protected', 'entry_filled_pending_sl']);
const PENDING_HEDGE_STATUSES = new Set(['waiting', 'entry_pending']);

function asFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nearlyEqual(a, b, epsilon = 1e-8) {
  return Math.abs(Number(a) - Number(b)) <= epsilon;
}

function pctToRatio(value) {
  return Number(value) / 100;
}

class ProtectedPoolDynamicService {
  constructor(deps = {}) {
    this.repo = deps.protectedPoolRepository || protectedPoolRepository;
    this.marketService = deps.marketService || marketService;
    this.hedgeRegistry = deps.hedgeRegistry || hedgeRegistry;
    this.logger = deps.logger || logger;
    this.intervalMs = deps.intervalMs || config.intervals.hedgeMonitorMs;
    this.interval = null;
    this.running = false;
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.evaluateAll().catch((err) => {
        this.logger.error('protected_pool_dynamic_unhandled_error', { error: err.message });
      });
    }, this.intervalMs);
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
      const protections = await this.repo.listActiveDynamic();
      if (!protections.length) return;
      const mids = await this.marketService.getAllPrices();

      for (const protection of protections) {
        await this.evaluateProtection(protection, mids).catch((err) => {
          this.logger.warn('protected_pool_dynamic_eval_failed', {
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

  _deriveSideFromHedges(protection) {
    const upside = protection.hedges?.upside;
    const downside = protection.hedges?.downside;
    const longOpen = upside && OPEN_HEDGE_STATUSES.has(upside.status);
    const shortOpen = downside && OPEN_HEDGE_STATUSES.has(downside.status);
    if (longOpen && shortOpen) return 'conflict';
    if (longOpen) return 'long';
    if (shortOpen) return 'short';
    return null;
  }

  _buildState(protection, price, overrides = {}) {
    const current = protection.dynamicState || {};
    return {
      phase: current.phase || 'inside_range',
      activeSide: this._deriveSideFromHedges(protection),
      armedReentrySide: current.armedReentrySide || null,
      lastBrokenEdge: current.lastBrokenEdge || null,
      currentReentryPrice: current.currentReentryPrice ?? null,
      lastFlipAt: current.lastFlipAt ?? null,
      sequentialFlipCount: Number(current.sequentialFlipCount || 0),
      recoveryStatus: current.recoveryStatus || null,
      transition: current.transition || null,
      reentryBufferPct: protection.reentryBufferPct,
      flipCooldownSec: protection.flipCooldownSec,
      maxSequentialFlips: protection.maxSequentialFlips,
      upperReentryPrice: protection.rangeUpperPrice * (1 - protection.reentryBufferPct),
      lowerReentryPrice: protection.rangeLowerPrice * (1 + protection.reentryBufferPct),
      lastEvaluatedPrice: price,
      lastTransitionAt: current.lastTransitionAt || protection.updatedAt || Date.now(),
      ...overrides,
    };
  }

  async _saveState(protection, dynamicState) {
    await this.repo.updateDynamicState(protection.userId, protection.id, {
      dynamicState,
      updatedAt: Date.now(),
    });
  }

  async _pause(protection, price, recoveryStatus) {
    const nextState = this._buildState(protection, price, {
      phase: 'paused',
      recoveryStatus,
      transition: 'recovery_pending',
      lastTransitionAt: Date.now(),
    });
    await this._saveState(protection, nextState);
  }

  async _retargetHedge(hedgeSvc, hedge, { entryPrice, exitPrice, label }) {
    if (!hedge || !PENDING_HEDGE_STATUSES.has(hedge.status)) return false;
    if (nearlyEqual(hedge.entryPrice, entryPrice) && nearlyEqual(hedge.exitPrice, exitPrice)) {
      return false;
    }
    await hedgeSvc.retargetPendingHedge(hedge.id, { entryPrice, exitPrice, label });
    return true;
  }

  async _updateExit(hedgeSvc, hedge, exitPrice) {
    if (!hedge || !OPEN_HEDGE_STATUSES.has(hedge.status)) return false;
    if (nearlyEqual(hedge.exitPrice, exitPrice)) return false;
    await hedgeSvc.updateOpenHedgeExit(hedge.id, exitPrice);
    return true;
  }

  async evaluateProtection(protection, mids = null) {
    const upside = protection.hedges?.upside || null;
    const downside = protection.hedges?.downside || null;
    if (!upside || !downside) {
      await this._pause(protection, null, 'missing_hedges');
      return;
    }

    const allMids = mids || await this.marketService.getAllPrices();
    const price = asFiniteNumber(allMids?.[protection.inferredAsset]);
    if (!price) {
      await this._pause(protection, null, 'price_unavailable');
      return;
    }

    const derivedSide = this._deriveSideFromHedges(protection);
    if (derivedSide === 'conflict') {
      await this._pause(protection, price, 'both_hedges_open');
      return;
    }

    const hedgeSvc = await this.hedgeRegistry.getOrCreate(protection.userId, protection.accountId);
    const upperReentryPrice = protection.rangeUpperPrice * (1 - protection.reentryBufferPct);
    const lowerReentryPrice = protection.rangeLowerPrice * (1 + protection.reentryBufferPct);
    const now = Date.now();
    const current = protection.dynamicState || {};
    let sequentialFlipCount = Number(current.sequentialFlipCount || 0);
    let lastFlipAt = current.lastFlipAt ?? null;
    const previousSide = current.activeSide || null;
    if (previousSide && derivedSide && previousSide !== derivedSide) {
      sequentialFlipCount += 1;
      lastFlipAt = now;
    } else if (!derivedSide) {
      sequentialFlipCount = 0;
    }
    if (protection.maxSequentialFlips && sequentialFlipCount > protection.maxSequentialFlips) {
      await this._pause(protection, price, 'max_flips_exceeded');
      return;
    }

    const cooldownActive = (
      lastFlipAt != null &&
      protection.flipCooldownSec != null &&
      protection.flipCooldownSec > 0 &&
      now - Number(lastFlipAt) < protection.flipCooldownSec * 1000
    );

    if (price >= protection.rangeUpperPrice) {
      await this._retargetHedge(hedgeSvc, downside, {
        entryPrice: upperReentryPrice,
        exitPrice: upperReentryPrice * (1 + pctToRatio(protection.stopLossDifferencePct)),
        label: `${protection.token0Symbol}/${protection.token1Symbol} · Reentrada short`,
      });
      if (!cooldownActive) {
        await this._updateExit(hedgeSvc, upside, upperReentryPrice);
      }
      await this._saveState(protection, this._buildState(protection, price, {
        phase: 'broken_upper',
        activeSide: derivedSide,
        armedReentrySide: 'short',
        lastBrokenEdge: 'upper',
        currentReentryPrice: upperReentryPrice,
        sequentialFlipCount,
        lastFlipAt,
        recoveryStatus: null,
        transition: null,
        lastTransitionAt: now,
      }));
      return;
    }

    if (price <= protection.rangeLowerPrice) {
      await this._retargetHedge(hedgeSvc, upside, {
        entryPrice: lowerReentryPrice,
        exitPrice: lowerReentryPrice * (1 - pctToRatio(protection.stopLossDifferencePct)),
        label: `${protection.token0Symbol}/${protection.token1Symbol} · Reentrada long`,
      });
      if (!cooldownActive) {
        await this._updateExit(hedgeSvc, downside, lowerReentryPrice);
      }
      await this._saveState(protection, this._buildState(protection, price, {
        phase: 'broken_lower',
        activeSide: derivedSide,
        armedReentrySide: 'long',
        lastBrokenEdge: 'lower',
        currentReentryPrice: lowerReentryPrice,
        sequentialFlipCount,
        lastFlipAt,
        recoveryStatus: null,
        transition: null,
        lastTransitionAt: now,
      }));
      return;
    }

    await this._saveState(protection, this._buildState(protection, price, {
      phase: 'inside_range',
      activeSide: derivedSide,
      currentReentryPrice: current.currentReentryPrice ?? null,
      armedReentrySide: current.armedReentrySide ?? null,
      lastBrokenEdge: current.lastBrokenEdge ?? null,
      sequentialFlipCount,
      lastFlipAt,
      recoveryStatus: null,
      transition: null,
    }));
  }
}

module.exports = new ProtectedPoolDynamicService();
module.exports.ProtectedPoolDynamicService = ProtectedPoolDynamicService;
