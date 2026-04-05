const hlRegistry = require('./hyperliquid.registry');
const config = require('../config');
const logger = require('./logger.service');

const CACHE_TTL_MS = config.intervals.balanceCacheTtlMs;
const REFRESH_INTERVAL_MS = config.intervals.balanceRefreshMs;

const cache = new Map();
let refreshTimer = null;

function key(userId, accountId) {
  return `${userId}:${accountId}`;
}

function startRefreshLoop() {
  if (refreshTimer) return;

  refreshTimer = setInterval(() => {
    for (const entry of cache.values()) {
      if (!entry.userId || !entry.accountId) continue;
      if (entry.isRefreshing) continue;
      if ((Date.now() - (entry.lastUpdatedAt || 0)) < REFRESH_INTERVAL_MS) continue;
      refreshSnapshot(entry.userId, entry.accountId).catch((err) => logger.warn('background balance refresh failed', { userId: entry.userId, accountId: entry.accountId, error: err.message }));
    }
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
}

function normalizeSnapshot(accountState = {}, openOrders = []) {
  const marginSummary = accountState.marginSummary || {};
  const positions = (accountState.assetPositions || [])
    .filter((item) => parseFloat(item.position?.szi || 0) !== 0)
    .map((item) => ({
      asset: item.position.coin,
      size: item.position.szi,
      entryPrice: item.position.entryPx,
      leverage: item.position.leverage,
      unrealizedPnl: item.position.unrealizedPnl,
      returnOnEquity: item.position.returnOnEquity,
      liquidationPrice: item.position.liquidationPx,
      marginUsed: item.position.marginUsed,
      side: parseFloat(item.position.szi) > 0 ? 'long' : 'short',
    }));

  return {
    accountValue: Number(marginSummary.accountValue || 0),
    totalMarginUsed: Number(marginSummary.totalMarginUsed || 0),
    totalNtlPos: Number(marginSummary.totalNtlPos || 0),
    withdrawable: Number(accountState.withdrawable || 0),
    positions,
    openOrders: Array.isArray(openOrders) ? openOrders : [],
    lastUpdatedAt: Date.now(),
  };
}

async function fetchSnapshot(userId, accountId) {
  const hl = await hlRegistry.getOrCreate(userId, accountId);
  const [accountState, openOrders] = await Promise.all([
    hl.getClearinghouseState(),
    hl.getOpenOrders().catch(() => []),
  ]);
  return normalizeSnapshot(accountState, openOrders);
}

async function refreshSnapshot(userId, accountId) {
  startRefreshLoop();

  const entryKey = key(userId, accountId);
  const current = cache.get(entryKey) || {
    userId,
    accountId,
    value: null,
    lastUpdatedAt: 0,
    promise: null,
    isRefreshing: false,
  };

  if (current.promise) {
    return current.promise;
  }

  current.isRefreshing = true;
  current.promise = fetchSnapshot(userId, accountId)
    .then((snapshot) => {
      current.value = snapshot;
      current.lastUpdatedAt = snapshot.lastUpdatedAt;
      current.isRefreshing = false;
      current.promise = null;
      cache.set(entryKey, current);
      return snapshot;
    })
    .catch((err) => {
      current.isRefreshing = false;
      current.promise = null;
      cache.set(entryKey, current);
      throw err;
    });

  cache.set(entryKey, current);
  return current.promise;
}

async function getSnapshot(userId, accountId, { force = false } = {}) {
  startRefreshLoop();

  const entryKey = key(userId, accountId);
  const entry = cache.get(entryKey);
  const isFresh = entry?.value && (Date.now() - entry.lastUpdatedAt) < CACHE_TTL_MS;

  if (!force && isFresh) {
    return entry.value;
  }

  return refreshSnapshot(userId, accountId);
}

function getCachedSnapshot(userId, accountId, { maxAgeMs = Infinity } = {}) {
  const entry = cache.get(key(userId, accountId));
  if (!entry?.value) return null;
  if ((Date.now() - entry.lastUpdatedAt) > maxAgeMs) return null;
  return entry.value;
}

async function getBalance(userId, accountId, { force = false } = {}) {
  const snapshot = await getSnapshot(userId, accountId, { force });
  return {
    balanceUsd: snapshot.accountValue,
    lastUpdatedAt: snapshot.lastUpdatedAt,
  };
}

async function enrichAccounts(userId, accounts, { forceAccountId = null } = {}) {
  return Promise.all(accounts.map(async (account) => {
    try {
      const balance = await getBalance(userId, account.id, {
        force: forceAccountId != null && Number(forceAccountId) === Number(account.id),
      });
      return {
        ...account,
        balanceUsd: balance.balanceUsd,
        lastBalanceUpdatedAt: balance.lastUpdatedAt,
      };
    } catch {
      return {
        ...account,
        balanceUsd: null,
        lastBalanceUpdatedAt: null,
      };
    }
  }));
}

function invalidateAccount(userId, accountId) {
  cache.delete(key(userId, accountId));
}

function invalidateUser(userId) {
  for (const entryKey of cache.keys()) {
    if (entryKey.startsWith(`${userId}:`)) {
      cache.delete(entryKey);
    }
  }
}

module.exports = {
  enrichAccounts,
  getBalance,
  getCachedSnapshot,
  getSnapshot,
  invalidateAccount,
  invalidateUser,
  refreshSnapshot,
};
