const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBacktestBody } = require('../src/routes/alerts.routes');
const { ValidationError } = require('../src/errors/app-error');

const ok = { asset: 'BTC', datasource: 'binance', startTime: 1000, endTime: 2000 };

test('parseBacktestBody acepta un body válido', () => {
  assert.deepEqual(parseBacktestBody(ok), ok);
});

test('parseBacktestBody rechaza bodies inválidos con ValidationError', () => {
  const bad = [
    undefined,
    { ...ok, asset: '' },
    { ...ok, datasource: 'kraken' },
    { ...ok, startTime: -1 },
    { ...ok, startTime: 1.5 },
    { ...ok, startTime: 2000, endTime: 1000 },
    { ...ok, endTime: undefined },
  ];
  for (const b of bad) assert.throws(() => parseBacktestBody(b), ValidationError);
});
