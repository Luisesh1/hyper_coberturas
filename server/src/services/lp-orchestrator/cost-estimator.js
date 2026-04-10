/**
 * cost-estimator.js
 *
 * Wrapper sobre `preparePositionAction` para estimar el costo de un
 * eventual rebalanceo o re-range del LP en USD, sin firmar nada.
 *
 * Devuelve `{ totalCostUsd, gasCostUsd, slippageCostUsd, txCount }` y
 * cachea por `snapshotHash` durante ~60 s para evitar pegarle al RPC en
 * cada tick del loop cuando nada cambió.
 */

const positionActionsService = require('../uniswap-position-actions.service');
const logger = require('../logger.service');

const CACHE_TTL_MS = 60_000;

class LpOrchestratorCostEstimator {
  constructor(deps = {}) {
    this.positionActionsService = deps.positionActionsService || positionActionsService;
    this.logger = deps.logger || logger;
    this.cacheTtlMs = deps.cacheTtlMs || CACHE_TTL_MS;
    this._cache = new Map();
  }

  _cacheKey(orchestratorId, snapshotHash, action) {
    return `${orchestratorId}:${action}:${snapshotHash || 'no-hash'}`;
  }

  _readCache(key) {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.cacheTtlMs) {
      this._cache.delete(key);
      return null;
    }
    return entry.value;
  }

  _writeCache(key, value) {
    this._cache.set(key, { ts: Date.now(), value });
  }

  /**
   * Estima el costo de re-rangear el LP a un nuevo rango centrado en el
   * precio actual ± rangeWidthPct.
   */
  async estimateModifyRangeCost({
    orchestrator,
    pool,
    snapshotHash,
    rangeWidthPct,
    slippageBps = 100,
  }) {
    const key = this._cacheKey(orchestrator.id, snapshotHash, 'modify-range');
    const cached = this._readCache(key);
    if (cached) return cached;

    const priceCurrent = Number(pool?.priceCurrent);
    if (!Number.isFinite(priceCurrent) || priceCurrent <= 0) {
      return this._zeroCost('invalid_price');
    }

    const widthFactor = rangeWidthPct / 100;
    const newLower = priceCurrent * (1 - widthFactor);
    const newUpper = priceCurrent * (1 + widthFactor);

    let prepared;
    try {
      prepared = await this.positionActionsService.preparePositionAction({
        action: 'modify-range',
        payload: {
          network: orchestrator.network,
          version: orchestrator.version,
          walletAddress: orchestrator.walletAddress,
          positionIdentifier: orchestrator.activePositionIdentifier,
          rangeLowerPrice: newLower,
          rangeUpperPrice: newUpper,
          slippageBps,
          poolId: pool?.poolId || undefined,
          tickSpacing: pool?.tickSpacing != null ? Number(pool.tickSpacing) : undefined,
          hooks: pool?.hooks || undefined,
        },
      });
    } catch (err) {
      this.logger.warn('lp_orchestrator_cost_estimate_failed', {
        orchestratorId: orchestrator.id,
        action: 'modify-range',
        error: err.message,
      });
      return this._zeroCost('prepare_failed');
    }

    const summary = this._summarize(prepared);
    this._writeCache(key, summary);
    return summary;
  }

  /**
   * Estima el costo de un rebalance manteniendo el rango actual pero
   * llevando los pesos al óptimo (50/50 sobre el precio actual).
   */
  async estimateRebalanceCost({
    orchestrator,
    pool,
    snapshotHash,
    targetWeightToken0Pct = 50,
    slippageBps = 100,
  }) {
    const key = this._cacheKey(orchestrator.id, snapshotHash, 'rebalance');
    const cached = this._readCache(key);
    if (cached) return cached;

    let prepared;
    try {
      prepared = await this.positionActionsService.preparePositionAction({
        action: 'rebalance',
        payload: {
          network: orchestrator.network,
          version: orchestrator.version,
          walletAddress: orchestrator.walletAddress,
          positionIdentifier: orchestrator.activePositionIdentifier,
          targetWeightToken0Pct,
          slippageBps,
          poolId: pool?.poolId || undefined,
          tickSpacing: pool?.tickSpacing != null ? Number(pool.tickSpacing) : undefined,
          hooks: pool?.hooks || undefined,
        },
      });
    } catch (err) {
      this.logger.warn('lp_orchestrator_cost_estimate_failed', {
        orchestratorId: orchestrator.id,
        action: 'rebalance',
        error: err.message,
      });
      return this._zeroCost('prepare_failed');
    }

    const summary = this._summarize(prepared);
    this._writeCache(key, summary);
    return summary;
  }

  _summarize(prepared) {
    const costs = prepared?.estimatedCosts || {};
    const gasCostUsd = Number(costs.gasCostUsd) || 0;
    const slippageCostUsd = Number(costs.slippageCostUsd) || 0;
    const totalCostUsd = Number(costs.totalEstimatedCostUsd) || (gasCostUsd + slippageCostUsd);
    return {
      gasCostUsd,
      slippageCostUsd,
      totalCostUsd,
      txCount: Number(costs.txCount) || (Array.isArray(prepared?.txPlan) ? prepared.txPlan.length : 0),
      reason: 'ok',
    };
  }

  _zeroCost(reason) {
    return {
      gasCostUsd: 0,
      slippageCostUsd: 0,
      totalCostUsd: 0,
      txCount: 0,
      reason,
    };
  }

  invalidate(orchestratorId) {
    for (const key of this._cache.keys()) {
      if (key.startsWith(`${orchestratorId}:`)) {
        this._cache.delete(key);
      }
    }
  }
}

module.exports = LpOrchestratorCostEstimator;
module.exports.default = LpOrchestratorCostEstimator;
