const test = require('node:test');
const assert = require('node:assert/strict');
const { hourlyAtr, projectTakeProfit } = require('../src/services/options/options-take-profit');

const hour = 3600000;
const time = Date.UTC(2026, 9, 15, 12);
const candles = Array.from({ length: 17 }, (_, i) => [
  time - (17 - i) * hour, '100', '105', '95', '100', '100',
  time - (16 - i) * hour - 1,
]);

test('ATR ignora vela incompleta, usa OHLC y exige datos suficientes', () => {
  assert.equal(hourlyAtr(candles, 14, time), 10);
  const withOpen = [...candles, [time, '100', '900', '1', '200', '1', time + hour - 1]];
  assert.equal(hourlyAtr(withOpen, 14, time), 10);
  assert.equal(hourlyAtr(candles.slice(0, 10), 14, time), null);
  assert.equal(hourlyAtr([[0, 0, 1, 5, 3, 0, 1]], 14, time), null);
});

const base = {
  entryPrice: 650, spot: 100000, strike: 101000, iv: 0.6,
  type: 'C', side: 'BUY', nowMs: time,
  expiryMs: time + 7 * 24 * hour,
  atrHourly: 500, tickSize: 0.1,
};

test('TP de call comprada es una venta más cara que el fill real', () => {
  const tp = projectTakeProfit(base);
  assert.ok(tp);
  assert.ok(tp.price > base.entryPrice);
  assert.ok(tp.underlyingTarget > base.spot);
  assert.equal(Math.round(tp.price * 10), tp.price * 10);
});

test('TP de put comprada requiere descenso y call vendida requiere descenso', () => {
  const put = projectTakeProfit({ ...base, type: 'P' });
  const shortCall = projectTakeProfit({ ...base, side: 'SELL', entryPrice: 1500 });
  assert.ok(put);
  assert.ok(put.underlyingTarget < base.spot);
  assert.ok(shortCall);
  assert.ok(shortCall.price < 1500);
});

test('no inventa TP ante falta de IV, ATR o vencimiento insuficiente', () => {
  assert.equal(projectTakeProfit({ ...base, iv: null }), null);
  assert.equal(projectTakeProfit({ ...base, atrHourly: 0 }), null);
  assert.equal(projectTakeProfit({ ...base, expiryMs: time + 2 * hour }), null);
  assert.equal(projectTakeProfit({ ...base, tickSize: 0 }), null);
});
