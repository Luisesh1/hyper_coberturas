/**
 * protection-recovery.js
 *
 * Lógica pura para el caso "el LP existe pero la cobertura no".
 *
 * Pasa cuando `attachLp` corrió en modo `lenient` y la creación de la
 * protección falló: el orquestador queda en `lp_active` con
 * `activeProtectedPoolId = null` y ninguna ruta del loop lo mira, porque
 * todas van detrás de `if (orch.activeProtectedPoolId)`. El resultado es un
 * LP operando descubierto de forma indefinida y silenciosa.
 *
 * El backoff existe porque los dos fallos posibles tienen escalas distintas:
 * el snapshot que llegó tarde se arregla en minutos, y el margen insuficiente
 * en Hyperliquid no se arregla reintentando nunca. Se reintenta rápido al
 * principio, se espacía, y se para avisando.
 */

const BASE_RETRY_DELAY_MS = 5 * 60_000;
const MAX_RETRY_DELAY_MS = 4 * 60 * 60_000;
const MAX_PROTECTION_RETRY_ATTEMPTS = 8;

/**
 * ¿Este orquestador pidió cobertura y se quedó sin ella?
 */
function needsProtectionRecovery(orch) {
  if (!orch) return false;
  if (orch.status !== 'active') return false;
  if (!orch.activePositionIdentifier) return false;
  if (orch.activeProtectedPoolId != null) return false;
  const protection = orch.protectionConfig;
  if (!protection) return false;
  return protection.enabled !== false;
}

function readRetryState(orch) {
  return orch?.strategyState?.protectionRetry || null;
}

/**
 * ¿Toca intentarlo en este tick? El primer intento es inmediato; los
 * siguientes esperan al `nextAttemptAt` persistido.
 */
function shouldAttemptNow(orch, now = Date.now()) {
  const state = readRetryState(orch);
  if (!state) return true;
  if (Number(state.attempts || 0) >= MAX_PROTECTION_RETRY_ATTEMPTS) return false;
  return now >= Number(state.nextAttemptAt || 0);
}

/**
 * Estado de reintento tras un intento. `null` si salió bien: el éxito
 * borra el rastro para que un fallo futuro empiece de cero.
 */
function nextRetryState(previous, { ok, error = null, now = Date.now() } = {}) {
  if (ok) return null;
  const attempts = Number(previous?.attempts || 0) + 1;
  const delay = Math.min(BASE_RETRY_DELAY_MS * (2 ** (attempts - 1)), MAX_RETRY_DELAY_MS);
  return {
    attempts,
    nextAttemptAt: now + delay,
    lastError: error,
    exhausted: attempts >= MAX_PROTECTION_RETRY_ATTEMPTS,
  };
}

module.exports = {
  needsProtectionRecovery,
  shouldAttemptNow,
  nextRetryState,
  readRetryState,
  BASE_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  MAX_PROTECTION_RETRY_ATTEMPTS,
};
