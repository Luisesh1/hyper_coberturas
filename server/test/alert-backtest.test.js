const test = require('node:test');
const assert = require('node:assert/strict');

const alertsRepo = require('../src/repositories/alerts.repository');
const alertEvents = require('../src/services/alerts/alert-events');
const telegramRegistry = require('../src/services/telegram.registry');
const backtest = require('../src/services/alerts/alert-backtest.service');

const { windowAt, simulate, createAlertBacktest } = backtest;
const { filterClosedCandles } = require('../src/services/alerts/alerts.service');

const M15 = 15 * 60_000;
const H4 = 4 * 60 * 60_000;
// Múltiplo de 4h (y de 15m) para que la rejilla de cierres quede alineada.
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

// Velas sintéticas con volumen controlado: volume > 50 ⇔ la regla 15m se cumple.
function makeCandles(tfMs, startMs, n, volumeAt = () => 10, { binanceClose = false } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const time = startMs + i * tfMs;
    const candle = { time, open: 100, high: 101, low: 99, close: 100, volume: volumeAt(i, time) };
    if (binanceClose) candle.closeTime = time + tfMs - 1;
    return candle;
  });
}

function volumeRule(timeframe, value, weight = 1) {
  return {
    weight,
    conditions: [{
      indicatorType: 'volume',
      indicatorParams: {},
      timeframe,
      operandSeries: 'line',
      operator: '>',
      operand: { kind: 'constant', value },
    }],
    joiners: [],
  };
}

function makeAlert({ cooldownSeconds = 900, rules = [volumeRule('15m', 50)], thresholdPercent = 100 } = {}) {
  return {
    id: 7,
    userId: 1,
    name: 'test',
    isActive: true,
    thresholdPercent,
    assetList: ['BTCUSDT'],
    rules,
    telegramEnabled: true,
    cooldownSeconds,
    lastTriggeredAt: {},
    datasource: 'binance',
    direction: 'neutral',
    createdAt: 1,
    updatedAt: 123,
  };
}

// Cierre de la vela 15m de índice i (abre en BASE + i·15m).
const closeOf = (i) => BASE + (i + 1) * M15;

test('windowAt en cripto 24/7 devuelve 249 velas en T = cierre + 3s', () => {
  for (const binanceClose of [false, true]) {
    const candles = makeCandles(M15, BASE, 400, undefined, { binanceClose });
    const T = closeOf(300) + 3000;
    const win = windowAt(candles, '15m', T);
    assert.equal(win.length, 249);
    assert.equal(win[win.length - 1].time, BASE + 300 * M15);
    assert.ok(win[0].time >= T - 250 * M15);
  }
});

test('windowAt excluye la vela HTF no cerrada', () => {
  const day = BASE + 20 * 24 * 3600_000;
  const candles = makeCandles(H4, BASE, 200);
  const T = day + (14 * 60 + 15) * 60_000 + 3000;
  const win = windowAt(candles, '4h', T);
  const last = win[win.length - 1];
  assert.equal(last.time + H4, day + 12 * 3600_000);
});

test('cooldown igual al TF suprime la vela siguiente', () => {
  const hot = new Set([300, 301]);
  const candles = makeCandles(M15, BASE, 400, (i) => (hot.has(i) ? 100 : 10));
  const out = simulate({
    alert: makeAlert({ cooldownSeconds: 900 }),
    candlesByTf: { '15m': candles },
    fromMs: closeOf(280),
    toMs: closeOf(320),
  });
  assert.equal(out.baseTimeframe, '15m');
  assert.deepEqual(out.events.map((e) => e.time), [closeOf(300), closeOf(301)]);
  assert.deepEqual(out.events.map((e) => e.suppressed), [false, true]);
  assert.equal(out.events[0].score, 100);
  assert.equal(out.events[0].threshold, 100);
  assert.equal(out.events[0].rules[0].indicatorType, 'volume');
  assert.equal(out.events[0].rules[0].timeframe, '15m');
  assert.equal(out.events[0].rules[0].matched, true);
  assert.deepEqual(out.events[0].rules[0].conditions, [{ indicatorType: 'volume', timeframe: '15m' }]);
  assert.equal(out.cooldownApprox, false);
});

test('cooldown deja pasar tras cd + 1 vela', () => {
  const hot = new Set([300, 301, 302]);
  const candles = makeCandles(M15, BASE, 400, (i) => (hot.has(i) ? 100 : 10));
  const out = simulate({
    alert: makeAlert({ cooldownSeconds: 900 }),
    candlesByTf: { '15m': candles },
    fromMs: closeOf(280),
    toMs: closeOf(320),
  });
  assert.deepEqual(out.events.map((e) => e.suppressed), [false, true, false]);
});

test('el resultado no depende de dónde empieza el tramo', () => {
  // Racha larga con huecos de 1 vela: con cd = 30 min un hueco no basta para
  // reiniciar, así que el punto de reinicio cae antes del inicio de la racha.
  const hot = (i) => i >= 300 && i < 340 && i % 3 !== 2;
  const candles = makeCandles(M15, BASE, 600, (i) => (hot(i) ? 100 : 10));
  const alert = makeAlert({ cooldownSeconds: 1800 });
  const candlesByTf = { '15m': candles };
  const a = closeOf(290);
  const b = closeOf(321); // mitad de la racha
  const c = closeOf(360);
  const whole = simulate({ alert, candlesByTf, fromMs: a, toMs: c });
  const left = simulate({ alert, candlesByTf, fromMs: a, toMs: b });
  const right = simulate({ alert, candlesByTf, fromMs: b, toMs: c });
  assert.ok(whole.events.some((e) => e.suppressed));
  assert.ok(whole.events.some((e) => !e.suppressed));
  assert.deepEqual([...left.events, ...right.events], whole.events);
  assert.equal(right.cooldownApprox, false);
});

test('el resultado no depende del tramo aunque la racha supere el lookback', () => {
  // Racha continua más larga que 32·cd: se marca cooldownApprox.
  const candles = makeCandles(M15, BASE, 600, (i) => (i >= 100 ? 100 : 10));
  const alert = makeAlert({ cooldownSeconds: 900 });
  const out = simulate({ alert, candlesByTf: { '15m': candles }, fromMs: closeOf(500), toMs: closeOf(510) });
  assert.equal(out.cooldownApprox, true);
});

test('sin historia suficiente no inventa disparos', () => {
  const candles15 = makeCandles(M15, BASE, 5000, () => 100);
  const start4h = BASE + 10 * 24 * 3600_000;
  const candles4h = makeCandles(H4, start4h, 400, () => 100);
  const alert = makeAlert({
    cooldownSeconds: 0,
    thresholdPercent: 50,
    rules: [volumeRule('15m', 50), volumeRule('4h', 50)],
  });
  const out = simulate({
    alert,
    candlesByTf: { '15m': candles15, '4h': candles4h },
    fromMs: closeOf(250),
    toMs: closeOf(4999),
  });
  assert.ok(out.insufficient > 0);
  // Primera evaluación cuya ventana 4h [T − 250·4h, T] ya está cubierta por
  // los datos: la misma que vería el motor en vivo (249 velas 4h cerradas).
  const firstOk = start4h + 249 * H4;
  assert.equal(out.events[0].time, firstOk);
  for (const e of out.events) assert.ok(e.time >= firstOk, `evento en ${e.time} antes de ${firstOk}`);
  // Sin cooldown: a partir de ahí dispara en cada cierre 15m.
  assert.equal(out.events.length, (closeOf(4999) - firstOk) / M15 + 1);
});

test('run es de solo lectura', async (t) => {
  const spies = [
    t.mock.method(alertsRepo, 'updateCooldown', async () => null),
    t.mock.method(alertsRepo, 'recordEvent', async () => ({ id: 1 })),
    t.mock.method(alertsRepo, 'markEventTelegramResult', async () => null),
    t.mock.method(alertEvents, 'emitAlertTriggered', () => null),
    t.mock.method(telegramRegistry, 'getOrCreate', async () => null),
    t.mock.method(telegramRegistry, 'get', () => null),
  ];
  const candles = makeCandles(M15, BASE, 600, (i) => (i % 5 === 0 ? 100 : 10));
  const getAlert = t.mock.fn(async () => makeAlert());
  const getCandles = t.mock.fn(async () => candles);
  const svc = createAlertBacktest({ getAlert, getCandles, now: () => closeOf(599) + 3000 });
  const res = await svc.run(1, 7, {
    asset: 'ETHUSDT', datasource: 'hyperliquid', startTime: closeOf(400), endTime: closeOf(599),
  });
  assert.ok(res.events.length > 0);
  assert.equal(res.alertId, 7);
  assert.equal(res.alertUpdatedAt, 123);
  assert.equal(res.asset, 'ETHUSDT');
  assert.equal(res.datasource, 'hyperliquid');
  assert.equal(res.alertDatasource, 'binance');
  assert.equal(res.baseTimeframe, '15m');
  assert.equal(getCandles.mock.callCount(), 1);
  const [asset, tf, opts] = getCandles.mock.calls[0].arguments;
  assert.equal(asset, 'ETHUSDT');
  assert.equal(tf, '15m');
  assert.equal(opts.datasource, 'hyperliquid');
  assert.equal(opts.startTime, closeOf(400) - 32 * 900_000 - 250 * M15);
  assert.equal(opts.endTime, closeOf(599));
  assert.deepEqual(getAlert.mock.calls[0].arguments, [1, 7]);
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});

test('run recorta endTime a now() − 3 s: no evalúa boundaries que el scheduler aún no evaluó', async () => {
  const candles = makeCandles(M15, BASE, 600, () => 100);
  const alert = makeAlert({ cooldownSeconds: 0 });
  const mk = (nowMs) => createAlertBacktest({ getAlert: async () => alert, getCandles: async () => candles, now: () => nowMs });
  const req = { asset: 'BTCUSDT', datasource: 'binance', startTime: closeOf(400), endTime: closeOf(900) };
  // 2 s después del cierre 500 el scheduler aún no lo ha evaluado.
  const early = await mk(closeOf(500) + 2000).run(1, 7, req);
  assert.equal(early.to, closeOf(500) + 2000 - 3000);
  assert.equal(early.events[early.events.length - 1].evalTime, closeOf(499));
  // A los 3 s ya sí.
  const onTime = await mk(closeOf(500) + 3000).run(1, 7, req);
  assert.equal(onTime.to, closeOf(500));
  assert.equal(onTime.events[onTime.events.length - 1].evalTime, closeOf(500));
});

test('fromMs no alineado con cd < tf no marca cooldownApprox', async () => {
  const candles = makeCandles(H4 / 4, BASE, 600); // 1h, sin disparos
  const alert = makeAlert({ cooldownSeconds: 60, rules: [volumeRule('1h', 50)] });
  const fromMs = BASE + 400 * 3600_000 + 45 * 60_000;
  const out = simulate({ alert, candlesByTf: { '1h': candles }, fromMs, toMs: fromMs + 10 * 3600_000 });
  assert.equal(out.cooldownApprox, false);
  const calls = [];
  const svc = createAlertBacktest({
    getAlert: async () => alert,
    getCandles: async (...args) => { calls.push(args); return candles; },
    now: () => fromMs + 100 * 3600_000,
  });
  const res = await svc.run(1, 7, { asset: 'BTCUSDT', datasource: 'binance', startTime: fromMs, endTime: fromMs + 10 * 3600_000 });
  assert.equal(res.cooldownApprox, false);
  // Fetch anclado al boundary: lastBefore(from) − 32·cd − 250·1h.
  assert.equal(calls[0][2].startTime, BASE + 400 * 3600_000 - 32 * 60_000 - 250 * 3600_000);
});

test('cada regla lista todas sus condiciones', () => {
  const rule = {
    weight: 2,
    conditions: [volumeRule('15m', 50).conditions[0], volumeRule('4h', 0).conditions[0]],
    joiners: ['and'],
  };
  const candles15 = makeCandles(M15, BASE, 3000, () => 100);
  const candles4h = makeCandles(H4, BASE - 300 * H4, 600, () => 100);
  const out = simulate({
    alert: makeAlert({ cooldownSeconds: 0, rules: [rule] }),
    candlesByTf: { '15m': candles15, '4h': candles4h },
    fromMs: closeOf(2990),
    toMs: closeOf(2991),
  });
  assert.equal(out.events.length, 1);
  const [r] = out.events[0].rules;
  assert.equal(r.indicatorType, 'volume');
  assert.equal(r.timeframe, '15m');
  assert.equal(r.weight, 2);
  assert.deepEqual(r.conditions, [
    { indicatorType: 'volume', timeframe: '15m' },
    { indicatorType: 'volume', timeframe: '4h' },
  ]);
});

test('run rechaza rangos de más de 2000 velas base', async () => {
  const svc = createAlertBacktest({
    getAlert: async () => makeAlert(),
    getCandles: async () => { throw new Error('no debería pedir velas'); },
    now: () => BASE + 10_000 * M15,
  });
  await assert.rejects(
    svc.run(1, 7, { asset: 'BTCUSDT', datasource: 'binance', startTime: BASE, endTime: BASE + 2001 * M15 }),
    (err) => err.name === 'ValidationError' && /rango demasiado grande: máximo 2000 velas de 15m/.test(err.message),
  );
  // Justo 2000 sí se acepta.
  const ok = createAlertBacktest({
    getAlert: async () => makeAlert(),
    getCandles: async () => [],
    now: () => BASE + 10_000 * M15,
  });
  const res = await ok.run(1, 7, { asset: 'BTCUSDT', datasource: 'binance', startTime: BASE, endTime: BASE + 2000 * M15 });
  assert.equal(res.events.length, 0);
});

test('constantes exportadas', () => {
  assert.equal(backtest.SEND_DELAY_MS, 1000);
  assert.equal(backtest.MAX_EVALS_PER_REQUEST, 2000);
  assert.equal(backtest.MAX_COOLDOWN_LOOKBACK_FACTOR, 32);
  assert.equal(typeof backtest.run, 'function');
});

const H1 = 60 * 60_000;
const M1 = 60_000;

test('velas horarias que abren en :30 (Yahoo) se evalúan en las horas del epoch', () => {
  // Sin closeTime (cierre = apertura + 1h) y con closeTime = time, que es lo
  // que devuelve yahoo.provider: en vivo filterClosedCandles da por cerrada
  // la vela en cuanto abre, así que entra la vela abierta a b − 30m.
  for (const yahooClose of [false, true]) {
    const candles = makeCandles(H1, BASE + 30 * 60_000, 600, () => 100)
      .map((c) => (yahooClose ? { ...c, closeTime: c.time } : c));
    const alert = makeAlert({ cooldownSeconds: 0, rules: [volumeRule('1h', 50)] });
    const fromMs = BASE + 300 * H1;
    const toMs = BASE + 320 * H1;
    const out = simulate({ alert, candlesByTf: { '1h': candles }, fromMs, toMs });
    assert.equal(out.baseTimeframe, '1h');
    assert.equal(out.insufficient, 0);
    assert.equal(out.events.length, 20);
    for (const e of out.events) {
      assert.equal(e.evalTime % H1, 0);
      assert.equal(e.time, e.evalTime - 30 * 60_000);
      assert.equal(e.suppressed, false);
      // windowAt === lo que vería el motor: ventana de tiempo de getCandles
      // + filterClosedCandles en T.
      const T = e.evalTime + 3000;
      const live = filterClosedCandles(candles.filter((c) => c.time >= T - 250 * H1 && c.time <= T), '1h', T);
      const win = windowAt(candles, '1h', T);
      assert.deepEqual(win, live);
      const lastOpen = win[win.length - 1].time;
      assert.equal(lastOpen, yahooClose ? e.evalTime - 30 * 60_000 : e.evalTime - 90 * 60_000);
    }
  }
});

test('dos boundaries sobre la misma última vela: el segundo sale suprimido', () => {
  // Falta la vela 301: en el boundary closeOf(301) la última cerrada sigue siendo la 300.
  const candles = makeCandles(M15, BASE, 400, (i) => (i === 300 ? 100 : 10))
    .filter((_, i) => i !== 301);
  const out = simulate({
    alert: makeAlert({ cooldownSeconds: 900 }),
    candlesByTf: { '15m': candles },
    fromMs: closeOf(280),
    toMs: closeOf(320),
  });
  assert.deepEqual(out.events.map((e) => e.evalTime), [closeOf(300), closeOf(301)]);
  assert.deepEqual(out.events.map((e) => e.time), [closeOf(300), closeOf(300)]);
  assert.deepEqual(out.events.map((e) => e.suppressed), [false, true]);
});

test('cooldown de 1 día en 1m: el calentamiento se limita a 2000 boundaries', async () => {
  // Racha continua de 3900 velas: sin el tope, el lookback de 32 días llegaría
  // a la zona sin datos y encontraría un reinicio; con el tope es aproximado.
  const candles = makeCandles(M1, BASE, 5000, (i) => (i >= 100 ? 100 : 10));
  const alert = makeAlert({ cooldownSeconds: 86_400, rules: [volumeRule('1m', 50)] });
  const fromMs = BASE + 4000 * M1;
  const toMs = BASE + 4010 * M1;
  const out = simulate({ alert, candlesByTf: { '1m': candles }, fromMs, toMs });
  assert.equal(out.cooldownApprox, true);
  assert.equal(out.events.length, 10);

  const getCandles = async () => candles;
  const calls = [];
  const svc = createAlertBacktest({
    getAlert: async () => alert,
    getCandles: async (...args) => { calls.push(args); return getCandles(); },
    now: () => toMs,
  });
  const res = await svc.run(1, 7, { asset: 'BTCUSDT', datasource: 'binance', startTime: fromMs, endTime: toMs });
  assert.equal(res.cooldownApprox, true);
  assert.equal(calls[0][2].startTime, fromMs - 2000 * M1 - 250 * M1);
});
