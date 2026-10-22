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

test('reentrada de un bot multi-subyacente: abre en el subyacente de la señal; solo bloquean sus posiciones', async () => {
  const multi = { ...STRATEGY, params: { ...STRATEGY.params, underlyings: ['BTC', 'ETH'], maxOpenPositions: 1 } };
  let open = [{ id: 1, symbol: 'BTC-261030-63000-C', side: 'BUY', quantity: 0.01, entryPrice: 100 }];
  const repo = {
    async getStrategyById() { return multi; },
    async listOpenPositions() { return open; },
    async lastOpenedAt() { return null; },
    async countEventsSince() { return 0; },
  };
  const asked = [];
  const ethChain = { underlying: 'ETH', expiry: '261030', spot: 3000,
    expiries: [{ code: '261030', dte: 14 }],
    rows: [{ strike: 3200,
      call: { symbol: 'ETH-261030-3200-C', ask: 10, bid: 9, delta: 0.35, minQty: 0.01, stepSize: 0.01, maxQty: 10 },
      put: { symbol: 'ETH-261030-3200-P', ask: 5, bid: 4, delta: -0.6 } }],
  };
  const runner = new OptionsStrategyRunner({
    repo, market: { async getChain(u) { asked.push(u); return ethChain; } },
    liveExecutor: { enabled: true }, now: () => NOW, logger: silent,
  });
  let action = null;
  runner.executeLive = async (_s, a) => { action = a; return { status: 'submitted' }; };
  const signal = { ...SIGNAL, underlying: 'ETH' };
  // maxOpenPositions 1 y una BTC abierta: el máximo es del bot entero.
  assert.equal((await runner.executeDeferredReentry(4, signal)).status, 'no_valid_entry');
  multi.params.maxOpenPositions = 2;
  assert.equal((await runner.executeDeferredReentry(4, signal)).status, 'submitted');
  assert.deepEqual([...new Set(asked)], ['ETH']);
  assert.equal(action.legs[0].symbol, 'ETH-261030-3200-C');
  // Una posición ETH aún abierta sí bloquea la reentrada ETH.
  open = [...open, { id: 2, symbol: 'ETH-261030-3200-P', side: 'BUY', quantity: 0.01, entryPrice: 5 }];
  assert.equal((await runner.executeDeferredReentry(4, signal)).status, 'positions_still_open');
});
