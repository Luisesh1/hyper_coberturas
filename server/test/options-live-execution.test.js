const test = require('node:test');
const assert = require('node:assert/strict');
const { OptionsLiveExecution, normalizeTrade, actionKey, WINDOW_MS } =
  require('../src/services/options/options-live-execution.service');

const strategy = { id: 1, userId: 7, template: 'alert_signal' };
const leg = { symbol: 'BTC-261030-60000-C', side: 'BUY', quantity: 0.5, price: 100 };
const context = (time = 100_000, eventId = 77) =>
  ({ now: time, signal: { eventId, direction: 'bullish' } });
const silent = { warn() {}, info() {}, error() {} };

function fixture({ now = 100_000, onSubmit } = {}) {
  const clock = { time: now };
  const orders = [];
  const fills = [];
  const calls = { post: [], get: [], cancel: [], trades: [] };
  let nextId = 1;
  const repo = {
    orders, fills,
    async assertExchangeExposure() { return true; },
    async beginBatch({ action, legs, key, deadlineAt }) {
      if (orders.some((o) => o.key === key || o.status !== 'final')) return null;
      return legs.map((l) => {
        const o = { ...l, id: nextId++, userId: 7, strategyId: 1, action,
          clientOrderId: 'HC' + nextId, orderId: null, status: 'queued', key,
          quantity: l.quantity, limitPrice: l.price, processedQty: 0,
          createdAt: clock.time, deadlineAt };
        orders.push(o);
        return { ...o };
      });
    },
    async listUnresolved() { return orders.filter((o) => o.status !== 'final').map((o) => ({ ...o })); },
    async markSending(id) {
      const o = orders.find((x) => x.id === id);
      if (o.status !== 'queued') return null;
      o.status = 'sending';
      return { ...o };
    },
    async markActive(id, orderId) {
      const o = orders.find((x) => x.id === id);
      o.status = 'active';
      o.orderId = String(orderId);
    },
    async markAttention(id, error) { const o = orders.find((x) => x.id === id); o.status = 'attention'; o.error = error; },
    async claimReconcile(id) {
      const o = orders.find((x) => x.id === id);
      if (o.leased) return null;
      o.leased = true;
      return { ...o };
    },
    async releaseReconcile(id) { orders.find((x) => x.id === id).leased = false; },
    async applyTrade(o, t) {
      if (fills.some((f) => f.orderId === o.id && f.id === t.id)) return false;
      const row = orders.find((x) => x.id === o.id);
      row.processedQty += t.quantity;
      fills.push({ ...t, orderId: o.id });
      return true;
    },
    async finishOrder(id, orderId, qty) {
      const o = orders.find((x) => x.id === id);
      assert.ok(Math.abs(o.processedQty - qty) < 1e-8);
      o.status = 'final';
      o.orderId = orderId == null ? null : String(orderId);
    },
  };
  const state = { status: 'NEW', executedQty: '0', quantity: String(leg.quantity), type: 'LIMIT', timeInForce: 'GTC' };
  let allTrades = [];
  const client = {
    async placeOrder(payload) {
      calls.post.push(payload);
      if (onSubmit) return onSubmit(payload);
      return { orderId: '4611875134427365377', status: 'NEW', executedQty: '0' };
    },
    async getOrder(payload) {
      calls.get.push(payload);
      return { orderId: '4611875134427365377', clientOrderId: orders[0].clientOrderId,
        symbol: leg.symbol, side: leg.side, ...state };
    },
    async getUserTrades(payload) {
      calls.trades.push(payload);
      const pages = payload.fromId == null ? allTrades
        : allTrades.filter((t) => BigInt(String(t.id)) >= BigInt(payload.fromId));
      return pages.slice(0, payload.limit);
    },
    async getPositions() { return []; },
    async cancelOrder(payload) {
      calls.cancel.push(payload);
      state.status = 'CANCELED';
      return { status: 'CANCELED' };
    },
  };
  const credentials = { async getClientForUser() { return client; } };
  const engine = new OptionsLiveExecution({ repo, credentials, logger: silent, enabled: true, now: () => clock.time });
  const submit = (eventId = 77) =>
    engine.submit(strategy, { type: 'open', legs: [leg], detail: 'señal' }, context(clock.time, eventId));
  const setState = (status, executedQty) => Object.assign(state, { status, executedQty: String(executedQty) });
  const setTrades = (list) => { allTrades = list; };
  return { engine, repo, orders, fills, clock, calls, client, submit, setState, setTrades };
}
function trade(quantity, tradeId = '300') {
  return { orderId: '4611875134427365377', tradeId, symbol: leg.symbol,
    side: leg.side, quantity: String(quantity), price: '98', fee: '-0.15',
    quoteAsset: 'USDT', time: 101_000 };
}

test('aceptar una orden no registra ningún fill y no reenvía la misma señal', async () => {
  const f = fixture();
  assert.equal((await f.submit()).status, 'submitted');
  assert.equal(f.orders.length, 1);
  assert.equal(f.fills.length, 0);
  assert.equal((await f.submit()).status, 'duplicate_or_unresolved');
  assert.equal(f.calls.post.length, 1);
  await f.engine.reconcilePending();
  assert.equal(f.fills.length, 0);
  assert.equal(f.orders[0].status, 'active');
});

test('fill parcial se registra una sola vez y se cancela el remanente al minuto 10', async () => {
  const f = fixture();
  await f.submit();
  f.setTrades([trade(0.2)]);
  f.setState('PARTIALLY_FILLED', 0.2);
  await f.engine.reconcilePending();
  assert.equal(f.fills.length, 1);
  assert.equal(f.orders[0].processedQty, 0.2);
  await f.engine.reconcilePending();
  assert.equal(f.fills.length, 1);
  f.clock.time += WINDOW_MS + 1;
  await f.engine.reconcilePending();
  assert.equal(f.calls.cancel.length, 1);
  assert.equal(f.orders[0].status, 'final');
  assert.equal(f.orders[0].processedQty, 0.2);
  assert.equal(f.calls.post.length, 1);
});

test('crash o timeout del POST nunca reenvía; busca por clientOrderId', async () => {
  const f = fixture({ onSubmit: async () => { throw new Error('timeout'); } });
  assert.equal((await f.submit()).status, 'attention');
  assert.equal(f.calls.post.length, 1);
  assert.equal(f.orders[0].status, 'attention');
  await f.engine.reconcilePending();
  assert.equal(f.calls.get[0].clientOrderId, f.orders[0].clientOrderId);
  assert.equal(f.calls.post.length, 1);
  assert.equal(f.orders[0].status, 'active');
});

test('no finaliza una pata queued durante la ventana ni crea una orden huérfana', async () => {
  const f = fixture();
  await f.engine.submit(strategy, {
    type: 'open', legs: [leg, { ...leg, symbol: 'BTC-261030-62000-C' }],
  }, context(f.clock.time));
  // La API aceptó las dos patas. Probar el caso de una orden no enviada
  // mediante un lote interrumpido con un nuevo fixture.
  const g = fixture({ onSubmit: async () => { throw new Error('timeout'); } });
  await g.engine.submit(strategy, {
    type: 'open', legs: [leg, { ...leg, symbol: 'BTC-261030-62000-C' }],
  }, context(g.clock.time));
  assert.equal(g.orders[1].status, 'queued');
  await g.engine.reconcilePending();
  assert.equal(g.orders[1].status, 'queued');
  assert.equal(g.calls.post.length, 1);
});

test('estado desconocido bloquea la estrategia y nunca inventa fills', async () => {
  const f = fixture();
  await f.submit();
  f.setState('UNKNOWN', 0);
  const result = await f.engine.reconcilePending();
  assert.equal(result.errors, 1);
  assert.equal(f.orders[0].status, 'attention');
  assert.equal(f.fills.length, 0);
  assert.equal((await f.submit(78)).status, 'duplicate_or_unresolved');
});

test('un lote interrumpido no envía patas todavía en queued', async () => {
  const f = fixture({ onSubmit: async () => { throw new Error('timeout'); } });
  const action = { type: 'open', legs: [leg, { ...leg, symbol: 'BTC-261030-62000-C' }] };
  await f.engine.submit(strategy, action, context(f.clock.time));
  assert.equal(f.orders[1].status, 'queued');
  // La cola no se termina durante la ventana: otro proceso podría
  // estar a punto de reclamarla para el POST.
  await f.engine.reconcilePending();
  assert.equal(f.orders[1].status, 'queued');
  f.clock.time += WINDOW_MS + 1;
  await f.engine.reconcilePending();
  assert.equal(f.orders[1].status, 'final');
  assert.equal(f.calls.post.length, 1);
});

test('rechaza comisiones desconocidas, orden ajena y cantidades inválidas', () => {
  const o = { symbol: leg.symbol, side: leg.side };
  assert.equal(normalizeTrade(trade(0.2), o, '4611875134427365377').quantity, 0.2);
  assert.equal(normalizeTrade(trade(0.2), o, 'other'), null);
  assert.throws(() => normalizeTrade({ ...trade(0.2), fee: null }, o, trade(0.2).orderId), /incomplete/);
  assert.throws(() => normalizeTrade({ ...trade(0.2), side: 'SELL' }, o, trade(0.2).orderId), /mismatch/);
});

test('clave de señal es estable, ventana exacta diez minutos', () => {
  assert.equal(WINDOW_MS, 600000);
  assert.equal(actionKey(strategy, { type: 'open' }, context()), 'alert:77:open');
  assert.throws(() => actionKey(strategy, { type: 'open' }, { now: 1, signal: {} }), /eventId/);
});

test('bloquea el envío cuando Binance y el ledger tienen exposiciones distintas', async () => {
  const f = fixture();
  f.repo.assertExchangeExposure = async () => { throw new Error('Binance exposure mismatch'); };
  await assert.rejects(f.submit(), /exposure mismatch/);
  assert.equal(f.calls.post.length, 0);
  assert.equal(f.orders.length, 0);
});

test('si la primera pata consume la ventana, jamás envía la segunda', async () => {
  let f;
  f = fixture({ onSubmit: async () => {
    f.clock.time += WINDOW_MS + 1;
    return { orderId: '4611875134427365377', status: 'NEW' };
  } });
  const result = await f.engine.submit(strategy, {
    type: 'open', legs: [leg, { ...leg, symbol: 'BTC-261030-61000-C' }],
  }, context(f.clock.time));
  assert.equal(result.status, 'deadline');
  assert.equal(f.calls.post.length, 1);
  assert.equal(f.orders[1].status, 'queued');
  await f.engine.reconcilePending();
  assert.equal(f.orders[1].status, 'final');
  assert.equal(f.calls.cancel.length, 1);
});

test('paginación con identificadores de 64 bits conserva los fills sin duplicarlos', async () => {
  const f = fixture();
  await f.submit();
  const unrelated = Array.from({ length: 1000 }, (_, i) => ({
    ...trade(0.01, String(i + 1)), orderId: 'other',
    id: String(4611875134427366000n + BigInt(i)),
  }));
  const mine = { ...trade(0.2, '5001'), id: '4611875134427367000' };
  f.setTrades([...unrelated, mine]);
  f.setState('FILLED', 0.2);
  const result = await f.engine.reconcilePending();
  assert.equal(result.errors, 0);
  assert.equal(f.calls.trades.length, 2);
  assert.equal(f.calls.trades[1].fromId, '4611875134427367000');
  assert.equal(f.fills.length, 1);
  assert.equal(f.orders[0].status, 'final');
});
