import { getPoolValue, getPoolTimestamp } from './pool-helpers';

export function getPoolSortScore(pool, sortBy) {
  if (sortBy === 'recent') return getPoolTimestamp(pool);
  if (sortBy === 'yield') return Number(pool.yieldPct) || Number.NEGATIVE_INFINITY;
  if (sortBy === 'out_of_range') {
    const outside = pool.currentOutOfRangeSide ? 1 : 0;
    const distance = Number(pool.distanceToRangePct) || 0;
    return outside * 10_000 + distance;
  }
  return getPoolValue(pool) || Number.NEGATIVE_INFINITY;
}

export function sortProtectedPools(pools) {
  return [...pools].sort((a, b) => {
    const aSnapshot = a.poolSnapshot || {};
    const bSnapshot = b.poolSnapshot || {};
    const getRank = (item, snapshot) => {
      if (item.status === 'active' && snapshot.currentOutOfRangeSide) return 0;
      if (item.status === 'active') return 1;
      return 2;
    };
    const rank = getRank(a, aSnapshot) - getRank(b, bSnapshot);
    if (rank !== 0) return rank;
    return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
  });
}

function buildProtectionKey({ walletAddress, network, version, positionIdentifier }) {
  return [
    String(walletAddress || '').trim().toLowerCase(),
    String(network || '').trim().toLowerCase(),
    String(version || '').trim().toLowerCase(),
    String(positionIdentifier || '').trim(),
  ].join('::');
}

export function mergeResultProtections(scanResult, protectedPools) {
  if (!scanResult) return scanResult;
  const protectionMap = new Map(
    protectedPools
      .filter((pool) => pool.status === 'active')
      .map((pool) => [
        buildProtectionKey({
          walletAddress: pool.walletAddress,
          network: pool.network,
          version: pool.version,
          positionIdentifier: pool.positionIdentifier,
        }),
        pool,
      ])
  );

  return {
    ...scanResult,
    pools: scanResult.pools.map((pool) => {
      const protection = protectionMap.get(buildProtectionKey({
        walletAddress: pool.owner || pool.creator,
        network: pool.network,
        version: pool.version,
        positionIdentifier: pool.identifier,
      }));

      return {
        ...pool,
        protection: protection
          ? {
              id: protection.id,
              status: protection.status,
              inferredAsset: protection.inferredAsset,
              hedgeSize: protection.hedgeSize,
              hedgeNotionalUsd: protection.hedgeNotionalUsd,
              configuredHedgeNotionalUsd: protection.configuredHedgeNotionalUsd,
              valueMultiplier: protection.valueMultiplier,
              stopLossDifferencePct: protection.stopLossDifferencePct,
              valueMode: protection.valueMode,
              leverage: protection.leverage,
              accountId: protection.accountId,
            }
          : null,
      };
    }),
  };
}
