import { clearSession, getToken } from './sessionStore';
import { createHttpClient } from '../shared/api/httpClient';

const BASE_URL = import.meta.env.VITE_API_URL || '/api';

function buildQueryString(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') qs.set(key, String(value));
  }
  return qs.size ? `?${qs.toString()}` : '';
}

// Sólo en dev: forwardea errores HTTP del cliente al buffer del DevLogPanel
// para que aparezcan correlacionados con los del server vía requestId.
// En build de producción este import lo elimina Vite por tree-shaking.
let _devOnHttpError = null;
if (import.meta.env.DEV) {
  // Carga dinámica para no bloquear el bundle si el módulo no existe.
  import('../dev/devLogBuffer').then(({ devLogBuffer }) => {
    _devOnHttpError = (err, ctx) => {
      const status = Number(err?.status ?? ctx?.status ?? 0);
      devLogBuffer.enqueue({
        level: status >= 500 ? 'error' : 'warn',
        source: 'client_http',
        message: `${ctx?.method || 'REQ'} ${ctx?.path || ''} → ${status || err?.code || 'ERR'}`,
        status,
        code: err?.code || null,
        requestId: err?.requestId || null,
        detailMessage: err?.message || null,
        details: err?.details || null,
      });
    };
  }).catch(() => { /* noop si el módulo no está disponible */ });
}

const request = createHttpClient({
  baseUrl: BASE_URL,
  getToken,
  onUnauthorized: clearSession,
  onHttpError: (err, ctx) => { if (_devOnHttpError) _devOnHttpError(err, ctx); },
});

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
  getAccount:    ({ accountId, refresh } = {}) =>
    request('GET', `/trading/account${buildQueryString({ accountId, refresh: refresh ? '1' : null })}`),
  getOpenOrders: ({ accountId, refresh } = {}) =>
    request('GET', `/trading/orders${buildQueryString({ accountId, refresh: refresh ? '1' : null })}`),

  openPosition: ({ accountId, asset, side, size, leverage, marginMode, limitPrice }) =>
    request('POST', '/trading/open', { accountId, asset, side, size, leverage, marginMode, limitPrice }),

  closePosition: ({ accountId, asset, size }) =>
    request('POST', '/trading/close', { accountId, asset, size }),

  cancelOrder: (asset, oid, { accountId } = {}) =>
    request('DELETE', `/trading/orders/${asset}/${oid}${buildQueryString({ accountId })}`),

  setSLTP: ({ accountId, asset, side, size, slPrice, tpPrice }) =>
    request('POST', '/trading/sltp', { accountId, asset, side, size, slPrice, tpPrice }),
};

// ------------------------------------------------------------------
// Hedge
// ------------------------------------------------------------------
export const hedgeApi = {
  getAll:  ({ accountId } = {}) =>
    request('GET', `/hedge${buildQueryString({ accountId })}`),
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
  getHyperliquidAccounts: (refreshAccountId) =>
    request('GET', `/settings/hyperliquid-accounts${buildQueryString({ refreshAccountId })}`),
  getHyperliquidAccountSummary: (accountId, { refresh = false } = {}) =>
    request('GET', `/settings/hyperliquid-accounts/${accountId}/summary${buildQueryString({ refresh: refresh ? '1' : null })}`),
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
  getAlchemy:    ()                 => request('GET',  '/settings/alchemy'),
  saveAlchemy:   ({ apiKey })       => request('PUT',  '/settings/alchemy', { apiKey }),
  testAlchemy:   ()                 => request('POST', '/settings/alchemy/test'),
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
    request('POST', `/uniswap/${action}/prepare`, payload, { timeoutMs: 120_000 }),
  finalizePositionAction: (action, payload) =>
    request('POST', `/uniswap/${action}/finalize`, payload, { timeoutMs: 30_000 }),
  prepareIncreaseLiquidity: (payload) => request('POST', '/uniswap/increase-liquidity/prepare', payload),
  finalizeIncreaseLiquidity: (payload) => request('POST', '/uniswap/increase-liquidity/finalize', payload, { timeoutMs: 240_000 }),
  prepareDecreaseLiquidity: (payload) => request('POST', '/uniswap/decrease-liquidity/prepare', payload),
  finalizeDecreaseLiquidity: (payload) => request('POST', '/uniswap/decrease-liquidity/finalize', payload, { timeoutMs: 240_000 }),
  prepareCollectFees: (payload) => request('POST', '/uniswap/collect-fees/prepare', payload),
  finalizeCollectFees: (payload) => request('POST', '/uniswap/collect-fees/finalize', payload, { timeoutMs: 240_000 }),
  prepareReinvestFees: (payload) => request('POST', '/uniswap/reinvest-fees/prepare', payload),
  finalizeReinvestFees: (payload) => request('POST', '/uniswap/reinvest-fees/finalize', payload, { timeoutMs: 240_000 }),
  prepareModifyRange: (payload) => request('POST', '/uniswap/modify-range/prepare', payload),
  finalizeModifyRange: (payload) => request('POST', '/uniswap/modify-range/finalize', payload, { timeoutMs: 240_000 }),
  prepareRebalance: (payload) => request('POST', '/uniswap/rebalance/prepare', payload),
  finalizeRebalance: (payload) => request('POST', '/uniswap/rebalance/finalize', payload, { timeoutMs: 240_000 }),
  prepareCreatePosition: (payload) => request('POST', '/uniswap/create-position/prepare', payload),
  finalizeCreatePosition: (payload) => request('POST', '/uniswap/create-position/finalize', payload, { timeoutMs: 240_000 }),
  smartCreateSuggest: ({
    network,
    version,
    walletAddress,
    token0Address,
    token1Address,
    fee,
    totalUsdHint,
    totalUsdTarget,
  }) =>
    request('POST', '/uniswap/smart-create/suggest', {
      network,
      version,
      walletAddress,
      token0Address,
      token1Address,
      fee,
      ...(totalUsdHint != null ? { totalUsdHint } : {}),
      ...(totalUsdTarget != null ? { totalUsdTarget } : {}),
    }),
  getSmartCreateTokenList: (network) =>
    request('GET', `/uniswap/smart-create/token-list?network=${encodeURIComponent(network)}`),
  getSmartCreateAssets: ({ network, walletAddress, importTokenAddresses = [] }) => {
    const params = new URLSearchParams();
    params.set('network', network);
    params.set('walletAddress', walletAddress);
    if (importTokenAddresses.length) {
      params.set('importTokenAddresses', importTokenAddresses.join(','));
    }
    return request('GET', `/uniswap/smart-create/assets?${params.toString()}`);
  },
  smartCreateFundingPlan: (payload) =>
    request('POST', '/uniswap/smart-create/funding-plan', payload),
  smartIncreaseLiquidityFundingPlan: (payload) =>
    request('POST', '/uniswap/increase-liquidity/funding-plan', payload),
  getOperation: (id) => request('GET', `/uniswap/operations/${id}`),
};

// ------------------------------------------------------------------
// LP Orchestrator
// ------------------------------------------------------------------
export const lpOrchestratorApi = {
  list: ({ includeArchived = false } = {}) => {
    const qs = includeArchived ? '?includeArchived=true' : '';
    return request('GET', `/lp-orchestrators${qs}`);
  },
  getById: (id) => request('GET', `/lp-orchestrators/${id}`),
  create: (payload) => request('POST', '/lp-orchestrators', payload),
  evaluate: (id) => request('POST', `/lp-orchestrators/${id}/evaluate`, {}),
  reconcile: (id) => request('POST', `/lp-orchestrators/${id}/reconcile`, {}, { timeoutMs: 60_000 }),
  attachLp: (id, payload) => request('POST', `/lp-orchestrators/${id}/attach-lp`, payload),
  listAdoptableLps: (id) => request('GET', `/lp-orchestrators/${id}/adoptable-lps`, null, { timeoutMs: 60_000 }),
  adoptLp: (id, { positionIdentifier, protectionConfig } = {}) =>
    request('POST', `/lp-orchestrators/${id}/adopt-lp`, { positionIdentifier, protectionConfig }),
  recordTxFinalized: (id, payload) =>
    request('POST', `/lp-orchestrators/${id}/record-tx-finalized`, payload),
  killLp: (id, { mode = 'auto' } = {}) =>
    request('POST', `/lp-orchestrators/${id}/kill-lp`, { mode }),
  archive: (id) => request('POST', `/lp-orchestrators/${id}/archive`, {}),
  getActionLog: (id, { limit } = {}) => {
    const qs = limit ? `?limit=${limit}` : '';
    return request('GET', `/lp-orchestrators/${id}/action-log${qs}`);
  },
  getProtectionOps: (id, { limit } = {}) => {
    const qs = limit ? `?limit=${limit}` : '';
    return request('GET', `/lp-orchestrators/${id}/protection-ops${qs}`);
  },
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
  validateDraft: (payload = {}) => request('POST', '/strategies/validate-draft', payload),
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

// ------------------------------------------------------------------
// Dev (sólo en NODE_ENV=development en el server)
// ------------------------------------------------------------------
export const devApi = {
  getInfo: () => request('GET', '/dev/info'),
  getLogsSnapshot: (limit) => request('GET', `/dev/logs/snapshot${limit ? `?limit=${limit}` : ''}`),
  clearLogs: () => request('POST', '/dev/logs/clear', {}),
  // Recovery endpoint para fondos atascados en posiciones V3 (liquidity=0
  // pero tokensOwed > 0). Devuelve una tx ready-to-sign que llama collect().
  recoverPositionFees: ({ network, tokenId, walletAddress, recipient }) =>
    request('POST', '/dev/recover-position-fees', { network, tokenId, walletAddress, recipient }),
};
