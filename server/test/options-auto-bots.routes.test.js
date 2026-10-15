const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const config = require('../src/config');
const authService = require('../src/services/auth.service');
const strategiesService = require('../src/services/options/options-strategies.service');
const autoTradingService = require('../src/services/options/options-auto-trading.service');
const { createOptionsBacktestService } = require('../src/services/options/options-backtest.service');
const { createOptionsStrategiesService } = strategiesService;
const { createOptionsAutoTradingService } = autoTradingService;
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

// Alertas del usuario 1 (A añade `direction`; sin él cuenta como neutral).
const ALERTS = [
  { id: 1, name: 'RSI sobreventa BTC', direction: 'bullish', assetList: ['BTCUSDT'], thresholdPercent: 70 },
  { id: 2, name: 'Cruce bajista BTC/ETH', direction: 'bearish', assetList: ['ETHUSDT', 'BTCUSDT'], thresholdPercent: 60 },
  { id: 3, name: 'Volumen BTC', direction: 'neutral', assetList: ['BTCUSDT'], thresholdPercent: 50 },
  { id: 4, name: 'Sin dirección', assetList: ['BTCUSDT'], thresholdPercent: 50 },
  { id: 5, name: 'RSI SOL', direction: 'bullish', assetList: ['SOLUSDT'], thresholdPercent: 70 },
];

const fakeCredentials = {
  async getClientForUser() { return { async placeOrder() { throw new Error('no se envían órdenes en tests'); } }; },
  async getLimits() { return { maxMarginUsdt: 1000, maxDailyLossUsdt: 100, maxLiveStrategies: 2, notifyTelegram: false }; },
};
const fakeMarket = {
  async getChain() { return { spot: 68000 }; },
  async getQuote() { return { delta: 0.3 }; },
};

function useFakeServices() {
  const repo = createFakeOptionsRepo();
  const origStrategies = { ...strategiesService };
  const origAuto = { ...autoTradingService };
  const strategies = createOptionsStrategiesService({ repo, credentials: fakeCredentials, market: fakeMarket });
  Object.assign(strategiesService, strategies);
  Object.assign(autoTradingService, createOptionsAutoTradingService({
    repo,
    strategies,
    alerts: { listAlerts: async (userId) => (userId === USER ? ALERTS : []) },
    runner: { async runForSignal() { return { produced: [] }; } },
  }));
  return {
    repo,
    restore: () => {
      Object.assign(strategiesService, origStrategies);
      Object.assign(autoTradingService, origAuto);
    },
  };
}

const validBot = { name: 'Bot BTC', underlying: 'BTC', alertIds: [1, 2], params: { structure: 'buy_with', quantity: 0.02 } };

test('POST /options/auto-bots crea en sombra y valida alertas, subyacente y forma', async () => {
  const { repo, restore } = useFakeServices();
  try {
    await withServer(async (call) => {
      const created = await call('POST', '/auto-bots', { ...validBot, limits: { maxOrdersPerDay: 3 } });
      assert.equal(created.status, 201);
      const bot = created.json.data;
      assert.equal(bot.template, 'alert_signal');
      assert.equal(bot.mode, 'shadow');
      assert.equal(bot.underlying, 'BTC');
      assert.deepEqual(bot.params.alertIds, [1, 2]);
      assert.equal(bot.params.quantity, 0.02);
      assert.equal(bot.params.targetDelta, 0.35);
      assert.equal(bot.limits.maxOrdersPerDay, 3);
      assert.deepEqual(bot.alerts.map((a) => [a.id, a.direction]), [[1, 'bullish'], [2, 'bearish']]);
      assert.deepEqual(bot.pnl30d, { shadow: 0, live: 0 });
      assert.equal(bot.status, 'waiting');
      assert.equal(bot.lastSignal, null);

      const bad = async (body, re) => {
        const res = await call('POST', '/auto-bots', body);
        assert.equal(res.status, 400, JSON.stringify(body));
        if (re) assert.match(JSON.stringify(res.json), re);
      };
      await bad({ ...validBot, alertIds: [3] }, /neutral/);
      await bad({ ...validBot, alertIds: [4] }, /neutral/);
      await bad({ ...validBot, alertIds: [5] }, /no vigila BTC/);
      await bad({ ...validBot, alertIds: [999] }, /no existe/);
      await bad({ ...validBot, alertIds: [] });
      await bad({ ...validBot, alertIds: ['a'] });
      await bad({ ...validBot, name: '' });
      await bad({ ...validBot, underlying: 'LUNA' }, /Subyacente/);
      await bad({ ...validBot, params: { structure: 'straddle' } }, /Estructura/);
      await bad({ ...validBot, params: { targetDelta: 3 } });
      await bad({ ...validBot, mode: 'live', alertIds: [3] });
      assert.equal(repo.strategies.length, 1);

      // ETH: la alerta 2 vigila ETHUSDT y BTCUSDT.
      assert.equal((await call('POST', '/auto-bots', { ...validBot, underlying: 'eth', alertIds: [2] })).status, 201);
    });
  } finally { restore(); }
});

test('GET /options/auto-bots/eligible-alerts filtra no neutrales del subyacente', async () => {
  const { restore } = useFakeServices();
  try {
    await withServer(async (call) => {
      const res = await call('GET', '/auto-bots/eligible-alerts?underlying=BTC');
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.data, [
        { id: 1, name: 'RSI sobreventa BTC', direction: 'bullish', assetList: ['BTCUSDT'], thresholdPercent: 70 },
        { id: 2, name: 'Cruce bajista BTC/ETH', direction: 'bearish', assetList: ['ETHUSDT', 'BTCUSDT'], thresholdPercent: 60 },
      ]);
      assert.deepEqual((await call('GET', '/auto-bots/eligible-alerts?underlying=sol')).json.data.map((a) => a.id), [5]);
      assert.equal((await call('GET', '/auto-bots/eligible-alerts')).status, 400);
      assert.equal((await call('GET', '/auto-bots/eligible-alerts?underlying=LUNA')).status, 400);
    });
  } finally { restore(); }
});

test('GET /options/auto-bots lista solo bots y GET /options/strategies los excluye', async () => {
  const { repo, restore } = useFakeServices();
  try {
    await withServer(async (call) => {
      const strat = await call('POST', '/strategies', { template: 'short_strangle', underlying: 'BTC' });
      assert.equal(strat.status, 201);
      const bot = (await call('POST', '/auto-bots', validBot)).json.data;
      await repo.claimAutoSignal({ strategyId: bot.id, userId: USER, alertId: 1, alertEventId: 9, alertName: 'RSI sobreventa BTC', direction: 'bullish', asset: 'BTCUSDT', score: 80, decision: 'opened', detail: 'Sombra: compra', createdAt: 1 });

      const bots = await call('GET', '/auto-bots');
      assert.equal(bots.status, 200);
      assert.deepEqual(bots.json.data.map((b) => b.id), [bot.id]);
      assert.deepEqual(bots.json.data[0].lastSignal, {
        id: repo.signals[0].id, alertId: 1, alertName: 'RSI sobreventa BTC', direction: 'bullish', asset: 'BTCUSDT', score: 80, decision: 'opened', detail: 'Sombra: compra', createdAt: 1,
      });

      const list = await call('GET', '/strategies');
      assert.deepEqual(list.json.data.map((s) => s.id), [strat.json.data.id]);
      const templatesRes = await call('GET', '/strategies/templates');
      assert.ok(!templatesRes.json.data.some((t) => t.id === 'alert_signal'));

      // Por /options/strategies no se crean bots ni se cambian sus alertas.
      assert.equal((await call('POST', '/strategies', { template: 'alert_signal', underlying: 'BTC' })).status, 400);
      assert.equal((await call('PUT', `/strategies/${bot.id}`, { underlying: 'ETH' })).status, 400);
      // Tampoco se backtestean.
      const backtests = createOptionsBacktestService({ repo: {}, snapshotsRepo: {}, strategiesRepo: repo });
      await assert.rejects(backtests.enqueue(USER, { strategyId: bot.id }), /no se pueden backtestear/);
    });
  } finally { restore(); }
});

test('PUT /options/auto-bots/:id valida alertas contra el subyacente del bot', async () => {
  const { repo, restore } = useFakeServices();
  try {
    await withServer(async (call) => {
      const bot = (await call('POST', '/auto-bots', validBot)).json.data;
      const ok = await call('PUT', `/auto-bots/${bot.id}`, { name: 'Renombrado', alertIds: [2], params: { onOpposite: 'close' } });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.data.name, 'Renombrado');
      assert.deepEqual(ok.json.data.params.alertIds, [2]);
      assert.equal(ok.json.data.params.onOpposite, 'close');
      assert.equal(ok.json.data.params.quantity, 0.02);

      assert.equal((await call('PUT', `/auto-bots/${bot.id}`, { alertIds: [5] })).status, 400);
      assert.equal((await call('PUT', `/auto-bots/${bot.id}`, { alertIds: [3] })).status, 400);
      assert.equal((await call('PUT', `/auto-bots/${bot.id}`, { params: { alertIds: [3] } })).status, 400);
      assert.equal((await call('PUT', `/auto-bots/${bot.id}`, { name: '' })).status, 400);
      assert.equal((await call('PUT', `/auto-bots/${bot.id}`, { params: { onOpposite: 'flip' } })).status, 400);
      assert.equal((await call('PUT', '/auto-bots/999', { name: 'x' })).status, 404);

      // Una estrategia normal no es un bot.
      const strat = await repo.createStrategy({ userId: USER, name: 's', template: 'short_strangle', underlying: 'BTC', mode: 'shadow' });
      assert.equal((await call('PUT', `/auto-bots/${strat.id}`, { name: 'x' })).status, 404);
      assert.deepEqual(repo.strategies.find((s) => s.id === bot.id).params.alertIds, [2]);
    });
  } finally { restore(); }
});

test('GET /options/auto-bots/:id/signals con filtro y límite', async () => {
  const { repo, restore } = useFakeServices();
  try {
    await withServer(async (call) => {
      const bot = (await call('POST', '/auto-bots', validBot)).json.data;
      const decisions = ['opened', 'ignored', 'closed', 'error', 'reversed', 'ignored'];
      for (const [i, decision] of decisions.entries()) {
        await repo.claimAutoSignal({ strategyId: bot.id, userId: USER, alertId: 1, alertEventId: 100 + i, alertName: 'RSI', direction: 'bullish', asset: 'BTCUSDT', score: 75, decision, detail: decision, createdAt: 1000 + i });
      }
      const all = await call('GET', `/auto-bots/${bot.id}/signals`);
      assert.equal(all.status, 200);
      assert.equal(all.json.data.length, 6);
      assert.equal(all.json.data[0].createdAt, 1005, 'más reciente primero');
      assert.deepEqual(Object.keys(all.json.data[0]).sort(), ['alertId', 'alertName', 'asset', 'createdAt', 'decision', 'detail', 'direction', 'id', 'score']);
      assert.deepEqual((await call('GET', `/auto-bots/${bot.id}/signals?filter=traded`)).json.data.map((s) => s.decision), ['reversed', 'closed', 'opened']);
      assert.deepEqual((await call('GET', `/auto-bots/${bot.id}/signals?filter=ignored`)).json.data.map((s) => s.decision), ['ignored', 'ignored']);
      assert.equal((await call('GET', `/auto-bots/${bot.id}/signals?limit=2`)).json.data.length, 2);
      assert.equal((await call('GET', `/auto-bots/${bot.id}/signals?filter=bogus`)).status, 400);
      assert.equal((await call('GET', `/auto-bots/${bot.id}/signals?limit=0`)).status, 400);
      assert.equal((await call('GET', '/auto-bots/999/signals')).status, 404);
    });
  } finally { restore(); }
});

test('detalle, modo y borrado de un bot van por /options/strategies/:id', async () => {
  const { repo, restore } = useFakeServices();
  try {
    await withServer(async (call) => {
      const bot = (await call('POST', '/auto-bots', validBot)).json.data;
      const detail = await call('GET', `/strategies/${bot.id}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.json.data.template, 'alert_signal');
      assert.ok(detail.json.data.kpis.shadow);
      assert.equal(detail.json.data.usage.mode, 'shadow');

      // Nombre y límites sí se editan por /strategies.
      assert.equal((await call('PUT', `/strategies/${bot.id}`, { name: 'Otro', limits: { maxNetDelta: 2 } })).status, 200);

      assert.equal((await call('PUT', `/strategies/${bot.id}/mode`, { mode: 'live' })).json.code, 'LIVE_CONFIRM_REQUIRED');
      assert.equal((await call('PUT', `/strategies/${bot.id}/mode`, { mode: 'paused' })).json.data.mode, 'paused');
      const live = await call('PUT', `/strategies/${bot.id}/mode`, { mode: 'live', confirm: true });
      assert.equal(live.status, 200);
      assert.equal(live.json.data.mode, 'live');

      await repo.insertPosition({ strategyId: bot.id, userId: USER, mode: 'live', symbol: 'BTC-261023-70000-C', side: 'BUY', quantity: 0.01, entryPrice: 100, openedAt: 1 });
      assert.equal((await call('DELETE', `/strategies/${bot.id}`)).status, 409);
      await repo.closePosition(repo.positions[0].id, { exitPrice: 120, closedAt: 2, pnlUsdt: 0.2, feesUsdt: 0 });
      assert.equal((await call('DELETE', `/strategies/${bot.id}`)).status, 200);
      assert.deepEqual((await call('GET', '/auto-bots')).json.data, []);
    });
  } finally { restore(); }
});
