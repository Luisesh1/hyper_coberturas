const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const config = require('../src/config');
const authService = require('../src/services/auth.service');
const strategiesService = require('../src/services/options/options-strategies.service');
const backtestService = require('../src/services/options/options-backtest.service');
const { createOptionsStrategiesService } = strategiesService;
const { createFakeOptionsRepo } = require('./support/options-fake-repo');

const USER = 1;

function token() {
  return jwt.sign({ userId: USER, username: 'tester', role: 'user' }, config.jwt.secret);
}

async function withServer(fn) {
  const originalAuth = authService.validateSessionToken;
  authService.validateSessionToken = async () => ({ id: USER, userId: USER, username: 'tester', role: 'user', active: true });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { address, port } = server.address();
  const call = async (method, path, body) => {
    const res = await fetch(`http://${address}:${port}/api/options${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    await fn(call);
  } finally {
    authService.validateSessionToken = originalAuth;
    server.close();
  }
}

function fakeCredentials({ configured = true, maxLiveStrategies = 1 } = {}) {
  return {
    async getClientForUser() {
      if (!configured) throw new Error('Sin credenciales');
      return { async placeOrder() { throw new Error('no se envían órdenes en tests'); } };
    },
    async getLimits() {
      return { maxMarginUsdt: 1000, maxDailyLossUsdt: 100, maxLiveStrategies, notifyTelegram: false };
    },
  };
}

// Sin red: el detalle consulta spot y deltas para el consumo de límites.
const fakeMarket = {
  async getChain() { return { spot: 68000 }; },
  async getQuote() { return { delta: 0.2 }; },
};

/** Sustituye el servicio real por uno con repo en memoria. */
function useFakeService(options = {}) {
  const repo = createFakeOptionsRepo();
  const original = { ...strategiesService };
  Object.assign(strategiesService, createOptionsStrategiesService({ repo, credentials: fakeCredentials(options), market: fakeMarket }));
  return { repo, restore: () => Object.assign(strategiesService, original) };
}

test('GET /options/strategies/templates lista los tres templates', async () => {
  await withServer(async (call) => {
    const res = await call('GET', '/strategies/templates');
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    assert.deepEqual(res.json.data.map((t) => t.id), ['short_strangle', 'covered_call', 'protective_put']);
    assert.ok(res.json.data[0].paramSchema.length > 0);
  });
});

test('CRUD de estrategias con validación, KPIs y alcance por usuario', async () => {
  const { repo, restore } = useFakeService();
  try {
    await withServer(async (call) => {
      assert.equal((await call('POST', '/strategies', { template: 'short_strangle', underlying: 'BTC', mode: 'live' })).status, 400);
      assert.equal((await call('POST', '/strategies', { template: 'nope', underlying: 'BTC' })).status, 404);
      assert.equal((await call('POST', '/strategies', { template: 'short_strangle', underlying: 'LUNA' })).status, 400);
      assert.equal((await call('POST', '/strategies', { template: 'short_strangle', underlying: 'BTC', params: { targetDelta: 3 } })).status, 400);

      const created = await call('POST', '/strategies', { name: 'Strangle semanal', template: 'short_strangle', underlying: 'btc', params: { targetDelta: 0.2 } });
      assert.equal(created.status, 201);
      const s = created.json.data;
      assert.equal(s.mode, 'shadow');
      assert.equal(s.underlying, 'BTC');
      assert.equal(s.params.targetDelta, 0.2);
      assert.equal(s.params.quantity, 0.01);
      assert.equal(s.limits.maxOrdersPerDay, 10);

      // Una posición cerrada en sombra para KPIs y curva.
      const now = Date.now();
      await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'shadow', symbol: 'BTC-261016-70000-C', side: 'SELL', quantity: 0.01, entryPrice: 100, openedAt: now - 1000, feesUsdt: 0.1 });
      await repo.closePosition(repo.positions[0].id, { exitPrice: 20, closedAt: now - 500, pnlUsdt: 0.6, feesUsdt: 0.2 });
      await repo.insertEvent({ strategyId: s.id, userId: USER, mode: 'shadow', action: 'open', premiumUsdt: 1, createdAt: now - 1000 });

      const list = await call('GET', '/strategies');
      assert.equal(list.status, 200);
      assert.equal(list.json.data.length, 1);
      assert.deepEqual(list.json.data[0].pnl30d, { shadow: 0.6, live: 0 });
      assert.equal(list.json.data[0].status, 'waiting');

      const detail = await call('GET', `/strategies/${s.id}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.json.data.kpis.shadow.realizedPnlUsdt, 0.6);
      assert.equal(detail.json.data.kpis.shadow.winRatePct, 100);
      assert.equal(detail.json.data.events.length, 1);
      assert.deepEqual(detail.json.data.equity.at(-1), { t: now - 500, shadow: 0.6, live: 0 });

      const updated = await call('PUT', `/strategies/${s.id}`, { name: 'Otro', params: { takeProfitPct: 60 }, limits: { maxNetDelta: null } });
      assert.equal(updated.status, 200);
      assert.equal(updated.json.data.name, 'Otro');
      assert.equal(updated.json.data.params.takeProfitPct, 60);
      assert.equal(updated.json.data.params.targetDelta, 0.2);
      assert.equal(updated.json.data.limits.maxNetDelta, null);
      assert.equal(updated.json.data.limits.maxOrdersPerDay, 10);

      // Otro usuario no la ve.
      repo.strategies[0].userId = 2;
      assert.equal((await call('GET', `/strategies/${s.id}`)).status, 404);
      repo.strategies[0].userId = USER;

      assert.equal((await call('DELETE', `/strategies/${s.id}`)).status, 200);
      assert.equal((await call('GET', `/strategies/${s.id}`)).status, 404);
    });
  } finally { restore(); }
});

test('PUT /:id/mode: live sin confirm → 400; pausa y sombra no la piden', async () => {
  const { repo, restore } = useFakeService();
  try {
    const s = await repo.createStrategy({ userId: USER, name: 'x', template: 'covered_call', underlying: 'ETH', mode: 'shadow' });
    await withServer(async (call) => {
      const noConfirm = await call('PUT', `/strategies/${s.id}/mode`, { mode: 'live' });
      assert.equal(noConfirm.status, 400);
      assert.equal(noConfirm.json.code, 'LIVE_CONFIRM_REQUIRED');
      assert.equal((await call('PUT', `/strategies/${s.id}/mode`, { mode: 'live', confirm: 'yes' })).status, 400);
      assert.equal(repo.strategies[0].mode, 'shadow');

      assert.equal((await call('PUT', `/strategies/${s.id}/mode`, { mode: 'paused' })).json.data.mode, 'paused');
      assert.equal((await call('PUT', `/strategies/${s.id}/mode`, { mode: 'turbo' })).status, 400);

      const live = await call('PUT', `/strategies/${s.id}/mode`, { mode: 'live', confirm: true });
      assert.equal(live.status, 200);
      assert.equal(live.json.data.mode, 'live');
    });
  } finally { restore(); }
});

test('PUT /:id/mode live exige credenciales y respeta maxLiveStrategies', async () => {
  const noCreds = useFakeService({ configured: false });
  try {
    const s = await noCreds.repo.createStrategy({ userId: USER, name: 'x', template: 'short_strangle', underlying: 'BTC', mode: 'shadow' });
    await withServer(async (call) => {
      const res = await call('PUT', `/strategies/${s.id}/mode`, { mode: 'live', confirm: true });
      assert.equal(res.status, 400);
      assert.equal(res.json.code, 'OPTIONS_CREDENTIALS_MISSING');
      assert.match(res.json.error || res.json.message || JSON.stringify(res.json), /API key de Binance Opciones/);
    });
  } finally { noCreds.restore(); }

  const capped = useFakeService({ maxLiveStrategies: 1 });
  try {
    await capped.repo.createStrategy({ userId: USER, name: 'ya real', template: 'short_strangle', underlying: 'BTC', mode: 'live' });
    const s = await capped.repo.createStrategy({ userId: USER, name: 'nueva', template: 'short_strangle', underlying: 'ETH', mode: 'shadow' });
    await withServer(async (call) => {
      const res = await call('PUT', `/strategies/${s.id}/mode`, { mode: 'live', confirm: true });
      assert.equal(res.status, 400);
      assert.equal(res.json.code, 'MAX_LIVE_STRATEGIES');
    });
  } finally { capped.restore(); }
});

test('DELETE con posiciones reales abiertas → 409', async () => {
  const { repo, restore } = useFakeService();
  try {
    const s = await repo.createStrategy({ userId: USER, name: 'x', template: 'short_strangle', underlying: 'BTC', mode: 'live' });
    await repo.insertPosition({ strategyId: s.id, userId: USER, mode: 'live', symbol: 'BTC-261016-70000-C', side: 'SELL', quantity: 0.01, entryPrice: 100, openedAt: 1 });
    await withServer(async (call) => {
      const res = await call('DELETE', `/strategies/${s.id}`);
      assert.equal(res.status, 409);
      assert.equal(repo.strategies.length, 1);
    });
  } finally { restore(); }
});

test('rutas de backtests: crea (202), lista y lee por usuario', async () => {
  const original = { ...backtestService };
  const seen = {};
  Object.assign(backtestService, {
    enqueue: async (userId, input) => { seen.enqueue = { userId, input }; return { id: 9, status: 'queued' }; },
    list: async (userId) => [{ id: 9, userId }],
    get: async (userId, id) => ({ id, userId, status: 'done', result: { metrics: {} } }),
  });
  try {
    await withServer(async (call) => {
      assert.equal((await call('POST', '/backtests', { underlying: 'BTC' })).status, 400);
      assert.equal((await call('POST', '/backtests', { template: 'short_strangle', source: 'magic' })).status, 400);
      const created = await call('POST', '/backtests', { template: 'short_strangle', underlying: 'BTC', source: 'realized', from: 1, to: '2026-09-01', spreadPct: 3 });
      assert.equal(created.status, 202);
      assert.deepEqual(created.json.data, { id: 9, status: 'queued' });
      assert.equal(seen.enqueue.userId, USER);
      assert.equal(seen.enqueue.input.spreadPct, 3);
      assert.equal((await call('GET', '/backtests')).json.data[0].userId, USER);
      const one = await call('GET', '/backtests/9');
      assert.equal(one.json.data.status, 'done');
      assert.equal((await call('GET', '/backtests/abc')).status, 400);
    });
  } finally { Object.assign(backtestService, original); }
});

test('kpisFor: closedTrades, avgPnlUsdt, maxDrawdownUsdt y longestLosingStreak por libro', () => {
  const { kpisFor } = strategiesService;
  const pos = (id, mode, closedAt, pnlUsdt) => ({ id, mode, openedAt: id, closedAt, pnlUsdt, feesUsdt: 0 });
  const positions = [
    // sombra: mismo closedAt 100 → desempata el id (1 antes que 2): +10, -5 ; luego -5, -3, +10, -5
    pos(2, 'shadow', 100, -5), pos(1, 'shadow', 100, 10), pos(3, 'shadow', 200, -5),
    pos(4, 'shadow', 300, -3), pos(5, 'shadow', 400, 10), pos(6, 'shadow', 500, -5),
    pos(7, 'shadow', 600, null), { ...pos(8, 'shadow', null, 0), closedAt: null },
    pos(9, 'live', 50, -2), pos(10, 'live', 60, 4),
  ];
  const s = kpisFor(positions, [], 'shadow', 1000);
  // acumulado: 10, 5, 0, -3, 7, 2 (la fila con pnl null no suma) → pico 10, mínimo -3
  assert.equal(s.closedTrades, 7);
  assert.equal(s.avgPnlUsdt, 0.33);
  assert.equal(s.maxDrawdownUsdt, 13);
  assert.equal(s.longestLosingStreak, 3);
  const l = kpisFor(positions, [], 'live', 1000);
  assert.deepEqual([l.closedTrades, l.avgPnlUsdt, l.maxDrawdownUsdt, l.longestLosingStreak], [2, 1, 2, 1]);
  const none = kpisFor([], [], 'live', 1000);
  assert.deepEqual([none.closedTrades, none.avgPnlUsdt, none.maxDrawdownUsdt, none.longestLosingStreak], [0, null, null, 0]);
});
