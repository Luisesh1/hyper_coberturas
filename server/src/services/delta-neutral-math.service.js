const STABLE_SYMBOLS = new Set([
  'USDC',
  'USDC.E',
  'USDBC',
  'USDT',
  'USDT0',
  'USD₮0',
  'DAI',
  'LUSD',
  'FDUSD',
  'USDE',
]);

const WRAPPED_TOKEN_EQUIVALENTS = new Map([
  ['WBTC', 'BTC'],
  ['WETH', 'ETH'],
]);

function normalizeSymbol(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  return WRAPPED_TOKEN_EQUIVALENTS.get(normalized) || normalized;
}

function isStableSymbol(symbol) {
  return STABLE_SYMBOLS.has(normalizeSymbol(symbol));
}

function asFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getTokenDecimals(token, fallback = 18) {
  const parsed = Number(token?.decimals);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function tickToRawSqrtRatio(tick) {
  return Math.pow(1.0001, Number(tick) / 2);
}

function sqrtPriceX96ToFloat(sqrtPriceX96) {
  const numeric = Number(sqrtPriceX96);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric / (2 ** 96);
}

function compactNumber(value, digits = 8) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

function liquidityToTokenAmounts({
  liquidity,
  sqrtPriceX96,
  tickCurrent,
  tickLower,
  tickUpper,
  token0Decimals,
  token1Decimals,
}) {
  const liquidityFloat = Number(liquidity);
  const sqrtCurrent = sqrtPriceX96 != null
    ? sqrtPriceX96ToFloat(sqrtPriceX96)
    : tickCurrent != null
      ? tickToRawSqrtRatio(tickCurrent)
      : null;
  const sqrtLower = tickToRawSqrtRatio(tickLower);
  const sqrtUpper = tickToRawSqrtRatio(tickUpper);

  if (
    !Number.isFinite(liquidityFloat)
    || liquidityFloat <= 0
    || !Number.isFinite(sqrtCurrent)
    || !Number.isFinite(sqrtLower)
    || !Number.isFinite(sqrtUpper)
    || sqrtLower <= 0
    || sqrtUpper <= 0
  ) {
    return {
      amount0: null,
      amount1: null,
    };
  }

  const lower = Math.min(sqrtLower, sqrtUpper);
  const upper = Math.max(sqrtLower, sqrtUpper);
  let amount0Raw = 0;
  let amount1Raw = 0;

  if (sqrtCurrent <= lower) {
    amount0Raw = liquidityFloat * ((upper - lower) / (lower * upper));
  } else if (sqrtCurrent < upper) {
    amount0Raw = liquidityFloat * ((upper - sqrtCurrent) / (sqrtCurrent * upper));
    amount1Raw = liquidityFloat * (sqrtCurrent - lower);
  } else {
    amount1Raw = liquidityFloat * (upper - lower);
  }

  return {
    amount0: compactNumber(amount0Raw / (10 ** token0Decimals), 8),
    amount1: compactNumber(amount1Raw / (10 ** token1Decimals), 8),
  };
}

function priceToSqrtPriceX96(priceQuotePerBase, token0Decimals, token1Decimals) {
  const price = Number(priceQuotePerBase);
  if (!Number.isFinite(price) || price <= 0) return null;
  const rawSqrt = Math.sqrt(price * (10 ** (token1Decimals - token0Decimals)));
  if (!Number.isFinite(rawSqrt) || rawSqrt <= 0) return null;
  return String(rawSqrt * (2 ** 96));
}

function resolveDeltaNeutralOrientation(snapshot) {
  const token0Symbol = normalizeSymbol(snapshot?.token0?.symbol || snapshot?.token0Symbol);
  const token1Symbol = normalizeSymbol(snapshot?.token1?.symbol || snapshot?.token1Symbol);
  const token0Stable = isStableSymbol(token0Symbol);
  const token1Stable = isStableSymbol(token1Symbol);
  const token0Supported = !!token0Symbol && !token0Stable;
  const token1Supported = !!token1Symbol && !token1Stable;

  if (token0Stable === token1Stable) {
    return {
      eligible: false,
      reason: token0Stable
        ? 'El pool tiene dos tokens estables; no necesita overlay delta-neutral.'
        : 'El pool no es stable + 1 volatil, por lo que el overlay delta-neutral v1 no aplica.',
    };
  }

  if (token0Stable && token1Supported) {
    return {
      eligible: true,
      stableTokenIndex: 0,
      volatileTokenIndex: 1,
      stableTokenSymbol: token0Symbol,
      volatileTokenSymbol: token1Symbol,
    };
  }

  if (token1Stable && token0Supported) {
    return {
      eligible: true,
      stableTokenIndex: 1,
      volatileTokenIndex: 0,
      stableTokenSymbol: token1Symbol,
      volatileTokenSymbol: token0Symbol,
    };
  }

  return {
    eligible: false,
    reason: 'No se pudo resolver la orientacion stable/volatil del pool.',
  };
}

function getCurrentVolatilePriceUsd(snapshot, orientation) {
  const currentPrice = Number(snapshot?.priceCurrent);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;
  return orientation.volatileTokenIndex === 0
    ? currentPrice
    : 1 / currentPrice;
}

function quotePriceFromVolatileUsd(volatilePriceUsd, orientation) {
  const price = Number(volatilePriceUsd);
  if (!Number.isFinite(price) || price <= 0) return null;
  return orientation.volatileTokenIndex === 0
    ? price
    : 1 / price;
}

function calculatePoolValueAtPrice(snapshot, orientation, volatilePriceUsd) {
  const token0Decimals = getTokenDecimals(snapshot?.token0);
  const token1Decimals = getTokenDecimals(snapshot?.token1);
  const priceQuotePerBase = quotePriceFromVolatileUsd(volatilePriceUsd, orientation);
  const sqrtPriceX96 = priceToSqrtPriceX96(priceQuotePerBase, token0Decimals, token1Decimals);
  if (!sqrtPriceX96) return null;

  const amounts = liquidityToTokenAmounts({
    liquidity: snapshot?.liquidity,
    sqrtPriceX96,
    tickLower: snapshot?.tickLower,
    tickUpper: snapshot?.tickUpper,
    token0Decimals,
    token1Decimals,
  });

  const amount0 = Number(amounts.amount0);
  const amount1 = Number(amounts.amount1);
  if (!Number.isFinite(amount0) || !Number.isFinite(amount1)) return null;

  const stableAmount = orientation.stableTokenIndex === 0 ? amount0 : amount1;
  const volatileAmount = orientation.volatileTokenIndex === 0 ? amount0 : amount1;
  const feesStable = orientation.stableTokenIndex === 0
    ? Number(snapshot?.unclaimedFees0 || 0)
    : Number(snapshot?.unclaimedFees1 || 0);
  const feesVolatile = orientation.volatileTokenIndex === 0
    ? Number(snapshot?.unclaimedFees0 || 0)
    : Number(snapshot?.unclaimedFees1 || 0);

  return {
    stableAmount: stableAmount + (Number.isFinite(feesStable) ? feesStable : 0),
    volatileAmount: volatileAmount + (Number.isFinite(feesVolatile) ? feesVolatile : 0),
    poolValueUsd: stableAmount + (Number.isFinite(feesStable) ? feesStable : 0)
      + ((volatileAmount + (Number.isFinite(feesVolatile) ? feesVolatile : 0)) * volatilePriceUsd),
  };
}

function computeDeltaNeutralMetrics(snapshot, {
  volatilePriceUsd,
  targetHedgeRatio = 1,
  epsilonPct = 0.001,
} = {}) {
  const orientation = resolveDeltaNeutralOrientation(snapshot);
  if (!orientation.eligible) {
    return {
      eligible: false,
      reason: orientation.reason,
    };
  }

  const referencePrice = asFiniteNumber(volatilePriceUsd) || getCurrentVolatilePriceUsd(snapshot, orientation);
  if (!referencePrice || referencePrice <= 0) {
    return {
      eligible: false,
      reason: 'No se pudo resolver el precio actual del activo volatil.',
    };
  }

  const center = calculatePoolValueAtPrice(snapshot, orientation, referencePrice);
  if (!center) {
    return {
      eligible: false,
      reason: 'No se pudo calcular la valuacion del LP para delta-neutral.',
    };
  }

  const step = Math.max(referencePrice * epsilonPct, referencePrice * 0.0001, 1e-8);
  const up = calculatePoolValueAtPrice(snapshot, orientation, referencePrice + step);
  const down = calculatePoolValueAtPrice(snapshot, orientation, Math.max(referencePrice - step, referencePrice * 0.1));
  if (!up || !down) {
    return {
      eligible: false,
      reason: 'No se pudo derivar delta/gamma del LP.',
    };
  }

  const deltaQty = (up.poolValueUsd - down.poolValueUsd) / ((referencePrice + step) - Math.max(referencePrice - step, referencePrice * 0.1));
  const gamma = (up.poolValueUsd - (2 * center.poolValueUsd) + down.poolValueUsd) / (step ** 2);
  const targetQty = Math.max(0, deltaQty * Number(targetHedgeRatio || 1));
  const hedgeNotionalUsd = targetQty * referencePrice;
  const normalizedGamma = Math.abs(gamma) * referencePrice / Math.max(Math.abs(deltaQty), 1e-9);

  return {
    eligible: true,
    orientation,
    volatilePriceUsd: referencePrice,
    stableAmount: center.stableAmount,
    volatileAmount: center.volatileAmount,
    poolValueUsd: center.poolValueUsd,
    deltaQty,
    gamma,
    normalizedGamma,
    targetQty,
    hedgeNotionalUsd,
  };
}

function buildBandPreset(effectiveRvPct) {
  const rv = Number(effectiveRvPct);
  if (!Number.isFinite(rv)) {
    return { priceMovePct: 3, intervalSec: 21600, preset: 'balanced' };
  }
  if (rv < 40) {
    return { priceMovePct: 5, intervalSec: 43200, preset: 'conservative' };
  }
  if (rv < 80) {
    return { priceMovePct: 3, intervalSec: 21600, preset: 'balanced' };
  }
  return { priceMovePct: 1, intervalSec: 3600, preset: 'aggressive' };
}

function networkSentinelIntervalMs(network) {
  return String(network || '').toLowerCase() === 'ethereum' ? 12_000 : 2_000;
}

module.exports = {
  asFiniteNumber,
  buildBandPreset,
  computeDeltaNeutralMetrics,
  getCurrentVolatilePriceUsd,
  isStableSymbol,
  networkSentinelIntervalMs,
  normalizeSymbol,
  resolveDeltaNeutralOrientation,
};
