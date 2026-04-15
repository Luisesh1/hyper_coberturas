const hlRegistry = require('./hyperliquid.registry');
const config = require('../config');
const logger = require('./logger.service');

const CACHE_TTL_MS = config.intervals.balanceCacheTtlMs;
const REFRESH_INTERVAL_MS = config.intervals.balanceRefreshMs;
// Tick corto para escanear candidatos; el refresh real se hace por entrada
// cuando toca su turno (staggered). Esto evita el spike de N requests
// simultaneos contra Hyperliquid cada 30-60s.
const TICK_MS = Math.max(2_000, Math.min(10_000, Math.floor(REFRESH_INTERVAL_MS / 6)));

const cache = new Map();
let refreshTimer = null;

function key(userId, accountId) {
  return `${userId}:${accountId}`;
}

/**
 * Devuelve un offset determinista (0..REFRESH_INTERVAL_MS) por cuenta para
 * distribuir los refreshes en la ventana. Asi, 4 cuentas se refrescan en
 * 4 instantes distintos del ciclo, no simultaneamente.
 */
function staggerOffset(userId, accountId) {
  const hash = (Number(userId) * 2654435761 + Number(accountId) * 1597334677) >>> 0;
  return hash % REFRESH_INTERVAL_MS;
}

function shouldRefresh(entry, now) {
  if (entry.isRefreshing) return false;
  if (!entry.lastUpdatedAt) return true;
  const age = now - entry.lastUpdatedAt;
  if (age < REFRESH_INTERVAL_MS) return false;

  // Alinea al offset: solo refresca si pasamos su "slot" en el ciclo actual.
  const offset = staggerOffset(entry.userId, entry.accountId);
  const posInCycle = now % REFRESH_INTERVAL_MS;
  const slotWindow = TICK_MS + 500; // tolerancia
  const relative = (posInCycle - offset + REFRESH_INTERVAL_MS) % REFRESH_INTERVAL_MS;
  return relative <= slotWindow;
}

function startRefreshLoop() {
  if (refreshTimer) return;

  refreshTimer = setInterval(() => {
    const now = Date.now();
    for (const entry of cache.values()) {
      if (!entry.userId || !entry.accountId) continue;
      if (!shouldRefresh(entry, now)) continue;
      refreshSnapshot(entry.userId, entry.accountId).catch((err) => logger.warn('background balance refresh failed', { userId: entry.userId, accountId: entry.accountId, error: err.message }));
    }
  }, TICK_MS);
  refreshTimer.unref?.();
}

/**
 * Convierte un campo crudo (string o number) a Number, distinguiendo
 * "falta el campo" (undefined/null) de "valor invalido" (NaN) de "cero real".
 * Lanza en casos de payload corrupto para que el cache NO almacene datos basura
 * y los consumidores puedan distinguir error de balance cero.
 */
function strictNumber(raw, path) {
  if (raw == null) {
    throw new Error(`hl_balance_field_missing:${path}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`hl_balance_field_not_finite:${path}:${raw}`);
  }
  return n;
}

function normalizeSnapshot(accountState, openOrders = []) {
  if (!accountState || typeof accountState !== 'object') {
    throw new Error('hl_clearinghouse_state_missing');
  }
  if (!accountState.marginSummary || typeof accountState.marginSummary !== 'object') {
    throw new Error('hl_margin_summary_missing');
  }

  const marginSummary = accountState.marginSummary;
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
    accountValue: strictNumber(marginSummary.accountValue, 'marginSummary.accountValue'),
    totalMarginUsed: strictNumber(marginSummary.totalMarginUsed, 'marginSummary.totalMarginUsed'),
    totalNtlPos: strictNumber(marginSummary.totalNtlPos, 'marginSummary.totalNtlPos'),
    withdrawable: strictNumber(accountState.withdrawable, 'withdrawable'),
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
        balanceStatus: 'ok',
        balanceError: null,
        lastBalanceUpdatedAt: balance.lastUpdatedAt,
      };
    } catch (err) {
      logger.warn('enrich_account_balance_failed', {
        userId,
        accountId: account.id,
        error: err.message,
      });
      return {
        ...account,
        balanceUsd: null,
        balanceStatus: 'unavailable',
        balanceError: err.message,
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
