/**
 * Precio USD por símbolo para el planificador cross-chain.
 *
 * Mismo criterio que `getUsdPriceForSymbol` del creador de pools (estables a
 * 1, envueltos como su nativo), copiado aquí porque ese servicio está en el
 * trinquete de tamaño y no exporta el helper.
 */

const { isStableSymbol } = require('../uniswap/pricing');

const WRAPPED_EQUIVALENTS = {
  WETH: 'ETH',
  WPOL: 'POL',
  WMATIC: 'MATIC',
};

function usdPriceForSymbol(symbol, prices = {}) {
  const upper = String(symbol || '').trim().toUpperCase();
  if (!upper) return null;
  if (isStableSymbol(upper)) return 1;
  const normalized = WRAPPED_EQUIVALENTS[upper] || upper;
  const candidates = normalized === 'POL' ? ['POL', 'MATIC'] : normalized === 'MATIC' ? ['MATIC', 'POL'] : [normalized];
  for (const key of candidates) {
    const numeric = Number(prices?.[key]);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return null;
}

module.exports = { usdPriceForSymbol };
