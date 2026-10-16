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

test('auditoría detecta órdenes huérfanas y no repite alertas al minuto siguiente', async () => {
  const clock = { now: 500_000 };
  const sent = [];
  const calls = { scans: 0, claimed: [] };
  const repo = {
    async listUnresolved() { return []; },
    async listMonitorUsers() { calls.scans++; return [7]; },
    async listUserOrderIds() { return []; },
    async assertExchangeExposure() { return true; },
    async claimIncidentNotification(user, type, resource) {
      calls.claimed.push({ user, type, resource });
      return true;
    },
  };
  const client = {
    async getPositions() { return []; },
    async getOpenOrders() {
      return [{ clientOrderId: 'MANUAL-1', symbol: 'BTC-261016-60000-C', status: 'NEW' }];
    },
  };
  const engine = new OptionsLiveExecution({
    enabled: false, repo, logger: { warn() {}, info() {} },
    credentials: { async getClientForUser() { return client; } },
    notify: async (user, msg) => sent.push({ user, msg }), now: () => clock.now,
  });
  const first = await engine.reconcilePending();
  assert.equal(first.accountAudit.checked, 1);
  assert.equal(first.accountAudit.incidents, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].msg, /sin seguimiento/);
  assert.deepEqual(calls.claimed.map((c) => c.type), ['ORPHAN_OPEN_ORDERS']);
  clock.now += 60_000;
  await engine.reconcilePending();
  assert.equal(calls.scans, 1);
  clock.now += 5 * 60_000;
  await engine.reconcilePending();
  assert.equal(calls.scans, 2);
});
test('caída de credenciales dispara alarma específica sin permitir órdenes nuevas', async () => {
  const events = [];
  const engine = new OptionsLiveExecution({
    enabled: false,
    logger: { warn() {}, info() {} },
    repo: {
      async listMonitorUsers() { return [9]; },
      async listUserOrderIds() { return []; },
      async claimIncidentNotification(_u, kind) { events.push(kind); return true; },
    },
    credentials: { async getClientForUser() { throw new Error('API unavailable'); } },
    notify: async (user, msg) => events.push({ user, msg }),
  });
  const state = await engine.scanExternalAccounts();
  assert.equal(state.incidents, 1);
  assert.equal(events[0], 'ACCOUNT_AUDIT_UNAVAILABLE');
  assert.match(events[1].msg, /no disponible/);
});
test('deduplicación de incidentes usa upsert condicional atómico', async () => {
  const calls = [];
  const repo = createOptionsLiveOrdersRepository({
    now: () => 10_000_000,
    db: { async query(sql, args) {
      calls.push({ sql, args });
      return { rows: [{ user_id: 7 }] };
    } },
  });
  assert.equal(await repo.claimIncidentNotification(7, 'EXPOSURE_MISMATCH', 'account'), true);
  assert.match(calls[0].sql, /ON CONFLICT/);
  assert.match(calls[0].sql, /last_notified_at <= \$5/);
  assert.equal(calls[0].args[4], 10_000_000 - 15 * 60_000);
});

test('watchdog detecta fill sin TP tras dos minutos y alerta con trading apagado sin usar Binance', async () => {
  const now = 700_000;
  const sent = [];
  const claims = [];
  const checks = [];
  let allowed = true;
  const engine = new OptionsLiveExecution({
    enabled: false, now: () => now,
    logger: { warn() {}, info() {}, error() {} },
    credentials: { async getClientForUser() {
      throw new Error('No debería consultar Binance');
    } },
    repo: {
      async listUnresolved() { return []; },
      async listUnprotectedLivePositions(olderThan, limit) {
        checks.push({ olderThan, limit });
        return [{ positionId: 101, userId: 7, strategyId: 4, openedAt: now - 200_000 }];
      },
      async claimIncidentNotification(userId, kind, resource) {
        claims.push({ userId, kind, resource });
        if (!allowed) return false;
        allowed = false;
        return true;
      },
    },
    notify: async (userId, msg) => sent.push({ userId, msg }),
  });
  const first = await engine.reconcilePending();
  assert.deepEqual(first.unprotected, { checked: 1, incidents: 1, alerts: 1 });
  assert.deepEqual(checks[0], { olderThan: now - 120_000, limit: 100 });
  assert.deepEqual(claims[0], { userId: 7, kind: 'UNPROTECTED_TP', resource: '101' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, 7);
  assert.match(sent[0].msg, /sin TP confirmado/);
  assert.match(sent[0].msg, /dos minutos/);
  assert.equal((await engine.reconcilePending()).unprotected.alerts, 0);
  assert.equal(sent.length, 1);
});

test('watchdog omite alertas cuando no existen posiciones desprotegidas', async () => {
  const engine = new OptionsLiveExecution({
    enabled: false, logger: { warn() {}, info() {}, error() {} },
    repo: {
      async listUnprotectedLivePositions() { return []; },
      async claimIncidentNotification() { throw new Error('No hay incidentes'); },
    },
    notify: async () => { throw new Error('Sin aviso'); },
  });
  assert.deepEqual(await engine.scanUnprotectedPositions(),
    { checked: 0, incidents: 0, alerts: 0 });
});
