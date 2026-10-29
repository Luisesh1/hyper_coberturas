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

test('GET detalle: closedPositions incluye el rango de la prima (o null sin registro)', async () => {
  const { repo, service } = setup();
  const s = await repo.createStrategy({ userId: USER, name: 'x', template: 'alert_signal', underlying: 'ETH', mode: 'shadow' });
  const range = { high: { price: 14, at: NOW - 4000 }, low: { price: 8, at: NOW - 7000 }, partial: false };
  const a = await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'shadow', symbol: 'ETH-261031-2500-C', side: 'BUY', quantity: 0.1, entryPrice: 10, openedAt: NOW - 9e6, premiumRange: range });
  await repo.closePosition(a.id, { exitPrice: 12, closedAt: NOW - 1000, pnlUsdt: 0.2, feesUsdt: 0.01 });
  const b = await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'shadow', symbol: 'ETH-261031-2600-C', side: 'BUY', quantity: 0.1, entryPrice: 10, openedAt: NOW - 9e6 });
  await repo.closePosition(b.id, { exitPrice: 12, closedAt: NOW - 2000, pnlUsdt: 0.2, feesUsdt: 0.01 });
  const detail = await service.get(USER, s.id);
  assert.deepEqual(detail.closedPositions[0].premiumRange, range);
  assert.equal(detail.closedPositions[1].premiumRange, null);
});

test('GET detalle: closedPositions incluye el objetivo de TP fijado', async () => {
  const { repo, service } = setup();
  const s = await repo.createStrategy({ userId: USER, name: 'x', template: 'alert_signal', underlying: 'ETH', mode: 'shadow' });
  const meta = { spot: 2400, bandValue: 2350, distancePct: -2.1, leverage: 12, appliedGainPct: 25, capped: false };
  const a = await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'shadow', symbol: 'ETH-261031-2500-P', side: 'BUY', quantity: 0.1, entryPrice: 10, openedAt: NOW - 9e6 });
  await repo.setTpTarget(a.id, 12.5, meta);
  await repo.closePosition(a.id, { exitPrice: 12.5, closedAt: NOW - 1000, pnlUsdt: 0.25, feesUsdt: 0.01, closeReason: 'take_profit_atr_band' });
  const [p] = (await service.get(USER, s.id)).closedPositions;
  assert.equal(p.tpTargetPrice, 12.5);
  assert.deepEqual(p.tpTargetMeta, meta);
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
  assert.equal(detail.usage.reservedUsdt, 10);
});

test('usage.committedUsdt: sin presupuesto también se calcula (KPI «en uso»)', async () => {
  const { repo, service } = setup();
  const s = await repo.createStrategy({ userId: USER, name: 'bot', template: 'alert_signal', underlying: 'BTC', mode: 'shadow', params: { alertIds: [1] } });
  await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'shadow', symbol: 'BTC-261031-70000-C', side: 'BUY', quantity: 0.01, entryPrice: 1200, openedAt: NOW - 3600e3 });
  const detail = await service.get(USER, s.id);
  assert.equal(detail.usage.committedUsdt, 12);
  assert.equal(detail.usage.reservedUsdt, 0);
});

test('usage.reservedUsdt: la parte de entradas pendientes; en sombra cuentan las simuladas como en el runner', async () => {
  const repo = createFakeOptionsRepo({ now: () => NOW });
  const shadowPending = [{ id: 4, strategyId: 0, status: 'pending', symbol: 'BTC-261031-71000-C', side: 'BUY',
    optionType: 'C', quantity: 0.02, limitPrice: 1000, deadlineAt: NOW + 60_000 }];
  const service = createOptionsStrategiesService({
    repo, now: () => NOW,
    credentials: { async getClientForUser() { return {}; }, async getLimits() { return {}; } },
    market: { async getChain() { return { spot: 68000 }; }, async getQuote() { return { delta: 0.3 }; } },
    liveOrders: { async listByStrategy() { return []; } },
    shadowEntries: { async listPending() { return shadowPending; } },
  });
  const s = await repo.createStrategy({ userId: USER, name: 'bot', template: 'alert_signal', underlying: 'BTC', mode: 'shadow',
    params: { alertIds: [1], budgetUsdt: 100, budgetFractions: 4 } });
  await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'shadow', symbol: 'BTC-261031-70000-C', side: 'BUY', quantity: 0.01, entryPrice: 1200, openedAt: NOW - 3600e3 });
  const detail = await service.get(USER, s.id);
  // 12 (posición) + 0,02 × 1000 (entrada simulada pendiente) = 32.
  assert.equal(detail.usage.committedUsdt, 32);
  assert.equal(detail.usage.reservedUsdt, 20);
});

test('usage de un bot multi-subyacente: margen y comprometido con el spot del subyacente de cada posición', async () => {
  const spots = { BTC: 68000, ETH: 3000 };
  const asked = [];
  const { repo, service } = setup({
    market: {
      async getChain(underlying) { asked.push(underlying); return { spot: spots[underlying] }; },
      async getQuote() { return { delta: 0.3 }; },
    },
  });
  const s = await repo.createStrategy({ userId: USER, name: 'm', template: 'alert_signal', underlying: 'BTC', params: { alertIds: [1], underlyings: ['BTC', 'ETH'], structure: 'sell_against', budgetUsdt: 10000 }, mode: 'shadow' });
  // BTC: 0,01 × (100 + máx(0,15·68000 − 2000, 6800)) = 83. ETH: 0,1 × (10 + máx(0,15·3000 − 200, 300)) = 31.
  await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'shadow', symbol: 'BTC-261031-70000-C', side: 'SELL', quantity: 0.01, entryPrice: 100, openedAt: NOW - 3600e3 });
  await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'shadow', symbol: 'ETH-261031-3200-C', side: 'SELL', quantity: 0.1, entryPrice: 10, openedAt: NOW - 3600e3 });

  const detail = await service.get(USER, s.id);
  assert.equal(detail.usage.marginUsedUsdt, 114);
  assert.equal(detail.usage.committedUsdt, 114);
  assert.deepEqual([...new Set(asked)].sort(), ['BTC', 'ETH']);
});

test('netDelta es null si las posiciones abiertas abarcan varios subyacentes (unidades distintas)', async () => {
  const { repo, service } = setup();
  const s = await repo.createStrategy({ userId: USER, name: 'm', template: 'alert_signal', underlying: 'BTC', mode: 'live',
    params: { alertIds: [1], underlyings: ['BTC', 'ETH'] } });
  await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'live', symbol: 'BTC-261031-70000-C', side: 'BUY', quantity: 0.01, entryPrice: 100, openedAt: NOW - 3600e3 });
  await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'live', symbol: 'ETH-261031-2500-C', side: 'BUY', quantity: 0.1, entryPrice: 10, openedAt: NOW - 3600e3 });
  assert.equal((await service.get(USER, s.id)).usage.netDelta, null);

  // Un solo subyacente (aunque el bot opere varios): sí se suma.
  const one = await repo.createStrategy({ userId: USER, name: 'o', template: 'alert_signal', underlying: 'BTC', mode: 'live',
    params: { alertIds: [1], underlyings: ['BTC', 'ETH'] } });
  await repo.insertPosition({ strategyId: one.id, userId: USER, mode: 'live', symbol: 'ETH-261031-2500-C', side: 'BUY', quantity: 0.1, entryPrice: 10, openedAt: NOW - 3600e3 });
  assert.equal((await service.get(USER, one.id)).usage.netDelta, 0.03);
});

test('kpis feeBreakdown sums components and reports unallocated history', () => {
  const { kpisFor } = require('../src/services/options/options-strategies.service');
  const positions = [
    // Abierta: solo entrada.
    { mode: 'live', openedAt: 1, closedAt: null, feesUsdt: 1, entryFeeUsdt: 1, exitFeeUsdt: null, exerciseFeeUsdt: null },
    // Cerrada con salida.
    { mode: 'live', openedAt: 2, closedAt: 5, pnlUsdt: 3, feesUsdt: 2.5, entryFeeUsdt: 2, exitFeeUsdt: 0.5, exerciseFeeUsdt: null },
    // Vencida con ejercicio.
    { mode: 'live', openedAt: 3, closedAt: 6, pnlUsdt: -1, feesUsdt: 1.75, entryFeeUsdt: 1.5, exitFeeUsdt: null, exerciseFeeUsdt: 0.25 },
    // Histórica sin desglose.
    { mode: 'live', openedAt: 4, closedAt: 7, pnlUsdt: 1, feesUsdt: 4, entryFeeUsdt: null, exitFeeUsdt: null, exerciseFeeUsdt: null },
    // Otro libro: no cuenta.
    { mode: 'shadow', openedAt: 1, closedAt: null, feesUsdt: 9, entryFeeUsdt: 9 },
  ];
  const k = kpisFor(positions, [], 'live', NOW);
  assert.equal(k.feesUsdt, 9.25);
  assert.deepEqual(k.feeBreakdown, { entryUsdt: 4.5, exitUsdt: 0.5, exerciseUsdt: 0.25, unallocatedUsdt: 4 });
  const empty = kpisFor([], [], 'live', NOW);
  assert.deepEqual(empty.feeBreakdown, { entryUsdt: 0, exitUsdt: 0, exerciseUsdt: 0, unallocatedUsdt: 0 });
});

test('GET detalle: pendingEntries une sombra y real con bid/ask, comisión estimada y bloqueos; posiciones traen desglose de comisiones', async () => {
  const market = {
    async getChain() { return { spot: 68000 }; },
    async getQuote() { return { delta: 0.3, bid: 90, ask: 110 }; },
  };
  const repo = createFakeOptionsRepo({ now: () => NOW });
  const service = createOptionsStrategiesService({
    repo, now: () => NOW, market,
    credentials: { async getClientForUser() { return {}; }, async getLimits() { return {}; } },
    shadowEntries: { async listPending() {
      return [{ id: 3, strategyId: 1, symbol: 'BTC-261031-70000-C', side: 'BUY', optionType: 'CALL', quantity: 0.1, limitPrice: 100, spot: 68000, deadlineAt: NOW + 1000, status: 'pending' }];
    } },
    liveOrders: { async listByStrategy() {
      return [
        { id: 9, purpose: 'entry', action: 'open', status: 'working', symbol: 'BTC-261031-72000-C', side: 'BUY', quantity: 0.2, processedQty: 0.05, limitPrice: 50, deadlineAt: NOW + 2000, cancelRequested: false },
        { id: 10, purpose: 'entry', action: 'open', status: 'final', symbol: 'BTC-261031-72000-C', side: 'BUY', quantity: 0.2, processedQty: 0.2, limitPrice: 50, deadlineAt: NOW },
        { id: 11, purpose: 'exit', action: 'close', status: 'working', symbol: 'BTC-261031-72000-C', side: 'SELL', quantity: 0.2, processedQty: 0, limitPrice: 50, deadlineAt: NOW },
      ];
    } },
  });
  const s = await repo.createStrategy({ userId: USER, name: 'x', template: 'alert_signal', underlying: 'BTC', mode: 'live' });
  repo.strategies[0].state = { blockedUnderlyings: { BTC: { reason: 'r', at: 5 } } };
  const closed = await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'live', symbol: 'BTC-261017-64000-P', side: 'BUY', quantity: 0.01, entryPrice: 50, openedAt: NOW - 7200e3 });
  await repo.closePosition(closed.id, { exitPrice: 70, closedAt: NOW - 600e3, pnlUsdt: 1, feesUsdt: 0.7, entryFeeUsdt: 0.5, exitFeeUsdt: 0.2 });

  const d = await service.get(USER, s.id);

  assert.deepEqual(d.pendingEntries.map((e) => [e.id, e.mode, e.executedQty, e.bid, e.ask, e.deadlineAt]),
    [[3, 'shadow', 0, 90, 110, NOW + 1000], [9, 'live', 0.05, 90, 110, NOW + 2000]]);
  assert.ok(d.pendingEntries.every((e) => e.feesEstUsdt > 0));
  assert.deepEqual(Object.keys(d.blockedUnderlyings), ['BTC']);
  assert.equal(d.kpis.live.feesPctOfPremium, null);
  assert.equal(d.closedPositions[0].entryFeeUsdt, 0.5);
  assert.equal(d.closedPositions[0].exitFeeUsdt, 0.2);
  assert.equal(d.closedPositions[0].exerciseFeeUsdt, null);
});

test('kpisFor feesPctOfPremium = comisiones / prima', () => {
  const { kpisFor } = require('../src/services/options/options-strategies.service');
  const k = kpisFor([{ mode: 'live', openedAt: 1, closedAt: null, feesUsdt: 2 }], [{ mode: 'live', action: 'open', premiumUsdt: 100 }], 'live', NOW);
  assert.equal(k.feesPctOfPremium, 2);
});

test('dailyPnlSeries: 30 puntos diarios acumulados del libro, más antiguo primero', () => {
  const { dailyPnlSeries } = require('../src/services/options/options-pnl-series');
  const DAY = 86400e3;
  const day0 = Math.floor(NOW / DAY) * DAY;
  const positions = [
    { mode: 'shadow', closedAt: day0 - 40 * DAY, pnlUsdt: 5 },
    { mode: 'shadow', closedAt: day0 - 2 * DAY + 5, pnlUsdt: 3 },
    { mode: 'shadow', closedAt: day0 + 10, pnlUsdt: -1 },
    { mode: 'live', closedAt: day0, pnlUsdt: 100 },
    { mode: 'shadow', closedAt: null, pnlUsdt: null },
  ];
  const s = dailyPnlSeries(positions, 'shadow', NOW);
  assert.equal(s.length, 30);
  assert.equal(s[0], 5);
  assert.deepEqual(s.slice(-4), [5, 8, 8, 7]);
  assert.equal(dailyPnlSeries([], 'live', NOW).every((v) => v === 0), true);
});
