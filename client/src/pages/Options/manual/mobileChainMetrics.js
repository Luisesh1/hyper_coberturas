/**
 * Midpoint and premium-funded notional exposure of a long option.
 *
 * Display leverage = underlying value controlled / entry premium:
 *   (spot * contractUnit * contracts) / (ask * contractUnit * contracts).
 * Option quotes and spot are per underlying unit, so common unit/quantity
 * cancel. This is NOT delta-adjusted leverage nor a margin facility.
 * We use executable ASK rather than midpoint to avoid overstating exposure.
 * For a purchased option the entire premium can be lost.
 */
const positive = value => value != null && value !== '' &&
  Number.isFinite(Number(value)) && Number(value) > 0;

export function quoteMid(bid, ask) {
  if (!positive(bid) || !positive(ask) || Number(bid) > Number(ask)) return null;
  return (Number(bid) + Number(ask)) / 2;
}

export function optionPremiumLeverage(spot, ask) {
  if (!positive(spot) || !positive(ask)) return null;
  const ratio = Number(spot) / Number(ask);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}
