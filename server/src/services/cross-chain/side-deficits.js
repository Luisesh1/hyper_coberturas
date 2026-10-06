/**
 * Cuánto falta en la red del LP, por lado del pool.
 *
 * Mismo criterio que el planificador de una sola red: cada lado necesita su
 * peso del objetivo con un colchón del 5 % (`DEFAULT_POOL_VALUE_BUFFER`), y
 * no se va a otras redes si lo local ya llega al 93 % del objetivo. Los
 * activos locales que no son de ningún lado se swapearán en la fase 2, así
 * que restan del déficit en proporción a lo que le falta a cada lado.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEFAULT_BUFFER = 1.05;
const DEFAULT_MIN_DEPLOYABLE_RATIO = 0.93;

function lower(value) {
  return String(value || '').toLowerCase();
}

function isNativeSide(token, wrappedNativeAddress) {
  const address = lower(token?.address);
  return address === ZERO_ADDRESS || (wrappedNativeAddress && address === lower(wrappedNativeAddress));
}

function isDirectFor(asset, token, wrappedNativeAddress) {
  if (lower(asset.address) === lower(token.address)) return true;
  if (!isNativeSide(token, wrappedNativeAddress)) return false;
  // Nativo y envuelto valen igual para un lado ETH: la fase 2 los convierte.
  return asset.isNative === true
    || lower(asset.address) === ZERO_ADDRESS
    || (wrappedNativeAddress && lower(asset.address) === lower(wrappedNativeAddress));
}

function computeSideDeficits({
  targetUsd,
  weightToken0Pct,
  token0,
  token1,
  localAssets = [],
  wrappedNativeAddress = null,
  buffer = DEFAULT_BUFFER,
  minDeployableRatio = DEFAULT_MIN_DEPLOYABLE_RATIO,
}) {
  const target = Number(targetUsd) || 0;
  const weight = Number(weightToken0Pct) / 100;
  const needUsd = { token0: target * weight * buffer, token1: target * (1 - weight) * buffer };
  const haveUsd = { token0: 0, token1: 0 };
  let otherLocalUsd = 0;

  for (const asset of localAssets) {
    const value = Number(asset.usableUsd);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (isDirectFor(asset, token0, wrappedNativeAddress)) haveUsd.token0 += value;
    else if (isDirectFor(asset, token1, wrappedNativeAddress)) haveUsd.token1 += value;
    else otherLocalUsd += value;
  }

  const localUsableUsd = haveUsd.token0 + haveUsd.token1 + otherLocalUsd;
  const needsCrossChain = localUsableUsd < target * minDeployableRatio;
  const shortfall = {
    token0: Math.max(0, needUsd.token0 - haveUsd.token0),
    token1: Math.max(0, needUsd.token1 - haveUsd.token1),
  };
  const totalShortfall = shortfall.token0 + shortfall.token1;
  const totalDeficitUsd = needsCrossChain
    ? Math.max(0, needUsd.token0 + needUsd.token1 - localUsableUsd)
    : 0;
  const share = (side) => (totalShortfall > 0 ? (shortfall[side] / totalShortfall) * totalDeficitUsd : 0);

  return {
    needUsd,
    haveUsd,
    otherLocalUsd,
    localUsableUsd,
    deficitUsd: { token0: share('token0'), token1: share('token1') },
    totalDeficitUsd,
    needsCrossChain,
  };
}

function deliveryTokenFor(token, { wrappedNativeAddress = null, nativeSymbol = 'ETH' } = {}) {
  if (isNativeSide(token, wrappedNativeAddress)) {
    return { address: ZERO_ADDRESS, symbol: nativeSymbol, decimals: 18, isNative: true };
  }
  return { address: token.address, symbol: token.symbol, decimals: Number(token.decimals), isNative: false };
}

module.exports = { computeSideDeficits, deliveryTokenFor, isDirectFor, ZERO_ADDRESS };
