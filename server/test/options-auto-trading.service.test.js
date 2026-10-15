const test = require('node:test');
const assert = require('node:assert/strict');

const { OptionsStrategyRunner } = require('../src/services/options/options-strategy-runner.service');
const {
  createOptionsAutoTradingService,
  assetToUnderlying,
  decide,
} = require('../src/services/options/options-auto-trading.service');
const { buildSyntheticChain, syntheticExpiries } = require('../src/services/options/options-synthetic-chain');
const { parseSymbol, tradeFee, HOUR_MS } = require('../src/services/options/options-utils');
const { createFakeOptionsRepo } = require('./support/options-fake-repo');

const NOW = Date.UTC(2026, 9, 16, 9);
const SPOT = 60000;
const USER = 7;
const silent = { info() {}, warn() {}, error() {} };

function fakeMarket({ now = NOW, spot = SPOT } = {}) {
  const state = { spot, priceFactor: 1 };
  const expiries = syntheticExpiries(now);
  const chainOf = (code) => {
    const e = expiries.find((x) => x.code === code) || expiries[0];
    const chain = buildSyntheticChain({ underlying: 'BTC', spot: state.spot, now, expiry: e, atmIv: 0.6, spreadPct: 4 });
    const scale = (q) => (q ? { ...q, bid: q.bid * state.priceFactor, ask: q.ask * state.priceFactor, mark: q.mark * state.priceFactor } : q);
    return { ...chain, rows: chain.rows.map((r) => ({ ...r, call: scale(r.call), put: scale(r.put) })), expiries };
  };
  return {
    state,
    async getChain(_underlying, expiry) { return chainOf(expiry); },
    async getQuote(symbol) {
      const meta = parseSymbol(symbol);
      const row = chainOf(meta.expiry).rows.find((r) => r.strike === meta.strike);
      if (!row) throw new Error('símbolo desconocido');
      return { ...(meta.type === 'C' ? row.call : row.put), ...meta, spot: state.spot };
    },
  };
}

function fakeEmitter() {
  const listeners = new Set();
  return {
    listeners,
    onAlertTriggered(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async emit(payload) {
      for (const fn of listeners) await fn(payload);
    },
  };
}

async function setup({ params = {}, mode = 'shadow', underlying = 'BTC' } = {}) {
  const clock = { now: NOW };
  const repo = createFakeOptionsRepo({ now: () => clock.now });
  const market = fakeMarket();
  const orders = [];
  const credentials = {
    async getClientForUser() { return { async placeOrder(o) { orders.push(o); return { orderId: orders.length, avgPrice: '0' }; } }; },
    async getLimits() { return { maxMarginUsdt: 1e6, maxDailyLossUsdt: 1e6, maxLiveStrategies: 5, notifyTelegram: false }; },
  };
  const runner = new OptionsStrategyRunner({ repo, market, credentials, notify: async () => {}, logger: silent, now: () => clock.now });
  const emitter = fakeEmitter();
  const service = createOptionsAutoTradingService({ repo, runner, alertEvents: emitter, logger: silent, now: () => clock.now, alerts: { listAlerts: async () => [] } });
  const bot = await repo.createStrategy({
    userId: USER,
    name: 'Bot BTC',
    template: 'alert_signal',
    underlying,
    params: { alertIds: [11], ...params },
    limits: {},
    mode,
  });
  return { clock, repo, market, runner, emitter, service, bot, orders };
}

const signal = (overrides = {}) => ({
  userId: USER,
  alertId: 11,
  alertName: 'RSI sobreventa',
  direction: 'bullish',
  asset: 'BTCUSDT',
  score: 82.5,
  thresholdPercent: 70,
  eventId: 501,
  candleCloseTime: NOW,
  triggeredAt: NOW,
  ...overrides,
});

test('assetToUnderlying quita el sufijo de cotización y exige un subyacente de opciones', () => {
  assert.equal(assetToUnderlying('BTCUSDT'), 'BTC');
  assert.equal(assetToUnderlying('ethusdc'), 'ETH');
  assert.equal(assetToUnderlying('SOLUSD'), 'SOL');
  assert.equal(assetToUnderlying('BINANCE:BNBUSDT'), 'BNB');
  assert.equal(assetToUnderlying('DOGE/USDT'), 'DOGE');
  assert.equal(assetToUnderlying('XRP'), 'XRP');
  assert.equal(assetToUnderlying('PEPEUSDT'), null);
  assert.equal(assetToUnderlying(''), null);
});

test('runForSignal en sombra: compra la call al ask con comisión y la registra', async () => {
  const { repo, runner, bot, orders } = await setup();
  const { actions, produced } = await runner.runForSignal(await repo.getStrategy(USER, bot.id), { direction: 'bullish' });
  assert.deepEqual(actions.shadow.map((a) => a.type), ['open']);
  assert.equal(actions.live, undefined);
  const [p] = repo.positions;
  assert.equal(repo.positions.length, 1);
  assert.equal(p.mode, 'shadow');
  assert.equal(p.side, 'BUY');
  assert.equal(parseSymbol(p.symbol).type, 'C');
  const leg = actions.shadow[0].legs[0];
  assert.ok(p.entryPrice >= leg.price, 'compra al ask del libro');
  assert.equal(p.feesUsdt, tradeFee({ spot: SPOT, quantity: p.quantity, price: p.entryPrice }));
  assert.equal(produced.filter((x) => x.booked).length, 1);
  assert.equal(repo.events.at(-1).action, 'open');
  assert.equal(orders.length, 0, 'la sombra no envía órdenes');
});

test('handleAlertTriggered: abre, registra la decisión y no procesa dos veces el mismo evento', async () => {
  const { repo, service, bot } = await setup();
  const [first] = await service.handleAlertTriggered(signal());
  assert.equal(first.decision, 'opened');
  assert.match(first.detail, /^Sombra: Señal alcista: compra \d+C/);
  assert.equal(repo.signals.length, 1);
  assert.equal(repo.signals[0].decision, 'opened');
  assert.equal(repo.signals[0].alertEventId, 501);
  assert.equal(repo.signals[0].strategyId, bot.id);

  const [again] = await service.handleAlertTriggered(signal());
  assert.equal(again.decision, 'duplicate');
  assert.equal(repo.signals.length, 1);
  assert.equal(repo.positions.length, 1);

  // Otro disparo alcista: ya hay una posición (máx. 1) → ignorada con motivo.
  const [capped] = await service.handleAlertTriggered(signal({ eventId: 502 }));
  assert.equal(capped.decision, 'ignored');
  assert.match(capped.detail, /Máximo de 1 posición/);

  // Bajista con reverse: cierra la call y compra put.
  const [rev] = await service.handleAlertTriggered(signal({ eventId: 503, direction: 'bearish' }));
  assert.equal(rev.decision, 'reversed');
  const open = repo.positions.filter((x) => x.closedAt == null);
  assert.equal(open.length, 1);
  assert.equal(parseSymbol(open[0].symbol).type, 'P');
});

test('handleAlertTriggered: onOpposite close → closed; ignore → ignored', async () => {
  const closeBot = await setup({ params: { onOpposite: 'close' } });
  await closeBot.service.handleAlertTriggered(signal());
  const [closed] = await closeBot.service.handleAlertTriggered(signal({ eventId: 600, direction: 'bearish' }));
  assert.equal(closed.decision, 'closed');
  assert.equal(closeBot.repo.positions.filter((x) => x.closedAt == null).length, 0);

  const ignoreBot = await setup({ params: { onOpposite: 'ignore' } });
  await ignoreBot.service.handleAlertTriggered(signal());
  const [ignored] = await ignoreBot.service.handleAlertTriggered(signal({ eventId: 601, direction: 'bearish' }));
  assert.equal(ignored.decision, 'ignored');
  assert.match(ignored.detail, /sentido contrario/);
});

test('handleAlertTriggered: alerta neutral → ignored «Alerta neutral» sin evaluar', async () => {
  const { repo, service } = await setup();
  const [res] = await service.handleAlertTriggered(signal({ direction: 'neutral' }));
  assert.equal(res.decision, 'ignored');
  assert.equal(repo.signals[0].detail, 'Alerta neutral');
  assert.equal(repo.positions.length, 0);
  // Sin dirección también cuenta como neutral.
  const [missing] = await service.handleAlertTriggered(signal({ direction: undefined, eventId: 777 }));
  assert.equal(missing.decision, 'ignored');
});

test('handleAlertTriggered: filtra por alerta, subyacente, usuario y modo', async () => {
  const { repo, service, bot } = await setup();
  assert.deepEqual(await service.handleAlertTriggered(signal({ alertId: 99 })), []);
  assert.deepEqual(await service.handleAlertTriggered(signal({ asset: 'ETHUSDT' })), []);
  assert.deepEqual(await service.handleAlertTriggered(signal({ asset: 'PEPEUSDT' })), []);
  assert.deepEqual(await service.handleAlertTriggered(signal({ userId: 8 })), []);
  await repo.setMode(USER, bot.id, 'paused');
  assert.deepEqual(await service.handleAlertTriggered(signal()), []);
  assert.equal(repo.signals.length, 0);
});

test('handleAlertTriggered: un error del runner queda como decisión error', async () => {
  const { repo, bot } = await setup();
  const service = createOptionsAutoTradingService({
    repo,
    runner: { async runForSignal() { throw new Error('sin cadena'); } },
    logger: silent,
    now: () => NOW,
  });
  const [res] = await service.handleAlertTriggered(signal());
  assert.equal(res.decision, 'error');
  assert.equal(repo.signals[0].strategyId, bot.id);
  assert.match(repo.signals[0].detail, /Error al procesar la señal: sin cadena/);
});

test('decide: en real manda el libro real (bloqueo por límite → ignored)', () => {
  const produced = [
    { mode: 'shadow', type: 'open', booked: true, detail: 'Señal alcista: compra 65000C' },
    { mode: 'live', type: 'skip', reason: 'limit', detail: 'Bloqueada por límite: margen' },
  ];
  assert.deepEqual(decide({ mode: 'live' }, produced), { decision: 'ignored', detail: 'Real: Bloqueada por límite: margen' });
  assert.equal(decide({ mode: 'shadow' }, produced).decision, 'opened');
  assert.equal(decide({ mode: 'shadow' }, [{ mode: 'shadow', type: 'error', detail: 'Sin precio' }]).decision, 'error');
});

test('start/stop se suscriben al emisor de disparos', async () => {
  const { emitter, service, repo } = await setup();
  assert.equal(service.start(), true);
  service.start();
  assert.equal(emitter.listeners.size, 1);
  await emitter.emit(signal());
  assert.equal(repo.signals.length, 1);
  service.stop();
  assert.equal(emitter.listeners.size, 0);
});

test('start sin emisor inyectado lo carga perezosamente y no rompe si aún no existe', () => {
  const service = createOptionsAutoTradingService({ repo: createFakeOptionsRepo(), logger: silent });
  assert.equal(typeof service.start(), 'boolean');
  service.stop();
});

test('el tick de 5 min evalúa las salidas de los bots (toma de ganancia)', async () => {
  const { clock, repo, market, runner, service } = await setup();
  await service.handleAlertTriggered(signal());
  assert.equal(repo.positions.filter((x) => x.closedAt == null).length, 1);

  // Sin cambios: el tick mantiene la posición y no abre nada sin señal.
  await runner.tick();
  assert.equal(repo.positions.length, 1);

  market.state.priceFactor = 3; // la call triplica su precio: take profit (80 %).
  clock.now = NOW + HOUR_MS;
  await runner.tick();
  const [p] = repo.positions;
  assert.ok(p.closedAt != null);
  assert.ok(p.pnlUsdt > 0);
  assert.match(repo.events.at(-1).detail, /Take profit/);
});

test('integración: un disparo real de alerts/alert-events llega al bot y abre en sombra', async () => {
  const alertEvents = require('../src/services/alerts/alert-events');
  const { repo, runner, bot } = await setup();
  // Sin `alertEvents` inyectado: start() carga el emisor real de las alertas.
  const service = createOptionsAutoTradingService({ repo, runner, logger: silent, now: () => NOW, alerts: { listAlerts: async () => [] } });
  assert.notEqual(service.start(), false);
  try {
    alertEvents.emitAlertTriggered(signal({ eventId: 9001 }));
    // Los listeners corren de forma asíncrona.
    for (let i = 0; i < 50 && !(await repo.listAutoSignals(bot.id)).some((s) => s.decision !== 'ignored'); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const [row] = await repo.listAutoSignals(bot.id);
    assert.equal(row.decision, 'opened');
    assert.equal(row.alertEventId, 9001);
    assert.equal(repo.positions.filter((p) => p.mode === 'shadow').length, 1);
  } finally {
    service.stop();
  }
  assert.equal(alertEvents.listenerCount(), 0);
});
