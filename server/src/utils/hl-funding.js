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

/** Conserva el funding del ciclo cuando `sinceOpen` vuelve a cero. */
function accumulateFundingUsd(position, state = {}) {
  const stored = Number(state.fundingAccumUsd);
  const previous = Number.isFinite(stored) ? stored : 0;
  const allTimeRaw = position?.cumFunding?.allTime;
  const allTimePaid = allTimeRaw == null ? NaN : Number(allTimeRaw);
  const allTime = Number.isFinite(allTimePaid) ? -allTimePaid : null;
  const sinceOpen = fundingReceivedUsd(position);
  const storedBaseline = state.fundingAllTimeBaselineUsd;
  const baseline = storedBaseline != null && Number.isFinite(Number(storedBaseline))
    ? Number(storedBaseline)
    : allTime != null
      ? allTime - (sinceOpen ?? previous)
      : null;
  return {
    fundingAccumUsd: allTime != null && baseline != null
      ? allTime - baseline
      : baseline == null && sinceOpen != null ? sinceOpen : previous,
    fundingAllTimeBaselineUsd: baseline,
  };
}

module.exports = { fundingReceivedUsd, accumulateFundingUsd };
