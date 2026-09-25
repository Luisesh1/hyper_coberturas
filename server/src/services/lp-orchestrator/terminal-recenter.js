/**
 * Regla de recentrado del orquestador cuando la cobertura viva es
 * `terminal_range_v1`.
 *
 * En el backtest el recentrado es automatico: un cierre fuera del rango abre un
 * ciclo nuevo si pasaron al menos 24 h desde la apertura ANTERIOR (no desde la
 * salida). Aqui el recentrado lo firma el usuario, asi que lo que se adapta es
 * la RECOMENDACION: el orquestador pide recentrar solo cuando el perfil lo
 * haria, y dentro del rango no lo pide nunca — la politica termina su ciclo en
 * el borde, no a medio camino.
 *
 * La apertura del ciclo la marca la propia politica (`openedAt` cambia cuando
 * llega un rango nuevo), que es la unica fuente fiable: el orquestador no
 * guarda cuando se abrio su LP vigente.
 *
 * Los demas orquestadores no pasan por aqui: devuelve `null` y se aplican sus
 * reglas de siempre.
 */
const { resolveProtectionLivePolicy } = require('../protected-pool-delta-neutral.helpers');

// Perfil aprobado. El `minRebalanceCooldownSec` configurado solo puede
// alargarlo: su default historico (1 h) no debe acortar el perfil en silencio.
const TERMINAL_RECENTER_MIN_COOLDOWN_SEC = 86_400;

function resolveTerminalRecenterDecision({ protection, evaluation, cooldownSec = null, now = Date.now() } = {}) {
  if (resolveProtectionLivePolicy(protection) !== 'terminal_range_v1') return null;
  if (!evaluation || evaluation.inRange) return { decision: 'hold', reason: 'terminal_in_range' };

  const side = evaluation.outOfRangeSide || 'unknown';
  const configured = Number(cooldownSec);
  const effectiveSec = Math.max(
    TERMINAL_RECENTER_MIN_COOLDOWN_SEC,
    Number.isFinite(configured) ? configured : 0,
  );
  const openedAt = Number(protection?.strategyState?.terminalRangePolicyState?.openedAt);
  if (Number.isFinite(openedAt) && openedAt > 0) {
    const eligibleAt = openedAt + effectiveSec * 1000;
    if (now < eligibleAt) {
      return { decision: 'hold', reason: `out_of_range_${side}_terminal_cooldown`, eligibleAt };
    }
  }
  return { decision: 'urgent_adjust', reason: `out_of_range_${side}` };
}

module.exports = {
  TERMINAL_RECENTER_MIN_COOLDOWN_SEC,
  resolveTerminalRecenterDecision,
};
