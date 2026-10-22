const test = require('node:test');
const assert = require('node:assert/strict');

const { OptionsStrategyRunner } = require('../src/services/options/options-strategy-runner.service');
const { createOptionsAutoTradingService } = require('../src/services/options/options-auto-trading.service');
const { buildSyntheticChain, syntheticExpiries } = require('../src/services/options/options-synthetic-chain');
const { parseSymbol, HOUR_MS } = require('../src/services/options/options-utils');
const { createFakeOptionsRepo } = require('./support/options-fake-repo');

const NOW = Date.UTC(2026, 9, 16, 9);
const USER = 7;
const SPOTS = { BTC: 60000, ETH: 3000, SOL: 150 };
const silent = { info() {}, warn() {}, error() {} };

/** Mercado sintético por subyacente; registra qué cadenas se piden. */
function fakeMarket({ now = NOW } = {}) {
  const state = { priceFactor: 1, chainCalls: [], spots: { ...SPOTS } };
  const expiries = syntheticExpiries(now);
  const chainOf = (underlying, code) => {
    const e = expiries.find((x) => x.code === code) || expiries[0];
    const chain = buildSyntheticChain({ underlying, spot: state.spots[underlying], now, expiry: e, atmIv: 0.6, spreadPct: 4 });
    const scale = (q) => (q ? { ...q, bid: q.bid * state.priceFactor, ask: q.ask * state.priceFactor, mark: q.mark * state.priceFactor } : q);
    return { ...chain, rows: chain.rows.map((r) => ({ ...r, call: scale(r.call), put: scale(r.put) })), expiries };
  };
  return {
    state,
    async getChain(underlying, expiry) {
      state.chainCalls.push(underlying);
      return chainOf(underlying, expiry);
    },
    async getQuote(symbol) {
      const meta = parseSymbol(symbol);
      const row = chainOf(meta.underlying, meta.expiry).rows.find((r) => r.strike === meta.strike);
      if (!row) throw new Error('símbolo desconocido');
      return { ...(meta.type === 'C' ? row.call : row.put), ...meta, spot: state.spots[meta.underlying] };
    },
  };
}

async function setup({ params = {}, underlying = 'BTC', underlyings = ['BTC', 'ETH'] } = {}) {
  const clock = { now: NOW };
  const repo = createFakeOptionsRepo({ now: () => clock.now });
  const market = fakeMarket();
  const credentials = {
    async getClientForUser() { throw new Error('sin órdenes reales en tests'); },
    async getLimits() { return { maxMarginUsdt: 1e6, maxDailyLossUsdt: 1e6, maxLiveStrategies: 5, notifyTelegram: false }; },
  };
  const runner = new OptionsStrategyRunner({ repo, market, credentials, notify: async () => {}, logger: silent, now: () => clock.now });
  const service = createOptionsAutoTradingService({ repo, runner, logger: silent, now: () => clock.now, alerts: { listAlerts: async () => [] } });
  const bot = await repo.createStrategy({
    userId: USER,
    name: 'Bot multi',
    template: 'alert_signal',
    underlying,
    params: { alertIds: [11], ...(underlyings ? { underlyings } : {}), ...params },
    limits: {},
    mode: 'shadow',
  });
  return { clock, repo, market, runner, service, bot };
}

let eventSeq = 1000;
const fire = (overrides = {}) => ({
  userId: USER, alertId: 11, alertName: 'Cruce', direction: 'bullish', asset: 'BTCUSDT',
  score: 80, eventId: (eventSeq += 1), triggeredAt: NOW, ...overrides,
});
const openOf = (repo) => repo.positions.filter((p) => p.closedAt == null);
const underlyingOf = (p) => parseSymbol(p.symbol).underlying;

test('bot BTC+ETH: disparo ETHUSDT abre en la cadena ETH; SOLUSDT no se procesa', async () => {
  const { repo, service, market } = await setup();
  const [res] = await service.handleAlertTriggered(fire({ asset: 'ETHUSDT' }));
  assert.equal(res.decision, 'opened');
  const [p] = openOf(repo);
  assert.equal(underlyingOf(p), 'ETH');
  assert.ok(market.state.chainCalls.includes('ETH'));

  assert.deepEqual(await service.handleAlertTriggered(fire({ asset: 'SOLUSDT' })), []);
  assert.equal(repo.signals.length, 1);
});

test('bot antiguo sin underlyings: solo su subyacente, igual que antes', async () => {
  const { repo, service, market } = await setup({ underlyings: null });
  assert.deepEqual(await service.handleAlertTriggered(fire({ asset: 'ETHUSDT' })), []);
  const [res] = await service.handleAlertTriggered(fire({ asset: 'BTCUSDT' }));
  assert.equal(res.decision, 'opened');
  assert.equal(underlyingOf(openOf(repo)[0]), 'BTC');
  assert.ok(!market.state.chainCalls.includes('ETH'));
});

test('límites compartidos: maxOpenPositions 1 con BTC abierta → señal ETH max_open_positions', async () => {
  const { repo, service } = await setup({ params: { maxOpenPositions: 1 } });
  assert.equal((await service.handleAlertTriggered(fire({ asset: 'BTCUSDT' })))[0].decision, 'opened');
  const [res] = await service.handleAlertTriggered(fire({ asset: 'ETHUSDT' }));
  assert.equal(res.decision, 'ignored');
  assert.match(res.detail, /Máximo de 1 posición/);
  assert.equal(openOf(repo).length, 1);
});

test('límites compartidos: maxTradesPerDay suma todos los subyacentes', async () => {
  const { service } = await setup({ params: { maxOpenPositions: 5, maxTradesPerDay: 1 } });
  assert.equal((await service.handleAlertTriggered(fire({ asset: 'BTCUSDT' })))[0].decision, 'opened');
  const [res] = await service.handleAlertTriggered(fire({ asset: 'ETHUSDT' }));
  assert.equal(res.decision, 'ignored');
  assert.match(res.detail, /operación\(es\) por día/);
});

test('señal contraria por subyacente: bajista ETH no cierra la posición BTC (onOpposite close)', async () => {
  const { repo, service } = await setup({ params: { onOpposite: 'close', maxOpenPositions: 3 } });
  await service.handleAlertTriggered(fire({ asset: 'BTCUSDT' }));
  await service.handleAlertTriggered(fire({ asset: 'ETHUSDT' }));
  assert.deepEqual(openOf(repo).map(underlyingOf).sort(), ['BTC', 'ETH']);

  const [res] = await service.handleAlertTriggered(fire({ asset: 'ETHUSDT', direction: 'bearish' }));
  assert.equal(res.decision, 'closed');
  assert.deepEqual(openOf(repo).map(underlyingOf), ['BTC'], 'solo cierra la de ETH');
});

test('señal bajista ETH sin posición ETH no toca BTC (reverse → solo abre la put ETH)', async () => {
  const { repo, service } = await setup({ params: { maxOpenPositions: 3 } });
  await service.handleAlertTriggered(fire({ asset: 'BTCUSDT' }));
  const [res] = await service.handleAlertTriggered(fire({ asset: 'ETHUSDT', direction: 'bearish' }));
  assert.equal(res.decision, 'opened');
  const open = openOf(repo);
  assert.equal(open.length, 2);
  const eth = open.find((p) => underlyingOf(p) === 'ETH');
  assert.equal(parseSymbol(eth.symbol).type, 'P');
});

test('presupuesto compartido: 48/4 con 40 comprometidos en BTC → la señal ETH dimensiona 8', async () => {
  const { repo, runner, bot } = await setup({ params: { budgetUsdt: 48, budgetFractions: 4, maxOpenPositions: 5 } });
  const btc = await runner.chainFor('BTC', null, { chains: new Map() });
  const row = btc.rows.find((r) => r.strike > SPOTS.BTC);
  // Compra BTC con 40 USDT de prima comprometidos.
  await repo.insertPosition({ strategyId: bot.id, userId: USER, mode: 'shadow', symbol: row.call.symbol, side: 'BUY', quantity: 0.01, entryPrice: 4000, openedAt: NOW, feesUsdt: 0 });
  const strategy = await repo.getStrategy(USER, bot.id);
  const { actions } = await runner.runForSignal(strategy, { direction: 'bullish', underlying: 'ETH' });
  const open = actions.shadow.find((a) => a.type === 'open');
  assert.ok(open, JSON.stringify(actions.shadow));
  assert.equal(open.signalBudgetUsdt, 8);
  assert.ok(open.legs.every((l) => parseSymbol(l.symbol).underlying === 'ETH'));
});

test('presupuesto compartido: una venta BTC se valora con el spot de BTC aunque la señal sea ETH', async () => {
  const { repo, runner, bot } = await setup({ params: { structure: 'sell_against', budgetUsdt: 100000, budgetFractions: 1, maxOpenPositions: 5 } });
  const btc = await runner.chainFor('BTC', null, { chains: new Map() });
  const row = btc.rows.find((r) => r.strike < SPOTS.BTC);
  await repo.insertPosition({ strategyId: bot.id, userId: USER, mode: 'shadow', symbol: row.put.symbol, side: 'SELL', quantity: 1, entryPrice: 100, openedAt: NOW, feesUsdt: 0 });
  const strategy = await repo.getStrategy(USER, bot.id);
  const { actions } = await runner.runForSignal(strategy, { direction: 'bullish', underlying: 'ETH' });
  const open = actions.shadow.find((a) => a.type === 'open');
  // Margen BTC ≈ 100 + máx(15 % · 60000 − OTM, 10 % · 60000) ≥ 6100 (con el spot de ETH serían ~400).
  assert.ok(open.signalBudgetUsdt < 100000 - 6000, `presupuesto ${open.signalBudgetUsdt}`);
});

test('tick: posiciones BTC y ETH piden las dos cadenas y evalúan las salidas de ambas', async () => {
  const { clock, repo, runner, service, market } = await setup({ params: { maxOpenPositions: 3 } });
  await service.handleAlertTriggered(fire({ asset: 'BTCUSDT' }));
  await service.handleAlertTriggered(fire({ asset: 'ETHUSDT' }));
  assert.equal(openOf(repo).length, 2);

  market.state.chainCalls = [];
  market.state.priceFactor = 3; // las dos calls triplican: take profit.
  clock.now = NOW + HOUR_MS;
  await runner.tick();
  assert.ok(market.state.chainCalls.includes('BTC'));
  assert.ok(market.state.chainCalls.includes('ETH'));
  assert.equal(openOf(repo).length, 0);
  const closes = repo.events.filter((e) => e.action === 'close');
  assert.equal(closes.length, 2);
  assert.ok(closes.every((e) => /Take profit/.test(e.detail)));
});

test('tick: el objetivo por volatilidad de una posición ETH usa el spot de ETH', async () => {
  const { repo, runner, service, market } = await setup({ params: { maxOpenPositions: 3, takeProfitMode: 'volatility' } });
  const spots = [];
  market.getVolatilityInputs = async () => ({ atrHourly: SPOTS.ETH * 0.01, tickSize: 0.1, minPrice: 0.1 });
  await service.handleAlertTriggered(fire({ asset: 'ETHUSDT' }));
  const original = runner.attachVolatilityTargets.bind(runner);
  runner.attachVolatilityTargets = async (positions, params, spot, now) => {
    spots.push([positions.map(underlyingOf), spot]);
    return original(positions, params, spot, now);
  };
  await runner.tick();
  assert.deepEqual(spots, [[['ETH'], SPOTS.ETH]]);
  assert.equal(openOf(repo).length, 1);
});

test('cierre manual: cierra posiciones BTC y ETH, cada una con su cotización', async () => {
  const { repo, runner, service, bot } = await setup({ params: { maxOpenPositions: 3 } });
  await service.handleAlertTriggered(fire({ asset: 'BTCUSDT' }));
  await service.handleAlertTriggered(fire({ asset: 'ETHUSDT' }));
  const strategy = await repo.getStrategy(USER, bot.id);
  const { status } = await runner.closeManually(strategy, { mode: 'shadow' });
  assert.equal(status, 'closed');
  assert.equal(openOf(repo).length, 0);
});

test('vencimiento: posiciones BTC y ETH de un bot se liquidan cada una contra su índice', async () => {
  const { repo, runner, bot } = await setup();
  // Vencen el 16-10-2026 a las 08:00 UTC: ya pasado un día después.
  await repo.insertPosition({ strategyId: bot.id, userId: USER, mode: 'shadow', symbol: 'BTC-261016-50000-C', side: 'BUY', quantity: 1, entryPrice: 1, openedAt: NOW, feesUsdt: 0 });
  await repo.insertPosition({ strategyId: bot.id, userId: USER, mode: 'shadow', symbol: 'ETH-261016-2000-C', side: 'BUY', quantity: 1, entryPrice: 1, openedAt: NOW, feesUsdt: 0 });
  await runner.settleExpired({ now: NOW + 24 * HOUR_MS, chains: new Map() });
  const byUnderlying = Object.fromEntries(repo.positions.map((p) => [underlyingOf(p), p.exitPrice]));
  assert.equal(byUnderlying.BTC, SPOTS.BTC - 50000);
  assert.equal(byUnderlying.ETH, SPOTS.ETH - 2000);
});

test('simular: underlying opcional (por defecto el primero) y debe ser del bot', async () => {
  const { repo, service, bot, clock } = await setup();
  const res = await service.simulateSignal(USER, bot.id, { direction: 'bullish', underlying: 'eth' });
  assert.equal(res.decision, 'opened');
  assert.equal(underlyingOf(openOf(repo)[0]), 'ETH');
  assert.equal(repo.signals.at(-1).asset, 'ETH');
  clock.now += 20_000;
  await assert.rejects(service.simulateSignal(USER, bot.id, { direction: 'bullish', underlying: 'SOL' }), (err) => err.status === 400 && /SOL/.test(err.message));
  clock.now += 20_000;
  await service.simulateSignal(USER, bot.id, { direction: 'bearish' });
  assert.equal(repo.signals.at(-1).asset, 'BTC');
});
