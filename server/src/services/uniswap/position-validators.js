/**
 * Validadores compartidos para acciones sobre posiciones de Uniswap.
 *
 * Estas funciones reemplazan patrones de validación duplicados que aparecían
 * múltiples veces en `uniswap-position-actions.service.js`. Cada validador
 * lanza una `ValidationError` con un mensaje consistente y, cuando aplica,
 * detalles estructurados para el cliente.
 */

const { ValidationError } = require('../../errors/app-error');

/**
 * Valida que un par de precios forme un rango válido (bajo > 0 y alto > bajo).
 * Reemplaza el patrón:
 *   if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower <= 0 || upper <= lower) {
 *     throw new ValidationError('El rango nuevo es invalido');
 *   }
 *
 * @param {number|string} lowerPrice
 * @param {number|string} upperPrice
 * @param {string} [label='rango'] - Identificador legible para el mensaje de error.
 * @returns {{ lowerPrice: number, upperPrice: number }}
 * @throws {ValidationError}
 */
function validatePriceRange(lowerPrice, upperPrice, label = 'rango') {
  const lower = Number(lowerPrice);
  const upper = Number(upperPrice);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower <= 0 || upper <= lower) {
    throw new ValidationError(`El ${label} nuevo es invalido`, {
      lowerPrice,
      upperPrice,
    });
  }
  return { lowerPrice: lower, upperPrice: upper };
}

/**
 * Valida que dos ticks formen un rango ascendente.
 *
 * @param {number} tickLower
 * @param {number} tickUpper
 * @param {string} [label='rango']
 * @throws {ValidationError}
 */
function validateTickRange(tickLower, tickUpper, label = 'rango') {
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper)) {
    throw new ValidationError(`El ${label} nuevo genera ticks invalidos`, { tickLower, tickUpper });
  }
  if (tickLower >= tickUpper) {
    throw new ValidationError(`El ${label} nuevo genera ticks invalidos`, { tickLower, tickUpper });
  }
}

/**
 * Valida que dos addresses ERC20 sean distintos (case-insensitive).
 *
 * @param {string} token0Address
 * @param {string} token1Address
 * @throws {ValidationError}
 */
function validateTokenPair(token0Address, token1Address) {
  if (!token0Address || !token1Address) {
    throw new ValidationError('Direcciones de tokens requeridas', {
      token0Address,
      token1Address,
    });
  }
  if (String(token0Address).toLowerCase() === String(token1Address).toLowerCase()) {
    throw new ValidationError('Los tokens del par deben ser distintos', {
      token0Address,
      token1Address,
    });
  }
}

/**
 * Valida un porcentaje (0 < value < 100) usado en pesos de portfolio.
 *
 * @param {number|string} value
 * @param {string} [field='targetWeightToken0Pct']
 * @returns {number}
 * @throws {ValidationError}
 */
function validateWeightPct(value, field = 'targetWeightToken0Pct') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 100) {
    throw new ValidationError(`${field} debe estar entre 0 y 100`, { value });
  }
  return numeric;
}

/**
 * Valida un valor de slippage en basis points (1-5000).
 *
 * @param {number|string|undefined} value
 * @param {object} [options]
 * @param {number} [options.defaultBps=100]
 * @param {number} [options.maxBps=5000]
 * @returns {number}
 * @throws {ValidationError}
 */
function validateSlippageBps(value, { defaultBps = 100, maxBps = 5000 } = {}) {
  if (value == null || value === '') return defaultBps;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > maxBps) {
    throw new ValidationError('slippageBps invalido', { value, maxBps });
  }
  return numeric;
}

/**
 * Valida un delta de liquidez (BigInt o convertible a BigInt) y devuelve BigInt.
 *
 * @param {bigint|number|string} value
 * @param {string} [field='liquidityDelta']
 * @returns {bigint}
 * @throws {ValidationError}
 */
function validateLiquidityDelta(value, field = 'liquidityDelta') {
  try {
    const big = BigInt(value);
    if (big <= 0n) {
      throw new ValidationError(`${field} debe ser positivo`, { value: String(value) });
    }
    return big;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(`${field} invalido`, { value: String(value) });
  }
}

module.exports = {
  validatePriceRange,
  validateTickRange,
  validateTokenPair,
  validateWeightPct,
  validateSlippageBps,
  validateLiquidityDelta,
};
