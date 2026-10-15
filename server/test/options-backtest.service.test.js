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
  for (const key of ['returnPct', 'maxDrawdownPct', 'sharpe', 'wins', 'cycles', 'premiumUsdt', 'worstCycleUsdt']) {
    assert.ok(Number.isFinite(metrics[key]), key);
  }
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
