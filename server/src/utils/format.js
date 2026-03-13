/**
 * format.js — Shared formatting utilities for Hyperliquid wire protocol
 */

/**
 * Formats a price to Hyperliquid's 5 significant figures wire format.
 */
function formatPrice(price) {
  if (!price || price <= 0) return '0';
  const d = Math.ceil(Math.log10(Math.abs(price)));
  const power = 5 - d;
  const magnitude = Math.pow(10, power);
  const rounded = Math.round(price * magnitude) / magnitude;
  return power > 0 ? rounded.toFixed(power) : rounded.toString();
}

/**
 * Formats a size to the asset's decimal precision, truncating (not rounding).
 */
function formatSize(size, szDecimals) {
  const numericSize = parseFloat(size);
  if (!Number.isFinite(numericSize) || numericSize <= 0) {
    return (0).toFixed(szDecimals);
  }

  const [integerPart, fractionalPart = ''] = numericSize
    .toFixed(szDecimals + 8)
    .split('.');

  return `${integerPart}.${fractionalPart.slice(0, szDecimals).padEnd(szDecimals, '0')}`;
}

/**
 * Compares two numeric values within an epsilon tolerance.
 */
function numericEqual(a, b, epsilon = 1e-8) {
  return Math.abs(parseFloat(a) - parseFloat(b)) < epsilon;
}

module.exports = { formatPrice, formatSize, numericEqual };
