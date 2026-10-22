const test = require('node:test');
const assert = require('node:assert/strict');

const { createOptionsStrategiesService } = require('../src/services/options/options-strategies.service');
const { createFakeOptionsRepo } = require('./support/options-fake-repo');

const USER = 1;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

function setup({ mode = 'live', market } = {}) {
  const repo = createFakeOptionsRepo({ now: () => NOW });
  const service = createOptionsStrategiesService({
    repo,
    now: () => NOW,
    credentials: { async getClientForUser() { return {}; }, async getLimits() { return {}; } },
    market: market || {
      async getChain() { return { spot: 68000 }; },
      async getQuote() { return { delta: 0.3 }; },
    },
  });
  return { repo, service, mode };
}

test('GET detalle expone el consumo de los límites del libro activo', async () => {
  const { repo, service } = setup();
  const s = await repo.createStrategy({ userId: USER, name: 'x', template: 'short_strangle', underlying: 'BTC', mode: 'live' });
  // Abierta: call vendida 0,01 a strike 70000 (2000 OTM con spot 68000).
  await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'live', symbol: 'BTC-261031-70000-C', side: 'SELL', quantity: 0.01, entryPrice: 100, openedAt: NOW - 3600e3 });
  // Cerrada hoy con pérdida de 20.
  const closed = await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'live', symbol: 'BTC-261017-64000-P', side: 'SELL', quantity: 0.01, entryPrice: 50, openedAt: NOW - 7200e3 });
  await repo.closePosition(closed.id, { exitPrice: 70, closedAt: NOW - 600e3, pnlUsdt: -20, feesUsdt: 0 });
  await repo.insertEvent({ strategyId: s.id, userId: USER, mode: 'live', action: 'open', legs: [{ symbol: 'BTC-261031-70000-C', orderId: '1' }], createdAt: NOW - 3600e3 });

  const detail = await service.get(USER, s.id);

  // margen = 0,01 × (100 + máx(0,15·68000 − 2000, 0,1·68000)) = 83
  assert.equal(detail.usage.mode, 'live');
  assert.equal(detail.usage.marginUsedUsdt, 83);
  assert.equal(detail.usage.dailyLossUsdt, 20);
  assert.equal(detail.usage.ordersToday, 1);
  // Call vendida con Δ 0,3 → −0,003 del subyacente.
  assert.equal(detail.usage.netDelta, -0.003);
});

test('el consumo usa el libro sombra si la estrategia no está en real y tolera un mercado caído', async () => {
  const { repo, service } = setup({
    market: { async getChain() { throw new Error('caído'); }, async getQuote() { throw new Error('caído'); } },
  });
  const s = await repo.createStrategy({ userId: USER, name: 'y', template: 'short_strangle', underlying: 'BTC', mode: 'shadow' });
  await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'shadow', symbol: 'BTC-261031-70000-C', side: 'SELL', quantity: 0.01, entryPrice: 100, openedAt: NOW - 3600e3 });

  const detail = await service.get(USER, s.id);

  assert.equal(detail.usage.mode, 'shadow');
  assert.equal(detail.usage.marginUsedUsdt, null);
  assert.equal(detail.usage.netDelta, null);
  assert.equal(detail.usage.dailyLossUsdt, 0);
  assert.equal(detail.usage.ordersToday, 0);
});

test('no deja salir de Real con posiciones reales abiertas: quedarían sin stop ni TP', async () => {
  const { repo, service } = setup();
  const s = await repo.createStrategy({ userId: USER, name: 'x', template: 'alert_signal', underlying: 'ETH', mode: 'live' });
  await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'live', symbol: 'ETH-261031-2500-C', side: 'BUY', quantity: 0.01, entryPrice: 10, openedAt: NOW - 3600e3 });
  for (const mode of ['paused', 'shadow']) {
    await assert.rejects(service.setMode(USER, s.id, { mode }), (err) => err.code === 'OPEN_LIVE_POSITIONS' && err.status === 409);
  }
  assert.equal((await repo.getStrategy(USER, s.id)).mode, 'live');
});

test('no deja salir de Real con órdenes reales sin finalizar', async () => {
  const repo = createFakeOptionsRepo({ now: () => NOW });
  const service = createOptionsStrategiesService({
    repo, now: () => NOW,
    credentials: { async getClientForUser() { return {}; }, async getLimits() { return {}; } },
    liveOrders: { async listByStrategy() { return [{ id: 1, status: 'active' }]; } },
  });
  const s = await repo.createStrategy({ userId: USER, name: 'x', template: 'alert_signal', underlying: 'ETH', mode: 'live' });
  await assert.rejects(service.setMode(USER, s.id, { mode: 'paused' }), (err) => err.code === 'PENDING_LIVE_ORDERS' && err.status === 409);
});

test('sin posiciones ni órdenes vivas sí se puede pausar una estrategia real', async () => {
  const { repo, service } = setup();
  const s = await repo.createStrategy({ userId: USER, name: 'x', template: 'alert_signal', underlying: 'ETH', mode: 'live' });
  await service.setMode(USER, s.id, { mode: 'paused' });
  assert.equal((await repo.getStrategy(USER, s.id)).mode, 'paused');
});

test('GET detalle de un bot trae solo las órdenes sin finalizar como pendingOrders', async () => {
  const repo = createFakeOptionsRepo({ now: () => NOW });
  const orders = [
    { id: 2, purpose: 'standard', action: 'open', symbol: 'ETH-261031-2500-C', side: 'BUY', quantity: 0.1, limitPrice: 12, processedQty: 0.04, status: 'queued', cancelRequested: false, createdAt: NOW - 1000, deadlineAt: NOW + 1000, error: null },
    { id: 1, purpose: 'standard', action: 'open', symbol: 'ETH-261031-2500-C', side: 'BUY', quantity: 0.1, limitPrice: 11, processedQty: 0.1, status: 'final' },
  ];
  const service = createOptionsStrategiesService({
    repo, now: () => NOW,
    credentials: { async getClientForUser() { return {}; }, async getLimits() { return {}; } },
    liveOrders: { async listByStrategy() { return orders; } },
  });
  const s = await repo.createStrategy({ userId: USER, name: 'x', template: 'alert_signal', underlying: 'ETH', mode: 'live' });
  const detail = await service.get(USER, s.id);
  assert.equal(detail.pendingOrders.length, 1);
  const [o] = detail.pendingOrders;
  assert.equal(o.id, 2);
  assert.equal(o.price, 12);
  assert.equal(o.executedQty, 0.04);
  assert.equal(o.purpose, 'standard');
  assert.equal(o.deadlineAt, NOW + 1000);
  assert.equal(o.limitPrice, undefined);
});

test('GET detalle: closedPositions ordena por cierre desc con motivo y una plantilla ajena no trae pendingOrders', async () => {
  const { repo, service } = setup();
  const s = await repo.createStrategy({ userId: USER, name: 'x', template: 'alert_signal', underlying: 'ETH', mode: 'shadow' });
  const mk = async (symbol, closedAt, closeReason) => {
    const p = await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'shadow', symbol, side: 'BUY', quantity: 0.1, entryPrice: 10, openedAt: NOW - 9e6 });
    await repo.closePosition(p.id, { exitPrice: 12, closedAt, pnlUsdt: 0.2, feesUsdt: 0.01, closeReason });
  };
  await mk('ETH-261031-2500-C', NOW - 5000, 'stop_loss');
  await mk('ETH-261031-2600-C', NOW - 1000, undefined);
  const open = await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'shadow', symbol: 'ETH-261031-2700-C', side: 'BUY', quantity: 0.1, entryPrice: 10, openedAt: NOW });
  const detail = await service.get(USER, s.id);
  assert.deepEqual(detail.closedPositions.map((p) => p.symbol), ['ETH-261031-2600-C', 'ETH-261031-2500-C']);
  assert.equal(detail.closedPositions[1].closeReason, 'stop_loss');
  assert.equal(detail.closedPositions[0].closeReason, null);
  assert.ok(!detail.closedPositions.some((p) => p.id === open.id));
  assert.deepEqual(detail.pendingOrders, []);

  const other = await repo.createStrategy({ userId: USER, name: 'y', template: 'short_strangle', underlying: 'BTC', mode: 'shadow' });
  assert.equal((await service.get(USER, other.id)).pendingOrders, undefined);
});

test('GET detalle: las posiciones abiertas traen mark, bid y ask; si la cotización falla quedan en null', async () => {
  const market = {
    async getChain() { return { spot: 2500 }; },
    async getQuote(symbol) {
      if (symbol.endsWith('-2600-C')) throw new Error('sin datos');
      return { delta: 0.4, mark: 11.5, bid: 11, ask: 12 };
    },
  };
  const { repo, service } = setup({ market });
  const s = await repo.createStrategy({ userId: USER, name: 'x', template: 'alert_signal', underlying: 'ETH', mode: 'shadow' });
  await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'shadow', symbol: 'ETH-261031-2500-C', side: 'BUY', quantity: 0.1, entryPrice: 10, openedAt: NOW });
  await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'shadow', symbol: 'ETH-261031-2600-C', side: 'BUY', quantity: 0.1, entryPrice: 10, openedAt: NOW });

  const detail = await service.get(USER, s.id);

  const ok = detail.positions.find((p) => p.symbol.endsWith('-2500-C'));
  const bad = detail.positions.find((p) => p.symbol.endsWith('-2600-C'));
  assert.deepEqual([ok.mark, ok.bid, ok.ask], [11.5, 11, 12]);
  assert.deepEqual([bad.mark, bad.bid, bad.ask], [null, null, null]);
  assert.equal(detail.usage.netDelta, null);
});

test('usage.committedUsdt: con presupuesto, posiciones del libro + entradas pendientes en Real (cálculo compartido)', async () => {
  const repo = createFakeOptionsRepo({ now: () => NOW });
  let orders = [];
  const service = createOptionsStrategiesService({
    repo, now: () => NOW,
    credentials: { async getClientForUser() { return {}; }, async getLimits() { return {}; } },
    market: { async getChain() { return { spot: 68000 }; }, async getQuote() { return { delta: 0.3 }; } },
    liveOrders: { async listByStrategy() { return orders; } },
  });
  const s = await repo.createStrategy({ userId: USER, name: 'bot', template: 'alert_signal', underlying: 'BTC', mode: 'live',
    params: { alertIds: [1], budgetUsdt: 48, budgetFractions: 4 } });
  await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'live', symbol: 'BTC-261031-70000-C', side: 'BUY', quantity: 0.01, entryPrice: 1200, openedAt: NOW - 3600e3 });
  // La sombra no cuenta en un bot real.
  await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'shadow', symbol: 'BTC-261031-70000-C', side: 'BUY', quantity: 0.01, entryPrice: 1200, openedAt: NOW - 3600e3 });
  orders = [{ id: 1, action: 'open', purpose: 'standard', status: 'active', symbol: 'BTC-261031-71000-C', side: 'BUY', quantity: 0.02, processedQty: 0.01, limitPrice: 1000 }];

  const detail = await service.get(USER, s.id);
  // 12 (posición) + 0,01 × 1000 (pendiente) = 22.
  assert.equal(detail.usage.committedUsdt, 22);
});

test('usage.committedUsdt: null si el bot no tiene presupuesto', async () => {
  const { repo, service } = setup();
  const s = await repo.createStrategy({ userId: USER, name: 'bot', template: 'alert_signal', underlying: 'BTC', mode: 'shadow', params: { alertIds: [1] } });
  const detail = await service.get(USER, s.id);
  assert.equal(detail.usage.committedUsdt, null);
});
