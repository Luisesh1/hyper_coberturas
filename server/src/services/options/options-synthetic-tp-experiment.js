/**
 * OFF by default. Narrow experimental alternative to GTC partial-fill dust:
 * trigger one-contract ETH TP off-exchange and attempt a full-size FOK close.
 *
 * A synthetic exit is NOT exchange protection: process downtime, latency,
 * missing market data and insufficient FOK liquidity can leave it open.
 * Never treat enabling this feature as production authorization.
 */
function isPilotSyntheticTpEligible({ candidate, enabled } = {}) {
  if (enabled !== true || !candidate) return false;
  const id = Number(candidate.strategyId ?? candidate.id);
  const user = Number(candidate.userId);
  const params = candidate.params;
  return id === 2 && user === 1 &&
    (candidate.mode == null || candidate.mode === 'live') &&
    /^ETH-\d{6}-\d+(?:\.\d+)?-[CP]$/.test(candidate.symbol || '') &&
    candidate.side === 'BUY' &&
    Number(candidate.quantity) === 0.01 &&
    params?.takeProfitMode === 'fixed' &&
    Number(params.takeProfitPct) === 50 &&
    Number(params.stopLossPct) === 50 &&
    Number(params.exitHoursBeforeExpiry) === 24 &&
    Number(params.maxOpenPositions) === 1;
}

function experimentalModeEnabled(env = process.env) {
  return env.OPTIONS_ETH_SYNTHETIC_TP_EXPERIMENT === 'true' &&
    env.OPTIONS_ETH_SYNTHETIC_TP_EXPERIMENT_ACK === 'NO_EXCHANGE_STOP';
}

function fixedTargetPrice(position, params) {
  const entry = Number(position?.entryPrice);
  const pct = Number(params?.takeProfitPct);
  if (position?.side !== 'BUY' || !Number.isFinite(entry) || entry <= 0 ||
      !Number.isFinite(pct) || pct <= 0) {
    throw new Error('Synthetic TP target not verifiable');
  }
  return entry * (1 + pct / 100);
}

module.exports = { isPilotSyntheticTpEligible, experimentalModeEnabled, fixedTargetPrice };
