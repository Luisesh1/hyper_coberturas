/**
 * Funciones matemáticas para cálculos de Uniswap V3:
 * - Conversión precio ↔ tick
 * - Estimación de liquidez para montos
 * - Helpers numéricos varios
 */

const { ethers } = require('ethers');
const { ValidationError } = require('../../errors/app-error');
// OJO: `position-action-math` NO exporta tickToRawSqrtRatio — importarlo de
// ahi dejaba `undefined` y reventaba con "is not a function" en el primer
// mint v4 (unico camino que llama a estimateLiquidityForAmounts).
const { sqrtPriceX96ToFloat, tickToRawSqrtRatio } = require('./pool-math');

/**
 * Convierte un precio (en token1/token0) al tick más cercano según el spacing
 * del pool. La dirección puede ser 'down', 'up' o 'nearest'.
 */
function priceToNearestTick(price, token0Decimals, token1Decimals, tickSpacing, direction = 'nearest') {
  const numeric = Number(price);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new ValidationError('Precio de rango invalido');
  }

  const decimalDelta = token0Decimals - token1Decimals;
  const rawTick = Math.log(numeric / (10 ** decimalDelta)) / Math.log(1.0001);
  const spacing = Number(tickSpacing);
  if (!Number.isFinite(spacing) || spacing <= 0) {
    throw new ValidationError('tickSpacing invalido');
  }

  if (direction === 'down') return Math.floor(rawTick / spacing) * spacing;
  if (direction === 'up') return Math.ceil(rawTick / spacing) * spacing;
  return Math.round(rawTick / spacing) * spacing;
}

function isZeroAddress(value) {
  return String(value || '').toLowerCase() === ethers.ZeroAddress.toLowerCase();
}

/**
 * Convierte un valor a `Number` (float) intentando varios formatos. Útil para
 * manejar tanto BigInt como strings hex / decimales.
 */
function amountToNumber(rawAmount) {
  const numeric = Number(rawAmount);
  if (Number.isFinite(numeric)) return numeric;
  try {
    return Number(rawAmount.toString());
  } catch {
    return 0;
  }
}

/**
 * Estima la liquidez (en unidades L) que produciría depositar `amount0Raw` y
 * `amount1Raw` en un rango (tickLower, tickUpper) dado el tick actual.
 *
 * Devuelve `BigInt(L)` listo para usar como `liquidity` en mints V4.
 */
function estimateLiquidityForAmounts({
  amount0Raw,
  amount1Raw,
  tickCurrent,
  sqrtPriceX96,
  tickLower,
  tickUpper,
}) {
  // `slot0.tick` identifica el tick activo, pero no la posicion exacta del
  // precio dentro de ese tick. En rangos estrechos perder esa fraccion puede
  // cambiar el monto requerido de un lado mas que el slippage permitido. El
  // PositionManager usa `sqrtPriceX96`, asi que cuando esta disponible la
  // estimacion del mint debe partir del mismo valor exacto.
  const exactSqrtCurrent = sqrtPriceX96 != null
    ? sqrtPriceX96ToFloat(sqrtPriceX96)
    : null;
  const sqrtCurrent = Number.isFinite(exactSqrtCurrent) && exactSqrtCurrent > 0
    ? exactSqrtCurrent
    : tickToRawSqrtRatio(tickCurrent);
  const sqrtLower = tickToRawSqrtRatio(tickLower);
  const sqrtUpper = tickToRawSqrtRatio(tickUpper);
  if (
    !Number.isFinite(sqrtCurrent) ||
    !Number.isFinite(sqrtLower) ||
    !Number.isFinite(sqrtUpper) ||
    sqrtLower <= 0 ||
    sqrtUpper <= 0
  ) {
    throw new ValidationError('No se pudo estimar la liquidez del rango seleccionado');
  }

  const lower = Math.min(sqrtLower, sqrtUpper);
  const upper = Math.max(sqrtLower, sqrtUpper);
  const amount0 = amountToNumber(amount0Raw);
  const amount1 = amountToNumber(amount1Raw);
  let liquidity = 0;

  if (sqrtCurrent <= lower) {
    liquidity = amount0 * ((lower * upper) / (upper - lower));
  } else if (sqrtCurrent < upper) {
    const liquidity0 = amount0 * ((sqrtCurrent * upper) / (upper - sqrtCurrent));
    const liquidity1 = amount1 / (sqrtCurrent - lower);
    liquidity = Math.min(liquidity0, liquidity1);
  } else {
    liquidity = amount1 / (upper - lower);
  }

  if (!Number.isFinite(liquidity) || liquidity <= 0) {
    throw new ValidationError('Los montos elegidos no generan liquidez util para este rango');
  }

  return BigInt(Math.max(1, Math.floor(liquidity)));
}

module.exports = {
  priceToNearestTick,
  isZeroAddress,
  amountToNumber,
  estimateLiquidityForAmounts,
};
