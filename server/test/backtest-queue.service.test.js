const test = require('node:test');
const assert = require('node:assert/strict');

const backtestingService = require('../src/services/backtesting.service');
const queue = require('../src/services/backtest-queue.service');

test('enqueue + waitForJob ejecuta el backtest exactamente una vez', async (t) => {
  const originalSimulate = backtestingService.simulateBacktest;
  let executions = 0;
  backtestingService.simulateBacktest = async () => {
    executions += 1;
    return { metrics: { trades: 2 } };
  };
  t.after(() => {
    backtestingService.simulateBacktest = originalSimulate;
    queue.stop();
  });

  const { jobId } = queue.enqueue(901, { strategyId: 11, asset: 'BTC', timeframe: '15m' });
  const job = await queue.waitForJob(jobId, 901, { timeoutMs: 1_000 });

  assert.equal(job.status, 'completed');
  assert.equal(job.result.metrics.trades, 2);
  assert.equal(executions, 1);
});
