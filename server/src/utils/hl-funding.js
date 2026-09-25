/**
 * hl-funding.js — Convencion de signo del funding de Hyperliquid.
 *
 * Hyperliquid publica `position.cumFunding.{allTime,sinceOpen,sinceChange}`
 * desde el lado del que PAGA: positivo = funding pagado. Su endpoint
 * `userFunding` usa el signo contrario (`delta.usdc < 0` = pagado).
 * Verificado el 2026-09-25 cruzando ambos en posiciones reales.
 *
 * El servidor, el cliente y la contabilidad trabajan con "positivo =
 * recibido". Leer `cumFunding` sin pasar por aqui invierte el funding en el
 * PnL: un short que cobra aparece como si pagara.
 */

/**
 * Funding acumulado desde la apertura, en USD, con signo recibido.
 * Devuelve `null` si la posicion no trae un dato utilizable.
 */
function fundingReceivedUsd(position) {
  const raw = position?.cumFunding?.sinceOpen;
  if (raw == null) return null;
  const paid = Number(raw);
  if (!Number.isFinite(paid)) return null;
  return paid === 0 ? 0 : -paid;
}

module.exports = { fundingReceivedUsd };
