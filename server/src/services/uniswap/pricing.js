/**
 * Helpers para identificar tokens stable y estimar valores en USD a partir
 * de pares de tokens.
 *
 * Extraído de `uniswap.service.js`.
 */

const { compactNumber } = require('./pool-math');

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

function isStableSymbol(symbol) {
  return STABLE_SYMBOLS.has(String(symbol || '').toUpperCase());
}

/**
 * Estimación gruesa de TVL en USD para un par de reservas.
 * - Si ambos tokens son stables: suma las reservas.
 * - Si uno es stable: duplica el valor del lado stable (asume 50/50).
 * - Si ninguno es stable: devuelve null.
 */
function estimateTvlApproxUsd(token0, amount0, token1, amount1) {
  const reserve0 = Number(amount0);
  const reserve1 = Number(amount1);

  if (!Number.isFinite(reserve0) || !Number.isFinite(reserve1)) return null;
  if (reserve0 <= 0 && reserve1 <= 0) return null;

  const stable0 = isStableSymbol(token0.symbol);
  const stable1 = isStableSymbol(token1.symbol);

  if (stable0 && stable1) return compactNumber(reserve0 + reserve1, 2);
  if (stable0) return compactNumber(reserve0 * 2, 2);
  if (stable1) return compactNumber(reserve1 * 2, 2);
  return null;
}

/**
 * Estima el valor en USD de un par (amount0, amount1) usando un precio de
 * conversión `priceQuotePerBase` (token1/token0).
 *
 * - Si ambos tokens son stables, suma directamente.
 * - Si solo uno es stable, usa el precio para convertir el otro.
 * - Si ninguno es stable, devuelve null.
 */
function estimateUsdValueFromPair(token0, token1, amount0, amount1, priceQuotePerBase) {
  const a0 = Number(amount0);
  const a1 = Number(amount1);
  const price = Number(priceQuotePerBase);

  if (!Number.isFinite(a0) || !Number.isFinite(a1)) return null;

  const stable0 = isStableSymbol(token0?.symbol);
  const stable1 = isStableSymbol(token1?.symbol);

  if (stable0 && stable1) return compactNumber(a0 + a1, 2);
  if (stable1 && Number.isFinite(price) && price > 0) {
    return compactNumber(a1 + (a0 * price), 2);
  }
  if (stable0 && Number.isFinite(price) && price > 0) {
    return compactNumber(a0 + (a1 / price), 2);
  }
  return null;
}

module.exports = {
  STABLE_SYMBOLS,
  isStableSymbol,
  estimateTvlApproxUsd,
  estimateUsdValueFromPair,
};
