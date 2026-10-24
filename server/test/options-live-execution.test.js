const test = require('node:test');
const assert = require('node:assert/strict');
const { OptionsLiveExecution, normalizeTrade, actionKey, WINDOW_MS, orderTimeInForce } =
  require('../src/services/options/options-live-execution.service');

const strategy = { id: 1, userId: 7, template: 'alert_signal' };
const leg = { symbol: 'BTC-261030-60000-C', side: 'BUY', quantity: 0.5, price: 100 };
const context = (time = 100_000, eventId = 77) =>
  ({ now: time, signal: { eventId, direction: 'bullish' } });
const silent = { warn() {}, info() {}, error() {} };

function fixture({ now = 100_000, onSubmit, leg: l = leg } = {}) {
  const clock = { time: now };
  const orders = [];
  const fills = [];
  const calls = { post: [], get: [], cancel: [], trades: [], info: 0 };
  let nextId = 1;
  const repo = {
    orders, fills,
    async assertExchangeExposure() { return true; },
    batches: [],
    async beginBatch({ action, legs, key, deadlineAt, autoSignalId = null }) {
      if (orders.some((o) => o.key === key || o.status !== 'final')) return null;
      const batchId = repo.batches.length + 1;
      repo.batches.push({ id: batchId, action, autoSignalId });
      return legs.map((l) => {
        const o = { ...l, id: nextId++, batchId, userId: 7, strategyId: 1, action,
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
    async markRejected(id, error) {
      const o = orders.find((x) => x.id === id);
      if (o.status !== 'sending' || o.orderId != null || o.processedQty !== 0) return false;
      Object.assign(o, { status: 'queued', cancelRequested: true, error });
      return true;
    },
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
    // Simula la transacción: si falla, ni se finaliza ni se bloquea.
    blocks: [], resolvedSignals: [], failBlock: false, finishCalls: [],
    async finishOrder(id, orderId, qty, opts = {}) {
      repo.finishCalls.push({ id, opts });
      const o = orders.find((x) => x.id === id);
      if (o.status === 'final') return null;
      assert.ok(Math.abs(o.processedQty - qty) < 1e-8);
      if (opts.block && repo.failBlock) throw new Error('db down');
      const batch = repo.batches.find((b) => b.id === o.batchId);
      const completed = orders.filter((x) => x.batchId === o.batchId && x.id !== id)
        .every((x) => x.status === 'final');
      let resolution = null;
      if (completed && batch.autoSignalId != null && opts.resolveSignal) {
        resolution = opts.resolveSignal(await repo.batchEntryOutcome(o.batchId));
      }
      // commit
      o.status = 'final';
      o.orderId = orderId == null ? null : String(orderId);
      if (opts.block) repo.blocks.push({ strategyId: o.strategyId, ...opts.block });
      if (resolution) repo.resolvedSignals.push({ id: batch.autoSignalId, ...resolution });
      const blocked = !!opts.block;
      return completed
        ? { batchId: o.batchId, completed, action: batch.action, autoSignalId: batch.autoSignalId, blocked,
          signalResolved: !!resolution }
        : { batchId: o.batchId, completed, blocked };
    },
    async batchEntryOutcome(batchId) {
      const batch = repo.batches.find((b) => b.id === batchId);
      const mine = orders.filter((o) => o.batchId === batchId);
      if (!batch || batch.action !== 'open' || !mine.length) return null;
      const got = fills.filter((f) => mine.some((o) => o.id === f.orderId));
      const filled = got.reduce((a, f) => a + f.quantity, 0);
      const notional = got.reduce((a, f) => a + f.quantity * f.price, 0);
      const round = (x) => Number(x.toFixed(12));
      return {
        autoSignalId: batch.autoSignalId,
        requested: round(mine.reduce((a, o) => a + o.quantity, 0)),
        filled: round(filled), avgPrice: filled > 0 ? round(notional / filled) : null,
        feesUsdt: round(got.reduce((a, f) => a + f.fee, 0)),
        symbol: mine[0].symbol, side: mine[0].side,
        cancelRequested: mine.some((o) => o.cancelRequested === true),
        rejected: mine.some((o) => /^Rechazada por Binance/.test(o.error || '')),
      };
    },
    incidents: [],
    async claimIncidentNotification(userId, kind, resource) {
      if (repo.incidents.some((i) => i.kind === kind && i.resource === resource)) return false;
      repo.incidents.push({ userId, kind, resource });
      return true;
    },
  };
  const strategiesRepo = {
    resolved: [], fees: [], blocks: [],
    async resolveAutoSignal(id, patch) { strategiesRepo.resolved.push({ id, ...patch }); return { id }; },
    async setAutoSignalFees(id, patch) { strategiesRepo.fees.push({ id, ...patch }); return { id }; },
    async setUnderlyingBlock(strategyId, underlying, patch) {
      strategiesRepo.blocks.push({ strategyId, underlying, ...patch }); return { id: strategyId };
    },
  };
  const notes = [];
  const state = { status: 'NEW', executedQty: '0', quantity: String(l.quantity), type: 'LIMIT', timeInForce: 'GTC' };
  let allTrades = [];
  let openOrders = [];
  const client = {
    async getExchangeInfo() {
      calls.info += 1;
      const symbols = [60000, 61000, 62000].map((strike) => `BTC-261030-${strike}-C`);
      if (!symbols.includes(l.symbol)) symbols.push(l.symbol);
      return { optionSymbols: symbols.map((symbol) => ({
        symbol, status: 'TRADING',
        quoteAsset: 'USDT', expiryDate: 9999999999999,
        filters: [{ filterType: 'PRICE_FILTER', minPrice: '0',
          maxPrice: '1000000', tickSize: '0.01', minQty: '0.01',
          maxQty: '100', stepSize: '0.01' }],
      })) };
    },
    async placeOrder(payload) {
      calls.post.push(payload);
      if (onSubmit) return onSubmit(payload);
      return { orderId: '4611875134427365377', status: 'NEW', executedQty: '0' };
    },
    async getOrder(payload) {
      calls.get.push(payload);
      return { orderId: '4611875134427365377', clientOrderId: orders[0].clientOrderId,
        symbol: l.symbol, side: l.side, ...state };
    },
    async getUserTrades(payload) {
      calls.trades.push(payload);
      const pages = payload.fromId == null ? allTrades
        : allTrades.filter((t) => BigInt(String(t.id)) >= BigInt(payload.fromId));
      return pages.slice(0, payload.limit);
    },
    async getPositions() { return []; },
    async getOpenOrders() { return openOrders; },
    async cancelOrder(payload) {
      calls.cancel.push(payload);
      state.status = 'CANCELED';
      return { status: 'CANCELED' };
    },
  };
  const credentials = { async getClientForUser() { return client; } };
  const engine = new OptionsLiveExecution({ repo, credentials, logger: silent, enabled: true, now: () => clock.time,
    targetRepo: strategiesRepo, notify: async (userId, text) => { notes.push({ userId, text }); } });
  const submit = (eventId = 77, signalId) =>
    engine.submit(strategy, { type: 'open', legs: [l], detail: 'señal' },
      { now: clock.time, signal: { eventId, direction: 'bullish', ...(signalId == null ? {} : { signalId }) } });
  const setState = (status, executedQty) => Object.assign(state, { status, executedQty: String(executedQty) });
  const setTrades = (list) => { allTrades = list; };
  const setOpenOrders = (list) => { openOrders = list; };
  const setExchangeInfo = (fn) => { client.getExchangeInfo = fn; };
  return { engine, repo, orders, fills, clock, calls, client, submit, setState, setTrades, setOpenOrders,
    strategiesRepo, notes, setExchangeInfo };
}
function trade(quantity, tradeId = '300', l = leg) {
  return { orderId: '4611875134427365377', tradeId, symbol: l.symbol,
    side: l.side, quantity: String(quantity), price: '98', fee: '-0.15',
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

test('bloquea nuevas órdenes cuando hay órdenes manuales abiertas en Binance', async () => {
  const f = fixture();
  f.setOpenOrders([{ symbol: leg.symbol, orderId: '555', status: 'NEW' }]);
  await assert.rejects(f.submit(), /no gestionadas por la app.*manual reconciliation required/);
  assert.equal(f.calls.post.length, 0);
  assert.equal(f.orders.length, 0);
});

test('abrir tolera órdenes abiertas que solo son TPs resting propios', async () => {
  const f = fixture();
  f.repo.listRestingTpOrderIds = async () => [
    { clientOrderId: 'HCTP1', orderId: '900' }, { clientOrderId: 'HCTP2', orderId: null }];
  f.setOpenOrders([
    { symbol: leg.symbol, clientOrderId: 'HCTP1', orderId: '900', status: 'NEW' },
    { symbol: leg.symbol, clientOrderId: 'HCTP2', orderId: '902', status: 'NEW' },
  ]);
  assert.equal((await f.submit()).status, 'submitted');
  assert.equal(f.calls.post.length, 1);
});

test('abrir con TP propio y una orden desconocida sigue bloqueado', async () => {
  const f = fixture();
  f.repo.listRestingTpOrderIds = async () => [{ clientOrderId: 'HCTP1', orderId: '900' }];
  f.setOpenOrders([
    { symbol: leg.symbol, clientOrderId: 'HCTP1', orderId: '900', status: 'NEW' },
    { symbol: leg.symbol, clientOrderId: 'manual', orderId: '555', status: 'NEW' },
  ]);
  await assert.rejects(f.submit(), /órdenes abiertas no gestionadas por la app.*manual reconciliation required/);
  assert.equal(f.calls.post.length, 0);
  assert.equal(f.orders.length, 0);
});

test('sin listRestingTpOrderIds, abrir con órdenes abiertas sigue bloqueado', async () => {
  const f = fixture();
  f.setOpenOrders([{ symbol: leg.symbol, clientOrderId: 'HCTP1', orderId: '900', status: 'NEW' }]);
  await assert.rejects(f.submit(), /manual reconciliation required/);
  assert.equal(f.calls.post.length, 0);
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

test('conciliación recupera el estado reclamado aunque el listado previo indique queued', async () => {
  const f = fixture();
  await f.submit();
  // Otra réplica puede pasar queued -> sending entre SELECT y el claim.
  // Se usa el estado obtenido bajo el lease, no el snapshot anterior.
  const originalList = f.repo.listUnresolved.bind(f.repo);
  f.repo.listUnresolved = async () => (await originalList()).map((o) => ({ ...o, status: 'queued' }));
  const result = await f.engine.reconcilePending();
  assert.equal(result.errors, 0);
  assert.equal(f.calls.get.length, 1);
  assert.equal(f.orders[0].status, 'active');
  assert.equal(f.calls.post.length, 1);
});

const { AppError } = require('../src/errors/app-error');
const binanceError = (code, httpStatus, binanceCode) =>
  new AppError('Binance', { status: 400, code, details: { endpoint: '/eapi/v1/order', httpStatus, binanceCode } });

test('un rechazo definitivo de Binance no deja la orden en attention para siempre', async () => {
  const f = fixture({ onSubmit: async () => { throw binanceError('BINANCE_OPTIONS_REJECTED', 400, -2010); } });
  const result = await f.submit();
  assert.equal(result.status, 'rejected');
  assert.notEqual(f.orders[0].status, 'attention');
  await f.engine.reconcilePending();
  assert.equal(f.orders[0].status, 'final');
  assert.equal(f.orders[0].processedQty, 0);
  assert.equal(f.calls.get.length, 0);
  assert.equal(f.calls.post.length, 1);
});

test('el enfriamiento local por límite de peticiones tampoco bloquea el lote', async () => {
  const f = fixture({ onSubmit: async () => {
    throw new AppError('limite', { status: 429, code: 'BINANCE_OPTIONS_RATE_LIMIT', details: { endpoint: '/eapi/v1/order' } });
  } });
  assert.equal((await f.submit()).status, 'rejected');
  await f.engine.reconcilePending();
  assert.equal(f.orders[0].status, 'final');
});

test('un -1007 de Binance (estado desconocido) sigue tratándose como envío ambiguo', async () => {
  const f = fixture({ onSubmit: async () => { throw binanceError('BINANCE_OPTIONS_REJECTED', 400, -1007); } });
  assert.equal((await f.submit()).status, 'attention');
  assert.equal(f.orders[0].status, 'attention');
});

// Aperturas al medio: GTC en cualquier subyacente; ETH conserva FOK al cerrar.
const ethLeg = { symbol: 'ETH-261031-2500-C', side: 'BUY', quantity: 0.2, price: 715 };

test('ETH open is GTC; ETH close stays FOK and the resting TP GTC', () => {
  assert.equal(orderTimeInForce({ symbol: 'ETH-261031-2500-C', action: 'open' }), 'GTC');
  assert.equal(orderTimeInForce({ symbol: 'BTC-261031-60000-C', action: 'open' }), 'GTC');
  assert.equal(orderTimeInForce({ symbol: 'ETH-261031-2500-C', action: 'close' }), 'FOK');
  assert.equal(orderTimeInForce({ symbol: 'ETH-261031-2500-C', action: 'close', purpose: 'take_profit' }), 'GTC');
  assert.equal(orderTimeInForce({ symbol: 'BTC-261031-60000-C', action: 'close' }), 'GTC');
});

test('ETH open is posted to Binance as GTC', async () => {
  const f = fixture({ leg: ethLeg });
  assert.equal((await f.submit()).status, 'submitted');
  assert.equal(f.calls.post[0].timeInForce, 'GTC');
  assert.equal(f.calls.post[0].price, 715);
  assert.equal(f.calls.post[0].reduceOnly, false);
});

test('partial GTC open is not an anomaly: finalizes with the confirmed quantity', async () => {
  const f = fixture({ leg: ethLeg });
  await f.submit();
  f.setTrades([trade(0.1, '300', ethLeg)]);
  f.setState('PARTIALLY_FILLED', 0.1);
  let result = await f.engine.reconcilePending();
  assert.equal(result.errors, 0);
  assert.equal(f.orders[0].processedQty, 0.1);
  assert.notEqual(f.orders[0].status, 'attention');
  f.clock.time += WINDOW_MS + 1;
  result = await f.engine.reconcilePending();
  assert.equal(result.errors, 0);
  assert.equal(f.calls.cancel.length, 1);
  assert.equal(f.orders[0].status, 'final');
  assert.equal(f.orders[0].processedQty, 0.1);
  assert.equal(f.calls.post.length, 1);
});

// ---------- señal → entrada real: resolución con comisión real ----------

const btcSignalLeg = { symbol: 'BTC-261030-60000-C', side: 'BUY', quantity: 0.35, price: 712 };
const fillOf = (quantity, fee, tradeId, l = btcSignalLeg) => ({ ...trade(quantity, tradeId, l), price: '712', fee: String(-fee) });

test('submit links the batch to the bot signal (autoSignalId)', async () => {
  const f = fixture({ leg: btcSignalLeg });
  await f.submit(77, 31);
  assert.equal(f.repo.batches[0].autoSignalId, 31);
  const g = fixture({ leg: btcSignalLeg });
  await g.submit(78);
  assert.equal(g.repo.batches[0].autoSignalId, null);
});

test('signal resolves to opened with real fee', async () => {
  const f = fixture({ leg: btcSignalLeg });
  await f.submit(77, 31);
  f.setTrades([fillOf(0.35, 7.14, '300')]);
  f.setState('FILLED', 0.35);
  const result = await f.engine.reconcilePending();
  assert.equal(result.errors, 0);
  assert.equal(f.orders[0].status, 'final');
  assert.deepEqual(f.repo.resolvedSignals, [{
    id: 31, decision: 'opened',
    detail: 'Real: Compra 0,35 BTC-261030-60000-C a 712 · comisión 7,14 USDT',
    feesUsdt: 7.14, feesEstimated: false,
  }]);
  assert.equal(f.repo.blocks.length, 0);
});

test('partial entry resolves to opened with the partial note', async () => {
  const f = fixture({ leg: btcSignalLeg });
  await f.submit(77, 31);
  f.setTrades([fillOf(0.1, 2.04, '300')]);
  f.setState('PARTIALLY_FILLED', 0.1);
  await f.engine.reconcilePending();
  assert.equal(f.repo.resolvedSignals.length, 0, 'no se resuelve antes del final');
  f.clock.time += WINDOW_MS + 1;
  await f.engine.reconcilePending();
  assert.equal(f.orders[0].status, 'final');
  assert.deepEqual(f.repo.resolvedSignals, [{
    id: 31, decision: 'opened',
    detail: 'Real: Compra 0,10 BTC-261030-60000-C a 712 · comisión 2,04 USDT · parcial: 0,10 de 0,35',
    feesUsdt: 2.04, feesEstimated: false,
  }]);
});

test('unfilled entry resolves as not executed', async () => {
  const f = fixture({ leg: btcSignalLeg });
  await f.submit(77, 31);
  f.clock.time += WINDOW_MS + 1;
  const result = await f.engine.reconcilePending();
  assert.equal(result.errors, 0);
  assert.equal(f.orders[0].status, 'final');
  assert.deepEqual(f.repo.resolvedSignals, [{
    id: 31, decision: 'ignored', detail: 'Real: Entrada sin ejecutar en 10 min',
    feesUsdt: 0, feesEstimated: false,
  }]);
});

test('unfilled entry cancelled by an opposite signal says so', async () => {
  const f = fixture({ leg: btcSignalLeg });
  await f.submit(77, 31);
  f.orders[0].cancelRequested = true;
  await f.engine.reconcilePending();
  assert.equal(f.orders[0].status, 'final');
  assert.equal(f.repo.resolvedSignals[0].decision, 'ignored');
  assert.equal(f.repo.resolvedSignals[0].detail, 'Real: Entrada cancelada por señal contraria');
});

test('entry rejected by Binance resolves as rejected, not as a contrary signal', async () => {
  const f = fixture({ leg: btcSignalLeg,
    onSubmit: async () => { throw binanceError('BINANCE_OPTIONS_REJECTED', 400, -2010); } });
  await f.submit(77, 31);
  await f.engine.reconcilePending();
  assert.equal(f.orders[0].status, 'final');
  assert.equal(f.repo.resolvedSignals[0].decision, 'ignored');
  assert.equal(f.repo.resolvedSignals[0].detail, 'Real: Entrada rechazada por Binance');
});

test('a batch without a linked signal is not resolved', async () => {
  const f = fixture({ leg: btcSignalLeg });
  await f.submit(77);
  f.setTrades([fillOf(0.35, 7.14, '300')]);
  f.setState('FILLED', 0.35);
  await f.engine.reconcilePending();
  assert.equal(f.orders[0].status, 'final');
  assert.equal(f.repo.resolvedSignals.length, 0);
});

test('partial inoperable fill blocks the underlying', async () => {
  const f = fixture({ leg: ethLeg });
  await f.submit(77, 31);
  f.setTrades([{ ...trade(0.005, '300', ethLeg), price: '715', fee: '-0.1' }]);
  f.setState('PARTIALLY_FILLED', 0.005);
  await f.engine.reconcilePending();
  f.clock.time += WINDOW_MS + 1;
  const result = await f.engine.reconcilePending();
  assert.equal(result.errors, 0);
  assert.equal(f.orders[0].status, 'final', 'no queda en atención: no bloquea otros lotes');
  assert.equal(f.repo.blocks.length, 1);
  assert.equal(f.strategiesRepo.blocks.length, 0, 'el bloqueo va en la transacción de finishOrder');
  assert.ok(f.repo.finishCalls.at(-1).opts.block);
  assert.match(f.notes[0].text, /no abrirá más en ETH/);
  const [block] = f.repo.blocks;
  assert.equal(block.strategyId, 1);
  assert.equal(block.underlying, 'ETH');
  assert.equal(block.reason, 'Resto no operable de 0,005 contratos en ETH-261031-2500-C');
  assert.equal(block.at, f.clock.time);
  assert.deepEqual(f.repo.incidents.map((i) => i.kind), ['ENTRY_REMAINDER_INOPERABLE']);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /Resto no operable de 0,005 contratos en ETH-261031-2500-C/);
  assert.equal(f.repo.resolvedSignals[0].decision, 'opened');
  await f.engine.reconcilePending();
  assert.equal(f.notes.length, 1, 'un único aviso');
});

test('orderable partial fill does not block the underlying', async () => {
  const f = fixture({ leg: ethLeg });
  await f.submit(77, 31);
  f.setTrades([trade(0.1, '300', ethLeg)]);
  f.setState('PARTIALLY_FILLED', 0.1);
  await f.engine.reconcilePending();
  f.clock.time += WINDOW_MS + 1;
  await f.engine.reconcilePending();
  assert.equal(f.repo.blocks.length, 0);
  assert.equal(f.notes.length, 0);
});

test('unknown lot filters fail safe: block the underlying and alert', async () => {
  const f = fixture({ leg: ethLeg });
  await f.submit(77, 31);
  f.setTrades([trade(0.1, '300', ethLeg)]);
  f.setState('PARTIALLY_FILLED', 0.1);
  await f.engine.reconcilePending();
  f.setExchangeInfo(async () => { throw new Error('exchangeInfo down'); });
  f.clock.time += WINDOW_MS + 1;
  const result = await f.engine.reconcilePending();
  assert.equal(result.errors, 0);
  assert.equal(f.orders[0].status, 'final');
  assert.equal(f.repo.blocks.length, 1);
  assert.equal(f.repo.blocks[0].underlying, 'ETH');
  assert.match(f.repo.blocks[0].reason, /^Resto no operable de 0,10 contratos en ETH-261031-2500-C/);
  assert.equal(f.notes.length, 1);
});

test('two 0.005 fills of a 0.01 entry block the underlying (per position row)', async () => {
  const leg01 = { ...ethLeg, quantity: 0.01 };
  const f = fixture({ leg: leg01 });
  await f.submit(77, 31);
  f.setTrades([{ ...trade(0.005, '300', leg01), price: '715', fee: '-0.1' },
    { ...trade(0.005, '301', leg01), price: '715', fee: '-0.1', time: 101_500 }]);
  f.setState('FILLED', 0.01);
  const result = await f.engine.reconcilePending();
  assert.equal(result.errors, 0);
  assert.equal(f.orders[0].status, 'final');
  assert.equal(f.repo.blocks.length, 1);
  assert.equal(f.repo.blocks[0].underlying, 'ETH');
  assert.equal(f.repo.blocks[0].reason, 'Resto no operable de 0,01 contratos en ETH-261031-2500-C (2 posiciones)');
  assert.equal(f.notes.length, 1);
  assert.equal(f.repo.resolvedSignals[0].decision, 'opened');
});

test('a single full fill needs no lot filters and never blocks', async () => {
  const f = fixture({ leg: ethLeg });
  await f.submit(77, 31);
  const before = f.calls.info;
  f.setExchangeInfo(async () => { throw new Error('exchangeInfo down'); });
  f.setTrades([trade(0.2, '300', ethLeg)]);
  f.setState('FILLED', 0.2);
  const result = await f.engine.reconcilePending();
  assert.equal(result.errors, 0);
  assert.equal(f.calls.info, before);
  assert.equal(f.orders[0].status, 'final');
  assert.equal(f.repo.blocks.length, 0);
  assert.equal(f.notes.length, 0);
});

test('if the block cannot be written the order is not finalized and the alert says NOT blocked; next pass retries', async () => {
  const f = fixture({ leg: ethLeg });
  await f.submit(77, 31);
  f.setTrades([{ ...trade(0.005, '300', ethLeg), price: '715', fee: '-0.1' }]);
  f.setState('PARTIALLY_FILLED', 0.005);
  await f.engine.reconcilePending();
  f.clock.time += WINDOW_MS + 1;
  f.repo.failBlock = true;
  let result = await f.engine.reconcilePending();
  assert.equal(result.errors, 1);
  assert.notEqual(f.orders[0].status, 'final');
  assert.equal(f.repo.blocks.length, 0);
  assert.equal(f.repo.resolvedSignals.length, 0);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0].text, /NO se pudo bloquear ETH; revisa manualmente/);
  assert.doesNotMatch(f.notes[0].text, /no abrirá más/);
  f.repo.failBlock = false;
  result = await f.engine.reconcilePending();
  assert.equal(result.errors, 0);
  assert.equal(f.orders[0].status, 'final');
  assert.equal(f.repo.blocks.length, 1);
  assert.equal(f.repo.resolvedSignals.length, 1);
  assert.match(f.notes.at(-1).text, /no abrirá más en ETH/);
});

test('a crash after the commit (alert fails) no longer loses the block or the resolution', async () => {
  const f = fixture({ leg: ethLeg });
  await f.submit(77, 31);
  f.setTrades([{ ...trade(0.005, '300', ethLeg), price: '715', fee: '-0.1' }]);
  f.setState('PARTIALLY_FILLED', 0.005);
  await f.engine.reconcilePending();
  f.clock.time += WINDOW_MS + 1;
  f.engine.notify = async () => { throw new Error('telegram down'); };
  const result = await f.engine.reconcilePending();
  assert.equal(result.errors, 0);
  assert.equal(f.orders[0].status, 'final');
  assert.equal(f.repo.blocks.length, 1);
  assert.equal(f.repo.resolvedSignals.length, 1);
});

test('una entrada GTC propia en reposo no bloquea el cierre de otra posición; el del mismo contrato se difiere y la cancela', async () => {
  const f = fixture();
  // Entrada BTC propia en reposo (no final) en el ledger y en Binance.
  f.repo.listOwnOpenOrderIds = async () => [{ clientOrderId: 'HCENTRY', orderId: '777' }];
  f.repo.listRestingTpOrderIds = async () => [];
  f.setOpenOrders([{ symbol: leg.symbol, clientOrderId: 'HCENTRY', orderId: '777', status: 'PARTIALLY_FILLED' }]);
  // Mismo criterio que deferExitIfProtected real: una entrada propia no final
  // en el contrato del cierre difiere la salida y pide cancelar la entrada.
  const deferred = [];
  f.repo.deferExitIfProtected = async (_s, action) => {
    const hit = action.legs.some((l) => l.symbol === leg.symbol);
    if (hit) deferred.push(action.legs.map((l) => l.positionId));
    return hit;
  };
  // El lote de cierre lo admite el repositorio (probado aparte): aquí solo el preflight.
  f.repo.beginBatch = async ({ legs, deadlineAt }) => legs.map((l, i) => ({
    ...l, id: 100 + i, batchId: 50, clientOrderId: 'HCCLOSE' + i, quantity: l.quantity,
    limitPrice: l.price, deadlineAt, status: 'queued' }));
  f.repo.markSending = async (id) => ({ id });
  f.repo.markActive = async () => {};
  const other = { symbol: 'BTC-261030-61000-C', side: 'SELL', quantity: 0.5, price: 100, positionId: 41 };
  const partial = { ...leg, side: 'SELL', quantity: 0.2, positionId: 42 };
  const otherRes = await f.engine.submit(strategy, { type: 'close', reason: 'stop_loss', legs: [other] },
    { now: f.clock.time });
  assert.equal(otherRes.status, 'submitted');
  const partialRes = await f.engine.submit(strategy, { type: 'close', reason: 'stop_loss', legs: [partial] },
    { now: f.clock.time });
  assert.equal(partialRes.status, 'tp_cancel_requested');
  assert.deepEqual(deferred, [[42]]);
  // Solo sale el cierre del otro contrato; el del parcial espera a que la
  // entrada quede cancelada y conciliada (listReadyExitRequests).
  assert.equal(f.calls.post.length, 1);
  assert.equal(f.calls.post[0].symbol, other.symbol);
  assert.equal(f.calls.post[0].reduceOnly, true);
});

test('con la entrada propia en reposo, una orden ajena sigue bloqueando', async () => {
  const f = fixture();
  f.repo.listOwnOpenOrderIds = async () => [{ clientOrderId: 'HCENTRY', orderId: '777' }];
  f.setOpenOrders([
    { symbol: leg.symbol, clientOrderId: 'HCENTRY', orderId: '777', status: 'NEW' },
    { symbol: leg.symbol, clientOrderId: 'manual', orderId: '555', status: 'NEW' },
  ]);
  await assert.rejects(f.submit(), /no gestionadas por la app/);
  assert.equal(f.calls.post.length, 0);
});
