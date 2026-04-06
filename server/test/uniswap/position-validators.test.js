const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validatePriceRange,
  validateTickRange,
  validateTokenPair,
  validateWeightPct,
  validateSlippageBps,
  validateLiquidityDelta,
} = require('../../src/services/uniswap/position-validators');
const { ValidationError } = require('../../src/errors/app-error');

test('validatePriceRange acepta un rango válido', () => {
  const result = validatePriceRange(1500, 2500);
  assert.deepEqual(result, { lowerPrice: 1500, upperPrice: 2500 });
});

test('validatePriceRange convierte strings numéricos', () => {
  const result = validatePriceRange('1500', '2500.5');
  assert.equal(result.lowerPrice, 1500);
  assert.equal(result.upperPrice, 2500.5);
});

test('validatePriceRange rechaza lower >= upper', () => {
  assert.throws(() => validatePriceRange(2500, 1500), ValidationError);
  assert.throws(() => validatePriceRange(2500, 2500), ValidationError);
});

test('validatePriceRange rechaza valores no positivos', () => {
  assert.throws(() => validatePriceRange(0, 100), ValidationError);
  assert.throws(() => validatePriceRange(-1, 100), ValidationError);
});

test('validatePriceRange rechaza NaN/Infinity', () => {
  assert.throws(() => validatePriceRange('abc', 100), ValidationError);
  assert.throws(() => validatePriceRange(100, Infinity), ValidationError);
});

test('validatePriceRange usa el label en el mensaje', () => {
  try {
    validatePriceRange(2500, 1500, 'rebalance');
    assert.fail('debería haber lanzado');
  } catch (err) {
    assert.match(err.message, /rebalance/);
  }
});

test('validateTickRange acepta ticks válidos', () => {
  assert.doesNotThrow(() => validateTickRange(-1000, 1000));
});

test('validateTickRange rechaza ticks no enteros', () => {
  assert.throws(() => validateTickRange(1.5, 100), ValidationError);
});

test('validateTickRange rechaza tickLower >= tickUpper', () => {
  assert.throws(() => validateTickRange(100, 100), ValidationError);
  assert.throws(() => validateTickRange(200, 100), ValidationError);
});

test('validateTokenPair rechaza tokens iguales (case-insensitive)', () => {
  assert.throws(
    () => validateTokenPair('0xABCdef', '0xabcDEF'),
    ValidationError,
  );
});

test('validateTokenPair acepta tokens distintos', () => {
  assert.doesNotThrow(() => validateTokenPair('0xAAA', '0xBBB'));
});

test('validateTokenPair rechaza valores vacíos', () => {
  assert.throws(() => validateTokenPair('', '0xBBB'), ValidationError);
  assert.throws(() => validateTokenPair('0xAAA', null), ValidationError);
});

test('validateWeightPct acepta valores entre 0 y 100', () => {
  assert.equal(validateWeightPct(50), 50);
  assert.equal(validateWeightPct('25.5'), 25.5);
});

test('validateWeightPct rechaza valores fuera de rango', () => {
  assert.throws(() => validateWeightPct(0), ValidationError);
  assert.throws(() => validateWeightPct(100), ValidationError);
  assert.throws(() => validateWeightPct(-1), ValidationError);
  assert.throws(() => validateWeightPct(101), ValidationError);
});

test('validateSlippageBps usa default cuando es undefined', () => {
  assert.equal(validateSlippageBps(undefined), 100);
  assert.equal(validateSlippageBps(undefined, { defaultBps: 50 }), 50);
});

test('validateSlippageBps acepta enteros válidos', () => {
  assert.equal(validateSlippageBps(50), 50);
  assert.equal(validateSlippageBps('200'), 200);
});

test('validateSlippageBps rechaza decimales y valores fuera de rango', () => {
  assert.throws(() => validateSlippageBps(0.5), ValidationError);
  assert.throws(() => validateSlippageBps(-1), ValidationError);
  assert.throws(() => validateSlippageBps(6000), ValidationError);
});

test('validateLiquidityDelta convierte a BigInt y valida positivo', () => {
  assert.equal(validateLiquidityDelta('1000'), 1000n);
  assert.equal(validateLiquidityDelta(500n), 500n);
});

test('validateLiquidityDelta rechaza cero o negativo', () => {
  assert.throws(() => validateLiquidityDelta(0n), ValidationError);
  assert.throws(() => validateLiquidityDelta('-100'), ValidationError);
});

test('validateLiquidityDelta rechaza valores no convertibles', () => {
  assert.throws(() => validateLiquidityDelta('abc'), ValidationError);
});
