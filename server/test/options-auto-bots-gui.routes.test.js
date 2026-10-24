// Aparte de options-auto-bots.routes.test.js: el limitador global (100/min) no deja más peticiones en un mismo proceso.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const config = require('../src/config');
const authService = require('../src/services/auth.service');
const strategiesService = require('../src/services/options/options-strategies.service');
const autoTradingService = require('../src/services/options/options-auto-trading.service');
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

function useFakeServices({ runner = null, liveOrders = null, shadowEntries = null } = {}) {
  const repo = createFakeOptionsRepo();
  const origStrategies = { ...strategiesService };
  const origAuto = { ...autoTradingService };
  const strategies = createOptionsStrategiesService({ repo, credentials: fakeCredentials, market: fakeMarket, ...(shadowEntries ? { shadowEntries } : {}) });
  Object.assign(strategiesService, strategies);
  Object.assign(autoTradingService, createOptionsAutoTradingService({
    repo,
    strategies,
    alerts: { listAlerts: async (userId) => (userId === USER ? ALERTS : []) },
    runner: runner || { async runForSignal() { return { produced: [] }; } },
    ...(liveOrders ? { liveOrders } : {}),
    ...(shadowEntries ? { shadowEntries } : {}),
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

test('GET /:id trae pendingEntries sombra con deadlineAt y bid/ask; GET lista trae pnlSeries, feesUsdt, pendingEntry y blocked', async () => {
  const deadlineAt = Date.now() + 5 * 60_000;
  const shadowEntries = { async listPending() {
    return [{ id: 7, strategyId: null, symbol: 'BTC-261031-70000-C', side: 'BUY', optionType: 'CALL', quantity: 0.1, limitPrice: 100, spot: 68000, deadlineAt, status: 'pending' }];
  } };
  const { restore } = useFakeServices({ shadowEntries });
  try {
    await withServer(async (call) => {
      const bot = (await call('POST', '/auto-bots', validBot)).json.data;
      const detail = (await call('GET', `/strategies/${bot.id}`)).json.data;
      assert.equal(detail.pendingEntries.length, 1);
      const e = detail.pendingEntries[0];
      assert.equal(e.deadlineAt, deadlineAt);
      assert.equal(e.mode, 'shadow');
      assert.equal(e.limitPrice, 100);
      assert.equal(e.executedQty, 0);
      assert.ok(e.feesEstUsdt > 0);
      assert.deepEqual(detail.blockedUnderlyings, {});
      const listed = (await call('GET', '/auto-bots')).json.data[0];
      assert.equal(listed.pnlSeries.length, 30);
      assert.equal(listed.feesUsdt, 0);
      assert.deepEqual(listed.pendingEntry, { deadlineAt });
      assert.equal(listed.blocked, false);
    });
  } finally { restore(); }
});

test('POST /:id/unblock limpia el bloqueo y da 400 con un subyacente ajeno al bot, 404 sin bot', async () => {
  const { repo, restore } = useFakeServices();
  try {
    await withServer(async (call) => {
      const bot = (await call('POST', '/auto-bots', validBot)).json.data;
      repo.strategies.find((s) => s.id === bot.id).state = { blockedUnderlyings: { BTC: { reason: 'x', at: 1 } } };
      assert.equal((await call('GET', '/auto-bots')).json.data[0].blocked, true);
      assert.equal((await call('POST', `/auto-bots/${bot.id}/unblock`, { underlying: 'ETH' })).status, 400);
      assert.equal((await call('POST', `/auto-bots/${bot.id}/unblock`, {})).status, 400);
      const ok = await call('POST', `/auto-bots/${bot.id}/unblock`, { underlying: 'btc' });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.data.blocked, false);
      assert.deepEqual(repo.strategies.find((s) => s.id === bot.id).state.blockedUnderlyings, {});
      assert.equal((await call('POST', '/auto-bots/999/unblock', { underlying: 'BTC' })).status, 404);
    });
  } finally { restore(); }
});

test('GET /:id/signals trae feesUsdt y feesEstimated', async () => {
  const { repo, restore } = useFakeServices();
  try {
    await withServer(async (call) => {
      const bot = (await call('POST', '/auto-bots', validBot)).json.data;
      const s = await repo.claimAutoSignal({ strategyId: bot.id, userId: USER, alertId: 1, alertEventId: 5, alertName: 'RSI', direction: 'bullish', asset: 'BTCUSDT', score: 75, decision: 'opened', detail: 'x', createdAt: 5 });
      await repo.resolveAutoSignal(s.id, { decision: 'opened', detail: 'x', feesUsdt: 1.25, feesEstimated: true });
      const sig = (await call('GET', `/auto-bots/${bot.id}/signals`)).json.data[0];
      assert.equal(sig.feesUsdt, 1.25);
      assert.equal(sig.feesEstimated, true);
    });
  } finally { restore(); }
});
