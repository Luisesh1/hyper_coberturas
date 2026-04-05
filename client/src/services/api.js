/**
 * api.js
 *
 * Cliente HTTP para comunicarse con el backend del bot.
 * Incluye Authorization header con el JWT del usuario autenticado.
 * Si el servidor responde 401, limpia el storage y recarga la página (→ login).
 */

import { clearSession, getToken } from './sessionStore';

const BASE_URL = import.meta.env.VITE_API_URL || '/api';

async function request(method, path, body) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
    },
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const res  = await fetch(`${BASE_URL}${path}`, options);
  const text = await res.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    throw new Error('Respuesta invalida del servidor');
  }

  if (res.status === 401) {
    clearSession();
    throw new Error('Sesión expirada');
  }

  if (!res.ok || !data.success) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  return data.data;
}

// ------------------------------------------------------------------
// Auth
// ------------------------------------------------------------------
export const authApi = {
  login: ({ username, password }) => request('POST', '/auth/login', { username, password }),
  me:    ()                       => request('GET',  '/auth/me'),
};

// ------------------------------------------------------------------
// Usuarios (gestión por superuser)
// ------------------------------------------------------------------
export const usersApi = {
  getAll:    ()               => request('GET',  '/users'),
  create:    (data)           => request('POST', '/users', data),
  getById:   (id)             => request('GET',  `/users/${id}`),
  update:    (id, data)       => request('PUT',  `/users/${id}`, data),
  setActive: (id, active)     => request('PUT',  `/users/${id}/active`, { active }),
  setRole:   (id, role)       => request('PUT',  `/users/${id}/role`, { role }),
};

// ------------------------------------------------------------------
// Market
// ------------------------------------------------------------------
export const marketApi = {
  getContexts: () => request('GET', '/market/contexts'),
};

// ------------------------------------------------------------------
// Trading
// ------------------------------------------------------------------
export const tradingApi = {
  getAccount:    ({ accountId, refresh } = {}) => {
    const params = new URLSearchParams();
    if (accountId != null) params.set('accountId', String(accountId));
    if (refresh) params.set('refresh', '1');
    return request('GET', `/trading/account${params.size ? `?${params.toString()}` : ''}`);
  },
  getOpenOrders: ({ accountId, refresh } = {}) => {
    const params = new URLSearchParams();
    if (accountId != null) params.set('accountId', String(accountId));
    if (refresh) params.set('refresh', '1');
    return request('GET', `/trading/orders${params.size ? `?${params.toString()}` : ''}`);
  },

  openPosition: ({ accountId, asset, side, size, leverage, marginMode, limitPrice }) =>
    request('POST', '/trading/open', { accountId, asset, side, size, leverage, marginMode, limitPrice }),

  closePosition: ({ accountId, asset, size }) =>
    request('POST', '/trading/close', { accountId, asset, size }),

  cancelOrder: (asset, oid, { accountId } = {}) => {
    const params = new URLSearchParams();
    if (accountId != null) params.set('accountId', String(accountId));
    return request('DELETE', `/trading/orders/${asset}/${oid}${params.size ? `?${params.toString()}` : ''}`);
  },

  setSLTP: ({ accountId, asset, side, size, slPrice, tpPrice }) =>
    request('POST', '/trading/sltp', { accountId, asset, side, size, slPrice, tpPrice }),
};

// ------------------------------------------------------------------
// Hedge
// ------------------------------------------------------------------
export const hedgeApi = {
  getAll:  ({ accountId } = {}) => {
    const params = new URLSearchParams();
    if (accountId != null) params.set('accountId', String(accountId));
    return request('GET', `/hedge${params.size ? `?${params.toString()}` : ''}`);
  },
  getById: (id) => request('GET', `/hedge/${id}`),

  create: ({ accountId, asset, entryPrice, exitPrice, size, leverage, label, direction }) =>
    request('POST', '/hedge', { accountId, asset, entryPrice, exitPrice, size, leverage, label, direction }),

  cancel: (id) => request('DELETE', `/hedge/${id}`),
};

// ------------------------------------------------------------------
// Settings
// ------------------------------------------------------------------
export const settingsApi = {
  get:          ()                  => request('GET',  '/settings'),
  saveTelegram: ({ token, chatId }) => request('PUT',  '/settings/telegram', { token, chatId }),
  testTelegram: ()                  => request('POST', '/settings/telegram/test'),
  getWallet:    ()                  => request('GET',  '/settings/wallet'),
  getEtherscan: ()                  => request('GET',  '/settings/etherscan'),
  saveWallet:   ({ privateKey, address }) =>
    request('PUT', '/settings/wallet', { privateKey, address }),
  getHyperliquidAccounts: (refreshAccountId) => {
    const params = new URLSearchParams();
    if (refreshAccountId != null) params.set('refreshAccountId', String(refreshAccountId));
    return request('GET', `/settings/hyperliquid-accounts${params.size ? `?${params.toString()}` : ''}`);
  },
  getHyperliquidAccountSummary: (accountId, { refresh = false } = {}) => {
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', '1');
    return request('GET', `/settings/hyperliquid-accounts/${accountId}/summary${params.size ? `?${params.toString()}` : ''}`);
  },
  createHyperliquidAccount: ({ alias, address, privateKey, isDefault }) =>
    request('POST', '/settings/hyperliquid-accounts', { alias, address, privateKey, isDefault }),
  updateHyperliquidAccount: (id, { alias, address, privateKey, isDefault }) =>
    request('PUT', `/settings/hyperliquid-accounts/${id}`, { alias, address, privateKey, isDefault }),
  setDefaultHyperliquidAccount: (id) =>
    request('PUT', `/settings/hyperliquid-accounts/${id}/default`, {}),
  deleteHyperliquidAccount: (id) =>
    request('DELETE', `/settings/hyperliquid-accounts/${id}`),
  saveEtherscan: ({ apiKey })       => request('PUT', '/settings/etherscan', { apiKey }),
  testEtherscan: ()                 => request('POST', '/settings/etherscan/test'),
};

// ------------------------------------------------------------------
// Uniswap
// ------------------------------------------------------------------
export const uniswapApi = {
  getMeta: () => request('GET', '/uniswap/meta'),
  scanPools: ({ wallet, network, version }) =>
    request('POST', '/uniswap/pools/scan', { wallet, network, version }),
  listProtectedPools: () => request('GET', '/uniswap/protected-pools'),
  refreshProtectedPools: () => request('POST', '/uniswap/protected-pools/refresh', {}),
  createProtectedPool: ({
    pool,
    accountId,
    leverage,
    configuredNotionalUsd,
    valueMultiplier,
    stopLossDifferencePct,
    protectionMode,
    reentryBufferPct,
    flipCooldownSec,
    maxSequentialFlips,
    breakoutConfirmDistancePct,
    breakoutConfirmDurationSec,
    bandMode,
    baseRebalancePriceMovePct,
    rebalanceIntervalSec,
    targetHedgeRatio,
    minRebalanceNotionalUsd,
    maxSlippageBps,
    twapMinNotionalUsd,
  }) =>
    request('POST', '/uniswap/protected-pools', {
      pool,
      accountId,
      leverage,
      configuredNotionalUsd,
      valueMultiplier,
      stopLossDifferencePct,
      protectionMode,
      reentryBufferPct,
      flipCooldownSec,
      maxSequentialFlips,
      breakoutConfirmDistancePct,
      breakoutConfirmDurationSec,
      bandMode,
      baseRebalancePriceMovePct,
      rebalanceIntervalSec,
      targetHedgeRatio,
      minRebalanceNotionalUsd,
      maxSlippageBps,
      twapMinNotionalUsd,
    }),
  deactivateProtectedPool: (id) =>
    request('POST', `/uniswap/protected-pools/${id}/deactivate`, {}),
  prepareClaimFees: ({ network, version, positionIdentifier, walletAddress }) =>
    request('POST', '/uniswap/claim-fees/prepare', { network, version, positionIdentifier, walletAddress }),
  finalizeClaimFees: ({ network, version, positionIdentifier, walletAddress, txHash }) =>
    request('POST', '/uniswap/claim-fees/finalize', { network, version, positionIdentifier, walletAddress, txHash }),
  preparePositionAction: (action, payload) =>
    request('POST', `/uniswap/${action}/prepare`, payload),
  finalizePositionAction: (action, payload) =>
    request('POST', `/uniswap/${action}/finalize`, payload),
  prepareIncreaseLiquidity: (payload) => request('POST', '/uniswap/increase-liquidity/prepare', payload),
  finalizeIncreaseLiquidity: (payload) => request('POST', '/uniswap/increase-liquidity/finalize', payload),
  prepareDecreaseLiquidity: (payload) => request('POST', '/uniswap/decrease-liquidity/prepare', payload),
  finalizeDecreaseLiquidity: (payload) => request('POST', '/uniswap/decrease-liquidity/finalize', payload),
  prepareCollectFees: (payload) => request('POST', '/uniswap/collect-fees/prepare', payload),
  finalizeCollectFees: (payload) => request('POST', '/uniswap/collect-fees/finalize', payload),
  prepareReinvestFees: (payload) => request('POST', '/uniswap/reinvest-fees/prepare', payload),
  finalizeReinvestFees: (payload) => request('POST', '/uniswap/reinvest-fees/finalize', payload),
  prepareModifyRange: (payload) => request('POST', '/uniswap/modify-range/prepare', payload),
  finalizeModifyRange: (payload) => request('POST', '/uniswap/modify-range/finalize', payload),
  prepareRebalance: (payload) => request('POST', '/uniswap/rebalance/prepare', payload),
  finalizeRebalance: (payload) => request('POST', '/uniswap/rebalance/finalize', payload),
  prepareCreatePosition: (payload) => request('POST', '/uniswap/create-position/prepare', payload),
  finalizeCreatePosition: (payload) => request('POST', '/uniswap/create-position/finalize', payload),
};

// ------------------------------------------------------------------
// Strategies / Indicators / Bots
// ------------------------------------------------------------------
export const strategiesApi = {
  list: () => request('GET', '/strategies'),
  getById: (id) => request('GET', `/strategies/${id}`),
  create: (payload) => request('POST', '/strategies', payload),
  update: (id, payload) => request('PUT', `/strategies/${id}`, payload),
  remove: (id) => request('DELETE', `/strategies/${id}`),
  validate: (id, payload = {}) => request('POST', `/strategies/${id}/validate`, payload),
  backtest: (id, payload = {}) => request('POST', `/strategies/${id}/backtest`, payload),
};

export const indicatorsApi = {
  list: () => request('GET', '/indicators'),
  create: (payload) => request('POST', '/indicators', payload),
  update: (id, payload) => request('PUT', `/indicators/${id}`, payload),
  remove: (id) => request('DELETE', `/indicators/${id}`),
};

export const botsApi = {
  list: () => request('GET', '/bots'),
  getById: (id) => request('GET', `/bots/${id}`),
  create: (payload) => request('POST', '/bots', payload),
  update: (id, payload) => request('PUT', `/bots/${id}`, payload),
  remove: (id) => request('DELETE', `/bots/${id}`),
  duplicate: (id) => request('POST', `/bots/${id}/duplicate`, {}),
  activate: (id) => request('POST', `/bots/${id}/activate`, {}),
  pause: (id) => request('POST', `/bots/${id}/pause`, {}),
  stop: (id) => request('POST', `/bots/${id}/stop`, {}),
  getRuns: (id) => request('GET', `/bots/${id}/runs`),
};

export const backtestingApi = {
  simulate: (payload) => request('POST', '/backtesting/simulate', payload),
  enqueue: (payload) => request('POST', '/backtesting/queue', payload),
  getJob: (jobId) => request('GET', `/backtesting/jobs/${jobId}`),
  getJobs: () => request('GET', '/backtesting/jobs'),
};
