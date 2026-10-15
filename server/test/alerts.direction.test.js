const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const db = require('../src/db');
const alertsRepo = require('../src/repositories/alerts.repository');
const marketData = require('../src/services/market-data.service');
const evaluator = require('../src/services/alerts/indicator-evaluator');
const alertEvents = require('../src/services/alerts/alert-events');
const logger = require('../src/services/logger.service');
const alertsService = require('../src/services/alerts/alerts.service');

const { buildAlertMessage, rowToDto, validatePayload } = alertsService;

function basePayload(extra = {}) {
  return {
    name: 'BTC · MACD cruce',
    assetList: ['BTCUSDT'],
    rules: [{
      weight: 1,
      conditions: [{
        indicatorType: 'rsi',
        indicatorParams: { length: 14 },
        timeframe: '15m',
        operandSeries: 'line',
        operator: '<',
        operand: { kind: 'constant', value: 30 },
      }],
      joiners: [],
    }],
    ...extra,
  };
}

// Espera a que corran los setImmediate/microtareas pendientes del emisor.
const flush = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

function stub(t, obj, key, value) {
  const original = obj[key];
  obj[key] = value;
  t.after(() => { obj[key] = original; });
}

// ------------------------------------------------------------------
// Migración
// ------------------------------------------------------------------

test('la migración 032 añade direction a alerts (neutral por defecto, CHECK) y a alert_events (nullable)', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/032_alert_direction.sql'), 'utf8');
  assert.match(sql, /ALTER TABLE alerts\s+ADD COLUMN IF NOT EXISTS direction VARCHAR\(10\) NOT NULL DEFAULT 'neutral'/);
  assert.match(sql, /CHECK \(direction IN \('bullish', 'bearish', 'neutral'\)\)/);
  assert.match(sql, /ALTER TABLE alert_events\s+ADD COLUMN IF NOT EXISTS direction VARCHAR\(10\);/);
});

// ------------------------------------------------------------------
// Schema zod
// ------------------------------------------------------------------

test('validatePayload pone direction = neutral cuando no viene', () => {
  assert.equal(validatePayload(basePayload()).direction, 'neutral');
});

test('validatePayload acepta bullish y bearish', () => {
  assert.equal(validatePayload(basePayload({ direction: 'bullish' })).direction, 'bullish');
  assert.equal(validatePayload(basePayload({ direction: 'bearish' })).direction, 'bearish');
});

test('validatePayload rechaza una dirección desconocida', () => {
  assert.throws(() => validatePayload(basePayload({ direction: 'up' })), /direction/);
});

// ------------------------------------------------------------------
// Mapeo fila ↔ DTO
// ------------------------------------------------------------------

test('rowToDto devuelve neutral si la fila no trae direction (antes de la migración)', () => {
  const dto = rowToDto({ id: 1, user_id: 2, name: 'x', threshold_percent: '70', cooldown_seconds: 900 });
  assert.equal(dto.direction, 'neutral');
});

test('rowToDto conserva la dirección guardada', () => {
  const dto = rowToDto({ id: 1, user_id: 2, name: 'x', direction: 'bearish' });
  assert.equal(dto.direction, 'bearish');
});

test('create/update guardan la dirección y recordEvent guarda la foto', async (t) => {
  const calls = [];
  stub(t, db, 'query', async (text, params) => {
    calls.push({ text, params });
    return { rows: [{ id: 9, direction: params[params.length - 1] }], rowCount: 1 };
  });

  await alertsRepo.create(1, { name: 'a', direction: 'bullish', now: 1 });
  assert.match(calls[0].text, /direction/);
  assert.equal(calls[0].params[10], 'bullish');

  await alertsRepo.update(1, 5, { name: 'a', direction: 'bearish', now: 1 });
  assert.match(calls[1].text, /direction\s+= \$12/);
  assert.equal(calls[1].params[11], 'bearish');

  await alertsRepo.update(1, 5, { name: 'a', now: 1 });
  assert.equal(calls[2].params[11], 'neutral');

  await alertsRepo.recordEvent({ alertId: 5, userId: 1, direction: 'bullish', now: 1 });
  assert.match(calls[3].text, /INSERT INTO alert_events[\s\S]*direction/);
  assert.equal(calls[3].params[12], 'bullish');
});

// ------------------------------------------------------------------
// Mensaje de Telegram
// ------------------------------------------------------------------

function message(direction) {
  return buildAlertMessage({
    alert: { name: 'BTC <MACD>', thresholdPercent: 70, direction },
    asset: 'BTCUSDT',
    score: 85,
    matched: [],
    total: 1,
    candleCloseTime: Date.UTC(2026, 0, 1, 9, 15),
    lowestTf: '15m',
    sentAt: Date.UTC(2026, 0, 1, 9, 15, 3),
  });
}

test('buildAlertMessage antepone 🟢 ALCISTA · al título de una alerta alcista', () => {
  assert.equal(message('bullish').split('\n')[0], '🟢 ALCISTA · <b>BTC &lt;MACD&gt;</b>');
});

test('buildAlertMessage antepone 🔴 BAJISTA · al título de una alerta bajista', () => {
  assert.equal(message('bearish').split('\n')[0], '🔴 BAJISTA · <b>BTC &lt;MACD&gt;</b>');
});

test('buildAlertMessage deja el encabezado de siempre para neutral o sin dirección', () => {
  assert.equal(message('neutral').split('\n')[0], '🔔 <b>BTC &lt;MACD&gt;</b>');
  assert.equal(message(undefined).split('\n')[0], '🔔 <b>BTC &lt;MACD&gt;</b>');
});

// ------------------------------------------------------------------
// Emisor
// ------------------------------------------------------------------

test('emitAlertTriggered aísla a los listeners: uno que falla no afecta a otros ni al emisor', async (t) => {
  const warnings = [];
  stub(t, logger, 'warn', (msg, meta) => warnings.push({ msg, meta }));
  const received = [];
  const offs = [
    alertEvents.onAlertTriggered(() => { throw new Error('sync boom'); }),
    alertEvents.onAlertTriggered(async () => { throw new Error('async boom'); }),
    alertEvents.onAlertTriggered((payload) => { received.push(payload); }),
  ];
  t.after(() => offs.forEach((off) => off()));

  let calledSync = false;
  const off = alertEvents.onAlertTriggered(() => { calledSync = true; });
  offs.push(off);

  const notified = alertEvents.emitAlertTriggered({ alertId: 3, eventId: 7, direction: 'bullish' });
  assert.equal(notified, 4);
  // Asíncrono: nada se ha llamado todavía al volver del emit.
  assert.equal(calledSync, false);

  await flush();
  assert.equal(received.length, 1);
  assert.equal(received[0].direction, 'bullish');
  assert.ok(Object.isFrozen(received[0]));
  assert.equal(calledSync, true);
  const failures = warnings.filter((w) => w.msg === 'alert_event_listener_failed');
  assert.deepEqual(failures.map((w) => w.meta.error).sort(), ['async boom', 'sync boom']);
});

test('onAlertTriggered devuelve un unsubscribe y rechaza no-funciones', async () => {
  const before = alertEvents.listenerCount();
  let calls = 0;
  const off = alertEvents.onAlertTriggered(() => { calls += 1; });
  assert.equal(alertEvents.listenerCount(), before + 1);
  off();
  assert.equal(alertEvents.listenerCount(), before);
  alertEvents.emitAlertTriggered({ alertId: 1 });
  await flush();
  assert.equal(calls, 0);
  assert.throws(() => alertEvents.onAlertTriggered(null), TypeError);
});

// ------------------------------------------------------------------
// Emisión desde evaluateAlertOnAsset
// ------------------------------------------------------------------

function stubEvaluation(t, { alert }) {
  const recorded = [];
  stub(t, marketData, 'getCandles', async () => [{ time: 0, closeTime: 1_000, close: 1 }]);
  stub(t, evaluator, 'evaluateRule', () => ({ matched: true, value: 1, reason: 'ok' }));
  stub(t, alertsRepo, 'recordEvent', async (payload) => { recorded.push(payload); return { id: 42 }; });
  stub(t, alertsRepo, 'updateCooldown', async () => {});
  stub(t, alertsRepo, 'getById', async () => alert);
  return recorded;
}

const ALERT_ROW = {
  id: 5,
  user_id: 1,
  name: 'BTC · MACD cruce',
  is_active: true,
  threshold_percent: '70',
  asset_list_json: JSON.stringify(['BTCUSDT']),
  rules_json: JSON.stringify(basePayload().rules),
  telegram_enabled: false,
  cooldown_seconds: 900,
  last_triggered_at_json: {},
  datasource: 'binance',
  direction: 'bullish',
  created_at: 1,
  updated_at: 1,
};

test('un disparo real emite la señal con la dirección y guarda la foto en el evento', async (t) => {
  const recorded = stubEvaluation(t, { alert: ALERT_ROW });
  const received = [];
  t.after(alertEvents.onAlertTriggered((p) => { received.push(p); }));

  const result = await alertsService.evaluateAlertOnAsset(rowToDto(ALERT_ROW), 'BTCUSDT', { sendTelegram: false });
  assert.equal(result.triggered, true);
  assert.equal(recorded[0].direction, 'bullish');

  await flush();
  assert.equal(received.length, 1);
  const p = received[0];
  assert.deepEqual(Object.keys(p).sort(), [
    'alertId', 'alertName', 'asset', 'candleCloseTime', 'direction', 'eventId',
    'score', 'thresholdPercent', 'triggeredAt', 'userId',
  ]);
  assert.equal(p.userId, 1);
  assert.equal(p.alertId, 5);
  assert.equal(p.alertName, 'BTC · MACD cruce');
  assert.equal(p.direction, 'bullish');
  assert.equal(p.asset, 'BTCUSDT');
  assert.equal(p.score, 100);
  assert.equal(p.thresholdPercent, 70);
  assert.equal(p.eventId, 42);
  assert.equal(typeof p.triggeredAt, 'number');
});

test('emitSignal: false no emite aunque la alerta se dispare', async (t) => {
  stubEvaluation(t, { alert: ALERT_ROW });
  let calls = 0;
  t.after(alertEvents.onAlertTriggered(() => { calls += 1; }));

  const result = await alertsService.evaluateAlertOnAsset(rowToDto(ALERT_ROW), 'BTCUSDT', {
    sendTelegram: false, emitSignal: false,
  });
  assert.equal(result.triggered, true);
  await flush();
  assert.equal(calls, 0);
});

test('testAlertNow (dry-run y envío manual) nunca emite señal', async (t) => {
  stubEvaluation(t, { alert: ALERT_ROW });
  let calls = 0;
  t.after(alertEvents.onAlertTriggered(() => { calls += 1; }));

  const dry = await alertsService.testAlertNow(1, 5, { dryRun: true });
  assert.equal(dry.results[0].triggered, true);
  const manual = await alertsService.testAlertNow(1, 5, { dryRun: false });
  assert.equal(manual.results[0].triggered, true);
  await flush();
  assert.equal(calls, 0);
});

test('una alerta que no supera el umbral no emite', async (t) => {
  stubEvaluation(t, { alert: ALERT_ROW });
  stub(t, evaluator, 'evaluateRule', () => ({ matched: false, value: 1, reason: 'no' }));
  let calls = 0;
  t.after(alertEvents.onAlertTriggered(() => { calls += 1; }));

  const result = await alertsService.evaluateAlertOnAsset(rowToDto(ALERT_ROW), 'BTCUSDT', { sendTelegram: false });
  assert.equal(result.wouldTrigger, false);
  await flush();
  assert.equal(calls, 0);
});
