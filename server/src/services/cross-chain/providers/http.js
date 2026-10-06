const { AppError } = require('../../../errors/app-error');

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * GET JSON con timeout. Devuelve `{ ok, status, body }` sin lanzar por HTTP:
 * cada proveedor decide qué es un error (Li.Fi responde 404 a un estado aún
 * no indexado).
 */
async function getJson(fetchImpl, url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, provider } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, signal: controller.signal });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    throw new AppError(`${provider} no respondió: ${err?.message || err}`, {
      status: 502,
      code: 'BRIDGE_PROVIDER_UNAVAILABLE',
      details: { provider },
    });
  } finally {
    clearTimeout(timer);
  }
}

function quoteFailed(provider, response) {
  const message = response?.body?.message || response?.body?.error || `HTTP ${response?.status}`;
  return new AppError(`${provider} no pudo cotizar la ruta: ${message}`, {
    status: 502,
    code: 'BRIDGE_QUOTE_FAILED',
    details: { provider, httpStatus: response?.status },
  });
}

module.exports = { getJson, quoteFailed };
