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
const { createFakeShadowEntries, fillShadowEntries } = require('./support/options-fake-shadow-entries');

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
    // Las aperturas de los bots por alertas van al medio de la rejilla.
    async getPriceFilter() { return { tickSize: '0.01', minPrice: '0.01' }; },
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
  const shadowEntries = createFakeShadowEntries({ now: () => clock.now });
  const runner = new OptionsStrategyRunner({ repo, market, credentials, shadowEntries, notify: async () => {}, logger: silent, now: () => clock.now });
  // Llena las entradas simuladas pendientes (libro cruzado un instante).
  const fill = () => fillShadowEntries({ runner, market });
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
  return { clock, repo, market, runner, emitter, service, bot, orders, shadowEntries, fill };
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

test('runForSignal en sombra: la compra de la call espera al medio y se registra al llenarse', async () => {
  const { repo, runner, bot, orders, shadowEntries, fill, market } = await setup();
  const { actions, produced } = await runner.runForSignal(await repo.getStrategy(USER, bot.id), { direction: 'bullish' });
  assert.deepEqual(actions.shadow.map((a) => a.type), ['open']);
  assert.equal(actions.live, undefined);
  assert.equal(repo.positions.length, 0);
  assert.equal(produced.filter((x) => x.booked).length, 0);
  assert.ok(produced.some((x) => x.mode === 'shadow' && x.pending));
  const [entry] = shadowEntries.entries;
  const quote = await market.getQuote(entry.symbol);
  assert.ok(entry.limitPrice > quote.bid && entry.limitPrice <= quote.ask, 'LIMIT al medio del libro');
  assert.deepEqual(await fill(), { filled: 1, expired: 0 });
  const [p] = repo.positions;
  assert.equal(repo.positions.length, 1);
  assert.equal(p.mode, 'shadow');
  assert.equal(p.side, 'BUY');
  assert.equal(parseSymbol(p.symbol).type, 'C');
  assert.equal(p.entryPrice, entry.limitPrice);
  assert.equal(p.feesUsdt, tradeFee({ spot: SPOT, quantity: p.quantity, price: p.entryPrice }));
  assert.equal(repo.events.at(-1).action, 'open');
  assert.equal(orders.length, 0, 'la sombra no envía órdenes');
});

test('handleAlertTriggered: abre, registra la decisión y no procesa dos veces el mismo evento', async () => {
  const { repo, service, bot, fill } = await setup();
  const [first] = await service.handleAlertTriggered(signal());
  assert.deepEqual(first, { strategyId: bot.id, decision: 'pending', detail: 'Sombra: Orden LIMIT al medio, esperando ejecución' });
  await fill();
  assert.equal(repo.signals.length, 1);
  assert.equal(repo.signals[0].decision, 'opened');
  assert.match(repo.signals[0].detail, /^Sombra: Compra .*C a [\d.,]+ · comisión/);
  assert.equal(repo.signals[0].feesEstimated, true);
  assert.equal(repo.signals[0].alertEventId, 501);
  assert.equal(repo.signals[0].strategyId, bot.id);

  const [again] = await service.handleAlertTriggered(signal());
  assert.equal(again.decision, 'duplicate');
  assert.equal(repo.signals.length, 1);
  assert.equal(repo.positions.length, 1);

  // Otro disparo alcista: el subyacente ya tiene su opción → ignorada con motivo.
  const [capped] = await service.handleAlertTriggered(signal({ eventId: 502 }));
  assert.equal(capped.decision, 'ignored');
  assert.match(capped.detail, /Ya hay una opción abierta en BTC/);

  // Bajista con reverse: cierra la call y deja la compra de la put al medio.
  const [rev] = await service.handleAlertTriggered(signal({ eventId: 503, direction: 'bearish' }));
  assert.equal(rev.decision, 'pending');
  assert.match(rev.detail, /Orden LIMIT al medio, esperando ejecución/);
  assert.equal(repo.positions.filter((x) => x.closedAt == null).length, 0);
  await fill();
  assert.equal(repo.signals.find((x) => x.alertEventId === 503).decision, 'opened');
  const open = repo.positions.filter((x) => x.closedAt == null);
  assert.equal(open.length, 1);
  assert.equal(parseSymbol(open[0].symbol).type, 'P');
});

test('handleAlertTriggered: onOpposite close → closed; ignore → ignored', async () => {
  const closeBot = await setup({ params: { onOpposite: 'close' } });
  await closeBot.service.handleAlertTriggered(signal());
  await closeBot.fill();
  const [closed] = await closeBot.service.handleAlertTriggered(signal({ eventId: 600, direction: 'bearish' }));
  assert.equal(closed.decision, 'closed');
  assert.equal(closeBot.repo.positions.filter((x) => x.closedAt == null).length, 0);

  const ignoreBot = await setup({ params: { onOpposite: 'ignore' } });
  await ignoreBot.service.handleAlertTriggered(signal());
  await ignoreBot.fill();
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
  const { clock, repo, market, runner, service, fill } = await setup();
  await service.handleAlertTriggered(signal());
  await fill();
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
  const { repo, runner, bot, fill } = await setup();
  // Sin `alertEvents` inyectado: start() carga el emisor real de las alertas.
  const service = createOptionsAutoTradingService({ repo, runner, logger: silent, now: () => NOW, alerts: { listAlerts: async () => [] } });
  assert.notEqual(service.start(), false);
  try {
    alertEvents.emitAlertTriggered(signal({ eventId: 9001 }));
    // Los listeners corren de forma asíncrona.
    for (let i = 0; i < 50 && !(await repo.listAutoSignals(bot.id)).some((s) => s.decision !== 'ignored'
      && s.detail !== 'Procesando…'); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal((await repo.listAutoSignals(bot.id))[0].decision, 'pending');
    await fill();
    const [row] = await repo.listAutoSignals(bot.id);
    assert.equal(row.decision, 'opened');
    assert.equal(row.alertEventId, 9001);
    assert.equal(repo.positions.filter((p) => p.mode === 'shadow').length, 1);
  } finally {
    service.stop();
  }
  assert.equal(alertEvents.listenerCount(), 0);
});

test('cierre manual en sombra: cierra con el runner real y deja un solo evento «Cierre manual»', async () => {
  const { repo, service, bot, fill } = await setup();
  await service.handleAlertTriggered(signal());
  await fill();
  assert.equal(repo.positions.filter((p) => p.closedAt == null).length, 1);
  const before = repo.events.length;

  const res = await service.closeBot(USER, bot.id, { confirm: true });
  assert.equal(res.status, 'closed');
  assert.match(res.detail, /Cierre manual/);
  const [p] = repo.positions;
  assert.ok(p.closedAt != null);
  assert.equal(p.closeReason, 'manual');
  const added = repo.events.slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].action, 'close');
  assert.equal(added[0].detail, 'Cierre manual');

  const again = await service.closeBot(USER, bot.id, { confirm: true });
  assert.equal(again.status, 'nothing_to_close');
  assert.match(again.detail, /No hay posiciones abiertas/);
  assert.equal(repo.events.length, before + 1, 'sin posiciones no se registra evento');
});

test('cierre manual en Real: registra el evento y explica por qué no se envió', async () => {
  const repo = createFakeOptionsRepo({ now: () => NOW });
  let next = { status: 'pending', produced: [{ mode: 'live', type: 'close', pending: true, reason: 'submitted', detail: 'Orden límite enviada; ejecución pendiente' }] };
  const calls = [];
  const runner = { async closeManually(strategy, opts) { calls.push(opts); return next; } };
  const liveOrders = { async hasPendingClose() { return false; } };
  const service = createOptionsAutoTradingService({ repo, runner, liveOrders, logger: silent, now: () => NOW, alerts: { listAlerts: async () => [] } });
  const bot = await repo.createStrategy({ userId: USER, name: 'Bot', template: 'alert_signal', underlying: 'BTC', params: { alertIds: [11] }, mode: 'live' });

  await assert.rejects(service.closeBot(USER, bot.id, {}), (err) => err.code === 'CONFIRM_REQUIRED' && err.status === 400);

  const pending = await service.closeBot(USER, bot.id, { confirm: true, positionIds: [3] });
  assert.deepEqual(pending, { status: 'pending', detail: 'Orden límite enviada; ejecución pendiente' });
  assert.deepEqual(calls[0], { mode: 'live', positionIds: [3] });
  assert.equal(repo.events.at(-1).action, 'close');
  assert.equal(repo.events.at(-1).mode, 'live');
  assert.match(repo.events.at(-1).detail, /^Cierre manual/);

  next = { status: 'not_submitted', produced: [
    { mode: 'shadow', type: 'close', detail: 'no debe salir' },
    { mode: 'live', type: 'skip', reason: 'live_disabled', detail: 'Envio real deshabilitado: OPTIONS_LIVE_TRADING_ENABLED no está activo' },
  ] };
  const skipped = await service.closeBot(USER, bot.id, { confirm: true });
  assert.equal(skipped.status, 'not_submitted');
  assert.equal(skipped.detail, 'Envio real deshabilitado: OPTIONS_LIVE_TRADING_ENABLED no está activo');
  assert.equal(repo.events.at(-1).action, 'skip');
  assert.match(repo.events.at(-1).detail, /^Cierre manual no enviado: Envio real deshabilitado/);
});

test('simular en un bot Real: solo corre la sombra, no envía órdenes y la fila queda simulated', async () => {
  const { repo, service, bot, orders, fill } = await setup({ mode: 'live' });
  const res = await service.simulateSignal(USER, bot.id, { direction: 'bullish' });
  assert.equal(res.decision, 'pending');
  assert.match(res.detail, /Sombra/);
  await fill();
  assert.equal(repo.signals[0].decision, 'opened');
  assert.equal(orders.length, 0, 'no se llama a submit real');
  assert.deepEqual(repo.positions.map((p) => p.mode), ['shadow']);
  const [row] = await repo.listAutoSignals(bot.id);
  assert.equal(row.simulated, true);
  assert.equal(row.alertName, 'Simulación');
  assert.equal(row.alertEventId, null);
  assert.equal(row.direction, 'bullish');
});

test('simular: límite de 1 cada 10 s por bot (429 SIMULATE_RATE_LIMIT) y otro bot no se ve afectado', async () => {
  const { clock, repo, service, bot } = await setup();
  const other = await repo.createStrategy({ userId: USER, name: 'Otro', template: 'alert_signal', underlying: 'BTC', params: { alertIds: [11] }, mode: 'shadow' });
  await service.simulateSignal(USER, bot.id, { direction: 'bullish' });
  clock.now += 9_000;
  await assert.rejects(service.simulateSignal(USER, bot.id, { direction: 'bearish' }), (err) => err.status === 429 && err.code === 'SIMULATE_RATE_LIMIT');
  await service.simulateSignal(USER, other.id, { direction: 'bullish' });
  clock.now += 1_000;
  const again = await service.simulateSignal(USER, bot.id, { direction: 'bearish' });
  assert.ok(again.decision);
  assert.equal((await repo.listAutoSignals(bot.id)).length, 2, 'las simulaciones no se deduplican entre sí');
});

test('simular: bot pausado → 409 BOT_PAUSED y dirección inválida → 400', async () => {
  const { service, bot, repo } = await setup({ mode: 'paused' });
  await assert.rejects(service.simulateSignal(USER, bot.id, { direction: 'bullish' }), (err) => err.status === 409 && err.code === 'BOT_PAUSED' && /Sombra/.test(err.message));
  assert.equal((await repo.listAutoSignals(bot.id)).length, 0);
  await repo.setMode(USER, bot.id, 'shadow');
  await assert.rejects(service.simulateSignal(USER, bot.id, { direction: 'neutral' }), (err) => err.status === 400);
});

test('processBot passes the claimed signal id to the runner as signalId', async () => {
  const { repo } = await setup();
  const seen = [];
  const service = createOptionsAutoTradingService({
    repo,
    runner: { async runForSignal(_bot, sig) { seen.push(sig); return { produced: [] }; } },
    logger: silent,
    now: () => NOW,
  });
  await service.handleAlertTriggered(signal());
  assert.equal(seen.length, 1);
  assert.equal(seen[0].signalId, repo.signals[0].id);
  assert.ok(seen[0].signalId != null);
  assert.equal(seen[0].eventId, 501);
});

test('decide: señal contraria que cancela la entrada real queda pendiente con texto legible', () => {
  const produced = [
    { mode: 'live', type: 'cancel_entries', pending: true, reason: 'reevaluation_queued',
      detail: 'Cancelando la entrada pendiente; se reevalúa al conciliar' },
  ];
  assert.deepEqual(decide({ mode: 'live' }, produced),
    { decision: 'pending', detail: 'Real: Cancelando la entrada pendiente; se reevalúa al conciliar' });
});

test('decide: giro en sombra con la entrada al medio esperando queda pendiente', () => {
  const produced = [
    { mode: 'shadow', type: 'close', booked: true, detail: 'Señal bajista: cierra 60000C' },
    { mode: 'shadow', type: 'open', pending: true, reason: 'shadow_entry_pending', detail: 'Orden LIMIT al medio, esperando ejecución' },
  ];
  assert.deepEqual(decide({ mode: 'shadow' }, produced), {
    decision: 'pending', detail: 'Sombra: Señal bajista: cierra 60000C · Orden LIMIT al medio, esperando ejecución',
  });
});
