const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOptionsBacktestService,
  realizedVolSeries,
  fetchDvol,
} = require('../src/services/options/options-backtest.service');
const { buildSyntheticChain, syntheticExpiries } = require('../src/services/options/options-synthetic-chain');
const { HOUR_MS, DAY_MS } = require('../src/services/options/options-utils');

const TO = Date.UTC(2026, 8, 30, 0);
const FROM = TO - 90 * DAY_MS;
const silent = { info() {}, warn() {}, error() {} };

/** Velas horarias deterministas: paseo aleatorio con LCG sembrado (~60 % anual). */
function syntheticCandles(start, end, { seed = 42, spot = 60000, hourlyVol = 0.6 / Math.sqrt(8760) } = {}) {
  let state = seed;
  const rand = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const candles = [];
  let price = spot;
  for (let t = start; t < end; t += HOUR_MS) {
    // Box-Muller
    const z = Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    const open = price;
    price = price * Math.exp(hourlyVol * z);
    candles.push({ time: t, closeTime: t + HOUR_MS - 1, open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume: 1 });
  }
  return candles;
}

function fakeBacktestsRepo() {
  const rows = [];
  return {
    rows,
    async create({ userId, strategyId, config }) {
      const row = { id: rows.length + 1, userId, strategyId, config, status: 'queued', result: null, error: null, createdAt: Date.now(), finishedAt: null };
      rows.push(row);
      return { ...row };
    },
    async markRunning(id) { rows.find((r) => r.id === id).status = 'running'; },
    async finish(id, { status, result, error }) { Object.assign(rows.find((r) => r.id === id), { status, result, error, finishedAt: Date.now() }); },
    async get(userId, id) { const r = rows.find((x) => x.id === id && x.userId === userId); return r ? { ...r } : null; },
    async list(userId) { return rows.filter((r) => r.userId === userId); },
    async countPending(userId) { return rows.filter((r) => r.userId === userId && ['queued', 'running'].includes(r.status)).length; },
    async failStale() { return 0; },
  };
}

function makeService(overrides = {}) {
  const candles = syntheticCandles(FROM - 31 * DAY_MS, TO);
  const candleCalls = [];
  const service = createOptionsBacktestService({
    repo: fakeBacktestsRepo(),
    snapshotsRepo: { async listRange() { return []; } },
    strategiesRepo: { async getStrategy() { return null; } },
    async getCandles(symbol, timeframe, opts) {
      candleCalls.push({ symbol, timeframe, ...opts });
      return candles.filter((c) => c.time >= opts.startTime && c.time < opts.endTime);
    },
    fetchImpl: async () => { throw new Error('red prohibida en tests'); },
    logger: silent,
    now: () => TO + DAY_MS,
    ...overrides,
  });
  return { service, candleCalls, candles };
}

test('realizedVolSeries recupera la volatilidad de retornos alternos conocidos', () => {
  const r = 0.01;
  const candles = [{ close: 100 }];
  for (let i = 0; i < 800; i += 1) candles.push({ close: candles[i].close * Math.exp(i % 2 ? -r : r) });
  const vols = realizedVolSeries(candles, 720);
  const expected = r * Math.sqrt(8760);
  assert.ok(Math.abs(vols[800] - expected) / expected < 0.01, `${vols[800]} vs ${expected}`);
  assert.equal(vols[5], null);
});

test('backtest realized: short strangle sobre velas sintéticas, determinista y con la forma del contrato', async () => {
  const { service, candleCalls } = makeService();
  const config = await service.normalizeConfig(1, {
    template: 'short_strangle', underlying: 'btc', from: FROM, to: TO, capitalUsdt: 10000, source: 'realized', spreadPct: 4, feePct: 0.03, volPremiumPct: 10,
  });
  const result = await service.runBacktest(config);
  // Pide 30 días extra de historia para la volatilidad realizada, en velas de 1h de Binance.
  assert.equal(candleCalls[0].symbol, 'BTCUSDT');
  assert.equal(candleCalls[0].timeframe, '1h');
  assert.equal(candleCalls[0].datasource, 'binance');
  assert.equal(candleCalls[0].startTime, FROM - 30 * DAY_MS);

  const { metrics, equity, cycles, sourceNote } = result;
  for (const key of ['returnPct', 'pnlUsdt', 'maxDrawdownPct', 'sharpe', 'wins', 'cycles', 'premiumUsdt', 'worstCycleUsdt']) {
    assert.ok(Number.isFinite(metrics[key]), key);
  }
  assert.ok(Math.abs(metrics.pnlUsdt - (equity.at(-1).strategy - config.capitalUsdt)) < 0.02);
  // Entra los viernes a las 09:00 UTC: ~13 viernes en 90 días.
  assert.ok(metrics.cycles >= 10 && metrics.cycles <= 14, `ciclos ${metrics.cycles}`);
  assert.equal(cycles.length, metrics.cycles);
  assert.ok(metrics.premiumUsdt > 0);
  assert.ok(metrics.wins <= metrics.cycles);
  for (const c of cycles) {
    assert.equal(new Date(c.openedAt).getUTCDay(), 5);
    assert.equal(c.legs.length, 2);
    assert.ok(['take_profit', 'stop_loss', 'delta_stop', 'time_exit', 'expiry', 'open'].includes(c.exitReason), c.exitReason);
    assert.match(c.expiry, /^\d{6}$/);
  }
  assert.ok(equity.length > 50 && equity.length <= 401);
  assert.ok(Math.abs(equity[0].hodl - 10000) < 200);
  assert.ok(equity.every((e) => Number.isFinite(e.strategy) && Number.isFinite(e.hodl)));
  assert.match(sourceNote, /volatilidad realizada a 30 días/);
  assert.match(sourceNote, /Estimación/);

  const again = await service.runBacktest(config);
  assert.deepEqual(again, result);
});

test('backtest: más spread y comisión empeoran el resultado', async () => {
  const { service } = makeService();
  const base = { template: 'short_strangle', underlying: 'BTC', from: FROM, to: TO, source: 'realized' };
  const cheap = await service.runBacktest(await service.normalizeConfig(1, { ...base, spreadPct: 0, feePct: 0 }));
  const costly = await service.runBacktest(await service.normalizeConfig(1, { ...base, spreadPct: 10, feePct: 0.1 }));
  assert.ok(costly.metrics.returnPct < cheap.metrics.returnPct);
});

test('backtest covered call incluye la tenencia spot: arranca en el capital', async () => {
  const { service } = makeService();
  const result = await service.runBacktest(await service.normalizeConfig(1, {
    template: 'covered_call', underlying: 'BTC', from: FROM, to: TO, source: 'realized', capitalUsdt: 5000,
  }));
  assert.ok(Math.abs(result.equity[0].strategy - result.equity[0].hodl) < 100);
  assert.ok(result.metrics.cycles > 0);
  assert.ok(result.cycles.every((c) => c.legs[0].side === 'SELL'));
});

test('validación: rango, fuente DVOL solo BTC/ETH, template o estrategia', async () => {
  const { service } = makeService();
  const base = { template: 'short_strangle', underlying: 'BTC', from: FROM, to: TO };
  await assert.rejects(service.normalizeConfig(1, { ...base, underlying: 'SOL', source: 'dvol' }), /solo existe para BTC y ETH/);
  await assert.rejects(service.normalizeConfig(1, { ...base, from: TO - 400 * DAY_MS }), /rango máximo/);
  await assert.rejects(service.normalizeConfig(1, { ...base, from: TO, to: FROM }), /anterior/);
  await assert.rejects(service.normalizeConfig(1, { underlying: 'BTC' }), /strategyId o template/);
  await assert.rejects(service.normalizeConfig(1, { ...base, source: 'magic' }), /Fuente inválida/);
  await assert.rejects(service.normalizeConfig(1, { strategyId: 9 }), /no encontrada/);
  const iso = await service.normalizeConfig(1, { ...base, from: new Date(FROM).toISOString(), to: new Date(TO).toISOString() });
  assert.equal(iso.from, FROM);
  assert.equal(iso.spreadPct, 5);
});

test('fetchDvol pagina con continuation y convierte a decimal (fetch mockeado)', async () => {
  const urls = [];
  const pages = [
    { result: { data: [[TO - HOUR_MS, 50, 52, 49, 51], [TO, 51, 53, 50, 52]], continuation: TO - 2 * HOUR_MS } },
    { result: { data: [[TO - 3 * HOUR_MS, 48, 49, 47, 48], [TO - 2 * HOUR_MS, 48, 50, 48, 49]], continuation: null } },
  ];
  const fetchImpl = async (url) => {
    urls.push(new URL(url));
    return { ok: true, json: async () => pages[urls.length - 1] };
  };
  const series = await fetchDvol({ currency: 'BTC', from: TO - 5 * HOUR_MS, to: TO, fetchImpl });
  assert.equal(urls.length, 2);
  assert.equal(urls[0].origin + urls[0].pathname, 'https://www.deribit.com/api/v2/public/get_volatility_index_data');
  assert.equal(urls[0].searchParams.get('currency'), 'BTC');
  assert.equal(urls[0].searchParams.get('resolution'), '3600');
  assert.equal(urls[1].searchParams.get('end_timestamp'), String(TO - 2 * HOUR_MS));
  assert.deepEqual(series.map((p) => p.iv), [0.48, 0.49, 0.51, 0.52]);

  await assert.rejects(
    fetchDvol({ currency: 'BTC', from: 0, to: 1, fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /Deribit respondió 503/
  );
});

test('backtest dvol: usa el DVOL mockeado como IV ATM', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ result: { data: [[FROM - DAY_MS, 60, 60, 60, 60]], continuation: null } }),
  });
  const { service } = makeService({ fetchImpl });
  const config = await service.normalizeConfig(1, { template: 'protective_put', underlying: 'ETH', from: FROM, to: TO, source: 'dvol' });
  const result = await service.runBacktest(config);
  assert.match(result.sourceNote, /DVOL histórico de Deribit/);
  assert.ok(result.metrics.cycles >= 2);
  assert.ok(result.metrics.premiumUsdt < 0, 'comprar puts paga prima');
  assert.ok(result.cycles.some((c) => c.exitReason === 'roll'));
});

test('backtest recorded: corre sobre snapshots grabados', async () => {
  const snapshots = [];
  const start = TO - 10 * DAY_MS;
  for (let t = start; t <= TO; t += HOUR_MS) {
    const spot = 60000 * (1 + 0.02 * Math.sin(t / (12 * HOUR_MS)));
    for (const expiry of syntheticExpiries(t).slice(0, 6)) {
      const chain = buildSyntheticChain({ underlying: 'BTC', spot, now: t, expiry, atmIv: 0.6, spreadPct: 3 });
      for (const row of chain.rows) {
        for (const [type, leg] of [['C', row.call], ['P', row.put]]) {
          snapshots.push({ underlying: 'BTC', symbol: leg.symbol, expiry: expiry.code, strike: row.strike, type, bid: leg.bid, ask: leg.ask, mark: leg.mark, iv: leg.iv, delta: leg.delta, spot, capturedAt: t });
        }
      }
    }
  }
  const { service } = makeService({ snapshotsRepo: { async listRange() { return snapshots; } } });
  const config = await service.normalizeConfig(1, { template: 'short_strangle', params: { entryWeekday: null }, underlying: 'BTC', from: start, to: TO, source: 'recorded' });
  const result = await service.runBacktest(config);
  assert.match(result.sourceNote, /snapshots horarios/);
  assert.ok(result.metrics.cycles >= 1);

  const empty = makeService();
  await assert.rejects(empty.service.runBacktest(config), /No hay snapshots/);
});

test('enqueue: crea la tarea en cola y termina done (o failed con error)', async () => {
  const repo = fakeBacktestsRepo();
  const { service } = makeService({ repo });
  const row = await service.enqueue(3, { template: 'short_strangle', underlying: 'BTC', from: FROM, to: TO, source: 'realized' });
  assert.equal(row.status, 'queued');
  await service.drain();
  const done = await service.get(3, row.id);
  assert.equal(done.status, 'done');
  assert.ok(done.result.metrics);
  await assert.rejects(service.get(4, row.id), /no encontrado/);

  const failing = makeService({ repo: fakeBacktestsRepo(), getCandles: async () => [] });
  const bad = await failing.service.enqueue(3, { template: 'short_strangle', underlying: 'BTC', from: FROM, to: TO });
  await failing.service.drain();
  const failed = await failing.service.get(3, bad.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /datos suficientes/);
});

test('enqueue: máximo 3 tareas pendientes por usuario', async () => {
  const repo = fakeBacktestsRepo();
  repo.countPending = async () => 3;
  const { service } = makeService({ repo });
  await assert.rejects(
    service.enqueue(3, { template: 'short_strangle', underlying: 'BTC', from: FROM, to: TO }),
    (err) => err.status === 429
  );
});

// ---------- bots por alertas: repetición de disparos ----------

const { simulate } = require('../src/services/options/options-backtest.service');
const templatesIndex = require('../src/services/options/templates');

const BOT_ID = 7;
const SIG_T = FROM + 10 * DAY_MS + 30 * 60 * 1000;

function botService({ params = {}, signals = [], ...overrides } = {}) {
  const alertCalls = [];
  const made = makeService({
    strategiesRepo: {
      async getStrategy(userId, id) {
        if (id !== BOT_ID) return null;
        return { id: BOT_ID, userId, template: 'alert_signal', underlying: 'BTC', params: { alertIds: [5, 6], ...params } };
      },
    },
    alertsRepo: {
      async listAlertSignals(args) {
        alertCalls.push(args);
        return signals.filter((s) => s.t >= args.from && s.t <= args.to);
      },
    },
    ...overrides,
  });
  return { ...made, alertCalls };
}

test('backtest bot: 2 señales alcistas con maxOpenPositions 1 → 1 apertura y 1 ignorada', async () => {
  const signals = [
    { t: SIG_T, direction: 'bullish', alertId: 5 },
    { t: SIG_T + 10 * 60 * 1000, direction: 'bullish', alertId: 6 },
  ];
  const { service, alertCalls } = botService({ params: { maxOpenPositions: 1 }, signals });
  const config = await service.normalizeConfig(3, { strategyId: BOT_ID, from: FROM, to: TO, source: 'realized' });
  assert.equal(config.template, 'alert_signal');
  assert.deepEqual(alertCalls[0], { userId: 3, alertIds: [5, 6], underlying: 'BTC', from: FROM, to: TO });
  const result = await service.runBacktest(config);
  assert.equal(result.metrics.cycles, 1);
  assert.equal(result.cycles[0].legs[0].side, 'BUY');
  assert.match(result.cycles[0].legs[0].symbol, /-C$/);
  // Abre en el paso que contiene la señal (la hora siguiente cerrada).
  assert.equal(result.cycles[0].openedAt, Math.ceil(SIG_T / HOUR_MS) * HOUR_MS);
  assert.deepEqual(result.signals, { received: 2, traded: 1, ignored: 1 });
});

test('backtest bot: señal bajista con onOpposite reverse cierra la call y abre un put', async () => {
  const signals = [
    { t: SIG_T, direction: 'bullish', alertId: 5 },
    { t: SIG_T + 2 * HOUR_MS, direction: 'bearish', alertId: 5 },
  ];
  const { service } = botService({ params: { onOpposite: 'reverse', stopLossPct: 1000, takeProfitPct: 1000 }, signals });
  const result = await service.runBacktest(await service.normalizeConfig(3, { strategyId: BOT_ID, from: FROM, to: TO }));
  assert.equal(result.metrics.cycles, 2);
  const [call, put] = result.cycles;
  assert.match(call.legs[0].symbol, /-C$/);
  assert.equal(call.exitReason, 'opposite_signal');
  assert.match(put.legs[0].symbol, /-P$/);
  assert.equal(put.legs[0].side, 'BUY');
  assert.equal(put.openedAt, Math.ceil((SIG_T + 2 * HOUR_MS) / HOUR_MS) * HOUR_MS);
  assert.deepEqual(result.signals, { received: 2, traded: 2, ignored: 0 });
});

test('backtest bot: sin disparos en el rango → ValidationError explicada (Review Focus 4)', async () => {
  const { service } = botService({ signals: [{ t: FROM - DAY_MS, direction: 'bullish', alertId: 5 }] });
  await assert.rejects(
    service.normalizeConfig(3, { strategyId: BOT_ID, from: FROM, to: TO }),
    (err) => err.name === 'ValidationError'
      && err.message === `Las alertas de este bot no se dispararon entre ${new Date(FROM).toISOString().slice(0, 10)} y ${new Date(TO).toISOString().slice(0, 10)}`
  );
});

test('backtest bot: exige el bot (strategyId), solo dvol/realized y banda ATR solo en 1h', async () => {
  const signals = [{ t: SIG_T, direction: 'bullish', alertId: 5 }];
  const { service } = botService({ signals });
  await assert.rejects(service.normalizeConfig(3, { template: 'alert_signal', underlying: 'BTC', from: FROM, to: TO }), /strategyId/);
  await assert.rejects(service.normalizeConfig(3, { strategyId: BOT_ID, from: FROM, to: TO, source: 'recorded' }), (err) => err.name === 'ValidationError' && /grabad/.test(err.message));
  const atr4h = botService({ params: { takeProfitMode: 'atr_band', atrBandInterval: '4h' }, signals });
  await assert.rejects(
    atr4h.service.normalizeConfig(3, { strategyId: BOT_ID, from: FROM, to: TO }),
    (err) => err.name === 'ValidationError' && err.message === 'El backtest de venta por banda ATR solo admite velas de 1h por ahora'
  );
  const noAlerts = botService({ params: { alertIds: [] }, signals });
  await assert.rejects(noAlerts.service.normalizeConfig(3, { strategyId: BOT_ID, from: FROM, to: TO }), (err) => err.name === 'ValidationError');
});

test('backtest bot multi-subyacente: un subyacente del bot a la vez; fuera del bot → ValidationError', async () => {
  const signals = [{ t: SIG_T, direction: 'bullish', alertId: 5 }];
  const { service, alertCalls } = botService({ params: { underlyings: ['BTC', 'ETH'] }, signals });
  const eth = await service.normalizeConfig(3, { strategyId: BOT_ID, underlying: 'eth', from: FROM, to: TO });
  assert.equal(eth.underlying, 'ETH');
  assert.equal(alertCalls.at(-1).underlying, 'ETH', 'las señales se filtran a ese subyacente');
  assert.equal((await service.normalizeConfig(3, { strategyId: BOT_ID, from: FROM, to: TO })).underlying, 'BTC', 'por defecto el primero');
  await assert.rejects(
    service.normalizeConfig(3, { strategyId: BOT_ID, underlying: 'SOL', from: FROM, to: TO }),
    (err) => err.name === 'ValidationError' && /no opera SOL/.test(err.message)
  );
  // params del input no amplían los subyacentes del bot guardado.
  await assert.rejects(
    service.normalizeConfig(3, { strategyId: BOT_ID, underlying: 'SOL', params: { underlyings: ['BTC', 'ETH', 'SOL'] }, from: FROM, to: TO }),
    (err) => err.name === 'ValidationError' && /no opera SOL/.test(err.message)
  );
  // Un bot de un solo subyacente tampoco acepta otro.
  const single = botService({ signals });
  await assert.rejects(single.service.normalizeConfig(3, { strategyId: BOT_ID, underlying: 'ETH', from: FROM, to: TO }), (err) => err.name === 'ValidationError');
});

test('listAlertSignals: lee alert_events, descarta neutral y otros subyacentes, ordena por created_at', async () => {
  const db = require('../src/db');
  const alertsRepo = require('../src/repositories/alerts.repository');
  const original = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    return {
      rows: [
        { alert_id: 5, asset: 'BTCUSDT', created_at: '3000', direction: 'bearish' },
        { alert_id: 5, asset: 'ETHUSDT', created_at: '1000', direction: 'bullish' },
        { alert_id: 6, asset: 'BINANCE:BTCUSDT', created_at: '1000', direction: 'bullish' },
        { alert_id: 6, asset: 'BTCUSDT', created_at: '2000', direction: 'neutral' },
        { alert_id: 6, asset: 'BTCUSDT', created_at: '2500', direction: null },
      ],
    };
  };
  try {
    const out = await alertsRepo.listAlertSignals({ userId: 3, alertIds: [5, 6], underlying: 'BTC', from: 500, to: 4000 });
    assert.deepEqual(out, [
      { t: 1000, direction: 'bullish', alertId: 6 },
      { t: 3000, direction: 'bearish', alertId: 5 },
    ]);
    assert.match(calls[0].sql, /FROM alert_events/);
    assert.match(calls[0].sql, /ORDER BY created_at/);
    assert.deepEqual(calls[0].params, [3, [5, 6], 500, 4000]);
    assert.deepEqual(await alertsRepo.listAlertSignals({ userId: 3, alertIds: [], underlying: 'BTC', from: 0, to: 1 }), []);
    assert.equal(calls.length, 1, 'sin alertas no consulta');
  } finally {
    db.query = original;
  }
});

// Pasos controlados: cadena de una call (61000) y un put (59000) que vencen el 9-oct 08:00 UTC.
const ATR_T0 = Date.UTC(2026, 9, 1, 0);
const ATR_EXPIRY = '261009';
const CALL = `BTC-${ATR_EXPIRY}-61000-C`;
const PUT = `BTC-${ATR_EXPIRY}-59000-P`;

function controlledSteps(bids) {
  return bids.map((bid, i) => {
    const t = ATR_T0 + i * HOUR_MS;
    const leg = (symbol, delta) => ({ symbol, bid, ask: i === 0 ? 200 : bid + 5, mark: bid + 2, delta, iv: 0.6 });
    return {
      t,
      spot: 60000,
      chainFor() {
        return { underlying: 'BTC', spot: 60000, expiry: ATR_EXPIRY, rows: [
          { strike: 59000, call: null, put: leg(PUT, -0.3) },
          { strike: 61000, call: leg(CALL, 0.35), put: null },
        ] };
      },
      quote(symbol) { return t < Date.UTC(2026, 9, 9, 8) ? leg(symbol, 0.35) : null; },
    };
  });
}

/** 20 velas de 1h cerradas antes de ATR_T0: rango 100 y cierre fijo → ATR 100, banda superior 60200. */
const atrCandles = Array.from({ length: 20 }, (_, i) => {
  const time = ATR_T0 - (20 - i) * HOUR_MS;
  return { time, closeTime: time + HOUR_MS - 1, open: 60000, high: 60050, low: 59950, close: 60000, volume: 1 };
});

function atrParams(extra = {}) {
  return templatesIndex.validateParams('alert_signal', {
    alertIds: [5], structure: 'buy_with', takeProfitMode: 'atr_band', atrBandInterval: '1h',
    atrBandLength: 14, atrBandMultiplier: 2, tpMaxGainPct: 200, quantity: 0.01, ...extra,
  });
}

test('simulate atr_band: abre con la señal y cierra con take_profit_atr_band al llegar el bid al objetivo', () => {
  // Fill 200, spot 60000, banda 60200 → distancia 0,333 % × apalancamiento 300 = +100 % → objetivo 400.
  // El bid se desploma (sin stop) y luego llega a 399 (no cierra) y a 400 (cierra).
  const bids = [195, 20, 5, 399, 400, 410];
  const result = simulate({
    template: templatesIndex.getTemplate('alert_signal'), params: atrParams(),
    steps: controlledSteps(bids), capitalUsdt: 1000, feePct: 0,
    signals: [{ t: ATR_T0 - 10 * 60 * 1000, direction: 'bullish', alertId: 5 }], candles: atrCandles,
  });
  assert.equal(result.metrics.cycles, 1);
  const [cycle] = result.cycles;
  assert.equal(cycle.openedAt, ATR_T0);
  assert.equal(cycle.legs[0].symbol, CALL);
  assert.equal(cycle.legs[0].price, 200);
  assert.equal(cycle.exitReason, 'take_profit_atr_band');
  assert.equal(cycle.closedAt ?? null, null, 'el DTO no expone closedAt');
  assert.equal(cycle.pnlUsdt, 2, '(400 − 200) × 0,01');
  assert.deepEqual(result.signals, { received: 1, traded: 1, ignored: 0 });
});

test('simulate atr_band: sin llegar al objetivo no cierra por stop ni por tiempo y liquida al vencimiento', () => {
  // Desde el 1-oct 00:00 hasta pasado el 9-oct 08:00 en pasos de 1h; el bid nunca pasa de 300.
  const hours = 8 * 24 + 10;
  const bids = Array.from({ length: hours }, (_, i) => (i === 0 ? 195 : Math.max(1, 300 - i)));
  const result = simulate({
    template: templatesIndex.getTemplate('alert_signal'), params: atrParams({ onOpposite: 'ignore' }),
    steps: controlledSteps(bids), capitalUsdt: 1000, feePct: 0,
    signals: [
      { t: ATR_T0, direction: 'bullish', alertId: 5 },
      // Con onOpposite 'ignore' la contraria no cierra la posición.
      { t: ATR_T0 + 5 * HOUR_MS, direction: 'bearish', alertId: 5 },
    ],
    candles: atrCandles,
  });
  assert.equal(result.metrics.cycles, 1);
  assert.equal(result.cycles[0].exitReason, 'expiry');
  assert.deepEqual(result.signals, { received: 2, traded: 1, ignored: 1 });
});

test('simulate: tradesToday se cuenta por día UTC y limita maxTradesPerDay', () => {
  // Bot de compra con maxTradesPerDay 1: la bajista del mismo día cierra la call
  // pero no puede abrir la put; la del día siguiente (sin posición) sí abre.
  const params = templatesIndex.validateParams('alert_signal', { alertIds: [5], maxTradesPerDay: 1, maxOpenPositions: 5, stopLossPct: 1000, takeProfitPct: 1000 });
  const bids = Array.from({ length: 30 }, () => 195);
  const result = simulate({
    template: templatesIndex.getTemplate('alert_signal'), params,
    steps: controlledSteps(bids), capitalUsdt: 1000, feePct: 0,
    signals: [
      { t: ATR_T0 + HOUR_MS, direction: 'bullish', alertId: 5 },
      { t: ATR_T0 + 3 * HOUR_MS, direction: 'bearish', alertId: 5 },
      { t: ATR_T0 + 25 * HOUR_MS, direction: 'bearish', alertId: 5 },
    ],
  });
  assert.equal(result.metrics.cycles, 2);
  // La 2.ª cuenta como operada (cierra la call aunque no abra). Sin el tope
  // diario abriría la put y la 3.ª se ignoraría por subyacente ocupado.
  assert.deepEqual(result.signals, { received: 3, traded: 3, ignored: 0 });
});

test('backtest bot dvol + banda ATR: pide historia previa de 1h y reproduce la señal', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: { data: [[FROM - DAY_MS, 60, 60, 60, 60]], continuation: null } }) });
  const { service, candleCalls } = botService({
    params: { takeProfitMode: 'atr_band', atrBandInterval: '1h' },
    signals: [{ t: SIG_T, direction: 'bullish', alertId: 5 }],
    fetchImpl,
  });
  const result = await service.runBacktest(await service.normalizeConfig(3, { strategyId: BOT_ID, from: FROM, to: TO, source: 'dvol' }));
  assert.equal(candleCalls[0].timeframe, '1h');
  assert.equal(candleCalls[0].startTime, FROM - 30 * DAY_MS);
  assert.equal(result.metrics.cycles, 1);
  assert.ok(['take_profit_atr_band', 'expiry'].includes(result.cycles[0].exitReason), result.cycles[0].exitReason);
  assert.deepEqual(result.signals, { received: 1, traded: 1, ignored: 0 });
});

test('backtest bot: respeta el presupuesto total y una sola opción por subyacente', async () => {
  const signals = [
    { t: SIG_T, direction: 'bullish', alertId: 5 },
    { t: SIG_T + 10 * 60 * 1000, direction: 'bullish', alertId: 6 },
  ];
  const base = { maxOpenPositions: 5, quantity: 1, stopLossPct: 1000, takeProfitPct: 1000 };
  const free = botService({ params: { ...base, capitalUsdt: 10 }, signals });
  const freeResult = await free.service.runBacktest(await free.service.normalizeConfig(3, { strategyId: BOT_ID, from: FROM, to: TO }));
  assert.equal(freeResult.metrics.cycles, 1, 'la 2.ª alcista encuentra el subyacente ocupado');
  assert.deepEqual(freeResult.signals, { received: 2, traded: 1, ignored: 1 });

  const capped = botService({ params: { ...base, budgetUsdt: 10, budgetFractions: 1 }, signals });
  const result = await capped.service.runBacktest(await capped.service.normalizeConfig(3, { strategyId: BOT_ID, from: FROM, to: TO }));
  assert.equal(result.metrics.cycles, 1);
  const leg = result.cycles[0].legs[0];
  assert.ok(leg.price * leg.quantity <= 10 + 1e-6);
  assert.deepEqual(result.signals, { received: 2, traded: 1, ignored: 1 });
});
