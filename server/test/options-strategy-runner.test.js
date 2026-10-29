const test = require('node:test');
const assert = require('node:assert/strict');

const { OptionsStrategyRunner, estimateMargin } = require('../src/services/options/options-strategy-runner.service');
const { buildSyntheticChain, syntheticExpiries } = require('../src/services/options/options-synthetic-chain');
const { parseSymbol, tradeFee, HOUR_MS, DAY_MS } = require('../src/services/options/options-utils');
const { createFakeOptionsRepo } = require('./support/options-fake-repo');
const { createFakeShadowEntries, fillShadowEntries } = require('./support/options-fake-shadow-entries');

const FRIDAY_9 = Date.UTC(2026, 9, 16, 9);
const SPOT = 60000;
const silent = { info() {}, warn() {}, error() {} };

function fakeMarket({ now = FRIDAY_9, spot = SPOT, atmIv = 0.6, spreadPct = 4 } = {}) {
  const state = { spot, calls: { chain: 0, quote: 0 } };
  const expiries = syntheticExpiries(now);
  const chainOf = (code) => {
    const e = expiries.find((x) => x.code === code) || expiries[0];
    return { ...buildSyntheticChain({ underlying: 'BTC', spot: state.spot, now, expiry: e, atmIv, spreadPct }), expiries };
  };
  return {
    state,
    async getChain(_underlying, expiry) {
      state.calls.chain += 1;
      return chainOf(expiry);
    },
    async getQuote(symbol) {
      state.calls.quote += 1;
      const meta = parseSymbol(symbol);
      const row = chainOf(meta.expiry).rows.find((r) => r.strike === meta.strike);
      if (!row) throw new Error('símbolo desconocido');
      return { ...(meta.type === 'C' ? row.call : row.put), ...meta, spot: state.spot };
    },
    // PRICE_FILTER del contrato: las aperturas reales van al medio de la rejilla.
    async getPriceFilter() {
      return { tickSize: '0.01', minPrice: '0.01', maxPrice: '1000000' };
    },
  };
}

function fakeCredentials({ limits = {}, throws = false } = {}) {
  const orders = [];
  return {
    orders,
    async getClientForUser() {
      if (throws) throw new Error('Sin credenciales de Binance Opciones');
      return {
        async placeOrder(order) {
          orders.push(order);
          return { orderId: 1000 + orders.length, status: 'ACCEPTED', avgPrice: '0' };
        },
      };
    },
    async getLimits() {
      return { maxMarginUsdt: 100000, maxDailyLossUsdt: 1000, maxLiveStrategies: 2, notifyTelegram: true, ...limits };
    },
  };
}

async function setup({ mode = 'shadow', limits = {}, globalLimits = {}, template = 'short_strangle', params = {}, now = FRIDAY_9 } = {}) {
  const repo = createFakeOptionsRepo({ now: () => now });
  const market = fakeMarket({ now });
  const credentials = fakeCredentials({ limits: globalLimits });
  const notes = [];
  const clock = { now };
  const shadowEntries = createFakeShadowEntries({ now: () => clock.now });
  const liveExecutor = {
    enabled: true,
    repo: {
      // Mock de órdenes enviadas (sin fills) en el ledger duradero.
      async countSubmittedSince() { return credentials.orders.length; },
    },
    async reconcilePending() { return { checked: 0 }; },
    async submit(strategy, action) {
      const client = await credentials.getClientForUser(strategy.userId);
      for (const leg of action.legs) {
        await client.placeOrder({ symbol: leg.symbol, side: leg.side,
          price: leg.price, quantity: leg.quantity, reduceOnly: action.type === 'close' });
      }
      // El exchange simuló ACCEPTED (sin fills confirmados).
      return { status: 'submitted', sent: action.legs.length };
    },
  };
  const runner = new OptionsStrategyRunner({
    repo,
    liveExecutor,
    market,
    credentials,
    shadowEntries,
    notify: async (userId, text) => notes.push({ userId, text }),
    logger: silent,
    now: () => clock.now,
  });
  const strategy = await repo.createStrategy({ userId: 7, name: 'Strangle BTC', template, underlying: 'BTC', params, limits, mode });
  return { repo, market, credentials, notes, runner, strategy, clock, shadowEntries };
}

test('sombra: vende al bid del libro real con comisión mín(0,03 % nocional, 10 % prima)', async () => {
  const { repo, runner, market } = await setup();
  await runner.tick();
  const open = repo.positions.filter((p) => p.closedAt == null);
  assert.equal(open.length, 2);
  for (const p of open) {
    assert.equal(p.mode, 'shadow');
    assert.equal(p.side, 'SELL');
    const quote = await market.getQuote(p.symbol);
    assert.equal(p.entryPrice, quote.bid);
    const expectedFee = Math.min(0.0003 * SPOT * 0.01, 0.1 * quote.bid * 0.01);
    assert.ok(Math.abs(p.feesUsdt - expectedFee) < 1e-12);
  }
  const [event] = repo.events;
  assert.equal(event.action, 'open');
  assert.equal(event.legs.length, 2);
  const premium = open.reduce((a, p) => a + p.entryPrice * p.quantity, 0);
  assert.ok(Math.abs(event.premiumUsdt - premium) < 1e-9);
  assert.ok(event.legs.every((l) => !('orderId' in l)));
});

test('tradeFee: el tope del 10 % de la prima manda en opciones baratas', () => {
  assert.equal(tradeFee({ spot: 60000, quantity: 1, price: 5 }), 0.5);
  assert.ok(Math.abs(tradeFee({ spot: 60000, quantity: 1, price: 1000 }) - 18) < 1e-9);
});

test('sombra: compra al ask para cerrar y calcula el PnL neto de comisiones', async () => {
  const { repo, runner, clock, market } = await setup();
  await runner.tick();
  // Al día siguiente: la prima se desploma → take profit
  clock.now = FRIDAY_9 + DAY_MS;
  const original = market.getQuote;
  market.getQuote = async (symbol) => ({ ...(await original(symbol)), bid: 1, ask: 2, mark: 1.5, delta: 0.01 });
  market.getChain = async () => ({ underlying: 'BTC', spot: SPOT, expiry: null, expiries: [], rows: [] });
  await runner.tick();
  const closed = repo.positions.filter((p) => p.closedAt != null);
  assert.equal(closed.length, 2);
  for (const p of closed) {
    assert.equal(p.exitPrice, 2);
    const exitFee = tradeFee({ spot: SPOT, quantity: p.quantity, price: 2 });
    const entryFee = tradeFee({ spot: SPOT, quantity: p.quantity, price: p.entryPrice });
    assert.ok(Math.abs(p.feesUsdt - (entryFee + exitFee)) < 1e-9);
    assert.ok(Math.abs(p.pnlUsdt - ((p.entryPrice - 2) * p.quantity - entryFee - exitFee)) < 1e-9);
  }
  const close = repo.events.find((e) => e.action === 'close');
  assert.match(close.detail, /Take profit/);
});

test('hold/skip solo se registran cuando cambia el motivo', async () => {
  const { repo, runner, clock } = await setup();
  clock.now = FRIDAY_9 + 2 * HOUR_MS;
  await runner.tick();
  clock.now += 5 * 60_000;
  await runner.tick();
  assert.equal(repo.events.length, 1);
  assert.equal(repo.events[0].action, 'skip');
});

test('modo real: acepta órdenes LIMIT sin inventar posiciones ni fills', async () => {
  const { repo, runner, credentials, notes, market } = await setup({ mode: 'live' });
  await runner.tick();
  const shadow = repo.positions.filter((p) => p.mode === 'shadow');
  const live = repo.positions.filter((p) => p.mode === 'live');
  assert.equal(shadow.length, 2);
  assert.equal(live.length, 0);
  assert.equal(credentials.orders.length, 2);
  for (const order of credentials.orders) {
    const quote = await market.getQuote(order.symbol);
    assert.equal(order.side, 'SELL');
    // Template que no es por alertas: conserva el precio ejecutable (bid).
    assert.equal(order.price, quote.bid);
    assert.equal(order.reduceOnly, false);
    assert.equal(order.quantity, 0.01);
  }
  const liveEvent = repo.events.find((e) => e.mode === 'live' && e.action === 'open');
  assert.equal(liveEvent, undefined);
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /LIMIT/);
  assert.equal(notes[0].userId, 7);
});

test('modo real: límite de órdenes por día bloquea la entrada real pero no la sombra', async () => {
  const { repo, runner, credentials, notes } = await setup({ mode: 'live', limits: { maxOrdersPerDay: 1 } });
  await runner.tick();
  assert.equal(credentials.orders.length, 0);
  assert.equal(repo.positions.filter((p) => p.mode === 'live').length, 0);
  assert.equal(repo.positions.filter((p) => p.mode === 'shadow').length, 2);
  const blocked = repo.events.find((e) => e.mode === 'live');
  assert.equal(blocked.action, 'skip');
  assert.match(blocked.detail, /Bloqueada por límite: Máximo de 1 órdenes/);
  assert.match(notes[0].text, /bloqueada/);
});

test('modo real: revalida presupuesto al precio LIMIT y bloquea sobrecostes', async () => {
  const { repo, runner, strategy, credentials, market } = await setup({ mode: 'live' });
  const symbol = 'BTC-261016-60000-C';
  const q = await market.getQuote(symbol);
  const quantity = 0.1;
  const budget = q.ask * quantity * 0.9;
  await runner.executeLive(strategy, {
    type: 'open', detail: 'entry',
    legs: [{ symbol, side: 'BUY', quantity, optionType: 'C', strike: 60000 }],
  }, { now: FRIDAY_9, spot: SPOT, positions: [], params: { capitalUsdt: budget } });
  assert.equal(credentials.orders.length, 0);
  assert.equal(repo.positions.filter((p) => p.mode === 'live').length, 0);
  assert.match(repo.events.find((e) => e.mode === 'live').detail, /capital requerido excede/);
});

test('modo real: las órdenes aceptadas sin fill consumen el cupo diario', async () => {
  const { repo, runner, credentials } = await setup({
    mode: 'live', limits: { maxOrdersPerDay: 2 },
  });
  credentials.orders.push({ symbol: 'BTC-261016-60000-C', status: 'ACCEPTED' });
  await runner.tick();
  assert.equal(credentials.orders.length, 1);
  assert.equal(repo.positions.filter((p) => p.mode === 'live').length, 0);
  assert.match(repo.events.find((e) => e.mode === 'live').detail, /Máximo de 2 órdenes/);
});

test('modo real: delta desconocida bloquea el riesgo en vez de asumir cero', async () => {
  const { runner, strategy } = await setup({ mode: 'live', limits: { maxNetDelta: 1 } });
  const result = await runner.checkLiveLimits(strategy, [{
    symbol: 'BTC-261030-60000-C', side: 'BUY', quantity: 0.01,
    price: 100, strike: 60000, type: 'C', delta: null,
  }], { now: FRIDAY_9, spot: SPOT, positions: [] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Delta no disponible/);
});

test('modo real: margen de la estrategia y margen global', async () => {
  const a = await setup({ mode: 'live', limits: { maxMarginUsdt: 50 } });
  await a.runner.tick();
  assert.equal(a.credentials.orders.length, 0);
  assert.match(a.repo.events.find((e) => e.mode === 'live').detail, /límite de la estrategia/);

  const b = await setup({ mode: 'live', globalLimits: { maxMarginUsdt: 50 } });
  await b.runner.tick();
  assert.equal(b.credentials.orders.length, 0);
  assert.match(b.repo.events.find((e) => e.mode === 'live').detail, /límite global/);
});

test('modo real: pérdida diaria (estrategia y global) y |Δ| neta', async () => {
  const loss = await setup({ mode: 'live', limits: { maxDailyLossUsdt: 10 } });
  await loss.repo.insertPosition({ strategyId: loss.strategy.id, userId: 7, mode: 'live', symbol: 'BTC-261009-50000-P', side: 'SELL', quantity: 0.01, entryPrice: 10, openedAt: FRIDAY_9 - DAY_MS });
  await loss.repo.closePosition(loss.repo.positions[0].id, { exitPrice: 2000, closedAt: FRIDAY_9 - HOUR_MS, pnlUsdt: -19.9, feesUsdt: 0 });
  await loss.runner.tick();
  assert.equal(loss.credentials.orders.length, 0);
  assert.match(loss.repo.events.find((e) => e.mode === 'live').detail, /Pérdida diaria de la estrategia/);

  const global = await setup({ mode: 'live', globalLimits: { maxDailyLossUsdt: 5 } });
  await global.repo.insertPosition({ strategyId: 999, userId: 7, mode: 'live', symbol: 'BTC-261009-50000-P', side: 'SELL', quantity: 0.01, entryPrice: 10, openedAt: FRIDAY_9 - DAY_MS });
  await global.repo.closePosition(global.repo.positions[0].id, { exitPrice: 700, closedAt: FRIDAY_9 - HOUR_MS, pnlUsdt: -6.9, feesUsdt: 0 });
  await global.runner.tick();
  assert.equal(global.credentials.orders.length, 0);
  assert.match(global.repo.events.find((e) => e.mode === 'live').detail, /Pérdida diaria global/);

  const delta = await setup({ mode: 'live', template: 'covered_call', params: { holdingQty: 1 }, limits: { maxNetDelta: 0.1 } });
  await delta.runner.tick();
  assert.equal(delta.credentials.orders.length, 0);
  assert.match(delta.repo.events.find((e) => e.mode === 'live').detail, /\|Δ\| neta/);
});

// Pérdida realizada hoy (UTC) de `loss` USDT en el modo, para el bot.
async function seedLoss(ctx, mode, loss) {
  await ctx.repo.insertPosition({ strategyId: ctx.strategy.id, userId: 7, mode, symbol: 'BTC-261009-50000-P', side: 'SELL', quantity: 0.01, entryPrice: 10, openedAt: FRIDAY_9 - DAY_MS });
  await ctx.repo.closePosition(ctx.repo.positions[0].id, { exitPrice: 2000, closedAt: FRIDAY_9 - HOUR_MS, pnlUsdt: -loss, feesUsdt: 0 });
}
const BUY_LEGS = [{ symbol: 'BTC-261016-70000-C', side: 'BUY', quantity: 0.01, price: 100, spot: 68000 }];

test('pérdida diaria que se anticipa: la prima + comisión que no cabe bloquea; la que cabe justo pasa', async () => {
  const ctx = await setup({ mode: 'live', limits: { maxDailyLossUsdt: 10 } });
  await seedLoss(ctx, 'live', 8);
  // prima 1 USDT + comisión (mín 0,03 % nocional, 10 % prima = 0,1) = 1,1; quedan 2.
  assert.equal((await ctx.runner.checkDailyLossBudget(ctx.strategy, 'live', BUY_LEGS, { now: FRIDAY_9 })).ok, true);
  ctx.repo.positions[0].pnlUsdt = -9.0;
  const blocked = await ctx.runner.checkDailyLossBudget(ctx.strategy, 'live', BUY_LEGS, { now: FRIDAY_9 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'daily_loss_budget');
  assert.equal(blocked.reason, 'La prima de esta entrada (1.00 USDT) no cabe en lo que queda del límite de pérdida diaria (9.00 de 10.00 USDT)');
  // Cabe justo: pérdida 8,9 + 1,1 = 10.
  ctx.repo.positions[0].pnlUsdt = -8.9;
  assert.equal((await ctx.runner.checkDailyLossBudget(ctx.strategy, 'live', BUY_LEGS, { now: FRIDAY_9 })).ok, true);
  // Las ventas no pagan prima: solo aplica la regla de «ya en el límite».
  const sell = [{ ...BUY_LEGS[0], side: 'SELL' }];
  ctx.repo.positions[0].pnlUsdt = -9.5;
  assert.equal((await ctx.runner.checkDailyLossBudget(ctx.strategy, 'live', sell, { now: FRIDAY_9 })).ok, true);
});

test('pérdida diaria que se anticipa: sin límite configurado no bloquea', async () => {
  const ctx = await setup({ mode: 'live' });
  ctx.strategy.limits = { ...ctx.strategy.limits, maxDailyLossUsdt: null };
  await seedLoss(ctx, 'live', 500);
  assert.equal((await ctx.runner.checkDailyLossBudget(ctx.strategy, 'live', BUY_LEGS, { now: FRIDAY_9 })).ok, true);
});

test('pérdida diaria: la entrada real que no cabe se salta con daily_loss_budget', async () => {
  const ctx = await setup({ mode: 'live', template: 'alert_signal', params: { alertIds: [1], maxOpenPositions: 5 }, limits: { maxDailyLossUsdt: 100 } });
  await seedLoss(ctx, 'live', 90);
  await ctx.runner.runForSignal(ctx.strategy, { direction: 'bullish' });
  assert.equal(ctx.credentials.orders.length, 0);
  assert.match(ctx.repo.events.find((e) => e.mode === 'live' && e.action === 'skip').detail, /^La prima de esta entrada/);
});

test('sombra aplica la regla actual y la nueva al crear la entrada', async () => {
  const opts = { template: 'alert_signal', params: { alertIds: [1], maxOpenPositions: 5 }, limits: { maxDailyLossUsdt: 100 } };
  const atLimit = await setup(opts);
  await seedLoss(atLimit, 'shadow', 100);
  await atLimit.runner.runForSignal(atLimit.strategy, { direction: 'bullish' });
  assert.match(atLimit.repo.events.find((e) => e.mode === 'shadow' && e.action === 'skip').detail, /en el límite de 100 USDT/);
  assert.equal((await atLimit.shadowEntries.listPending()).length, 0);

  const budget = await setup(opts);
  await seedLoss(budget, 'shadow', 90);
  await budget.runner.runForSignal(budget.strategy, { direction: 'bullish' });
  assert.match(budget.repo.events.find((e) => e.mode === 'shadow' && e.action === 'skip').detail, /no cabe en lo que queda del límite de pérdida diaria/);
  assert.equal((await budget.shadowEntries.listPending()).length, 0);

  const fits = await setup(opts);
  await seedLoss(fits, 'shadow', 80);
  await fits.runner.runForSignal(fits.strategy, { direction: 'bullish' });
  assert.equal((await fits.shadowEntries.listPending()).length, 1);
});

test('modo real sin credenciales: registra error y avisa, la sombra sigue', async () => {
  const { repo, runner, credentials } = await setup({ mode: 'live' });
  credentials.getClientForUser = async () => { throw new Error('Sin credenciales de Binance Opciones'); };
  await runner.tick();
  assert.equal(repo.positions.filter((p) => p.mode === 'shadow').length, 2);
  const err = repo.events.find((e) => e.mode === 'live');
  assert.equal(err.action, 'error');
  assert.match(err.detail, /Sin credenciales/);
});

test('liquidación al vencimiento: intrínseco contra el índice, con comisión de ejercicio', async () => {
  const { repo, runner, market, strategy } = await setup({ mode: 'paused' });
  const expiry = '261016';
  await repo.insertPosition({ strategyId: strategy.id, userId: 7, mode: 'shadow', symbol: `BTC-${expiry}-58000-P`, side: 'SELL', quantity: 0.1, entryPrice: 300, openedAt: FRIDAY_9 - 7 * DAY_MS, feesUsdt: 1.8 });
  await repo.insertPosition({ strategyId: strategy.id, userId: 7, mode: 'shadow', symbol: `BTC-${expiry}-62000-C`, side: 'SELL', quantity: 0.1, entryPrice: 250, openedAt: FRIDAY_9 - 7 * DAY_MS, feesUsdt: 1.8 });
  market.state.spot = 57000;
  await runner.tick();
  const put = repo.positions.find((p) => p.symbol.endsWith('-P'));
  const call = repo.positions.find((p) => p.symbol.endsWith('-C'));
  assert.equal(put.exitPrice, 1000);
  const exFee = Math.min(0.00015 * 57000 * 0.1, 0.1 * 1000 * 0.1);
  assert.ok(Math.abs(put.pnlUsdt - ((300 - 1000) * 0.1 - 1.8 - exFee)) < 1e-9);
  assert.equal(call.exitPrice, 0);
  assert.ok(Math.abs(call.pnlUsdt - (25 - 1.8)) < 1e-9);
  const settle = repo.events.find((e) => e.action === 'close');
  assert.match(settle.detail, /Vencimiento/);
  assert.equal(await repo.countOrdersSince(strategy.id, 'shadow', 0), 0);
});

test('cierre en sombra guarda el motivo de la acción y la liquidación guarda expiry', async () => {
  const { repo, runner, strategy } = await setup({ mode: 'paused' });
  const pos = await repo.insertPosition({ strategyId: strategy.id, userId: 7, mode: 'shadow', symbol: 'BTC-261030-58000-P', side: 'SELL', quantity: 0.1, entryPrice: 300, openedAt: FRIDAY_9 - HOUR_MS, feesUsdt: 1 });
  const leg = { symbol: pos.symbol, side: 'BUY', quantity: 0.1, price: 400, fee: 1, positionId: pos.id };
  await runner.book(strategy, 'shadow', { type: 'close', reason: 'stop_loss', legs: [leg] }, [leg], { now: FRIDAY_9, positions: [pos] });
  assert.equal(repo.positions.find((p) => p.id === pos.id).closeReason, 'stop_loss');
});

test('la liquidación al vencimiento guarda closeReason expiry', async () => {
  const { repo, runner, market, strategy } = await setup({ mode: 'paused' });
  await repo.insertPosition({ strategyId: strategy.id, userId: 7, mode: 'shadow', symbol: 'BTC-261016-58000-P', side: 'SELL', quantity: 0.1, entryPrice: 300, openedAt: FRIDAY_9 - 7 * DAY_MS, feesUsdt: 1.8 });
  market.state.spot = 57000;
  await runner.tick();
  assert.equal(repo.positions[0].closeReason, 'expiry');
});

test('estimateMargin: venta usa prima + máx(15 % spot − OTM, 10 % spot); compra, la prima', () => {
  assert.equal(estimateMargin({ side: 'SELL', type: 'C', strike: 66000, price: 100, quantity: 1, spot: 60000 }), 100 + 6000);
  assert.equal(estimateMargin({ side: 'SELL', type: 'P', strike: 60000, price: 100, quantity: 0.5, spot: 60000 }), 0.5 * (100 + 9000));
  assert.equal(estimateMargin({ side: 'BUY', type: 'P', strike: 55000, price: 200, quantity: 2, spot: 60000 }), 400);
});

test('start/stop no deja timers colgados y tick no se solapa', async () => {
  const { runner } = await setup();
  runner.start();
  runner.start();
  runner.stop();
  runner.running = true;
  assert.deepEqual(await runner.tick(), { skipped: true });
});

test('modo real: sin spot no se estima el margen de una venta y la entrada se bloquea', async () => {
  const { runner, strategy } = await setup({ mode: 'live', limits: { maxMarginUsdt: 100000 } });
  const result = await runner.checkLiveLimits(strategy, [{
    symbol: 'BTC-261030-66000-C', side: 'SELL', quantity: 0.01,
    price: 100, strike: 66000, type: 'C', optionType: 'C', delta: 0.2,
  }], { now: FRIDAY_9, spot: null, positions: [] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Spot no disponible/);
});

test('estimateMargin: una venta sin spot válido no se reduce a la prima', () => {
  assert.ok(Number.isNaN(estimateMargin({ side: 'SELL', type: 'C', strike: 66000, price: 100, quantity: 1, spot: null })));
  assert.equal(estimateMargin({ side: 'BUY', type: 'C', strike: 66000, price: 100, quantity: 1, spot: null }), 100);
});

// ---------- cierre manual y señal solo-sombra ----------

test('closeManually en sombra sin ids cierra todas las posiciones con closeReason manual', async () => {
  const { repo, runner, strategy } = await setup();
  await runner.tick();
  assert.equal((await repo.listOpenPositions(strategy.id, 'shadow')).length, 2);
  const result = await runner.closeManually(strategy, { mode: 'shadow' });
  assert.equal(result.status, 'closed');
  assert.ok(result.produced.some((p) => p.booked && p.type === 'close' && p.reason === 'manual'));
  const closed = repo.positions.filter((p) => p.closedAt != null);
  assert.equal(closed.length, 2);
  assert.ok(closed.every((p) => p.closeReason === 'manual'));
  const event = repo.events.find((e) => e.action === 'close');
  assert.equal(event.detail, 'Cierre manual');
});

test('closeManually con positionIds cierra solo esas posiciones', async () => {
  const { repo, runner, strategy } = await setup();
  await runner.tick();
  const [first, second] = await repo.listOpenPositions(strategy.id, 'shadow');
  const result = await runner.closeManually(strategy, { mode: 'shadow', positionIds: [first.id] });
  assert.equal(result.status, 'closed');
  assert.equal(repo.positions.find((p) => p.id === first.id).closeReason, 'manual');
  assert.equal(repo.positions.find((p) => p.id === second.id).closedAt, null);
});

test('closeManually sin posiciones abiertas devuelve nothing_to_close', async () => {
  const { runner, strategy, repo } = await setup({ mode: 'paused' });
  const result = await runner.closeManually(strategy, { mode: 'shadow' });
  assert.equal(result.status, 'nothing_to_close');
  assert.deepEqual(result.produced, []);
  assert.equal(repo.events.length, 0);
});

async function setupLiveWithPositions() {
  const ctx = await setup({ mode: 'live' });
  const { repo, runner, strategy, credentials } = ctx;
  await runner.tick();
  for (const p of await repo.listOpenPositions(strategy.id, 'shadow')) {
    const { id: _id, ...rest } = p;
    await repo.insertPosition({ ...rest, mode: 'live' });
  }
  credentials.orders.length = 0;
  let submits = 0;
  const originalSubmit = runner.liveExecutor.submit;
  runner.liveExecutor.submit = async (...args) => { submits += 1; return originalSubmit(...args); };
  return { ...ctx, submits: () => submits };
}

test('closeManually en real con TP residente: pending vía requestProtectedExit, sin submit', async () => {
  const { runner, strategy, repo, submits } = await setupLiveWithPositions();
  const requested = [];
  runner.liveExecutor.requestProtectedExit = async (s, action) => { requested.push(action); return true; };
  const result = await runner.closeManually(strategy, { mode: 'live' });
  assert.equal(result.status, 'pending');
  assert.equal(submits(), 0);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].reason, 'manual');
  assert.equal(requested[0].legs.length, 2);
  assert.ok(result.produced.some((p) => p.pending && p.reason === 'tp_cancel_requested'));
  assert.equal(repo.positions.filter((p) => p.mode === 'live' && p.closedAt != null).length, 0);
});

test('closeManually en real sin TP residente envía órdenes y queda pending', async () => {
  const { runner, strategy, credentials, submits } = await setupLiveWithPositions();
  const result = await runner.closeManually(strategy, { mode: 'live' });
  assert.equal(result.status, 'pending');
  assert.equal(submits(), 1);
  assert.equal(credentials.orders.length, 2);
  assert.ok(credentials.orders.every((o) => o.side === 'BUY' && o.reduceOnly === true));
});

test('closeManually en real con el ejecutor deshabilitado devuelve not_submitted', async () => {
  const { runner, strategy, repo, submits } = await setupLiveWithPositions();
  runner.liveExecutor.enabled = false;
  const result = await runner.closeManually(strategy, { mode: 'live' });
  assert.equal(result.status, 'not_submitted');
  assert.equal(submits(), 0);
  assert.ok(result.produced.some((p) => p.reason === 'live_disabled'));
  assert.ok(repo.events.some((e) => e.mode === 'live' && e.action === 'skip'));
});

test('dos closeManually concurrentes en sombra cierran cada posición una sola vez', async () => {
  const { repo, runner, strategy } = await setup();
  await runner.tick();
  const calls = [];
  const originalClose = repo.closePosition;
  repo.closePosition = async (id, data) => { calls.push(id); return originalClose(id, data); };
  const [a, b] = await Promise.all([
    runner.closeManually(strategy, { mode: 'shadow' }),
    runner.closeManually(strategy, { mode: 'shadow' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ['closed', 'nothing_to_close']);
  assert.equal(calls.length, 2);
  assert.equal(new Set(calls).size, 2);
  assert.equal(repo.events.filter((e) => e.action === 'close').length, 1);
});

test('runForSignal con shadowOnly en un bot real no envía órdenes reales', async () => {
  const { repo, runner, strategy, credentials } = await setup({ mode: 'live' });
  let submits = 0;
  runner.liveExecutor.submit = async () => { submits += 1; return { status: 'submitted', sent: 1 }; };
  const { actions, produced } = await runner.runForSignal(strategy, { direction: 'long' }, { shadowOnly: true });
  assert.equal(submits, 0);
  assert.equal(credentials.orders.length, 0);
  assert.deepEqual(Object.keys(actions), ['shadow']);
  assert.ok(produced.every((p) => p.mode === 'shadow'));
  assert.equal(repo.positions.filter((p) => p.mode === 'shadow').length, 2);
});

test('runForSignal sin shadowOnly en un bot real sigue evaluando el modo real', async () => {
  const { runner, strategy } = await setup({ mode: 'live' });
  let submits = 0;
  runner.liveExecutor.submit = async () => { submits += 1; return { status: 'submitted', sent: 2 }; };
  const { actions } = await runner.runForSignal(strategy, { direction: 'long' });
  assert.equal(submits, 1);
  assert.deepEqual(Object.keys(actions), ['shadow', 'live']);
});

// ---------- bot por alertas en modo atr_band (sombra) ----------

function withAtrBand(market, { band = { close: SPOT - 100, atr: 400, upper: SPOT + 700, lower: SPOT - 900, multiplier: 2 } } = {}) {
  market.state.calls.band = 0;
  market.getAtrBand = async () => {
    market.state.calls.band += 1;
    if (band instanceof Error) throw band;
    return band;
  };
  market.getVolatilityInputs = async () => ({ atrHourly: 300, tickSize: 5, minPrice: 5 });
  return market;
}

test('sombra atr_band: la apertura fija y persiste el objetivo una vez; un segundo tick no recalcula', async () => {
  const { repo, runner, market, strategy, clock } = await setup({
    template: 'alert_signal', params: { alertIds: [1], takeProfitMode: 'atr_band', tpMaxGainPct: 200 },
  });
  withAtrBand(market);
  await runner.runForSignal(strategy, { direction: 'bullish' });
  await fillShadowEntries({ runner, market });
  const [p] = repo.positions;
  assert.equal(repo.positions.length, 1);
  assert.equal(p.side, 'BUY');
  assert.ok(p.tpTargetPrice > p.entryPrice, `objetivo ${p.tpTargetPrice} > prima ${p.entryPrice}`);
  assert.equal(p.tpTargetMeta.spot, SPOT);
  assert.equal(p.tpTargetMeta.interval, '1h');
  assert.equal(p.tpTargetMeta.length, 14);
  assert.equal(p.tpTargetMeta.multiplier, 2);
  assert.equal(p.tpTargetMeta.computedAt, FRIDAY_9);
  assert.equal(market.state.calls.band, 1);
  const target = p.tpTargetPrice;

  clock.now = FRIDAY_9 + HOUR_MS;
  await runner.tick();
  assert.equal(market.state.calls.band, 1, 'el segundo tick no vuelve a llamar a getAtrBand');
  assert.equal(repo.positions[0].tpTargetPrice, target);
  assert.equal(repo.positions[0].closedAt, null, 'sin stop ni salida por tiempo');
});

test('sombra atr_band: sin banda al abrir, el objetivo queda pendiente y se reintenta en el siguiente tick', async () => {
  const { repo, runner, market, strategy, clock } = await setup({
    template: 'alert_signal', params: { alertIds: [1], takeProfitMode: 'atr_band' },
  });
  withAtrBand(market, { band: new Error('sin velas') });
  await runner.runForSignal(strategy, { direction: 'bullish' });
  await fillShadowEntries({ runner, market });
  assert.equal(repo.positions.length, 1, 'la posición se registra aunque falle la banda');
  assert.equal(repo.positions[0].tpTargetPrice ?? null, null);
  withAtrBand(market);
  clock.now = FRIDAY_9 + 5 * 60_000;
  await runner.tick();
  assert.ok(repo.positions[0].tpTargetPrice > 0);
  assert.equal(market.state.calls.band, 1);
});

test('sombra atr_band: el bid en el objetivo cierra con take_profit_atr_band', async () => {
  const { repo, runner, market, strategy, clock } = await setup({
    template: 'alert_signal', params: { alertIds: [1], takeProfitMode: 'atr_band' },
  });
  withAtrBand(market);
  await runner.runForSignal(strategy, { direction: 'bullish' });
  await fillShadowEntries({ runner, market });
  const target = repo.positions[0].tpTargetPrice;
  const original = market.getQuote;
  market.getQuote = async (symbol) => ({ ...(await original(symbol)), bid: target, ask: target + 10 });
  market.getChain = async () => ({ underlying: 'BTC', spot: SPOT, expiry: null, expiries: [], rows: [] });
  clock.now = FRIDAY_9 + HOUR_MS;
  await runner.tick();
  const [p] = repo.positions;
  assert.equal(p.closeReason, 'take_profit_atr_band');
  assert.equal(p.exitPrice, target);
});

test('atr_band: el cierre manual sigue funcionando (acción explícita del usuario)', async () => {
  const { repo, runner, market, strategy } = await setup({
    template: 'alert_signal', params: { alertIds: [1], takeProfitMode: 'atr_band' },
  });
  withAtrBand(market);
  await runner.runForSignal(strategy, { direction: 'bullish' });
  await fillShadowEntries({ runner, market });
  const out = await runner.closeManually(strategy, { mode: 'shadow' });
  assert.equal(out.status, 'closed');
  assert.equal(repo.positions[0].closeReason, 'manual');
});

test('real atr_band: con TP residente en Binance el tick no cancela ni compite con él', async () => {
  const runner = new OptionsStrategyRunner({
    repo: createFakeOptionsRepo({ now: () => FRIDAY_9 }), market: fakeMarket(), logger: silent, now: () => FRIDAY_9,
    liveExecutor: {
      enabled: true,
      repo: { async hasStandingTp() { return true; } },
      async requestProtectedExit() { throw new Error('no debe cancelar el TP residente'); },
      async submit() { throw new Error('no debe enviar'); },
    },
  });
  const produced = [];
  const action = { type: 'close', reason: 'take_profit_atr_band',
    legs: [{ positionId: 3, symbol: 'BTC-261030-65000-C', side: 'SELL', quantity: 0.01, targetPrice: 300 }] };
  const result = await runner.executeLive({ id: 1, userId: 7 }, action, { now: FRIDAY_9, produced, positions: [], params: {} });
  assert.equal(result, null);
  assert.equal(produced[0].reason, 'tp_resting');
});

test('notify por bot: trades=false silencia el envío de órdenes pero errors=true sigue avisando', async () => {
  const { runner, strategy, notes } = await setup({ mode: 'live', params: { notify: { trades: false, errors: true } } });
  await runner.maybeNotify(strategy, 'Órdenes LIMIT enviadas', 'trade');
  assert.equal(notes.length, 0);
  await runner.maybeNotify(strategy, 'Error en modo real: x', 'error');
  assert.equal(notes.length, 1);
});

test('notify por bot: errors=false silencia errores; sin la clave notify ambos avisan', async () => {
  const a = await setup({ mode: 'live', params: { notify: { trades: true, errors: false } } });
  await a.runner.maybeNotify(a.strategy, 'Error', 'error');
  assert.equal(a.notes.length, 0);
  await a.runner.maybeNotify(a.strategy, 'Orden', 'trade');
  assert.equal(a.notes.length, 1);
  const b = await setup({ mode: 'live' });
  await b.runner.maybeNotify(b.strategy, 'Orden', 'trade');
  await b.runner.maybeNotify(b.strategy, 'Error', 'error');
  assert.equal(b.notes.length, 2);
});

test('notify por bot: una apertura real con trades=false no llama a notify', async () => {
  const { runner, notes, credentials } = await setup({ mode: 'live', params: { notify: { trades: false, errors: true } } });
  await runner.tick();
  assert.equal(credentials.orders.length, 2);
  assert.equal(notes.length, 0);
});

// ---------- presupuesto total con reserva de pendientes (Task 11) ----------

const BUDGET_PARAMS = { alertIds: [1], budgetUsdt: 10, budgetFractions: 1, quantity: 1 };

function pendingEntry(strategyId, overrides = {}) {
  // 0,01 a 1000 USDT = 10 USDT pendientes de ejecutar. En ETH para que no
  // ocupe el subyacente de la señal (BTC): una opción por subyacente.
  return { id: 1, strategyId, action: 'open', purpose: 'standard', status: 'active',
    symbol: 'ETH-261023-3200-C', side: 'BUY', quantity: 0.01, processedQty: 0, limitPrice: 1000, ...overrides };
}

test('presupuesto: una orden de entrada pendiente de 10 USDT en Real cuenta como comprometida', async () => {
  const { runner, strategy } = await setup({ mode: 'live', template: 'alert_signal', params: { ...BUDGET_PARAMS, maxOpenPositions: 5 } });
  const asked = [];
  runner.liveOrders = { async listByStrategy(id) { asked.push(id); return [pendingEntry(id)]; } };
  const { actions } = await runner.runForSignal(strategy, { direction: 'bullish' });
  assert.deepEqual(asked, [strategy.id]);
  assert.equal(actions.live[0].type, 'skip');
  assert.equal(actions.live[0].reason, 'budget_exhausted');
  assert.equal(actions.live[0].detail, 'Presupuesto comprometido: 10 de 10 USDT');
  // La sombra solo cuenta sus posiciones: abre.
  assert.equal(actions.shadow[0].type, 'open');
});

test('presupuesto: lo ejecutado o cancelado de una orden no reserva; la orden final tampoco', async () => {
  const { runner, strategy } = await setup({ mode: 'live', template: 'alert_signal', params: { ...BUDGET_PARAMS, maxOpenPositions: 5 } });
  runner.liveOrders = { async listByStrategy(id) {
    return [pendingEntry(id, { processedQty: 0.005 }), pendingEntry(id, { id: 2, status: 'final' }),
      pendingEntry(id, { id: 3, action: 'close' })];
  } };
  const { actions } = await runner.runForSignal(strategy, { direction: 'bullish' });
  const open = actions.live.find((a) => a.type === 'open');
  assert.ok(open, 'quedan 5 USDT libres');
  assert.ok(open.legs.reduce((s, l) => s + l.price * l.quantity, 0) <= 5 + 1e-9);
});

test('presupuesto: las posiciones abiertas del modo comprometen su prima', async () => {
  const { repo, runner, strategy } = await setup({ template: 'alert_signal', params: { ...BUDGET_PARAMS, maxOpenPositions: 5 } });
  await repo.insertPosition({ strategyId: strategy.id, userId: 7, mode: 'shadow', symbol: 'ETH-261023-3200-C',
    side: 'BUY', quantity: 0.01, entryPrice: 1000, openedAt: FRIDAY_9, feesUsdt: 0 });
  const { actions } = await runner.runForSignal(strategy, { direction: 'bullish' });
  const skipped = actions.shadow.find((a) => a.type === 'skip');
  assert.equal(skipped?.reason, 'budget_exhausted');
});

test('presupuesto: la reentrada diferida también resta lo reservado', async () => {
  const { runner, strategy } = await setup({ mode: 'live', template: 'alert_signal', params: { ...BUDGET_PARAMS, maxOpenPositions: 5 } });
  runner.liveOrders = { async listByStrategy(id) { return [pendingEntry(id)]; } };
  const result = await runner.executeDeferredReentry(strategy.id, { direction: 'bullish' });
  assert.equal(result.status, 'no_valid_entry');
});

test('presupuesto: sin budgetUsdt las órdenes ya ejecutadas o cerradas no bloquean la entrada', async () => {
  const { runner, strategy } = await setup({ mode: 'live', template: 'alert_signal', params: { alertIds: [1] } });
  runner.liveOrders = { async listByStrategy(id) {
    return [pendingEntry(id, { status: 'final' }), pendingEntry(id, { id: 2, processedQty: 0.01 }), pendingEntry(id, { id: 3, action: 'close' })];
  } };
  const { actions } = await runner.runForSignal(strategy, { direction: 'bullish' });
  assert.equal(actions.live[0].type, 'open');
});

test('máximo de posiciones del bot: una entrada real pendiente en otro subyacente cuenta', async () => {
  const { runner, strategy } = await setup({ mode: 'live', template: 'alert_signal',
    params: { alertIds: [1], maxOpenPositions: 1 } });
  runner.liveOrders = { async listByStrategy(id) { return [pendingEntry(id)]; } };
  const { actions } = await runner.runForSignal(strategy, { direction: 'bullish' });
  assert.equal(actions.live[0].reason, 'max_open_positions');
  // La sombra no tiene entradas pendientes: abre.
  assert.equal(actions.shadow[0].type, 'open');
});

test('máximo de posiciones del bot: la reentrada diferida cuenta las entradas pendientes', async () => {
  const { runner, strategy } = await setup({ mode: 'live', template: 'alert_signal',
    params: { alertIds: [1], maxOpenPositions: 1, onOpposite: 'reverse' } });
  runner.liveOrders = { async listByStrategy(id) { return [pendingEntry(id)]; } };
  const result = await runner.executeDeferredReentry(strategy.id, { direction: 'bullish' });
  assert.equal(result.status, 'no_valid_entry');
});

test('máximo de posiciones del bot: una entrada simulada pendiente en otro subyacente cuenta en sombra', async () => {
  const { runner, strategy, shadowEntries } = await setup({ template: 'alert_signal',
    params: { alertIds: [1], maxOpenPositions: 1 } });
  await shadowEntries.insertEntry({ strategyId: strategy.id, userId: 7, symbol: 'ETH-261023-3200-C',
    side: 'BUY', optionType: 'C', quantity: 0.01, limitPrice: 1000, deadlineAt: FRIDAY_9 + 600_000 });
  const { actions } = await runner.runForSignal(strategy, { direction: 'bullish' });
  assert.equal(actions.shadow[0].reason, 'max_open_positions');
});

test('presupuesto: una entrada simulada pendiente reserva presupuesto en sombra como en Real', async () => {
  const { runner, strategy, shadowEntries } = await setup({ template: 'alert_signal',
    params: { ...BUDGET_PARAMS, maxOpenPositions: 5 } });
  await shadowEntries.insertEntry({ strategyId: strategy.id, userId: 7, symbol: 'ETH-261023-3200-C',
    side: 'BUY', optionType: 'C', quantity: 0.01, limitPrice: 1000, deadlineAt: FRIDAY_9 + 600_000 });
  const { actions } = await runner.runForSignal(strategy, { direction: 'bullish' });
  const skipped = actions.shadow.find((a) => a.type === 'skip');
  assert.equal(skipped?.reason, 'budget_exhausted');
  assert.equal(skipped.detail, 'Presupuesto comprometido: 10 de 10 USDT');
});

test('límites reales: el margen incluye las entradas pendientes del usuario', async () => {
  const { runner, strategy } = await setup({ mode: 'live', template: 'alert_signal',
    params: { alertIds: [1] }, globalLimits: { maxMarginUsdt: 15 } });
  runner.liveExecutor.repo.listOpenEntriesByUser = async (userId) => {
    assert.equal(userId, 7);
    return [pendingEntry(99, { symbol: 'ETH-261023-3200-C' })];
  };
  const leg = { symbol: 'BTC-261023-65000-C', side: 'BUY', optionType: 'C', strike: 65000, quantity: 0.01, price: 600 };
  const blocked = await runner.checkLiveLimits(strategy, [leg], { now: FRIDAY_9, spot: 60000, underlying: 'BTC', chains: new Map() });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /Margen estimado 16\.00 USDT supera el límite global/);
  runner.liveExecutor.repo.listOpenEntriesByUser = async () => [];
  assert.equal((await runner.checkLiveLimits(strategy, [leg], { now: FRIDAY_9, spot: 60000, underlying: 'BTC', chains: new Map() })).ok, true);
});

test('una opción por subyacente: una entrada pendiente en Real bloquea otra en el mismo subyacente', async () => {
  const { runner, strategy } = await setup({ mode: 'live', template: 'alert_signal', params: { alertIds: [1], maxOpenPositions: 5 } });
  runner.liveOrders = { async listByStrategy(id) { return [pendingEntry(id, { symbol: 'BTC-261023-65000-C' })]; } };
  const { actions } = await runner.runForSignal(strategy, { direction: 'bullish' });
  assert.equal(actions.live[0].reason, 'underlying_busy');
  // La sombra no tiene órdenes pendientes: abre.
  assert.equal(actions.shadow[0].type, 'open');
});

test('una opción por subyacente: la entrada pendiente de otro subyacente no bloquea', async () => {
  const { runner, strategy } = await setup({ mode: 'live', template: 'alert_signal', params: { alertIds: [1], maxOpenPositions: 5 } });
  runner.liveOrders = { async listByStrategy(id) { return [pendingEntry(id)]; } };
  const { actions } = await runner.runForSignal(strategy, { direction: 'bullish' });
  assert.equal(actions.live[0].type, 'open');
});

test('presupuesto: el ejecutor real revalida contra la parte de la señal e ignora capitalUsdt', async () => {
  const { runner, strategy, credentials, market } = await setup({ mode: 'live' });
  const symbol = 'BTC-261016-60000-C';
  const q = await market.getQuote(symbol);
  const quantity = 0.1;
  const legs = [{ symbol, side: 'BUY', quantity, optionType: 'C', strike: 60000 }];
  const ctx = { now: FRIDAY_9, spot: SPOT, positions: [] };
  // capitalUsdt diminuto ignorado: la parte de la señal cubre la prima.
  await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs, signalBudgetUsdt: q.ask * quantity * 1.1 },
    { ...ctx, params: { capitalUsdt: 1, budgetUsdt: 1e6, budgetFractions: 4 } });
  assert.equal(credentials.orders.length, 1);
  // La parte de la señal no alcanza al precio LIMIT actual: bloquea.
  await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs, signalBudgetUsdt: q.ask * quantity * 0.9 },
    { ...ctx, params: { capitalUsdt: null, budgetUsdt: 1e6, budgetFractions: 4 } });
  assert.equal(credentials.orders.length, 1);
});

// ---------- aperturas reales al medio (LIMIT GTC) ----------

const MID_SYMBOL = 'BTC-261016-60000-C';
const midLeg = (quantity = 0.1) => ({ symbol: MID_SYMBOL, side: 'BUY', quantity, optionType: 'C', strike: 60000 });
const midCtx = (params) => ({ now: FRIDAY_9, spot: SPOT, positions: [], produced: [], params });

async function midSetup(book = { bid: 700, ask: 725 }, { filter = { tickSize: '5', minPrice: '5', maxPrice: '100000' } } = {}) {
  const env = await setup({ mode: 'live', template: 'alert_signal', params: { alertIds: [1] } });
  const original = env.market.getQuote;
  env.market.getQuote = async (symbol, opts) => ({ ...(await original(symbol, opts)), ...book });
  env.market.getPriceFilter = async () => filter;
  return env;
}

test('live open sends the mid on the contract grid', async () => {
  const { runner, strategy, credentials } = await midSetup();
  await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs: [midLeg()] }, midCtx({ capitalUsdt: 1000 }));
  assert.equal(credentials.orders.length, 1);
  assert.equal(credentials.orders[0].price, 715);
});

test('live open SELL rounds the mid down onto the grid', async () => {
  const { runner, strategy, credentials } = await midSetup();
  await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs: [{ ...midLeg(), side: 'SELL' }] },
    midCtx({ capitalUsdt: 1e6 }));
  assert.equal(credentials.orders.length, 1);
  assert.equal(credentials.orders[0].price, 710);
});

test('live open uses the tick carried by the quote when present', async () => {
  const { runner, strategy, credentials } = await midSetup({ bid: 700, ask: 725, tickSize: 5, minPrice: 5 }, { filter: null });
  await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs: [midLeg()] }, midCtx({ capitalUsdt: 1000 }));
  assert.equal(credentials.orders.length, 1);
  assert.equal(credentials.orders[0].price, 715);
});

test('live open without bid falls back to the ask (fastest fill)', async () => {
  const { runner, strategy, credentials } = await midSetup({ bid: null, ask: 725 });
  // Sin bid no hay medio: compra al ask, el precio que se ejecuta antes.
  await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs: [midLeg()] }, midCtx({ capitalUsdt: 1000 }));
  assert.equal(credentials.orders.length, 1);
  assert.equal(credentials.orders[0].price, 725);
});

test('live open without a known tick falls back to the ask', async () => {
  const { runner, strategy, credentials } = await midSetup({ bid: 700, ask: 725 }, { filter: null });
  await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs: [midLeg()] }, midCtx({ capitalUsdt: 1000 }));
  assert.equal(credentials.orders.length, 1);
  assert.equal(credentials.orders[0].price, 725);
});

test('live open with no grid tick inside the spread falls back to the ask', async () => {
  const { runner, strategy, credentials } = await midSetup({ bid: 701, ask: 704 });
  await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs: [midLeg()] }, midCtx({ capitalUsdt: 1000 }));
  assert.equal(credentials.orders.length, 1);
  assert.equal(credentials.orders[0].price, 704);
});

test('capital revalidated at mid: budget covers 715 but not 725 and the order goes out', async () => {
  const { runner, strategy, credentials } = await midSetup();
  await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs: [midLeg(0.1)] }, midCtx({ capitalUsdt: 72 }));
  assert.equal(credentials.orders.length, 1);
  assert.equal(credentials.orders[0].price, 715);
});

test('live close keeps the executable book price (not the mid)', async () => {
  const { runner, strategy, credentials } = await midSetup();
  await runner.executeLive(strategy, { type: 'close', reason: 'stop_loss', detail: 'stop',
    legs: [{ ...midLeg(), side: 'SELL', positionId: 1 }] }, midCtx({ capitalUsdt: 1000 }));
  assert.equal(credentials.orders.length, 1);
  assert.equal(credentials.orders[0].price, 700);
});

test('live SELL open without ask falls back to the bid', async () => {
  const { runner, strategy, credentials } = await midSetup({ bid: 700, ask: null });
  await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs: [{ ...midLeg(), side: 'SELL' }] },
    midCtx({ capitalUsdt: 1e6 }));
  assert.equal(credentials.orders.length, 1);
  assert.equal(credentials.orders[0].price, 700);
});

test('live BUY open without ask has no executable price and is skipped', async () => {
  const { runner, strategy, credentials } = await midSetup({ bid: 700, ask: null });
  const ctx = midCtx({ capitalUsdt: 1000 });
  await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs: [midLeg()] }, ctx);
  assert.equal(credentials.orders.length, 0);
  assert.equal(ctx.produced.find((p) => p.type === 'skip').reason, 'no_liquidity');
});

test('non-alert live open keeps the executable price, not the mid', async () => {
  const { runner, strategy, credentials, market } = await setup({ mode: 'live' });
  assert.equal(strategy.template, 'short_strangle');
  const original = market.getQuote;
  market.getQuote = async (symbol, opts) => ({ ...(await original(symbol, opts)), bid: 700, ask: 725 });
  market.getPriceFilter = async () => ({ tickSize: '5', minPrice: '5', maxPrice: '100000' });
  await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs: [midLeg()] }, midCtx({ capitalUsdt: 1000 }));
  await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs: [{ ...midLeg(), side: 'SELL' }] }, midCtx({ capitalUsdt: 1e6 }));
  assert.deepEqual(credentials.orders.map((o) => o.price), [725, 700]);
});

test('live submit outcomes leave readable text; attention stays pending', async () => {
  const { runner, strategy } = await midSetup();
  const texts = {};
  for (const status of ['attention', 'rejected', 'deadline', 'duplicate_or_unresolved']) {
    runner.liveExecutor.submit = async () => ({ status, sent: 0, error: 'Binance -2010' });
    const ctx = midCtx({ capitalUsdt: 1000 });
    await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs: [midLeg(0.1)] }, ctx);
    const p = ctx.produced.find((x) => x.type === 'open');
    texts[status] = p;
    assert.notEqual(p.detail, status);
  }
  assert.equal(texts.attention.pending, true);
  assert.equal(texts.rejected.pending, false);
  assert.match(texts.rejected.detail, /Binance -2010/);
});

test('pending signal shows estimated fee', async () => {
  const { runner, strategy, credentials, repo } = await midSetup();
  const fees = [];
  repo.setAutoSignalFees = async (id, patch) => { fees.push({ id, ...patch }); };
  const ctx = { ...midCtx({ capitalUsdt: 1000 }), signal: { eventId: 5, signalId: 31, direction: 'bullish' } };
  await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs: [midLeg(0.1)] }, ctx);
  assert.equal(credentials.orders.length, 1);
  const expected = tradeFee({ spot: SPOT, quantity: 0.1, price: 715 });
  assert.equal(fees.length, 1);
  assert.equal(fees[0].id, 31);
  assert.equal(fees[0].feesEstimated, true);
  assert.ok(Math.abs(fees[0].feesUsdt - expected) < 1e-12);
  // Sin signalId (reentradas diferidas) no hay señal que anotar.
  await runner.executeLive(strategy, { type: 'open', detail: 'entry', legs: [midLeg(0.1)] }, midCtx({ capitalUsdt: 1000 }));
  assert.equal(fees.length, 1);
});

// ---------- señal contraria con entradas pendientes ----------

const PENDING_PUT = 'BTC-261023-55000-P';

function cancelEnv(env, { orders = [], queued = true } = {}) {
  const calls = { cancel: [], queue: [] };
  env.runner.liveOrders = { async listByStrategy() { return orders; } };
  env.runner.liveExecutor.repo.requestCancelEntries = async (args) => {
    calls.cancel.push(args);
    return orders.filter((o) => o.status !== 'final').map((o) => o.id);
  };
  env.runner.liveExecutor.repo.queueSignalReevaluation = async (strategy, signal, ids) => {
    calls.queue.push({ strategyId: strategy.id, signal, ids });
    return queued;
  };
  return calls;
}

test('cancel_entries live requests cancel and queues reevaluation', async () => {
  const env = await setup({ mode: 'live', template: 'alert_signal', params: { alertIds: [1], maxOpenPositions: 5 } });
  const calls = cancelEnv(env, { orders: [pendingEntry(env.strategy.id, { id: 11, symbol: PENDING_PUT })] });
  const signal = { eventId: '501', direction: 'bullish', signalId: 77 };
  const { actions, produced } = await env.runner.runForSignal(env.strategy, signal);
  assert.deepEqual(actions.live.map((a) => a.type), ['cancel_entries']);
  assert.deepEqual(calls.cancel, [{ userId: 7, strategyId: env.strategy.id, underlying: 'BTC' }]);
  assert.deepEqual(calls.queue, [{ strategyId: env.strategy.id, signal, ids: [11] }]);
  // Ninguna orden real nueva: se espera a que la cancelación sea final.
  assert.equal(env.credentials.orders.length, 0);
  const live = produced.filter((p) => p.mode === 'live');
  assert.equal(live.length, 1);
  assert.equal(live[0].pending, true);
  assert.equal(live[0].reason, 'reevaluation_queued');
  // La sombra no tiene entradas pendientes: abre.
  assert.equal(actions.shadow[0].type, 'open');
});

test('cancel_entries live with trading disabled cancels but does not queue a reevaluation', async () => {
  const env = await setup({ mode: 'live', template: 'alert_signal', params: { alertIds: [1], maxOpenPositions: 5 } });
  const calls = cancelEnv(env, { orders: [pendingEntry(env.strategy.id, { id: 11, symbol: PENDING_PUT })] });
  env.runner.liveExecutor.enabled = false;
  const { produced } = await env.runner.runForSignal(env.strategy, { eventId: '501', direction: 'bullish' });
  assert.equal(calls.cancel.length, 1);
  assert.equal(calls.queue.length, 0);
  assert.equal(produced.find((p) => p.mode === 'live').reason, 'entries_cancel_requested');
});

test('cancel_entries live without the ledger fails closed', async () => {
  const env = await setup({ mode: 'live', template: 'alert_signal', params: { alertIds: [1], maxOpenPositions: 5 } });
  env.runner.liveOrders = { async listByStrategy(id) { return [pendingEntry(id, { id: 11, symbol: PENDING_PUT })]; } };
  const { produced } = await env.runner.runForSignal(env.strategy, { eventId: '501', direction: 'bullish' });
  const live = produced.filter((p) => p.mode === 'live');
  assert.deepEqual(live.map((p) => p.type), ['error']);
  assert.equal(env.credentials.orders.length, 0);
});

test('pendingEntries: dirección por lado y tipo, solo del subyacente evaluado', async () => {
  const env = await setup({ mode: 'live', template: 'alert_signal', params: { alertIds: [1], maxOpenPositions: 5 } });
  // Compra de call en BTC = alcista (mismo sentido): ocupa. La de ETH no cuenta.
  cancelEnv(env, { orders: [pendingEntry(env.strategy.id, { id: 11, symbol: 'BTC-261023-65000-C' }),
    pendingEntry(env.strategy.id, { id: 12, symbol: 'ETH-261023-3000-P' })] });
  let ctx = null;
  const template = require('../src/services/options/templates').getTemplate('alert_signal');
  const original = template.evaluate;
  template.evaluate = (c) => { if (c.mode === 'live') ctx = c; return original(c); };
  try {
    const { actions } = await env.runner.runForSignal(env.strategy, { eventId: '501', direction: 'bullish' });
    assert.deepEqual(ctx.pendingEntries, [{ id: 11, direction: 'bullish' }]);
    assert.equal(ctx.pendingOpens, undefined);
    assert.equal(actions.live[0].reason, 'underlying_busy');
  } finally {
    template.evaluate = original;
  }
});

test('una entrada con la cancelación ya pedida tiene sentido desconocido: la señal posterior encola su propia reevaluación', async () => {
  // A alcista en reposo; B bajista pidió cancelarla. C alcista llega antes de que A sea final:
  // no puede quedar «ocupado» (la reevaluación de B abriría bajista), C se encola.
  const env = await setup({ mode: 'live', template: 'alert_signal', params: { alertIds: [1], maxOpenPositions: 5 } });
  const calls = cancelEnv(env, { orders: [pendingEntry(env.strategy.id,
    { id: 11, symbol: 'BTC-261023-65000-C', cancelRequested: true })] });
  const signal = { eventId: '503', direction: 'bullish', signalId: 79 };
  const { actions } = await env.runner.runForSignal(env.strategy, signal);
  assert.deepEqual(actions.live.map((a) => a.type), ['cancel_entries']);
  assert.equal(actions.live[0].reevaluate, true);
  assert.deepEqual(calls.queue, [{ strategyId: env.strategy.id, signal, ids: [11] }]);
  assert.equal(env.credentials.orders.length, 0);
});

test('cancel_entries shadow cancels at once and the evaluation continues', async () => {
  const repo = createFakeOptionsRepo({ now: () => FRIDAY_9 });
  const canceled = [];
  const shadowEntries = {
    async listPending({ strategyId }) {
      return [
        { id: 3, strategyId, symbol: PENDING_PUT, side: 'BUY', optionType: 'P', status: 'pending' },
        { id: 4, strategyId, symbol: 'ETH-261023-3000-P', side: 'BUY', optionType: 'P', status: 'pending' },
      ];
    },
    async cancelEntries(ids, at) { canceled.push({ ids, at }); return ids; },
    async insertEntry(row) { inserted.push(row); return { id: 5, ...row }; },
  };
  const inserted = [];
  const runner = new OptionsStrategyRunner({ repo, market: fakeMarket(), credentials: fakeCredentials(),
    shadowEntries, liveExecutor: { enabled: true, repo: {} }, logger: silent, now: () => FRIDAY_9 });
  const strategy = await repo.createStrategy({ userId: 7, name: 'Bot', template: 'alert_signal', underlying: 'BTC',
    params: { alertIds: [1], maxOpenPositions: 5 }, mode: 'shadow' });
  const { actions } = await runner.runForSignal(strategy, { eventId: '9', direction: 'bullish' });
  assert.deepEqual(actions.shadow.map((a) => a.type), ['cancel_entries', 'open']);
  assert.deepEqual(canceled, [{ ids: [3], at: FRIDAY_9 }]);
  // La nueva apertura en sombra también espera al medio.
  assert.equal(inserted.length, 1);
  assert.equal(repo.positions.filter((p) => p.mode === 'shadow').length, 0);
});

test('blocked underlying: the runner passes the fresh block to the template', async () => {
  const env = await setup({ mode: 'live', template: 'alert_signal', params: { alertIds: [1] } });
  // El ejecutor bloquea en el repo después de cargar la estrategia.
  env.repo.strategies[0].state = { blockedUnderlyings: { BTC: { reason: 'remainder_not_orderable', at: FRIDAY_9 } } };
  const { actions } = await env.runner.runForSignal(env.strategy, { eventId: '501', direction: 'bullish' });
  assert.deepEqual(actions.live, [{ type: 'skip', reason: 'underlying_blocked',
    detail: 'Resto no operable en BTC: revísalo y desbloquéalo' }]);
  // El bloqueo es del libro real: la sombra sigue evaluando y abre.
  assert.equal(actions.shadow[0].type, 'open');
  assert.equal(env.credentials.orders.length, 0);
});

test('reevaluateSignal re-runs the signal in live only', async () => {
  const env = await setup({ mode: 'live', template: 'alert_signal', params: { alertIds: [1], maxOpenPositions: 5 } });
  cancelEnv(env, { orders: [pendingEntry(env.strategy.id, { id: 11, symbol: PENDING_PUT, status: 'final' })] });
  const result = await env.runner.reevaluateSignal(env.strategy.id, { eventId: '501', direction: 'bullish' });
  assert.equal(result.status, 'evaluated');
  assert.equal(env.credentials.orders.length, 1);
  assert.equal(env.credentials.orders[0].side, 'BUY');
  // La sombra ya evaluó la señal al llegar: no se repite.
  assert.equal(env.repo.positions.filter((p) => p.mode === 'shadow').length, 0);
});

test('reevaluateSignal: the filled part of the canceled entry reverses through queueReversal', async () => {
  const env = await setup({ mode: 'live', template: 'alert_signal',
    params: { alertIds: [1], maxOpenPositions: 5, onOpposite: 'reverse' } });
  cancelEnv(env);
  await env.repo.insertPosition({ strategyId: env.strategy.id, userId: 7, mode: 'live', symbol: PENDING_PUT,
    side: 'BUY', quantity: 0.004, entryPrice: 100, openedAt: FRIDAY_9, feesUsdt: 0 });
  const reversals = [];
  env.runner.liveExecutor.queueReversal = async (strategy, signal, close) => { reversals.push({ signal, close }); return true; };
  const signal = { eventId: '501', direction: 'bullish' };
  const result = await env.runner.reevaluateSignal(env.strategy.id, signal);
  assert.equal(result.status, 'reversal_queued');
  assert.equal(reversals.length, 1);
  assert.equal(reversals[0].signal, signal);
  assert.equal(env.credentials.orders.length, 0);
});

test('reevaluateSignal: new pending entries keep the request waiting; disabled or removed do not run', async () => {
  const env = await setup({ mode: 'live', template: 'alert_signal', params: { alertIds: [1], maxOpenPositions: 5 } });
  cancelEnv(env, { orders: [pendingEntry(env.strategy.id, { id: 12, symbol: PENDING_PUT })] });
  assert.equal((await env.runner.reevaluateSignal(env.strategy.id, { eventId: '501', direction: 'bullish' })).status, 'waiting');
  assert.equal((await env.runner.reevaluateSignal(env.strategy.id, { eventId: '501', direction: 'bullish', underlying: 'DOGE' })).status, 'underlying_removed');
  env.runner.liveExecutor.enabled = false;
  assert.equal((await env.runner.reevaluateSignal(env.strategy.id, { eventId: '501', direction: 'bullish' })).status, 'disabled');
  assert.equal(env.credentials.orders.length, 0);
});

// ---------- la señal reevaluada se resuelve ----------

async function reevaluationSetup(params, { position = true } = {}) {
  const env = await setup({ mode: 'live', template: 'alert_signal', params: { alertIds: [1], maxOpenPositions: 5, ...params } });
  cancelEnv(env);
  if (position) {
    await env.repo.insertPosition({ strategyId: env.strategy.id, userId: 7, mode: 'live', symbol: PENDING_PUT,
      side: 'BUY', quantity: 0.004, entryPrice: 100, openedAt: FRIDAY_9, feesUsdt: 0 });
  }
  const claim = await env.repo.claimAutoSignal({ strategyId: env.strategy.id, userId: 7, alertEventId: '501',
    direction: 'bullish', decision: 'pending', detail: 'Real: Cancelando la entrada pendiente; se reevalúa al conciliar' });
  const signal = { eventId: '501', direction: 'bullish', underlying: 'BTC', signalId: claim.id };
  return { ...env, signal, row: () => env.repo.signals.find((x) => x.id === claim.id) };
}

test('reevaluation that only closes resolves the signal as closed', async () => {
  const env = await reevaluationSetup({ onOpposite: 'close' });
  const result = await env.runner.reevaluateSignal(env.strategy.id, env.signal);
  assert.equal(result.status, 'evaluated');
  assert.equal(env.credentials.orders.length, 1);
  assert.equal(env.credentials.orders[0].reduceOnly, true);
  assert.deepEqual({ d: env.row().decision, t: env.row().detail },
    { d: 'closed', t: 'Real: entrada cancelada; posición contraria cerrada' });
});

test('reevaluation ignored by the rule resolves the signal as ignored', async () => {
  const env = await reevaluationSetup({ onOpposite: 'ignore' });
  await env.runner.reevaluateSignal(env.strategy.id, env.signal);
  assert.equal(env.credentials.orders.length, 0);
  assert.deepEqual({ d: env.row().decision, t: env.row().detail },
    { d: 'ignored', t: 'Real: entrada cancelada; señal ignorada por la regla' });
});

test('reevaluation that opens links the batch to the signal and leaves it pending', async () => {
  const env = await reevaluationSetup({}, { position: false });
  const seen = [];
  const submit = env.runner.liveExecutor.submit;
  env.runner.liveExecutor.submit = async (strategy, action, ctx) => { seen.push(ctx.signal?.signalId); return submit(strategy, action, ctx); };
  await env.runner.reevaluateSignal(env.strategy.id, env.signal);
  assert.deepEqual(seen, [env.signal.signalId]);
  // La resuelve el ejecutor con los fills del lote (Task 4).
  assert.equal(env.row().decision, 'pending');
});

test('reevaluation skipped for another reason resolves ignored with that reason', async () => {
  const env = await reevaluationSetup({ maxTradesPerDay: 1 }, { position: false });
  await env.repo.insertEvent({ strategyId: env.strategy.id, userId: 7, mode: 'live', action: 'open', detail: 'x', createdAt: FRIDAY_9 });
  await env.runner.reevaluateSignal(env.strategy.id, env.signal);
  assert.equal(env.row().decision, 'ignored');
  assert.match(env.row().detail, /^Real: entrada cancelada; Máximo de 1 operación/);
});

// ---------- sombra: entradas pendientes al medio ----------

const { WINDOW_MS } = require('../src/services/options/options-live-execution.service');

/** Bot por alertas en sombra con el libro del contrato fijado en bid/ask. */
async function shadowEntrySetup({ mode = 'shadow', bid = 710, ask = 720, params = {} } = {}) {
  const env = await setup({ mode, template: 'alert_signal', params: { alertIds: [1], maxOpenPositions: 5, ...params } });
  const book = { bid, ask };
  const original = env.market.getQuote;
  env.market.getQuote = async (symbol, opts) => ({ ...(await original(symbol, opts)), bid: book.bid, ask: book.ask });
  const claim = await env.repo.claimAutoSignal({ strategyId: env.strategy.id, userId: 7, alertEventId: '700',
    direction: 'bullish', decision: 'pending', detail: 'Procesando…' });
  const signal = { eventId: '700', direction: 'bullish', underlying: 'BTC', signalId: claim.id };
  return { ...env, book, signal, row: () => env.repo.signals.find((x) => x.id === claim.id) };
}

test('shadow entry fills when ask reaches the limit', async () => {
  const env = await shadowEntrySetup();
  const { produced } = await env.runner.runForSignal(env.strategy, env.signal);
  assert.equal(env.repo.positions.length, 0);
  const [entry] = env.shadowEntries.entries;
  assert.equal(entry.side, 'BUY');
  assert.equal(entry.limitPrice, 715);
  assert.equal(entry.autoSignalId, env.signal.signalId);
  assert.equal(entry.alertEventId, '700');
  assert.equal(entry.deadlineAt, FRIDAY_9 + WINDOW_MS);
  const { decide } = require('../src/services/options/options-auto-trading.service');
  assert.deepEqual(decide(env.strategy, produced),
    { decision: 'pending', detail: 'Sombra: Orden LIMIT al medio, esperando ejecución' });

  // Aún sin llegar: sigue pendiente.
  env.clock.now = FRIDAY_9 + 60_000;
  assert.deepEqual(await env.runner.processShadowEntries(), { filled: 0, expired: 0 });
  env.book.ask = 714;
  env.book.bid = 705;
  env.clock.now = FRIDAY_9 + 120_000;
  assert.deepEqual(await env.runner.processShadowEntries(), { filled: 1, expired: 0 });
  const [position] = env.repo.positions;
  assert.equal(position.mode, 'shadow');
  assert.equal(position.entryPrice, 715);
  const fee = tradeFee({ spot: SPOT, quantity: entry.quantity, price: 715 });
  assert.ok(Math.abs(position.feesUsdt - fee) < 1e-12);
  assert.equal(env.shadowEntries.entries[0].status, 'filled');
  assert.equal(env.row().decision, 'opened');
  assert.equal(env.row().feesEstimated, true);
  assert.ok(Math.abs(env.row().feesUsdt - fee) < 1e-12);
  assert.match(env.row().detail, /^Sombra: Compra .* a 715/);
  // Otra pasada (tick y conciliador a la vez) no vuelve a registrar.
  assert.deepEqual(await env.runner.processShadowEntries(), { filled: 0, expired: 0 });
  assert.equal(env.repo.positions.length, 1);
});

test('shadow entry with maxSpreadPct waits while the book spread is too wide at fill time', async () => {
  const env = await shadowEntrySetup({ params: { maxSpreadPct: 5 } });
  await env.runner.runForSignal(env.strategy, env.signal);
  assert.equal(env.shadowEntries.entries[0].limitPrice, 715);
  // El ask llega al límite, pero el bid se desploma: spread ≈ 56 %, no se llena.
  env.book.ask = 714;
  env.book.bid = 400;
  env.clock.now = FRIDAY_9 + 60_000;
  assert.deepEqual(await env.runner.processShadowEntries(), { filled: 0, expired: 0 });
  // Sin bid tampoco: no hay spread que comprobar.
  env.book.bid = 0;
  env.clock.now = FRIDAY_9 + 90_000;
  assert.deepEqual(await env.runner.processShadowEntries(), { filled: 0, expired: 0 });
  assert.equal(env.repo.positions.length, 0);
  // Libro sano otra vez: se llena al límite.
  env.book.bid = 705;
  env.clock.now = FRIDAY_9 + 120_000;
  assert.deepEqual(await env.runner.processShadowEntries(), { filled: 1, expired: 0 });
  assert.equal(env.repo.positions[0].entryPrice, 715);
});

test('shadow entry without maxSpreadPct fills on the ask alone', async () => {
  const env = await shadowEntrySetup();
  await env.runner.runForSignal(env.strategy, env.signal);
  env.book.ask = 714;
  env.book.bid = 400;
  env.clock.now = FRIDAY_9 + 60_000;
  assert.deepEqual(await env.runner.processShadowEntries(), { filled: 1, expired: 0 });
});

test('shadow entry: concurrent passes book the fill only once', async () => {
  const env = await shadowEntrySetup();
  await env.runner.runForSignal(env.strategy, env.signal);
  env.book.ask = 715;
  const results = await Promise.all([env.runner.processShadowEntries(), env.runner.processShadowEntries()]);
  assert.equal(results.reduce((n, r) => n + r.filled, 0), 1);
  assert.equal(env.repo.positions.length, 1);
});

test('shadow entry expires after 10 min', async () => {
  const env = await shadowEntrySetup();
  await env.runner.runForSignal(env.strategy, env.signal);
  env.clock.now = FRIDAY_9 + WINDOW_MS;
  assert.deepEqual(await env.runner.processShadowEntries(), { filled: 0, expired: 1 });
  assert.equal(env.shadowEntries.entries[0].status, 'expired');
  assert.equal(env.repo.positions.length, 0);
  assert.equal(env.row().decision, 'ignored');
  assert.equal(env.row().detail, 'Sombra: Entrada sin ejecutar en 10 min');
});

test('pending shadow entry survives restart and expires', async () => {
  const env = await shadowEntrySetup();
  await env.runner.runForSignal(env.strategy, env.signal);
  const restarted = new OptionsStrategyRunner({ repo: env.repo, market: env.market, credentials: env.credentials,
    shadowEntries: env.shadowEntries, liveExecutor: env.runner.liveExecutor, logger: silent,
    now: () => FRIDAY_9 + WINDOW_MS + 1 });
  assert.deepEqual(await restarted.processShadowEntries(), { filled: 0, expired: 1 });
  assert.equal(env.row().detail, 'Sombra: Entrada sin ejecutar en 10 min');
});

test('pending shadow entry blocks a same-direction signal', async () => {
  const env = await shadowEntrySetup();
  await env.runner.runForSignal(env.strategy, env.signal);
  const { actions } = await env.runner.runForSignal(env.strategy, { eventId: '701', direction: 'bullish', underlying: 'BTC' });
  assert.equal(actions.shadow.at(-1).reason, 'underlying_busy');
  assert.equal(env.shadowEntries.entries.length, 1);
});

test('opposite signal cancels the shadow entry and resolves its signal', async () => {
  const env = await shadowEntrySetup();
  await env.runner.runForSignal(env.strategy, env.signal);
  await env.runner.runForSignal(env.strategy, { eventId: '702', direction: 'bearish', underlying: 'BTC' });
  assert.equal(env.shadowEntries.entries[0].status, 'canceled');
  assert.equal(env.row().decision, 'ignored');
  assert.equal(env.row().detail, 'Sombra: Entrada cancelada por señal contraria');
  // La señal contraria deja su propia entrada pendiente.
  assert.equal(env.shadowEntries.entries[1].status, 'pending');
  assert.equal(env.shadowEntries.entries[1].side, 'BUY');
});

test('shadow entry: without a valid mid it rests at the ask', async () => {
  const env = await shadowEntrySetup({ bid: 0, ask: 720 });
  await env.runner.runForSignal(env.strategy, env.signal);
  assert.equal(env.shadowEntries.entries.length, 1);
  assert.equal(env.shadowEntries.entries[0].limitPrice, 720);
});

test('shadow entry: without an executable side there is no entry', async () => {
  const env = await shadowEntrySetup({ bid: 700, ask: 0 });
  const { produced } = await env.runner.runForSignal(env.strategy, env.signal);
  assert.equal(env.shadowEntries.entries.length, 0);
  assert.ok(produced.some((p) => p.mode === 'shadow' && p.reason === 'no_liquidity'));
});

test('shadow entry of a live bot is a parallel book: it never resolves the signal', async () => {
  const env = await shadowEntrySetup({ mode: 'live' });
  await env.runner.runForSignal(env.strategy, env.signal);
  const entry = env.shadowEntries.entries.find((e) => e.strategyId === env.strategy.id);
  assert.equal(entry.autoSignalId, null);
  env.clock.now = FRIDAY_9 + WINDOW_MS;
  await env.runner.processShadowEntries();
  assert.equal(env.row().decision, 'pending');
});

test('shadow entry of a paused or deleted bot is canceled without booking', async () => {
  const env = await shadowEntrySetup();
  await env.runner.runForSignal(env.strategy, env.signal);
  env.repo.strategies[0].mode = 'paused';
  env.book.ask = 700;
  assert.deepEqual(await env.runner.processShadowEntries(), { filled: 0, expired: 1 });
  assert.equal(env.shadowEntries.entries[0].status, 'canceled');
  assert.equal(env.repo.positions.length, 0);
  assert.equal(env.row().decision, 'ignored');
});

test('other templates keep instant shadow fills', async () => {
  const env = await setup();
  await env.runner.tick();
  assert.equal(env.shadowEntries.entries.length, 0);
  assert.equal(env.repo.positions.filter((p) => p.closedAt == null).length, 2);
});

test('shadow open+close splits entry and exit fees', async () => {
  const { repo, runner, strategy } = await setup({ mode: 'paused' });
  const openLeg = { symbol: 'BTC-261030-58000-P', side: 'SELL', quantity: 0.1, price: 300, fee: 1.8 };
  await runner.book(strategy, 'shadow', { type: 'open', legs: [openLeg] }, [openLeg], { now: FRIDAY_9, positions: [] });
  const opened = repo.positions[0];
  assert.equal(opened.entryFeeUsdt, 1.8);
  assert.equal(opened.feesUsdt, 1.8);
  const leg = { symbol: opened.symbol, side: 'BUY', quantity: 0.1, price: 200, fee: 0.6, positionId: opened.id };
  await runner.book(strategy, 'shadow', { type: 'close', reason: 'take_profit', legs: [leg] }, [leg], { now: FRIDAY_9 + HOUR_MS, positions: [{ ...opened }] });
  const p = repo.positions[0];
  assert.equal(p.entryFeeUsdt, 1.8);
  assert.equal(p.exitFeeUsdt, 0.6);
  assert.equal(p.exerciseFeeUsdt ?? null, null);
  assert.ok(Math.abs(p.feesUsdt - 2.4) < 1e-12);
});

test('shadow expiry books exercise fee', async () => {
  const { repo, runner, market, strategy } = await setup({ mode: 'paused' });
  await repo.insertPosition({ strategyId: strategy.id, userId: 7, mode: 'shadow', symbol: 'BTC-261016-58000-P', side: 'SELL', quantity: 0.1, entryPrice: 300, openedAt: FRIDAY_9 - 7 * DAY_MS, feesUsdt: 1.8 });
  market.state.spot = 57000;
  await runner.tick();
  const p = repo.positions[0];
  const exFee = Math.min(0.00015 * 57000 * 0.1, 0.1 * 1000 * 0.1);
  assert.equal(p.entryFeeUsdt, 1.8);
  assert.equal(p.exitFeeUsdt ?? null, null);
  assert.ok(Math.abs(p.exerciseFeeUsdt - exFee) < 1e-12);
  assert.ok(Math.abs(p.feesUsdt - (1.8 + exFee)) < 1e-12);
});
