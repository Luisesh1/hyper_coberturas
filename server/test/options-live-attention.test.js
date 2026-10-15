const test = require('node:test');
const assert = require('node:assert/strict');
const { OptionsLiveExecution } =
  require('../src/services/options/options-live-execution.service');
const { createOptionsLiveOrdersRepository } =
  require('../src/repositories/options-live-orders.repository');

test('seguridad: dos flags independientes antes de permitir enviar órdenes reales', () => {
  const original = [process.env.OPTIONS_LIVE_TRADING_ENABLED,
    process.env.OPTIONS_LIVE_PRODUCTION_APPROVED];
  try {
    process.env.OPTIONS_LIVE_TRADING_ENABLED = 'true';
    delete process.env.OPTIONS_LIVE_PRODUCTION_APPROVED;
    assert.equal(new OptionsLiveExecution().enabled, false);
    process.env.OPTIONS_LIVE_TRADING_ENABLED = 'false';
    process.env.OPTIONS_LIVE_PRODUCTION_APPROVED = 'true';
    assert.equal(new OptionsLiveExecution().enabled, false);
    process.env.OPTIONS_LIVE_TRADING_ENABLED = 'true';
    assert.equal(new OptionsLiveExecution().enabled, true);
  } finally {
    ['OPTIONS_LIVE_TRADING_ENABLED', 'OPTIONS_LIVE_PRODUCTION_APPROVED']
      .forEach((key, i) => { if (original[i] === undefined) delete process.env[key];
        else process.env[key] = original[i]; });
  }
});
test('alarma de atención no envía credenciales ni spam y sigue cuando trading está apagado', async () => {
  const messages = [];
  let claimed = 0;
  const logger = { warn() {}, info() {} };
  const order = { id: 10, user_id: 7, strategy_id: 3,
    client_order_id: 'HC23L0', symbol: 'BTC-261016-60000-C',
    last_error: 'Binance timeout <retry>', deadline_at: 1000 };
  const engine = new OptionsLiveExecution({
    enabled: false, logger,
    repo: {
      async listAttentionOrders() { return [10]; },
      async claimAttentionNotification() { claimed++; return claimed === 1 ? order : null; },
    },
    notify: async (user, message) => messages.push({ user, message }),
  });
  assert.equal(await engine.alertAttention(), 1);
  assert.equal(await engine.alertAttention(), 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].user, 7);
  assert.match(messages[0].message, /ALERTA.*Binance Opciones/);
  assert.match(messages[0].message, /timeout &lt;retry&gt;/);
});
test('alarma de atención persiste timestamp en PostgreSQL con condición atómica', async () => {
  const queries = [];
  const repo = createOptionsLiveOrdersRepository({
    now: () => 10_000_000,
    db: { async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [{ id: 123, user_id: 7 }] };
    } },
  });
  assert.equal((await repo.claimAttentionNotification(123)).id, 123);
  assert.match(queries[0].sql, /status='attention'/);
  assert.match(queries[0].sql, /attention_notified_at <= \$3/);
  assert.equal(queries[0].params[2], 10_000_000 - 15 * 60_000);
});
