const test = require('node:test');
const assert = require('node:assert/strict');
const { resolutionFor, chartDataToCandles, aggregateCandles, toUsdCandles } = require('../src/services/deribit/option-series');

const c = (time, o, h, l, cl, v = 1) => ({ time, open: o, high: h, low: l, close: cl, volume: v, traded: v > 0 });

test('resolutionFor cubre todas las temporalidades', () => {
  assert.deepEqual(resolutionFor('4h'), { resolution: '60', aggregateMs: 14_400_000, calendar: null });
  assert.equal(resolutionFor('1w').calendar, 'week');
  assert.equal(resolutionFor('1M').calendar, 'month');
  assert.equal(resolutionFor('1M').resolution, '1D');
  assert.deepEqual(resolutionFor('1m'), { resolution: '1', aggregateMs: null, calendar: null });
  assert.equal(resolutionFor('5m').resolution, '5');
  assert.equal(resolutionFor('15m').resolution, '15');
  assert.equal(resolutionFor('1h').resolution, '60');
  assert.equal(resolutionFor('1d').resolution, '1D');
});

test('chartDataToCandles zipea y marca traded', () => {
  const out = chartDataToCandles({ ticks: [1, 2], open: [1, 2], high: [3, 4], low: [0, 1], close: [2, 3], volume: [0, 5], status: 'ok' });
  assert.deepEqual(out[0], { time: 1, open: 1, high: 3, low: 0, close: 2, volume: 0, traded: false });
  assert.equal(out[1].traded, true);
  assert.deepEqual(chartDataToCandles({ status: 'no_data', ticks: [] }), []);
  assert.deepEqual(chartDataToCandles(null), []);
});

test('agrega 1h a 4h', () => {
  const t0 = Date.UTC(2026, 9, 16, 0);
  const h = 3_600_000;
  const out = aggregateCandles([c(t0, 1, 5, 0.5, 2, 1), c(t0 + h, 2, 9, 1, 3, 2), c(t0 + 2 * h, 3, 4, 0.2, 4, 0), c(t0 + 3 * h, 4, 6, 2, 7, 3)], '4h');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { time: t0, open: 1, high: 9, low: 0.2, close: 7, volume: 6, traded: true });
});

test('alineación 4h', () => {
  const out = aggregateCandles([c(Date.UTC(2026, 9, 16, 3), 1, 1, 1, 1)], '4h');
  assert.equal(out[0].time, Date.UTC(2026, 9, 16, 0));
});

test('semana empieza el lunes y mes el día 1', () => {
  const w = aggregateCandles([c(Date.UTC(2026, 9, 14), 1, 1, 1, 1)], '1w');
  assert.equal(w[0].time, Date.UTC(2026, 9, 12));
  const sun = aggregateCandles([c(Date.UTC(2026, 9, 18), 1, 1, 1, 1)], '1w');
  assert.equal(sun[0].time, Date.UTC(2026, 9, 12));
  const m = aggregateCandles([c(Date.UTC(2026, 9, 14), 1, 2, 0, 1), c(Date.UTC(2026, 9, 20), 1, 3, 1, 2, 0)], '1M');
  assert.equal(m.length, 1);
  assert.equal(m[0].time, Date.UTC(2026, 9, 1));
  assert.equal(m[0].high, 3);
});

test('sin agregación devuelve la entrada', () => {
  const input = [c(1, 1, 1, 1, 1)];
  assert.equal(aggregateCandles(input, '1h'), input);
  assert.equal(aggregateCandles(input, '1d'), input);
});

test('traded verdadero si alguna vela lo está', () => {
  const t0 = Date.UTC(2026, 9, 16, 0);
  assert.equal(aggregateCandles([c(t0, 1, 1, 1, 1, 0), c(t0 + 3_600_000, 1, 1, 1, 1, 2)], '4h')[0].traded, true);
  assert.equal(aggregateCandles([c(t0, 1, 1, 1, 1, 0)], '4h')[0].traded, false);
});

test('toUsdCandles inversas', () => {
  const t = 1000;
  const out = toUsdCandles([c(t, 0.0001, 0.0003, 0.0001, 0.0002), c(t + 1, 1, 1, 1, 1)], { inverse: true, underlyingCloseByTime: new Map([[t, 3829.09]]) });
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0].close - 0.765818) < 1e-9);
  assert.equal(out[0].premiumCoin, 0.0002);
});

test('toUsdCandles USDC no cambia', () => {
  const t = 1000;
  const out = toUsdCandles([c(t, 1, 2, 0.5, 1.5)], { inverse: false, underlyingCloseByTime: new Map() });
  assert.equal(out[0].close, 1.5);
  assert.equal('premiumCoin' in out[0], false);
});
