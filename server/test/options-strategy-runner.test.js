const test = require('node:test');
const assert = require('node:assert/strict');

const { OptionsStrategyRunner, estimateMargin } = require('../src/services/options/options-strategy-runner.service');
const { buildSyntheticChain, syntheticExpiries } = require('../src/services/options/options-synthetic-chain');
const { parseSymbol, tradeFee, HOUR_MS, DAY_MS } = require('../src/services/options/options-utils');
const { createFakeOptionsRepo } = require('./support/options-fake-repo');

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
  const liveExecutor = {
    enabled: true,
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
    notify: async (userId, text) => notes.push({ userId, text }),
    logger: silent,
    now: () => clock.now,
  });
  const strategy = await repo.createStrategy({ userId: 7, name: 'Strangle BTC', template, underlying: 'BTC', params, limits, mode });
  return { repo, market, credentials, notes, runner, strategy, clock };
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
