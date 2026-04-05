const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeSegmentFromCandles,
  computeTimeInRangeBatch,
  normalizeEpochMs,
  resolveTrackableAsset,
  shouldInvertPrice,
} = require('../src/services/time-in-range.service');

test('normalizeEpochMs soporta segundos y milisegundos', () => {
  assert.equal(normalizeEpochMs(1710000000), 1710000000000);
  assert.equal(normalizeEpochMs(1710000000000), 1710000000000);
});

test('resolveTrackableAsset infiere el activo volatil cuando el otro lado es stable', () => {
  assert.equal(resolveTrackableAsset({
    token0: { symbol: 'WBTC' },
    token1: { symbol: 'USDC' },
  }), 'BTC');
});

test('shouldInvertPrice detecta pools cotizados al reves', () => {
  assert.equal(shouldInvertPrice({
    token0: { symbol: 'USDC' },
    token1: { symbol: 'WETH' },
  }, 'ETH'), true);
  assert.equal(shouldInvertPrice({
    token0: { symbol: 'WETH' },
    token1: { symbol: 'USDC' },
  }, 'ETH'), false);
});

test('computeSegmentFromCandles devuelve 50% cuando sale del rango al final del primer dia', () => {
  const startAt = Date.UTC(2026, 0, 1, 0, 0, 0);
  const endAt = startAt + (2 * 24 * 60 * 60 * 1000);
  const day1 = startAt + (24 * 60 * 60 * 1000);

  const result = computeSegmentFromCandles({
    startAt,
    endAt,
    rangeLowerPrice: 90,
    rangeUpperPrice: 110,
    initialPrice: 100,
    candles: [
      { closeTime: day1, close: 120 },
    ],
  });

  assert.equal(result.timeTrackedMs, 2 * 24 * 60 * 60 * 1000);
  assert.equal(result.timeInRangeMs, 24 * 60 * 60 * 1000);
  assert.equal(result.finalInRange, false);
});

test('computeTimeInRangeBatch soporta resolucion invertida contra el rango del LP', async () => {
  const startAt = Date.UTC(2026, 0, 1, 0, 0, 0);
  const endAt = startAt + (2 * 60 * 60 * 1000);
  const batch = await computeTimeInRangeBatch([{
    id: 'pool',
    pool: {
      token0: { symbol: 'USDC' },
      token1: { symbol: 'WETH' },
    },
    asset: 'ETH',
    startAt,
    endAt,
    rangeLowerPrice: 1 / 2100,
    rangeUpperPrice: 1 / 1900,
    initialPrice: 1 / 2000,
    invertPrice: true,
  }], {
    marketDataService: {
      getCandles: async () => ([
        { closeTime: startAt + (60 * 60 * 1000), close: 2000 },
        { closeTime: endAt, close: 2200 },
      ]),
    },
  });

  const result = batch.get('pool');
  assert.equal(result.timeTrackedMs, 2 * 60 * 60 * 1000);
  assert.equal(result.timeInRangeMs, 2 * 60 * 60 * 1000);
  assert.equal(result.rangeResolution, '1m');
});
