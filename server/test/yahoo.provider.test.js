const assert = require('node:assert/strict');
const test = require('node:test');

const yahooProvider = require('../src/services/marketdata-providers/yahoo.provider');

test('yahoo provider soporta 4h como intervalo sintetico', () => {
  assert.ok(yahooProvider.supportedIntervals.includes('4h'));
});

test('aggregateHourlyCandles agrupa velas de 1h en OHLCV de 4h', () => {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  const hour = 60 * 60 * 1000;
  const candles = [
    { time: base, closeTime: base, open: 10, high: 12, low: 9, close: 11, volume: 100, trades: 0 },
    { time: base + hour, closeTime: base + hour, open: 11, high: 15, low: 10, close: 14, volume: 200, trades: 0 },
    { time: base + 2 * hour, closeTime: base + 2 * hour, open: 14, high: 16, low: 13, close: 15, volume: 300, trades: 0 },
    { time: base + 3 * hour, closeTime: base + 3 * hour, open: 15, high: 17, low: 12, close: 13, volume: 400, trades: 0 },
    { time: base + 4 * hour, closeTime: base + 4 * hour, open: 13, high: 18, low: 12, close: 17, volume: 500, trades: 0 },
  ];

  const grouped = yahooProvider.aggregateHourlyCandles(candles, 4);

  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[0], {
    time: base,
    closeTime: base + 3 * hour,
    open: 10,
    high: 17,
    low: 9,
    close: 13,
    volume: 1000,
    trades: 0,
  });
  assert.deepEqual(grouped[1], {
    time: base + 4 * hour,
    closeTime: base + 4 * hour,
    open: 13,
    high: 18,
    low: 12,
    close: 17,
    volume: 500,
    trades: 0,
  });
});
