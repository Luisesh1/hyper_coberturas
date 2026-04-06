/**
 * HTTP client helper — wrapper mínimo sobre `fetch` nativo de Node.js 18+.
 *
 * Objetivo: reemplazar `axios` manteniendo un shape de response/error
 * compatible (mismos atributos que axios: `response.data`, `err.response.data`,
 * `err.response.status`, etc.) para que los call sites existentes funcionen
 * sin cambios lógicos.
 *
 * Features:
 * - Query params como objeto (serializa con URLSearchParams, omite null/undefined).
 * - Auto-JSON para POST: stringify body y añadir Content-Type application/json.
 * - Auto-parse de response según Content-Type (JSON, text/*, vacío).
 * - Timeout con AbortController + setTimeout (con clearTimeout en finally).
 * - Errores HTTP lanzan `HttpError` con `err.response.{data, status, headers}`
 *   y `err.code === 'ECONNABORTED'` en timeouts (compatible con logs tipo axios).
 *
 * NO incluye (YAGNI): interceptors, instances con baseURL, responseType stream,
 * retries automáticos, transformers.
 */

const { URL, URLSearchParams } = require('node:url');

/**
 * Error lanzado cuando la respuesta HTTP tiene status fuera del rango 2xx o
 * cuando la request falla (timeout, red, DNS).
 *
 * Shape compatible con `AxiosError`:
 * - `err.response.data`, `err.response.status`, `err.response.statusText`, `err.response.headers`
 * - `err.code` (opcional, p. ej. 'ECONNABORTED', 'ENOTFOUND')
 * - `err.cause` (el error original cuando aplica)
 */
class HttpError extends Error {
  constructor(message, { response, request, code, cause } = {}) {
    super(message);
    this.name = 'HttpError';
    this.isHttpError = true;
    if (response) this.response = response;
    if (request) this.request = request;
    if (code) this.code = code;
    if (cause) this.cause = cause;
  }
}

/**
 * Serializa un objeto `params` en un string query-compatible.
 * Omite valores `undefined` y `null`. Acepta `URLSearchParams` tal cual.
 */
function buildSearchParams(params) {
  if (!params) return null;
  if (params instanceof URLSearchParams) return params;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null) search.append(key, String(item));
      }
    } else {
      search.append(key, String(value));
    }
  }
  return search;
}

/**
 * Añade los `params` a la URL. Si la URL ya tiene querystring, los combina.
 */
function appendSearchParamsToUrl(url, params) {
  const search = buildSearchParams(params);
  if (!search || search.toString() === '') return url;
  const parsed = new URL(url);
  for (const [key, value] of search.entries()) {
    parsed.searchParams.append(key, value);
  }
  return parsed.toString();
}

/**
 * True si el body debe serializarse como JSON automáticamente (objeto plano
 * pero NO URLSearchParams / Buffer / FormData / string / ArrayBuffer).
 */
function shouldJsonStringify(body) {
  if (body == null) return false;
  if (typeof body === 'string') return false;
  if (body instanceof URLSearchParams) return false;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) return false;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return false;
  if (body instanceof ArrayBuffer) return false;
  if (ArrayBuffer.isView(body)) return false;
  return typeof body === 'object';
}

/**
 * Convierte un `Headers` de fetch en un plain object (axios-style).
 */
function headersToObject(headers) {
  const obj = {};
  if (!headers) return obj;
  for (const [key, value] of headers.entries()) {
    obj[key] = value;
  }
  return obj;
}

/**
 * Intenta parsear el body de la response según el Content-Type.
 * - `application/json` → JSON.parse (fallback a text si falla en 2xx).
 * - `text/*` → string.
 * - vacío o Content-Length: 0 → null.
 * - otros → null (caller puede extender si lo necesita).
 */
async function parseResponseBody(response) {
  const contentLength = response.headers.get('content-length');
  if (contentLength === '0' || response.status === 204) return null;

  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      const text = await response.text();
      if (!text) return null;
      return JSON.parse(text);
    } catch {
      // Body malformado: fallback a text si es 2xx, si no propagar.
      return null;
    }
  }

  if (contentType.startsWith('text/')) {
    return response.text();
  }

  // Content-Type desconocido: intentar leerlo como texto.
  try {
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Ejecuta una request HTTP con soporte de timeout, params y auto-JSON.
 * Retorna `{ data, status, statusText, headers }`.
 *
 * Lanza `HttpError` en casos:
 * - Status fuera de 2xx (con `err.response` poblado).
 * - Timeout (con `err.code === 'ECONNABORTED'`).
 * - Error de red (DNS, connection refused, etc.), con `err.cause` original.
 */
async function request({ method, url, params, body, headers, timeout, signal } = {}) {
  if (!method || !url) {
    throw new TypeError('http-client: method y url son requeridos');
  }

  const finalUrl = appendSearchParamsToUrl(url, params);

  const init = {
    method,
    headers: { ...(headers || {}) },
  };

  if (body != null && method !== 'GET' && method !== 'HEAD') {
    if (shouldJsonStringify(body)) {
      init.body = JSON.stringify(body);
      if (!init.headers['Content-Type'] && !init.headers['content-type']) {
        init.headers['Content-Type'] = 'application/json';
      }
    } else {
      init.body = body;
    }
  }

  let timerId = null;
  let abortedByTimeout = false;
  const controller = new AbortController();

  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
  }

  if (typeof timeout === 'number' && timeout > 0) {
    timerId = setTimeout(() => {
      abortedByTimeout = true;
      controller.abort();
    }, timeout);
  }

  init.signal = controller.signal;

  let response;
  try {
    response = await fetch(finalUrl, init);
  } catch (err) {
    if (abortedByTimeout || err?.name === 'AbortError') {
      throw new HttpError(`timeout of ${timeout}ms exceeded`, {
        code: 'ECONNABORTED',
        request: { method, url: finalUrl },
        cause: err,
      });
    }
    const code = err?.cause?.code || err?.code || undefined;
    throw new HttpError(`request failed: ${err?.message || err}`, {
      code,
      request: { method, url: finalUrl },
      cause: err,
    });
  } finally {
    if (timerId) clearTimeout(timerId);
  }

  const data = await parseResponseBody(response);
  const responseHeaders = headersToObject(response.headers);

  if (response.status < 200 || response.status >= 300) {
    throw new HttpError(`Request failed with status code ${response.status}`, {
      response: {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        url: finalUrl,
      },
      request: { method, url: finalUrl },
    });
  }

  return {
    data,
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  };
}

function get(url, options = {}) {
  return request({ method: 'GET', url, ...options });
}

function post(url, body, options = {}) {
  return request({ method: 'POST', url, body, ...options });
}

module.exports = {
  get,
  post,
  request,
  HttpError,
};
