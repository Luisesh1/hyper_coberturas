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
