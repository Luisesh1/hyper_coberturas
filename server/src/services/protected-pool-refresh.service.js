const config = require('../config');
const logger = require('./logger.service');
const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');
const timeInRangeService = require('./time-in-range.service');
const uniswapService = require('./uniswap.service');

function buildGroupKey(item) {
  return [
    item.userId,
    item.network,
    item.version,
    String(item.walletAddress || '').toLowerCase(),
  ].join('::');
}

class ProtectedPoolRefreshService {
  constructor(deps = {}) {
    this.repo = deps.protectedPoolRepository || protectedPoolRepository;
    this.uniswapService = deps.uniswapService || uniswapService;
    this.timeInRangeService = deps.timeInRangeService || timeInRangeService;
    this.refreshIntervalMs = deps.refreshIntervalMs || config.intervals.protectedPoolRefreshMs;
    this.logger = deps.logger || logger;
    this.interval = null;
    this.running = false;
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.refreshAll().catch((err) => {
        this.logger.error('protected_pool_refresh_unhandled_error', { error: err.message });
      });
    }, this.refreshIntervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async refreshAll() {
    if (this.running) {
      this.logger.warn('protected_pool_refresh_skipped', { reason: 'already_running' });
      return;
    }

    this.running = true;
    const startedAt = Date.now();

    try {
      const activePools = await this.repo.listActiveForRefresh();
      const groups = this._buildGroups(activePools);
      if (groups.size === 0) return;

      for (const group of groups.values()) {
        await this.refreshGroup(group);
      }

      this.logger.info('protected_pool_refresh_completed', {
        activePoolCount: activePools.length,
        groupCount: groups.size,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      this.running = false;
    }
  }

  async refreshUser(userId) {
    if (this.running) {
      this.logger.warn('protected_pool_refresh_skipped', { reason: 'already_running', userId });
      return;
    }

    this.running = true;
    const startedAt = Date.now();

    try {
      const activePools = await this.repo.listActiveForRefresh();
      const filteredPools = activePools.filter((item) => Number(item.userId) === Number(userId));
      const groups = this._buildGroups(filteredPools);
      if (groups.size === 0) return;

      for (const group of groups.values()) {
        await this.refreshGroup(group);
      }

      this.logger.info('protected_pool_refresh_completed', {
        activePoolCount: filteredPools.length,
        groupCount: groups.size,
        userId,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      this.running = false;
    }
  }

  _buildGroups(activePools) {
    const groups = new Map();
    for (const item of activePools) {
      const key = buildGroupKey(item);
      const current = groups.get(key) || {
        userId: item.userId,
        walletAddress: item.walletAddress,
        network: item.network,
        version: item.version,
        items: [],
      };
      current.items.push(item);
      groups.set(key, current);
    }
    return groups;
  }

  async refreshGroup(group) {
    let scanResult;
    try {
      scanResult = await this.uniswapService.scanPoolsCreatedByWallet({
        userId: group.userId,
        wallet: group.walletAddress,
        network: group.network,
        version: group.version,
      });
    } catch (err) {
      this.logger.warn('protected_pool_refresh_group_failed', {
        userId: group.userId,
        walletAddress: group.walletAddress,
        network: group.network,
        version: group.version,
        error: err.message,
      });
      return;
    }

    const poolsByIdentifier = new Map(
      (scanResult?.pools || []).map((pool) => [String(pool.identifier || '').trim(), pool])
    );

    for (const protection of group.items) {
      const freshPool = poolsByIdentifier.get(String(protection.positionIdentifier || '').trim());
      if (!freshPool) {
        this.logger.warn('protected_pool_refresh_missing_snapshot', {
          protectionId: protection.id,
          userId: protection.userId,
          walletAddress: protection.walletAddress,
          network: protection.network,
          version: protection.version,
          positionIdentifier: protection.positionIdentifier,
        });
        continue;
      }

      try {
        const rangeMetrics = await this.timeInRangeService.computeIncrementalRangeMetrics(protection, {
          endAt: Date.now(),
          poolSnapshot: freshPool,
          asset: protection.inferredAsset,
        });
        const poolSnapshot = rangeMetrics
          ? this.timeInRangeService.applyRangeMetricsToSnapshot(freshPool, rangeMetrics)
          : freshPool;

        await this.repo.updateSnapshot(protection.userId, protection.id, {
          poolAddress: freshPool.poolAddress || null,
          token0Symbol: freshPool.token0?.symbol || protection.token0Symbol,
          token1Symbol: freshPool.token1?.symbol || protection.token1Symbol,
          token0Address: freshPool.token0Address || protection.token0Address,
          token1Address: freshPool.token1Address || protection.token1Address,
          rangeLowerPrice: freshPool.rangeLowerPrice,
          rangeUpperPrice: freshPool.rangeUpperPrice,
          priceCurrent: freshPool.priceCurrent,
          poolSnapshot,
          updatedAt: Date.now(),
          isCurrentlyInRange: freshPool.inRange === true,
          ...(rangeMetrics || {}),
        });
      } catch (err) {
        this.logger.warn('protected_pool_snapshot_update_failed', {
          protectionId: protection.id,
          userId: protection.userId,
          error: err.message,
        });
      }
    }
  }
}

module.exports = new ProtectedPoolRefreshService();
module.exports.ProtectedPoolRefreshService = ProtectedPoolRefreshService;
