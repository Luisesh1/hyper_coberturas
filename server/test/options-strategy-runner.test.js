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
