const test = require('node:test');
const assert = require('node:assert/strict');
const { OptionsLiveExecution } = require('../src/services/options/options-live-execution.service');
const { OptionsStrategyRunner } = require('../src/services/options/options-strategy-runner.service');

const NOW = Date.UTC(2026, 9, 16, 10);
const SIGNAL = { eventId: '9001', direction: 'bullish' };
const STRATEGY = { id: 4, userId: 7, template: 'alert_signal', mode: 'live',
  underlying: 'BTC', params: { onOpposite: 'reverse', quantity: 0.01, alertIds: [1] } };
const silent = { warn() {}, info() {}, error() {} };

function engineFor(list, statuses = []) {
  let ran = 0;
  const runner = { async executeDeferredReentry() { ran++; return { status: 'submitted' }; } };
  const repo = {
    async listPendingReentries() { return list; },
    async markReentry(id, status) { statuses.push([id, status]); return true; },
    async hasReentryOrder() { return false; },
  };
  const engine = new OptionsLiveExecution({
    enabled: true, repo, runner, now: () => NOW, logger: silent,
    notify: async () => {}, settlement: {},
  });
  return { engine, statuses, get ran() { return ran; } };
}

test('no reabre antes del cierre confirmado, pero recupera señal tras reinicio', async () => {
  const request = { id: 99, userId: 7, strategyId: 4, eventId: '9001',
    signal: SIGNAL, createdAt: NOW - 60000, ready: false };
  const f = engineFor([request]);
  await f.engine.processDeferredReentries();
  assert.equal(f.ran, 0);
  assert.deepEqual(f.statuses, []);
  request.ready = true;
  const result = await f.engine.processDeferredReentries();
  assert.equal(result.sent, 1);
  assert.equal(f.ran, 1);
  assert.deepEqual(f.statuses, [[99, 'submitted']]);
});

test('giro demasiado antiguo caduca sin ordenar una compra tardía', async () => {
  const request = { id: 99, userId: 7, strategyId: 4, eventId: '9001',
    signal: SIGNAL, createdAt: NOW - 31 * 60000, ready: true };
  const f = engineFor([request]);
  const result = await f.engine.processDeferredReentries();
  assert.equal(result.expired, 1);
  assert.equal(f.ran, 0);
  assert.deepEqual(f.statuses, [[99, 'expired']]);
});

test('reentrada recomputa la cadena y el presupuesto real, sin repetir sombra', async () => {
  const repo = {
    async getStrategyById() { return STRATEGY; },
    async listOpenPositions() { return []; },
    async lastOpenedAt() { return null; },
    async countEventsSince() { return 0; },
  };
  const chain = { underlying: 'BTC', expiry: '261030', spot: 60000,
    expiries: [{ code: '261030', dte: 14 }],
    rows: [{ strike: 63000,
      call: { symbol: 'BTC-261030-63000-C', ask: 100, bid: 98,
        delta: 0.35, minQty: 0.01, stepSize: 0.01, maxQty: 10 },
      put: { symbol: 'BTC-261030-63000-P', ask: 10, bid: 8, delta: -0.6 } }],
  };
  const runner = new OptionsStrategyRunner({
    repo, market: { async getChain() { return chain; } },
    liveExecutor: { enabled: true }, now: () => NOW, logger: silent,
  });
  let action = null;
  runner.executeLive = async (_strategy, a, ctx) => {
    action = a;
    assert.equal(ctx.signal.eventId, '9001');
    assert.equal(ctx.mode, 'live');
    return { status: 'submitted' };
  };
  const result = await runner.executeDeferredReentry(4, SIGNAL);
  assert.equal(result.status, 'submitted');
  assert.equal(action.type, 'open');
  assert.equal(action.legs[0].side, 'BUY');
  assert.equal(action.legs[0].symbol, 'BTC-261030-63000-C');
});

test('bot desactivado o cambio de modo no reabre exposición', async () => {
  const runner = new OptionsStrategyRunner({
    repo: { async getStrategyById() { return { ...STRATEGY, mode: 'shadow' }; } },
    liveExecutor: { enabled: true }, logger: silent,
  });
  assert.equal((await runner.executeDeferredReentry(4, SIGNAL)).status, 'disabled');
});
