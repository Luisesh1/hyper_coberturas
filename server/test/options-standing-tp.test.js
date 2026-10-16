const test = require('node:test');
const assert = require('node:assert/strict');
const { OptionsLiveExecution, WINDOW_MS } = require('../src/services/options/options-live-execution.service');
const { OptionsStrategyRunner } = require('../src/services/options/options-strategy-runner.service');

const NOW = Date.UTC(2026, 9, 16, 10);
const EXPIRY = Date.UTC(2026, 9, 30, 8);
const SYMBOL = 'BTC-261030-100000-C';
const strategy = { id: 4, userId: 7, template: 'alert_signal' };
const silent = { warn() {}, info() {}, error() {} };
function filledPosition(id = 100, quantity = 0.2) {
  return { id, strategyId: 4, userId: 7, symbol: SYMBOL, side: 'BUY',
    entryPrice: 100, quantity, underlying: 'BTC', params: {
      takeProfitMode: 'fixed', takeProfitPct: 80, exitHoursBeforeExpiry: 12,
    } };
}
function info() {
  return { optionSymbols: [{
    symbol: SYMBOL, quoteAsset: 'USDT', status: 'TRADING', expiryDate: EXPIRY,
    filters: [{ filterType: 'PRICE_FILTER', minPrice: '0', maxPrice: '10000',
      tickSize: '0.1', minQty: '0.01', maxQty: '10', stepSize: '0.01' }],
  }] };
}
function fixture({ positions = [], send = async () => ({ orderId: '12345678901234567' }) } = {}) {
  const clock = { now: NOW };
  const log = { sent: [], cancels: [], reads: [] };
  const orders = [];
  const repository = {
    async listUnresolved() { return []; },
    async listMissingTpPositions() {
      return positions.filter((p) => !orders.some((o) => o.positionId === p.id && o.status !== 'final'));
    },
    async listQueuedTpOrders() { return orders.filter((o) => o.status === 'queued' && !o.cancelRequested); },
    async listUserOrderIds() { return orders.map((o) => ({ clientOrderId: o.clientOrderId, status: o.status })); },
    async assertExchangeExposure() { return true; },
    async beginStandingTp({ position, price, deadlineAt }) {
      if (orders.some((o) => o.positionId === position.id && o.status !== 'final')) return null;
      const o = {
        id: orders.length + 1, strategyId: 4, userId: 7, positionId: position.id,
        symbol: position.symbol, side: 'SELL', quantity: position.quantity, limitPrice: price,
        deadlineAt, clientOrderId: 'HC1T' + orders.length,
        status: 'queued', purpose: 'take_profit', processedQty: 0, createdAt: clock.now,
      };
      orders.push(o);
      return { ...o };
    },
    async markSending(id) {
      const o = orders.find((x) => x.id === id);
      if (o.status !== 'queued' || o.cancelRequested) return null;
      o.status = 'sending';
      return { ...o };
    },
    async markActive(id, orderId) {
      const o = orders.find((x) => x.id === id);
      o.orderId = String(orderId); o.status = 'active';
    },
    async markAttention(id) {
      const o = orders.find((x) => x.id === id);
      o.status = 'attention';
    },
    async finishOrder(id, orderId, qty) {
      const o = orders.find((x) => x.id === id);
      assert.equal(Number(qty), Number(o.processedQty));
      o.orderId = orderId == null ? null : String(orderId);
      o.status = 'final';
    },
    async applyTrade() { throw new Error('Unexpected fill'); },
    async listReadyExitRequests() { return []; },
    async deferExitIfProtected() { return orders.some((o) => o.status !== 'final'); },
  };
  let brokerOrderStatus = 'NEW';
  const client = {
    async getExchangeInfo() { return info(); },
    async getPositions() { return [{ symbol: SYMBOL, side: 'LONG', quantity: '0.2' }]; },
    async getOpenOrders() { return []; },
    async placeOrder(payload) {
      log.sent.push(payload);
      return send(payload);
    },
    async getOrder({ symbol, orderId, clientOrderId }) {
      log.reads.push({ symbol, orderId, clientOrderId });
      return { orderId: '12345678901234567', symbol: SYMBOL, side: 'SELL',
        clientOrderId: orders[0]?.clientOrderId, quantity: '0.2',
        status: brokerOrderStatus, executedQty: '0',
        type: 'LIMIT', timeInForce: 'GTC' };
    },
    async getUserTrades() { return []; },
    async cancelOrder(payload) { log.cancels.push(payload); brokerOrderStatus = 'CANCELED'; },
  };
  const engine = new OptionsLiveExecution({
    repo: repository, credentials: { getClientForUser: async () => client },
    market: { async getQuote() { return { spot: 100000, iv: 0.5, bid: 165, ask: 166 }; } },
    settlement: { async reconcileExpired() {} }, logger: silent,
    notify: async () => {}, now: () => clock.now, enabled: true,
  });
  return { engine, repository, orders, clock, log, client, setBrokerStatus(s) { brokerOrderStatus = s; } };
}

test('sin fill NO registra ni envía take-profit, y en disabled tampoco', async () => {
  const empty = fixture();
  assert.deepEqual(await empty.engine.createMissingTakeProfits(), { attempted: 0, queued: 0 });
  assert.equal((await empty.engine.submitQueuedTakeProfits()).sent, 0);
  assert.equal(empty.log.sent.length, 0);

  const p = filledPosition();
  const disabled = fixture({ positions: [p] });
  disabled.engine.enabled = false;
  await disabled.engine.reconcilePending();
  assert.equal(disabled.orders.length, 0);
  assert.equal(disabled.log.sent.length, 0);
});

test('TP se registra duradero y se envía reduceOnly inmediatamente tras fill confirmado', async () => {
  const f = fixture({ positions: [filledPosition()] });
  const result = await f.engine.reconcilePending();
  assert.equal(result.protection.queued, 1);
  assert.equal(result.protectionSent.sent, 1);
  assert.equal(f.log.sent.length, 1);
  assert.deepEqual(f.log.sent[0], {
    symbol: SYMBOL, side: 'SELL', quantity: 0.2, price: 180,
    reduceOnly: true, clientOrderId: f.orders[0].clientOrderId,
  });
  assert.equal(f.orders[0].status, 'active');
  assert.ok(f.orders[0].deadlineAt - NOW > WINDOW_MS);
  await f.engine.reconcilePending();
  assert.equal(f.log.sent.length, 1);
});

test('fills parciales crean TPs independientes, cada uno solo por cantidad confirmada', async () => {
  const f = fixture({ positions: [filledPosition(100, 0.08), filledPosition(101, 0.12)] });
  await f.engine.reconcilePending();
  assert.equal(f.orders.length, 2);
  assert.equal(f.log.sent.length, 2);
  assert.deepEqual(f.log.sent.map((x) => x.quantity), [0.08, 0.12]);
  assert.ok(f.log.sent.every((x) => x.reduceOnly === true));
});

test('timeout del POST de TP no permite reenviar orden ambigua', async () => {
  const f = fixture({ positions: [filledPosition()], send: async () => { throw new Error('timeout'); } });
  await f.engine.reconcilePending();
  assert.equal(f.log.sent.length, 1);
  assert.equal(f.orders[0].status, 'attention');
  await f.engine.reconcilePending();
  assert.equal(f.log.sent.length, 1);
});

test('stop ante TP activo queda pendiente SIN enviar otro cierre', async () => {
  const f = fixture({ positions: [filledPosition()] });
  await f.engine.reconcilePending();
  const result = await f.engine.submit(strategy, { type: 'close', reason: 'stop_loss', legs: [{
    positionId: 100, symbol: SYMBOL, side: 'SELL', quantity: 0.2, price: 90,
  }] }, { now: NOW });
  assert.equal(result.status, 'tp_cancel_requested');
  assert.equal(f.log.sent.length, 1);
});

test('cancelación TP solicita estado terminal y nunca sintetiza fills', async () => {
  const f = fixture({ positions: [filledPosition()] });
  await f.engine.reconcilePending();
  const order = { ...f.orders[0], cancelRequested: true };
  await f.engine.reconcileOrder(order, f.client);
  assert.equal(f.log.cancels.length, 1);
  assert.equal(f.log.cancels[0].symbol, SYMBOL);
  assert.equal(f.orders[0].status, 'final');
  assert.equal(f.orders[0].processedQty, 0);
});

test('tras confirmar cancelación, el cierre diferido usa cotización fresca y key durable', async () => {
  const f = fixture();
  f.repository.listReadyExitRequests = async () => [{
    id: 55, positionId: 100, strategyId: 4, userId: 7,
    symbol: SYMBOL, side: 'BUY', quantity: 0.15,
  }];
  let stored = null;
  f.engine.submit = async (s, action, ctx) => { stored = { s, action, ctx }; return { status: 'submitted' }; };
  const out = await f.engine.processDeferredExits();
  assert.equal(out.sent, 1);
  assert.equal(stored.action.legs[0].quantity, 0.15);
  assert.equal(stored.action.legs[0].side, 'SELL');
  assert.equal(stored.action.legs[0].price, 165);
  assert.match(stored.ctx.durableActionKey, /^deferred:55:\d+$/);
});

test('un tick de ganancia no cancela orden TP resting', async () => {
  let quoted = 0;
  const runner = new OptionsStrategyRunner({
    repo: {}, market: { async getQuote() { quoted++; throw new Error('should not fetch'); } },
    liveExecutor: { enabled: true,
      repo: { async hasStandingTp() { return true; } } },
    logger: silent,
  });
  const ctx = { now: NOW, produced: [] };
  const result = await runner.executeLive(strategy, { type: 'close', reason: 'take_profit', legs: [{
    positionId: 100, symbol: SYMBOL, side: 'SELL', quantity: 0.2,
  }] }, ctx);
  assert.equal(result, null);
  assert.equal(quoted, 0);
  assert.equal(ctx.produced[0].reason, 'tp_resting');
});

test('stop solicita cancelación durable incluso si falla el libro de órdenes', async () => {
  let quoteCalls = 0;
  let deferred = 0;
  const runner = new OptionsStrategyRunner({
    repo: {},
    market: { async getQuote() { quoteCalls++; throw new Error('Binance unavailable'); } },
    liveExecutor: {
      enabled: true,
      requestProtectedExit: async () => { deferred++; return true; },
      repo: {},
    },
    logger: silent,
  });
  const ctx = { now: NOW, produced: [] };
  const result = await runner.executeLive(strategy, {
    type: 'close', reason: 'stop_loss',
    legs: [{ positionId: 100, symbol: SYMBOL, side: 'SELL', quantity: 0.2 }],
  }, ctx);
  assert.equal(result.status, 'tp_cancel_requested');
  assert.equal(deferred, 1);
  assert.equal(quoteCalls, 0);
  assert.equal(ctx.produced[0].pending, true);
});

test('si Binance no confirma cancelación terminal no se contabiliza el cierre', async () => {
  const f = fixture({ positions: [filledPosition()] });
  await f.engine.reconcilePending();
  // Orden pasa a CANCELED solo cuando la API confirma el cambio.
  const calls = [];
  f.client.cancelOrder = async () => { calls.push('cancel'); };
  const req = { ...f.orders[0], cancelRequested: true };
  await f.engine.reconcileOrder(req, f.client);
  assert.equal(calls.length, 1);
  assert.equal(f.orders[0].status, 'active');
  assert.equal(f.orders[0].processedQty, 0);
  assert.equal(f.log.sent.length, 1);
});

test('al vencer el TP se persiste salida temporal ANTES de cancelar el resting', async () => {
  const f = fixture({ positions: [filledPosition()] });
  await f.engine.reconcilePending();
  const sequence = [];
  f.clock.now = f.orders[0].deadlineAt;
  f.repository.requestDeadlineExit = async (order) => {
    sequence.push('persist_exit');
    assert.equal(order.purpose, 'take_profit');
    return true;
  };
  f.client.cancelOrder = async () => {
    sequence.push('cancel_exchange');
    f.setBrokerStatus('CANCELED');
  };
  await f.engine.reconcileOrder({ ...f.orders[0] }, f.client);
  assert.deepEqual(sequence, ['persist_exit', 'cancel_exchange']);
  assert.equal(f.orders[0].status, 'final');
});
