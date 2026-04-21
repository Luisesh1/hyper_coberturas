/**
 * circuit-breaker.js — Circuit breaker simple (closed/open/half-open).
 *
 * Uso típico:
 *   const breaker = createCircuitBreaker({
 *     name: 'alchemy-rpc',
 *     failureThreshold: 5,
 *     cooldownMs: 30_000,
 *     halfOpenMaxCalls: 1,
 *     isRetryable: (err) => err?.code === 'ECONNRESET' || /rate/i.test(err?.message),
 *   });
 *   const result = await breaker.exec(() => fetchSomething());
 *
 * Estados:
 *   - CLOSED    : todo pasa. Si `failureThreshold` fallos seguidos → OPEN.
 *   - OPEN      : rechaza inmediatamente con error `circuitBreakerOpen=true`
 *                 hasta que pasen `cooldownMs` → HALF_OPEN.
 *   - HALF_OPEN : permite hasta `halfOpenMaxCalls` llamadas de prueba; una
 *                 exitosa → CLOSED; una fallida → OPEN de nuevo.
 *
 * Nota: intencionalmente no usamos una dependencia externa (opossum) para
 * mantener la superficie del backend pequeña. Esta impl cubre los patrones
 * clave: exchange HL, RPC Alchemy, Hyperliquid INFO, Etherscan.
 */

const STATE_CLOSED = 'closed';
const STATE_OPEN = 'open';
const STATE_HALF_OPEN = 'half_open';

function createCircuitBreaker({
  name = 'breaker',
  failureThreshold = 5,
  cooldownMs = 30_000,
  halfOpenMaxCalls = 1,
  isRetryable = () => true,
  logger = null,
} = {}) {
  let state = STATE_CLOSED;
  let consecutiveFailures = 0;
  let openedAt = 0;
  let halfOpenInFlight = 0;

  function _log(level, event, payload) {
    if (!logger) return;
    try {
      const fn = logger[level] || logger.info || logger.log;
      if (typeof fn === 'function') fn.call(logger, `${event}`, { ...payload, breaker: name });
    } catch {
      /* swallow */
    }
  }

  function _transition(next) {
    if (state === next) return;
    const prev = state;
    state = next;
    if (next === STATE_OPEN) openedAt = Date.now();
    if (next === STATE_CLOSED) {
      consecutiveFailures = 0;
      halfOpenInFlight = 0;
    }
    _log('warn', 'circuit_breaker_state', { prev, next });
  }

  function _maybeFlipToHalfOpen() {
    if (state !== STATE_OPEN) return;
    if (Date.now() - openedAt >= cooldownMs) {
      _transition(STATE_HALF_OPEN);
    }
  }

  function _rejectOpen() {
    const retryInMs = Math.max(0, cooldownMs - (Date.now() - openedAt));
    const err = new Error(`circuit breaker '${name}' OPEN; retry in ${Math.ceil(retryInMs / 1000)}s`);
    err.circuitBreakerOpen = true;
    err.circuitBreakerName = name;
    err.retryInMs = retryInMs;
    return err;
  }

  async function exec(fn) {
    _maybeFlipToHalfOpen();
    if (state === STATE_OPEN) throw _rejectOpen();

    if (state === STATE_HALF_OPEN) {
      if (halfOpenInFlight >= halfOpenMaxCalls) throw _rejectOpen();
      halfOpenInFlight += 1;
    }

    try {
      const result = await fn();
      // Éxito
      if (state === STATE_HALF_OPEN) {
        _transition(STATE_CLOSED);
      } else {
        consecutiveFailures = 0;
      }
      return result;
    } catch (err) {
      if (!isRetryable(err)) {
        // Fallos "de dominio" (validación, 4xx, etc.) no mueven el breaker.
        throw err;
      }
      consecutiveFailures += 1;
      if (state === STATE_HALF_OPEN || consecutiveFailures >= failureThreshold) {
        _transition(STATE_OPEN);
      }
      throw err;
    } finally {
      if (state === STATE_HALF_OPEN && halfOpenInFlight > 0) halfOpenInFlight -= 1;
    }
  }

  function getState() {
    _maybeFlipToHalfOpen();
    return {
      name,
      state,
      consecutiveFailures,
      openedAt,
      msSinceOpen: state === STATE_OPEN ? Date.now() - openedAt : null,
    };
  }

  function reset() {
    _transition(STATE_CLOSED);
  }

  return { exec, getState, reset };
}

module.exports = { createCircuitBreaker };
