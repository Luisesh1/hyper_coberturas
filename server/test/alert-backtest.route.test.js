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

test('runBacktest registra el error original antes de envolverlo en 502', async (t) => {
  const alertBacktest = require('../src/services/alerts/alert-backtest.service');
  const logger = require('../src/services/logger.service');
  const { runBacktest } = require('../src/routes/alerts.routes');
  const boom = new Error('socket hang up');
  t.mock.method(alertBacktest, 'run', async () => { throw boom; });
  const warn = t.mock.method(logger, 'warn', () => null);
  await assert.rejects(runBacktest(1, 42, ok), (err) => err.name === 'ExternalServiceError' && /socket hang up/.test(err.message));
  assert.equal(warn.mock.callCount(), 1);
  const [msg, meta] = warn.mock.calls[0].arguments;
  assert.equal(msg, 'alerts_backtest_failed');
  assert.equal(meta.alertId, 42);
  assert.equal(meta.error, 'socket hang up');
  assert.equal(meta.stack, boom.stack);
  // Los AppError pasan tal cual y no se registran.
  t.mock.method(alertBacktest, 'run', async () => { throw new ValidationError('x'); });
  await assert.rejects(runBacktest(1, 42, ok), ValidationError);
  assert.equal(warn.mock.callCount(), 1);
});
