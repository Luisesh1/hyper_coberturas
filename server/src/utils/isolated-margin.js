/**
 * isolated-margin.js — Excedente extraíble de un slot isolated de Hyperliquid.
 *
 * Semántica de los campos que HL devuelve por posición isolated (verificada
 * contra `clearinghouseState` en las tres cuentas de la flota):
 *
 *   leverage.rawUsd  = colateral del slot + positionValue
 *   marginUsed       = colateral del slot (la equity aparcada en el aislado)
 *   positionValue    = notional vivo
 *
 * de donde `rawUsd - positionValue === marginUsed` exacto.
 *
 * El cálculo anterior usaba `rawUsd - marginUsed * 1.2`, que trata `rawUsd`
 * como si fuera colateral extraíble cuando en realidad ya incluye el notional.
 * Eso lo rompía en las dos direcciones:
 *
 *  - posición polvo (positionValue → 0): `rawUsd ≈ marginUsed`, así que la
 *    expresión colapsa a `-0.2 * marginUsed` y clampa a 0. Nunca extraía nada
 *    justo cuando TODO el colateral del slot estaba libre. Es el deadlock que
 *    dejó a pp24 sin cobertura 5 días por $0.90 de faltante.
 *  - posición de tamaño normal: devolvía ~el notional entero como "excedente"
 *    (p.ej. $199 sobre un slot con $0 realmente libre), sub-bloqueando órdenes
 *    que sí carecían de margen.
 *
 * La bolsa correcta es el colateral (`marginUsed`) y el piso es el margen que
 * el tamaño VIVO todavía necesita (`positionValue / leverage`), con un buffer.
 */

const DEFAULT_SAFETY_BUFFER_FACTOR = 1.2;

/**
 * Notional vivo del slot. Prefiere `positionValue` (lo que HL ya calculó) y
 * cae a |szi| * precio sólo si viniera ausente.
 */
function resolvePositionValueUsd(positionEntry, price) {
  const reported = Number(positionEntry?.position?.positionValue);
  if (Number.isFinite(reported) && reported >= 0) return reported;
  const szi = Math.abs(Number(positionEntry?.position?.szi || 0));
  const px = Number(price || 0);
  if (!Number.isFinite(szi) || !Number.isFinite(px)) return 0;
  return szi * px;
}

/**
 * USD que se pueden devolver del slot isolated a cross sin dejar la posición
 * viva por debajo de su margen requerido (× buffer de seguridad).
 *
 * @returns {number} >= 0
 */
function computeExtractableSlotSurplusUsd(positionEntry, {
  leverage,
  price,
  safetyBufferFactor = DEFAULT_SAFETY_BUFFER_FACTOR,
} = {}) {
  const slotEquityUsd = Number(positionEntry?.position?.marginUsed || 0);
  if (!Number.isFinite(slotEquityUsd) || slotEquityUsd <= 0) return 0;

  const lev = Math.max(Number(leverage || 1), 1);
  const positionValueUsd = resolvePositionValueUsd(positionEntry, price);
  const requiredForExistingUsd = positionValueUsd / lev;

  const surplus = slotEquityUsd - requiredForExistingUsd * safetyBufferFactor;
  return surplus > 0 ? surplus : 0;
}

module.exports = {
  DEFAULT_SAFETY_BUFFER_FACTOR,
  computeExtractableSlotSurplusUsd,
  resolvePositionValueUsd,
};
