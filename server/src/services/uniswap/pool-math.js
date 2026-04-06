/**
 * Funciones matemáticas auxiliares para Uniswap V3 (cálculos sobre ticks,
 * sqrt prices, liquidez, distancia a rango, P&L).
 *
 * Extraído de `uniswap.service.js` para reducir tamaño y permitir reutilización.
 */

const Q96 = 2 ** 96;

function compactNumber(value, digits = 6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function tickToPrice(tick, token0Decimals, token1Decimals) {
  const decimalDelta = token0Decimals - token1Decimals;
  return Math.pow(1.0001, Number(tick)) * Math.pow(10, decimalDelta);
}

function tickToRawSqrtRatio(tick) {
  return Math.pow(1.0001, Number(tick) / 2);
}

function sqrtPriceX96ToFloat(sqrtPriceX96) {
  const numeric = Number(sqrtPriceX96);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric / Q96;
}

/**
 * Calcula los `amount0` y `amount1` que corresponden a `liquidity` dado el
 * tick actual y el rango (tickLower, tickUpper). Es la inversa de
 * `estimateLiquidityForAmounts`.
 */
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
    !Number.isFinite(liquidityFloat) ||
    liquidityFloat <= 0 ||
    !Number.isFinite(sqrtCurrent) ||
    !Number.isFinite(sqrtLower) ||
    !Number.isFinite(sqrtUpper) ||
    sqrtLower <= 0 ||
    sqrtUpper <= 0
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

/**
 * Calcula la distancia (en precio absoluto y en %) del precio actual al rango.
 * Si el precio está dentro del rango devuelve cero. Si está fuera devuelve la
 * distancia absoluta y relativa al borde más cercano.
 */
function computeDistanceToRange(rangeLowerPrice, rangeUpperPrice, priceCurrent) {
  const lower = Number(rangeLowerPrice);
  const upper = Number(rangeUpperPrice);
  const current = Number(priceCurrent);

  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(current) || lower === upper) {
    return {
      distanceToRangePct: null,
      distanceToRangePrice: null,
    };
  }

  const min = Math.min(lower, upper);
  const max = Math.max(lower, upper);

  if (current >= min && current <= max) {
    return {
      distanceToRangePct: 0,
      distanceToRangePrice: 0,
    };
  }

  if (current < min) {
    const delta = min - current;
    return {
      distanceToRangePrice: compactNumber(delta, 6),
      distanceToRangePct: current > 0 ? compactNumber((delta / min) * 100, 4) : null,
    };
  }

  const delta = current - max;
  return {
    distanceToRangePrice: compactNumber(delta, 6),
    distanceToRangePct: compactNumber((delta / max) * 100, 4),
  };
}

/**
 * Calcula métricas de P&L total y rendimiento porcentual.
 */
function computePnlMetrics(initialValueUsd, currentValueUsd, unclaimedFeesUsd) {
  const initial = Number(initialValueUsd);
  const current = Number(currentValueUsd);
  const fees = Number(unclaimedFeesUsd);

  if (!Number.isFinite(initial) || !Number.isFinite(current) || !Number.isFinite(fees) || initial <= 0) {
    return {
      pnlTotalUsd: null,
      pnlTotalPct: null,
      yieldPct: null,
    };
  }

  const pnlTotalUsd = compactNumber(current + fees - initial, 2);
  const pnlTotalPct = compactNumber((pnlTotalUsd / initial) * 100, 4);

  return {
    pnlTotalUsd,
    pnlTotalPct,
    yieldPct: pnlTotalPct,
  };
}

module.exports = {
  Q96,
  compactNumber,
  tickToPrice,
  tickToRawSqrtRatio,
  sqrtPriceX96ToFloat,
  liquidityToTokenAmounts,
  computeDistanceToRange,
  computePnlMetrics,
};
