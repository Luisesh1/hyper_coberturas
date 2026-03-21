const config = require('../config');
const logger = require('./logger.service');
const marketService = require('./market.service');
const hedgeRegistry = require('./hedge.registry');
const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');
const { formatPrice } = require('../utils/format');

const OPEN_HEDGE_STATUSES = new Set(['open', 'open_protected', 'entry_filled_pending_sl']);
const PENDING_HEDGE_STATUSES = new Set(['waiting', 'entry_pending']);
const SUPPORTED_PHASES = new Set([
  'neutral',
  'confirming_lower_breakout',
  'lower_regime_confirmed',
  'confirming_upper_breakout',
  'upper_regime_confirmed',
  'paused',
]);

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

function normalizeDistancePct(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.5;
}

function normalizeDurationSec(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 600;
}

function toWireNumber(value) {
  const wire = formatPrice(Number(value));
  const parsed = Number(wire);
  return Number.isFinite(parsed) ? parsed : null;
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

  _deriveSideFromHedges({ downside, upside }) {
    const longOpen = upside && OPEN_HEDGE_STATUSES.has(upside.status);
    const shortOpen = downside && OPEN_HEDGE_STATUSES.has(downside.status);
    if (longOpen && shortOpen) return 'conflict';
    if (longOpen) return 'long';
    if (shortOpen) return 'short';
    return null;
  }

  _baseAnchor(protection, role) {
    return role === 'downside'
      ? Number(protection.rangeLowerPrice)
      : Number(protection.rangeUpperPrice);
  }

  _migratedAnchor(protection, role) {
    return role === 'downside'
      ? Number(protection.rangeUpperPrice) * (1 - Number(protection.reentryBufferPct))
      : Number(protection.rangeLowerPrice) * (1 + Number(protection.reentryBufferPct));
  }

  _expectedAnchor(protection, role, regime = 'neutral') {
    if (regime === 'lower_regime_confirmed' && role === 'upside') {
      return this._migratedAnchor(protection, role);
    }
    if (regime === 'upper_regime_confirmed' && role === 'downside') {
      return this._migratedAnchor(protection, role);
    }
    return this._baseAnchor(protection, role);
  }

  _expectedExit(anchorPrice, direction, stopLossDifferencePct) {
    const anchor = Number(anchorPrice);
    const ratio = pctToRatio(stopLossDifferencePct);
    return direction === 'short'
      ? anchor * (1 + ratio)
      : anchor * (1 - ratio);
  }

  _normalizePhase(phase) {
    if (SUPPORTED_PHASES.has(phase)) return phase;
    if (phase === 'broken_lower') return 'lower_regime_confirmed';
    if (phase === 'broken_upper') return 'upper_regime_confirmed';
    if (phase === 'inside_range') return 'neutral';
    return 'neutral';
  }

  _inferRegimeFromAnchors(protection, downside, upside) {
    const downsideAnchor = Number(downside?.dynamicAnchorPrice ?? downside?.entryPrice);
    const upsideAnchor = Number(upside?.dynamicAnchorPrice ?? upside?.entryPrice);
    if (!Number.isFinite(downsideAnchor) || !Number.isFinite(upsideAnchor)) return null;

    const baseLower = this._baseAnchor(protection, 'downside');
    const baseUpper = this._baseAnchor(protection, 'upside');
    const migratedLower = this._migratedAnchor(protection, 'upside');
    const migratedUpper = this._migratedAnchor(protection, 'downside');

    if (nearlyEqual(downsideAnchor, baseLower) && nearlyEqual(upsideAnchor, baseUpper)) {
      return 'neutral';
    }
    if (nearlyEqual(downsideAnchor, baseLower) && nearlyEqual(upsideAnchor, migratedLower)) {
      return 'lower_regime_confirmed';
    }
    if (nearlyEqual(downsideAnchor, migratedUpper) && nearlyEqual(upsideAnchor, baseUpper)) {
      return 'upper_regime_confirmed';
    }
    return null;
  }

  _buildState(protection, price, overrides = {}) {
    const current = protection.dynamicState || {};
    const normalizedPhase = this._normalizePhase(current.phase || current.regime || 'neutral');
    const breakoutConfirmDistancePct = normalizeDistancePct(
      protection.breakoutConfirmDistancePct ?? current.breakoutConfirmDistancePct
    );
    const breakoutConfirmDurationSec = normalizeDurationSec(
      protection.breakoutConfirmDurationSec ?? current.breakoutConfirmDurationSec
    );
    return {
      phase: normalizedPhase,
      regime: normalizedPhase === 'paused' ? (current.regime || 'neutral') : normalizedPhase,
      activeSide: current.activeSide || null,
      recoveryStatus: current.recoveryStatus || null,
      transition: current.transition || null,
      reentryBufferPct: protection.reentryBufferPct,
      breakoutConfirmDistancePct,
      breakoutConfirmDurationSec,
      upperReentryPrice: protection.rangeUpperPrice * (1 - protection.reentryBufferPct),
      lowerReentryPrice: protection.rangeLowerPrice * (1 + protection.reentryBufferPct),
      upperBreakoutConfirmPrice: protection.rangeUpperPrice * (1 + pctToRatio(breakoutConfirmDistancePct)),
      lowerBreakoutConfirmPrice: protection.rangeLowerPrice * (1 - pctToRatio(breakoutConfirmDistancePct)),
      lastBrokenEdge: current.lastBrokenEdge || null,
      currentReentryPrice: current.currentReentryPrice ?? null,
      pendingBreakoutEdge: current.pendingBreakoutEdge || null,
      pendingBreakoutSince: current.pendingBreakoutSince ?? null,
      pendingBreakoutPrice: current.pendingBreakoutPrice ?? null,
      lastEvaluatedPrice: price,
      lastTransitionAt: current.lastTransitionAt || protection.updatedAt || Date.now(),
      ...overrides,
    };
  }

  async _saveState(protection, dynamicState) {
    await this.repo.updateDynamicState(protection.userId, protection.id, {
      dynamicState,
      breakoutConfirmDistancePct: dynamicState?.breakoutConfirmDistancePct,
      breakoutConfirmDurationSec: dynamicState?.breakoutConfirmDurationSec,
      updatedAt: Date.now(),
    });
  }

  _dynamicSpacingIsSafe(protection) {
    const ratio = pctToRatio(protection.stopLossDifferencePct);
    const lowerCloseWire = toWireNumber(Number(protection.rangeLowerPrice) * (1 + ratio));
    const lowerOpenWire = toWireNumber(Number(protection.rangeLowerPrice) * (1 + Number(protection.reentryBufferPct)));
    const upperCloseWire = toWireNumber(Number(protection.rangeUpperPrice) * (1 - ratio));
    const upperOpenWire = toWireNumber(Number(protection.rangeUpperPrice) * (1 - Number(protection.reentryBufferPct)));

    return Number.isFinite(lowerCloseWire)
      && Number.isFinite(lowerOpenWire)
      && Number.isFinite(upperCloseWire)
      && Number.isFinite(upperOpenWire)
      && lowerCloseWire < lowerOpenWire
      && upperCloseWire > upperOpenWire;
  }

  async _loadLiveHedges(hedgeSvc, protection) {
    const downsideId = protection.hedges?.downside?.id;
    const upsideId = protection.hedges?.upside?.id;
    if (!downsideId || !upsideId) return null;

    try {
      return {
        downside: hedgeSvc.getById(downsideId),
        upside: hedgeSvc.getById(upsideId),
      };
    } catch {
      return null;
    }
  }

  async _ensureOpenHedgeProtected(hedgeSvc, hedge) {
    if (!hedge || !OPEN_HEDGE_STATUSES.has(hedge.status)) return false;
    if (hedge.status === 'open_protected' && hedge.slOid) return false;

    const anchor = Number(hedge.dynamicAnchorPrice ?? hedge.entryPrice);
    const exitPrice = Number(hedge.exitPrice);
    await hedgeSvc.updateOpenHedgeDynamicAnchor(hedge.id, {
      dynamicAnchorPrice: anchor,
      exitPrice,
      label: hedge.label,
    });
    return true;
  }

  async _pauseWithProtection(protection, price, recoveryStatus, hedgeSvc, liveHedges = null) {
    if (liveHedges) {
      for (const hedge of [liveHedges.downside, liveHedges.upside]) {
        try {
          await this._ensureOpenHedgeProtected(hedgeSvc, hedge);
        } catch (err) {
          this.logger.warn('protected_pool_dynamic_pause_restore_failed', {
            protectionId: protection.id,
            hedgeId: hedge?.id || null,
            error: err.message,
          });
        }
      }
    }

    const current = protection.dynamicState || {};
    await this._saveState(protection, this._buildState(protection, price, {
      phase: 'paused',
      regime: this._normalizePhase(current.regime || current.phase || 'neutral'),
      activeSide: this._deriveSideFromHedges(liveHedges || protection.hedges || {}),
      recoveryStatus,
      transition: 'recovery_pending',
      lastTransitionAt: Date.now(),
    }));
  }

  async _retargetPendingHedge(hedgeSvc, hedge, entryPrice, exitPrice, label) {
    if (!hedge || !PENDING_HEDGE_STATUSES.has(hedge.status)) return false;
    const currentAnchor = Number(hedge.dynamicAnchorPrice ?? hedge.entryPrice);
    if (
      nearlyEqual(hedge.entryPrice, entryPrice)
      && nearlyEqual(currentAnchor, entryPrice)
      && nearlyEqual(hedge.exitPrice, exitPrice)
    ) {
      return false;
    }
    await hedgeSvc.retargetPendingHedge(hedge.id, { entryPrice, exitPrice, label });
    return true;
  }

  async _reanchorOpenHedge(hedgeSvc, hedge, anchorPrice, exitPrice, label) {
    if (!hedge || !OPEN_HEDGE_STATUSES.has(hedge.status)) return false;
    const currentAnchor = Number(hedge.dynamicAnchorPrice ?? hedge.entryPrice);
    const hasProtection = hedge.status === 'open_protected' && hedge.slOid;
    if (nearlyEqual(currentAnchor, anchorPrice) && nearlyEqual(hedge.exitPrice, exitPrice) && hasProtection) {
      return false;
    }
    await hedgeSvc.updateOpenHedgeDynamicAnchor(hedge.id, {
      dynamicAnchorPrice: anchorPrice,
      exitPrice,
      label,
    });
    return true;
  }

  async _applyRegime(protection, hedgeSvc, liveHedges, regime) {
    const downsideAnchor = this._expectedAnchor(protection, 'downside', regime);
    const upsideAnchor = this._expectedAnchor(protection, 'upside', regime);
    const downsideExit = this._expectedExit(downsideAnchor, 'short', protection.stopLossDifferencePct);
    const upsideExit = this._expectedExit(upsideAnchor, 'long', protection.stopLossDifferencePct);

    const downside = liveHedges.downside;
    const upside = liveHedges.upside;

    const supportedStatuses = new Set([
      ...OPEN_HEDGE_STATUSES,
      ...PENDING_HEDGE_STATUSES,
    ]);
    if (!supportedStatuses.has(downside.status) || !supportedStatuses.has(upside.status)) {
      throw new Error('unsupported_hedge_status');
    }

    await this._retargetPendingHedge(
      hedgeSvc,
      downside,
      downsideAnchor,
      downsideExit,
      `${protection.token0Symbol}/${protection.token1Symbol} · Proteccion baja`
    );
    await this._retargetPendingHedge(
      hedgeSvc,
      upside,
      upsideAnchor,
      upsideExit,
      `${protection.token0Symbol}/${protection.token1Symbol} · Proteccion alza`
    );
    await this._reanchorOpenHedge(
      hedgeSvc,
      downside,
      downsideAnchor,
      downsideExit,
      `${protection.token0Symbol}/${protection.token1Symbol} · Proteccion baja`
    );
    await this._reanchorOpenHedge(
      hedgeSvc,
      upside,
      upsideAnchor,
      upsideExit,
      `${protection.token0Symbol}/${protection.token1Symbol} · Proteccion alza`
    );

    return {
      downsideAnchor,
      upsideAnchor,
    };
  }

  _resolveRuntimeState(protection, liveHedges) {
    const current = protection.dynamicState || {};
    const normalizedPhase = this._normalizePhase(current.phase || current.regime || 'neutral');
    const inferredRegime = this._inferRegimeFromAnchors(protection, liveHedges.downside, liveHedges.upside);

    if (normalizedPhase === 'paused') {
      return {
        phase: 'paused',
        regime: this._normalizePhase(current.regime || 'neutral'),
        inferredRegime,
      };
    }

    if (normalizedPhase === 'confirming_lower_breakout' || normalizedPhase === 'confirming_upper_breakout') {
      const targetRegime = normalizedPhase === 'confirming_lower_breakout'
        ? 'lower_regime_confirmed'
        : 'upper_regime_confirmed';
      const currentRegime = this._normalizePhase(current.regime || 'neutral');
      const allowedInferredRegimes = new Set([
        'neutral',
        currentRegime,
        targetRegime,
      ]);

      if (inferredRegime && !allowedInferredRegimes.has(inferredRegime)) {
        return null;
      }
      return {
        phase: normalizedPhase,
        regime: inferredRegime === targetRegime ? inferredRegime : currentRegime,
        inferredRegime,
      };
    }

    if (normalizedPhase === 'neutral') {
      if (!inferredRegime) return null;
      return {
        phase: inferredRegime,
        regime: inferredRegime,
        inferredRegime,
      };
    }

    if (inferredRegime && inferredRegime !== normalizedPhase) {
      return null;
    }

    return {
      phase: normalizedPhase,
      regime: normalizedPhase,
      inferredRegime: inferredRegime || normalizedPhase,
    };
  }

  async evaluateProtection(protection, mids = null) {
    const allMids = mids || await this.marketService.getAllPrices();
    const price = asFiniteNumber(allMids?.[protection.inferredAsset]);
    if (!price) {
      await this._saveState(protection, this._buildState(protection, null, {
        phase: 'paused',
        recoveryStatus: 'price_unavailable',
        transition: 'recovery_pending',
      }));
      return;
    }

    if (!this._dynamicSpacingIsSafe(protection)) {
      const hedgeSvcUnsafe = await this.hedgeRegistry.getOrCreate(protection.userId, protection.accountId);
      const liveUnsafe = await this._loadLiveHedges(hedgeSvcUnsafe, protection);
      await this._pauseWithProtection(protection, price, 'unsafe_dynamic_spacing', hedgeSvcUnsafe, liveUnsafe);
      return;
    }

    const hedgeSvc = await this.hedgeRegistry.getOrCreate(protection.userId, protection.accountId);
    const liveHedges = await this._loadLiveHedges(hedgeSvc, protection);
    if (!liveHedges?.downside || !liveHedges?.upside) {
      await this._pauseWithProtection(protection, price, 'missing_hedges', hedgeSvc, liveHedges);
      return;
    }

    const activeSide = this._deriveSideFromHedges(liveHedges);
    if (activeSide === 'conflict') {
      await this._pauseWithProtection(protection, price, 'both_hedges_open', hedgeSvc, liveHedges);
      return;
    }

    const resolvedState = this._resolveRuntimeState(protection, liveHedges);
    if (!resolvedState) {
      await this._pauseWithProtection(protection, price, 'regime_inference_failed', hedgeSvc, liveHedges);
      return;
    }

    if (resolvedState.phase === 'paused') {
      await this._pauseWithProtection(protection, price, protection.dynamicState?.recoveryStatus || 'paused', hedgeSvc, liveHedges);
      return;
    }

    try {
      await this._applyRegime(protection, hedgeSvc, liveHedges, resolvedState.regime);
    } catch (err) {
      await this._pauseWithProtection(protection, price, err.message === 'unsupported_hedge_status'
        ? 'unsupported_hedge_status'
        : 'reconciliation_failed', hedgeSvc, liveHedges);
      return;
    }

    const breakoutConfirmDistancePct = normalizeDistancePct(
      protection.breakoutConfirmDistancePct ?? protection.dynamicState?.breakoutConfirmDistancePct
    );
    const breakoutConfirmDurationSec = normalizeDurationSec(
      protection.breakoutConfirmDurationSec ?? protection.dynamicState?.breakoutConfirmDurationSec
    );
    const upperBreakoutConfirmPrice = protection.rangeUpperPrice * (1 + pctToRatio(breakoutConfirmDistancePct));
    const lowerBreakoutConfirmPrice = protection.rangeLowerPrice * (1 - pctToRatio(breakoutConfirmDistancePct));
    const pendingBreakoutEdge = protection.dynamicState?.pendingBreakoutEdge || null;
    const pendingBreakoutSince = protection.dynamicState?.pendingBreakoutSince != null
      ? Number(protection.dynamicState.pendingBreakoutSince)
      : null;
    const now = Date.now();

    const confirmRegime = async (targetRegime) => {
      try {
        await this._applyRegime(protection, hedgeSvc, liveHedges, targetRegime);
      } catch (err) {
        await this._pauseWithProtection(protection, price, 'reconciliation_failed', hedgeSvc, liveHedges);
        return;
      }

      const isLower = targetRegime === 'lower_regime_confirmed';
      await this._saveState(protection, this._buildState(protection, price, {
        phase: targetRegime,
        regime: targetRegime,
        activeSide,
        lastBrokenEdge: isLower ? 'lower' : 'upper',
        currentReentryPrice: isLower
          ? this._migratedAnchor(protection, 'upside')
          : this._migratedAnchor(protection, 'downside'),
        pendingBreakoutEdge: null,
        pendingBreakoutSince: null,
        pendingBreakoutPrice: null,
        recoveryStatus: null,
        transition: null,
        lastTransitionAt: now,
      }));
    };

    if (price >= upperBreakoutConfirmPrice && resolvedState.regime !== 'upper_regime_confirmed') {
      if (breakoutConfirmDurationSec === 0) {
        await confirmRegime('upper_regime_confirmed');
        return;
      }
      if (pendingBreakoutEdge !== 'upper' || pendingBreakoutSince == null) {
        await this._saveState(protection, this._buildState(protection, price, {
          phase: 'confirming_upper_breakout',
          regime: resolvedState.regime,
          activeSide,
          pendingBreakoutEdge: 'upper',
          pendingBreakoutSince: now,
          pendingBreakoutPrice: price,
          transition: 'confirming_upper_breakout',
          recoveryStatus: null,
          lastTransitionAt: now,
        }));
        return;
      }
      if (now - pendingBreakoutSince < breakoutConfirmDurationSec * 1000) {
        await this._saveState(protection, this._buildState(protection, price, {
          phase: 'confirming_upper_breakout',
          regime: resolvedState.regime,
          activeSide,
          pendingBreakoutEdge: 'upper',
          pendingBreakoutSince,
          pendingBreakoutPrice: price,
          transition: 'confirming_upper_breakout',
          recoveryStatus: null,
        }));
        return;
      }
      await confirmRegime('upper_regime_confirmed');
      return;
    }

    if (price <= lowerBreakoutConfirmPrice && resolvedState.regime !== 'lower_regime_confirmed') {
      if (breakoutConfirmDurationSec === 0) {
        await confirmRegime('lower_regime_confirmed');
        return;
      }
      if (pendingBreakoutEdge !== 'lower' || pendingBreakoutSince == null) {
        await this._saveState(protection, this._buildState(protection, price, {
          phase: 'confirming_lower_breakout',
          regime: resolvedState.regime,
          activeSide,
          pendingBreakoutEdge: 'lower',
          pendingBreakoutSince: now,
          pendingBreakoutPrice: price,
          transition: 'confirming_lower_breakout',
          recoveryStatus: null,
          lastTransitionAt: now,
        }));
        return;
      }
      if (now - pendingBreakoutSince < breakoutConfirmDurationSec * 1000) {
        await this._saveState(protection, this._buildState(protection, price, {
          phase: 'confirming_lower_breakout',
          regime: resolvedState.regime,
          activeSide,
          pendingBreakoutEdge: 'lower',
          pendingBreakoutSince,
          pendingBreakoutPrice: price,
          transition: 'confirming_lower_breakout',
          recoveryStatus: null,
        }));
        return;
      }
      await confirmRegime('lower_regime_confirmed');
      return;
    }

    const keepPendingUpper = pendingBreakoutEdge === 'upper' && price >= upperBreakoutConfirmPrice;
    const keepPendingLower = pendingBreakoutEdge === 'lower' && price <= lowerBreakoutConfirmPrice;
    const nextPendingEdge = keepPendingUpper ? 'upper' : (keepPendingLower ? 'lower' : null);
    const nextPendingSince = nextPendingEdge ? pendingBreakoutSince : null;
    const nextPendingPrice = nextPendingEdge ? price : null;

    await this._saveState(protection, this._buildState(protection, price, {
      phase: resolvedState.regime,
      regime: resolvedState.regime,
      activeSide,
      lastBrokenEdge: resolvedState.regime === 'lower_regime_confirmed'
        ? 'lower'
        : resolvedState.regime === 'upper_regime_confirmed'
          ? 'upper'
          : null,
      currentReentryPrice: resolvedState.regime === 'lower_regime_confirmed'
        ? this._migratedAnchor(protection, 'upside')
        : resolvedState.regime === 'upper_regime_confirmed'
          ? this._migratedAnchor(protection, 'downside')
          : null,
      pendingBreakoutEdge: nextPendingEdge,
      pendingBreakoutSince: nextPendingSince,
      pendingBreakoutPrice: nextPendingPrice,
      recoveryStatus: null,
      transition: nextPendingEdge ? `confirming_${nextPendingEdge}_breakout` : null,
    }));
  }
}

module.exports = new ProtectedPoolDynamicService();
module.exports.ProtectedPoolDynamicService = ProtectedPoolDynamicService;
