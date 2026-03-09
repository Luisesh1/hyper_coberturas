/**
 * api.js
 *
 * Cliente HTTP para comunicarse con el backend del bot.
 * Centraliza todas las llamadas a la API REST.
 */

const BASE_URL = import.meta.env.VITE_API_URL || '/api';

async function request(method, path, body) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${path}`, options);
  const data = await res.json();

  if (!res.ok || !data.success) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  return data.data;
}

// ------------------------------------------------------------------
// Market
// ------------------------------------------------------------------
export const marketApi = {
  getAllPrices: () => request('GET', '/market/prices'),
  getPrice: (asset) => request('GET', `/market/prices/${asset}`),
  getAssets: () => request('GET', '/market/assets'),
  getContexts: () => request('GET', '/market/contexts'),
};

// ------------------------------------------------------------------
// Trading
// ------------------------------------------------------------------
export const tradingApi = {
  getAccount: () => request('GET', '/trading/account'),
  getOpenOrders: () => request('GET', '/trading/orders'),

  openPosition: ({ asset, side, size, leverage, marginMode, limitPrice }) =>
    request('POST', '/trading/open', { asset, side, size, leverage, marginMode, limitPrice }),

  closePosition: ({ asset, size }) =>
    request('POST', '/trading/close', { asset, size }),

  cancelOrder: (asset, oid) =>
    request('DELETE', `/trading/orders/${asset}/${oid}`),
};

// ------------------------------------------------------------------
// Hedge (coberturas automaticas)
// ------------------------------------------------------------------
export const hedgeApi = {
  getAll: () => request('GET', '/hedge'),
  getById: (id) => request('GET', `/hedge/${id}`),

  create: ({ asset, entryPrice, exitPrice, size, leverage, label }) =>
    request('POST', '/hedge', { asset, entryPrice, exitPrice, size, leverage, label }),

  cancel: (id) => request('DELETE', `/hedge/${id}`),
};

// ------------------------------------------------------------------
// Settings (configuración persistente)
// ------------------------------------------------------------------
export const settingsApi = {
  get:          ()                  => request('GET',  '/settings'),
  saveTelegram: ({ token, chatId }) => request('PUT',  '/settings/telegram', { token, chatId }),
  testTelegram: ()                  => request('POST', '/settings/telegram/test'),
};
