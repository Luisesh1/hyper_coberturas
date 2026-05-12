const test = require('node:test');
const assert = require('node:assert/strict');

const lib = require('../src/services/indicator-library');
const { computeRoles, evaluateCondition } = require('../src/services/alerts/indicator-evaluator');

function makeCandles(length = 80) {
  return Array.from({ length }, (_, i) => {
    const close = 100 + Math.sin(i / 4) * 3 + i * 0.08 + (i > 74 ? (i - 74) * 4 : 0);
    return {
      time: 1700000000000 + i * 86_400_000,
      closeTime: 1700000000000 + (i + 1) * 86_400_000 - 1,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 100,
    };
  });
}

function makeFlatCandles(length = 3) {
  return Array.from({ length }, (_, i) => ({
    time: 1700000000000 + i * 86_400_000,
    closeTime: 1700000000000 + (i + 1) * 86_400_000 - 1,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
  }));
}

function withMockSqzmom(momentum, callback) {
  const original = lib.sqzmom;
  lib.sqzmom = () => ({
    momentum,
    normalUpper: momentum.map(() => null),
    normalMiddle: momentum.map(() => null),
    normalLower: momentum.map(() => null),
    sqzState: momentum.map(() => 'off'),
  });
  try {
    return callback();
  } finally {
    lib.sqzmom = original;
  }
}

function evaluateSqzmomRedirect(operator, momentum) {
  return withMockSqzmom(momentum, () => evaluateCondition({
    indicatorType: 'sqzmom',
    indicatorParams: {},
    timeframe: '1d',
    operandSeries: 'sqzMomentum',
    operator,
    operand: { kind: 'none' },
  }, { '1d': makeFlatCandles(momentum.length) }));
}

test('SQZMOM expone bandas normales para reglas de alertas', () => {
  const params = {
    length: 20,
    lengthKC: 20,
    multKC: 1.5,
    useTrueRange: true,
    normalBandLength: 5,
    normalBandSigma: 1,
  };
  const roles = computeRoles('sqzmom', makeCandles(), params);

  assert.deepEqual(Object.keys(roles), [
    'sqzMomentum',
    'normalUpper',
    'normalMiddle',
    'normalLower',
    'sqzState',
  ]);
  assert.ok(Number.isFinite(roles.sqzMomentum.at(-1)));
  assert.ok(Number.isFinite(roles.normalUpper.at(-1)));
  assert.ok(Number.isFinite(roles.normalLower.at(-1)));
});

test('SQZMOM permite comparar momentum contra banda superior normal', () => {
  const params = {
    length: 20,
    lengthKC: 20,
    multKC: 1.5,
    useTrueRange: true,
    normalBandLength: 5,
    normalBandSigma: 1,
  };
  const candles = makeCandles();
  const result = evaluateCondition({
    indicatorType: 'sqzmom',
    indicatorParams: params,
    timeframe: '1d',
    operandSeries: 'sqzMomentum',
    operator: '>',
    operand: {
      kind: 'series',
      indicatorType: 'sqzmom',
      indicatorParams: params,
      timeframe: '1d',
      operandSeries: 'normalUpper',
    },
  }, { '1d': candles });

  assert.equal(result.matched, true);
  assert.ok(result.value > result.threshold);
});

test('SQZMOM detecta redirección alcista del momentum', () => {
  const result = evaluateSqzmomRedirect('momentum_redirect_bullish', [3, 1, 2]);

  assert.equal(result.matched, true);
  assert.equal(result.value, 2);
  assert.equal(result.threshold, 1);
  assert.match(result.reason, /redirección alcista/);
});

test('SQZMOM detecta redirección bajista del momentum', () => {
  const result = evaluateSqzmomRedirect('momentum_redirect_bearish', [1, 3, 2]);

  assert.equal(result.matched, true);
  assert.equal(result.value, 2);
  assert.equal(result.threshold, 3);
  assert.match(result.reason, /redirección bajista/);
});

test('SQZMOM no dispara redirección si momentum solo sube o solo baja', () => {
  const bullishTrend = evaluateSqzmomRedirect('momentum_redirect_bullish', [1, 2, 3]);
  const bearishTrend = evaluateSqzmomRedirect('momentum_redirect_bearish', [3, 2, 1]);

  assert.equal(bullishTrend.matched, false);
  assert.equal(bearishTrend.matched, false);
});

test('SQZMOM no dispara redirección sin tres valores válidos de momentum', () => {
  const tooShort = evaluateSqzmomRedirect('momentum_redirect_bullish', [1, 2]);
  const withNull = evaluateSqzmomRedirect('momentum_redirect_bearish', [1, null, 2]);

  assert.equal(tooShort.matched, false);
  assert.equal(tooShort.reason, 'momentum no disponible');
  assert.equal(withNull.matched, false);
  assert.equal(withNull.reason, 'momentum no disponible');
});
