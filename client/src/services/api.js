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
  getAllPrices: () => request('GET', '/market/prices'),
  getPrice:    (asset) => request('GET', `/market/prices/${asset}`),
  getAssets:   () => request('GET', '/market/assets'),
  getContexts: () => request('GET', '/market/contexts'),
};

// ------------------------------------------------------------------
// Trading
// ------------------------------------------------------------------
export const tradingApi = {
  getAccount:    () => request('GET', '/trading/account'),
  getOpenOrders: () => request('GET', '/trading/orders'),

  openPosition: ({ asset, side, size, leverage, marginMode, limitPrice }) =>
    request('POST', '/trading/open', { asset, side, size, leverage, marginMode, limitPrice }),

  closePosition: ({ asset, size }) =>
    request('POST', '/trading/close', { asset, size }),

  cancelOrder: (asset, oid) =>
    request('DELETE', `/trading/orders/${asset}/${oid}`),

  setSLTP: ({ asset, side, size, slPrice, tpPrice }) =>
    request('POST', '/trading/sltp', { asset, side, size, slPrice, tpPrice }),
};

// ------------------------------------------------------------------
// Hedge
// ------------------------------------------------------------------
export const hedgeApi = {
  getAll:  () => request('GET', '/hedge'),
  getById: (id) => request('GET', `/hedge/${id}`),

  create: ({ asset, entryPrice, exitPrice, size, leverage, label, direction }) =>
    request('POST', '/hedge', { asset, entryPrice, exitPrice, size, leverage, label, direction }),

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
};
