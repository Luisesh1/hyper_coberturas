/**
 * binance-options.client.js
 *
 * Cliente REST de las opciones europeas de Binance (`eapi.binance.com`).
 *
 * - Endpoints públicos: exchangeInfo, mark, ticker, depth, index y openInterest.
 * - Endpoints firmados (HMAC-SHA256 sobre el query string con `timestamp` y
 *   `recvWindow`, cabecera `X-MBX-APIKEY`): cuenta, posiciones, órdenes y
 *   trades. Binance Opciones admite LIMIT con GTC/FOK. FOK se usa para
 *   entradas y cierres estándar ETH; TP resting GTC. Sin stop garantizado.
 * - `getApiRestrictions()` consulta el endpoint spot
 *   `/sapi/v1/account/apiRestrictions` con la misma key para saber si hay
 *   restricción por IP y si los retiros están habilitados.
 *
 * Los errores se normalizan a clases de `errors/app-error` sin incluir nunca
 * la API key, el secret ni el query string firmado.
 */

const crypto = require('crypto');
const { AppError, ExternalServiceError, ValidationError } = require('../../errors/app-error');
const logger = require('../logger.service');

const DEFAULT_BASE_URL = 'https://eapi.binance.com';
const DEFAULT_SPOT_BASE_URL = 'https://api.binance.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RECV_WINDOW = 5_000;

// Códigos de Binance que indican un problema con la key/firma/permisos.
const AUTH_ERROR_CODES = new Set([-1002, -1021, -1022, -2008, -2014, -2015]);
// El enfriamiento es compartido por host entre clientes del mismo proceso.
// No sustituye un rate limiter distribuido si hay varias réplicas.
const cooldownByHost = new Map();
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Firma un query string con HMAC-SHA256 (hex), como exige Binance.
 */
function signQuery(queryString, apiSecret) {
  return crypto.createHmac('sha256', String(apiSecret)).update(queryString).digest('hex');
}

/**
 * Serializa params omitiendo null/undefined, respetando el orden de inserción.
 */
function buildQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.append(key, String(value));
  }
  return search.toString();
}

/**
 * Parsea JSON conservando como string los enteros de 16+ dígitos: los
 * orderId de Binance Opciones superan Number.MAX_SAFE_INTEGER y perderían
 * precisión (y con ello no se podría cancelar la orden).
 */
function parseJsonPreservingBigInts(text) {
  if (!text) return null;
  const safe = String(text).replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"');
  return JSON.parse(safe);
}

async function readBody(res) {
  try {
    if (typeof res.text === 'function') return parseJsonPreservingBigInts(await res.text());
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Elimina de un texto cualquier aparición de credenciales o firmas.
 */
function scrubSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret && String(secret).length >= 4) {
      out = out.split(String(secret)).join('[REDACTED]');
    }
  }
  return out.replace(/signature=[0-9a-fA-F]+/g, 'signature=[REDACTED]');
}

/**
 * Convierte una respuesta de error de Binance (o un fallo de red) en un
 * AppError. `path` es solo la ruta del endpoint, nunca la URL con query.
 */
function normalizeBinanceError({ httpStatus = null, body = null, path, cause = null, secrets = [] }) {
  const binanceCode = Number.isFinite(Number(body?.code)) ? Number(body.code) : null;
  const rawMsg = body?.msg || body?.message || (cause ? cause.message : null) || (httpStatus ? `HTTP ${httpStatus}` : 'sin respuesta');
  const msg = scrubSecrets(rawMsg, secrets);
  const details = { endpoint: path, httpStatus, binanceCode };

  if (httpStatus == null) {
    const timedOut = cause?.name === 'AbortError';
    return new ExternalServiceError(
      timedOut ? 'Binance Opciones no respondió a tiempo' : `Binance Opciones no responde: ${msg}`,
      details
    );
  }
  if (httpStatus === 429 || httpStatus === 418) {
    return new AppError(`Binance Opciones limitó las peticiones: ${msg}`, {
      status: 429,
      code: 'BINANCE_OPTIONS_RATE_LIMIT',
      details,
    });
  }
  if (httpStatus === 401 || httpStatus === 403 || AUTH_ERROR_CODES.has(binanceCode)) {
    // 400 y no 401: un 401 haría que el cliente cerrara la sesión de la app.
    return new AppError(`Binance Opciones rechazó las credenciales: ${msg}`, {
      status: 400,
      code: 'BINANCE_OPTIONS_AUTH_ERROR',
      details,
    });
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    return new AppError(`Binance Opciones rechazó la petición: ${msg}`, {
      status: 400,
      code: 'BINANCE_OPTIONS_REJECTED',
      details,
    });
  }
  return new ExternalServiceError(`Error de Binance Opciones: ${msg}`, details);
}

function createBinanceOptionsClient({
  apiKey = null,
  apiSecret = null,
  baseUrl = DEFAULT_BASE_URL,
  spotBaseUrl = DEFAULT_SPOT_BASE_URL,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  recvWindow = DEFAULT_RECV_WINDOW,
  now = () => Date.now(),
} = {}) {
  const secrets = [apiKey, apiSecret].filter(Boolean);

  async function request(method, path, { params = {}, signed = false, apiKeyOnly = false, base = baseUrl } = {}) {
    const host = new URL(base).host;
    const retryAt = cooldownByHost.get(host) || 0;
    if (now() < retryAt) {
      throw new AppError('Binance Opciones: límite de peticiones, consulta aplazada', {
        status: 429, code: 'BINANCE_OPTIONS_RATE_LIMIT',
        details: { endpoint: path, retryAfterMs: retryAt - now() },
      });
    }
    if (retryAt) cooldownByHost.delete(host);
    let query = buildQuery(params);
    const headers = { accept: 'application/json' };

    if (signed) {
      if (!apiKey || !apiSecret) {
        throw new ValidationError('Faltan credenciales de Binance Opciones');
      }
      const withTime = buildQuery({ ...params, recvWindow, timestamp: now() });
      query = `${withTime}&signature=${signQuery(withTime, apiSecret)}`;
      headers['X-MBX-APIKEY'] = apiKey;
    } else if (apiKeyOnly) {
      // USER_STREAM: solo la cabecera con la key, sin timestamp ni firma.
      if (!apiKey) throw new ValidationError('Faltan credenciales de Binance Opciones');
      headers['X-MBX-APIKEY'] = apiKey;
    }

    const url = `${base}${path}${query ? `?${query}` : ''}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { method, headers, signal: controller.signal });
    } catch (err) {
      const appErr = normalizeBinanceError({ path, cause: err, secrets });
      logger.warn('binance_options_request_failed', { method, path, error: appErr.message });
      throw appErr;
    } finally {
      clearTimeout(timer);
    }

    const body = await readBody(res);
    if (!res.ok || (body && typeof body === 'object' && !Array.isArray(body) && Number(body.code) < 0)) {
      if (res.status === 429 || res.status === 418) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : DEFAULT_COOLDOWN_MS;
        cooldownByHost.set(host, Math.max(cooldownByHost.get(host) || 0, now() + Math.max(DEFAULT_COOLDOWN_MS, delay)));
      }
      const appErr = normalizeBinanceError({ httpStatus: res.ok ? 400 : res.status, body, path, secrets });
      logger.warn('binance_options_request_failed', {
        method,
        path,
        httpStatus: res.status,
        binanceCode: appErr.details?.binanceCode ?? null,
        error: appErr.message,
      });
      throw appErr;
    }
    return body;
  }

  return {
    hasCredentials: Boolean(apiKey && apiSecret),

    // ── Públicos ──────────────────────────────────────────────────
    getExchangeInfo() {
      return request('GET', '/eapi/v1/exchangeInfo');
    },
    getMark(symbol) {
      return request('GET', '/eapi/v1/mark', { params: { symbol } });
    },
    getTicker(symbol) {
      return request('GET', '/eapi/v1/ticker', { params: { symbol } });
    },
    getDepth(symbol, limit = 10) {
      return request('GET', '/eapi/v1/depth', { params: { symbol, limit } });
    },
    // Operaciones publicas (ejecuciones de mercado, NO ordenes privadas).
    // La muestra ayuda a detectar fills fuera del lote, pero no prueba
    // que todas las ejecuciones futuras respeten la misma granularidad.
    getRecentTrades(symbol, limit = 100) {
      if (!/^ETH-\d{6}-\d+(?:\.\d+)?-C$/.test(String(symbol)) ||
          !Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new ValidationError('Parametros de operaciones publicas invalidos');
      }
      return request('GET', '/eapi/v1/trades', { params: { symbol, limit } });
    },
    getIndex(underlyingPair) {
      return request('GET', '/eapi/v1/index', { params: { underlying: underlyingPair } });
    },
    getOpenInterest(underlyingAsset, expiration) {
      return request('GET', '/eapi/v1/openInterest', { params: { underlyingAsset, expiration } });
    },
    // Ticker 24h del spot (para el cambio porcentual de cada subyacente).
    getSpotTicker24h(symbols = []) {
      return request('GET', '/api/v3/ticker/24hr', {
        params: { symbols: JSON.stringify(symbols) },
        base: spotBaseUrl,
      });
    },
    // Velas spot públicas: ATR de 1 h, no implica ejecución de órdenes.
    getSpotKlines(symbol, interval = '1h', limit = 17) {
      if (!/^[A-Z0-9]{3,20}$/.test(String(symbol)) ||
          interval !== '1h' || !Number.isInteger(limit) || limit < 15 || limit > 100) {
        throw new ValidationError('Parámetros de klines inválidos');
      }
      return request('GET', '/api/v3/klines', {
        params: { symbol, interval, limit },
        base: spotBaseUrl,
      });
    },

    // ── Firmados ──────────────────────────────────────────────────
    // Binance retiró `/eapi/v1/account` (responde 404); la cuenta de opciones
    // se lee en `marginAccount`, con la misma forma: `asset[]` y `greek[]`.
    getAccount() {
      return request('GET', '/eapi/v1/marginAccount', { signed: true });
    },
    getPositions(symbol) {
      return request('GET', '/eapi/v1/position', { params: { symbol }, signed: true });
    },
    getOpenOrders(symbol) {
      return request('GET', '/eapi/v1/openOrders', { params: { symbol }, signed: true });
    },
    placeOrder({ symbol, side, quantity, price, timeInForce = 'GTC', postOnly, reduceOnly, clientOrderId }) {
      if (!['GTC', 'FOK'].includes(timeInForce)) {
        throw new ValidationError('Binance Options: timeInForce no permitido');
      }
      if (timeInForce === 'FOK' && postOnly) {
        throw new ValidationError('FOK no puede combinarse con postOnly');
      }
      return request('POST', '/eapi/v1/order', {
        signed: true,
        params: {
          symbol,
          side,
          type: 'LIMIT',
          quantity,
          price,
          timeInForce,
          postOnly: postOnly ? 'true' : undefined,
          reduceOnly: reduceOnly ? 'true' : undefined,
          clientOrderId,
          newOrderRespType: 'RESULT',
        },
      });
    },
    getOrder({ symbol, orderId, clientOrderId }) {
      return request('GET', '/eapi/v1/order', { signed: true, params: { symbol, orderId, clientOrderId } });
    },
    cancelOrder({ symbol, orderId, clientOrderId }) {
      return request('DELETE', '/eapi/v1/order', { signed: true, params: { symbol, orderId, clientOrderId } });
    },
    getUserTrades({ symbol, fromId, startTime, endTime, limit = 1000 } = {}) {
      return request('GET', '/eapi/v1/userTrades', {
        signed: true,
        params: { symbol, fromId, startTime, endTime, limit },
      });
    },
    // Registro de ejercicio efectivamente contabilizado por el exchange.
    // Nunca inferir liquidaciones reales del precio spot/mark.
    getExerciseRecords({ symbol, startTime, endTime, limit = 1000 } = {}) {
      return request('GET', '/eapi/v1/exerciseRecord', {
        signed: true, params: { symbol, startTime, endTime, limit },
      });
    },
    // Movimientos contables: corroborar EXERCISE_PNL y EXERCISE_FEE,
    // sin confundir comisiones de entrada/salida o transferencias.
    getBills({ currency = 'USDT', recordId, startTime, endTime, limit = 1000 } = {}) {
      return request('GET', '/eapi/v1/bill', {
        signed: true, params: { currency, recordId, startTime, endTime, limit },
      });
    },
    // ── User data stream (listenKey válido 60 min; renovar con PUT) ──
    createListenKey() {
      return request('POST', '/eapi/v1/listenKey', { apiKeyOnly: true });
    },
    keepAliveListenKey() {
      return request('PUT', '/eapi/v1/listenKey', { apiKeyOnly: true });
    },
    closeListenKey() {
      return request('DELETE', '/eapi/v1/listenKey', { apiKeyOnly: true });
    },
    // Endpoint spot, firmado con la misma key.
    getApiRestrictions() {
      return request('GET', '/sapi/v1/account/apiRestrictions', { signed: true, base: spotBaseUrl });
    },
  };
}

module.exports = {
  createBinanceOptionsClient,
  signQuery,
  buildQuery,
  normalizeBinanceError,
  scrubSecrets,
  parseJsonPreservingBigInts,
  DEFAULT_BASE_URL,
  DEFAULT_SPOT_BASE_URL,
};
