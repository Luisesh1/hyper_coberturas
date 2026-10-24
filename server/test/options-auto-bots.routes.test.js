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
        { id: 1, name: 'RSI sobreventa BTC', direction: 'bullish', assetList: ['BTCUSDT'], thresholdPercent: 70, coveredUnderlyings: ['BTC'] },
        { id: 2, name: 'Cruce bajista BTC/ETH', direction: 'bearish', assetList: ['ETHUSDT', 'BTCUSDT'], thresholdPercent: 60, coveredUnderlyings: ['BTC'] },
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
        id: repo.signals[0].id, alertId: 1, alertName: 'RSI sobreventa BTC', direction: 'bullish', asset: 'BTCUSDT', score: 80, decision: 'opened', detail: 'Sombra: compra', simulated: false, feesUsdt: null, feesEstimated: false, createdAt: 1,
      });

      const list = await call('GET', '/strategies');
      assert.deepEqual(list.json.data.map((s) => s.id), [strat.json.data.id]);
      const templatesRes = await call('GET', '/strategies/templates');
      assert.ok(!templatesRes.json.data.some((t) => t.id === 'alert_signal'));

      // Por /options/strategies no se crean bots ni se cambian sus alertas.
      assert.equal((await call('POST', '/strategies', { template: 'alert_signal', underlying: 'BTC' })).status, 400);
      assert.equal((await call('PUT', `/strategies/${bot.id}`, { underlying: 'ETH' })).status, 400);
      // El backtest de un bot repite los disparos de sus alertas: sin disparos en el rango, error explicado.
      const backtests = createOptionsBacktestService({ repo: {}, snapshotsRepo: {}, strategiesRepo: repo, alertsRepo: { async listAlertSignals() { return []; } } });
      await assert.rejects(backtests.enqueue(USER, { strategyId: bot.id }), /Las alertas de este bot no se dispararon entre/);
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
      assert.deepEqual(Object.keys(all.json.data[0]).sort(), ['alertId', 'alertName', 'asset', 'createdAt', 'decision', 'detail', 'direction', 'feesEstimated', 'feesUsdt', 'id', 'score', 'simulated']);
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

function fakeCloseRunner(result = { status: 'closed', produced: [] }) {
  const calls = [];
  return {
    calls,
    async runForSignal() { return { produced: [] }; },
    async closeManually(strategy, opts) {
      calls.push({ strategyId: strategy.id, ...opts });
      return typeof result === 'function' ? result(strategy, opts) : result;
    },
  };
}

function fakeLiveOrders({ orders = [], pendingClose = false } = {}) {
  const cancels = [];
  const pendingChecks = [];
  return {
    orders,
    cancels,
    pendingChecks,
    async listByStrategy(strategyId) { return orders.filter((o) => o.strategyId === strategyId); },
    async hasPendingClose(args) { pendingChecks.push(args); return pendingClose; },
    async requestCancel({ userId, strategyId, orderId }) {
      const o = orders.find((x) => x.id === orderId && x.userId === userId && x.strategyId === strategyId
        && x.status !== 'final' && x.purpose !== 'take_profit' && x.action === 'open');
      if (!o) return null;
      cancels.push(orderId);
      o.cancelRequested = true;
      return o;
    },
  };
}

test('POST /options/auto-bots/:id/close exige confirm, valida forma y es del usuario', async () => {
  const runner = fakeCloseRunner();
  const { repo, restore } = useFakeServices({ runner, liveOrders: fakeLiveOrders() });
  try {
    await withServer(async (call) => {
      const bot = (await call('POST', '/auto-bots', validBot)).json.data;
      const noConfirm = await call('POST', `/auto-bots/${bot.id}/close`, {});
      assert.equal(noConfirm.status, 400);
      assert.equal(noConfirm.json.code, 'CONFIRM_REQUIRED');
      assert.equal((await call('POST', `/auto-bots/${bot.id}/close`, { confirm: false })).json.code, 'CONFIRM_REQUIRED');
      assert.equal((await call('POST', `/auto-bots/${bot.id}/close`, { confirm: 'yes' })).json.code, 'CONFIRM_REQUIRED');
      assert.equal((await call('POST', `/auto-bots/${bot.id}/close`, { confirm: true, positionIds: ['a'] })).status, 400);
      assert.equal((await call('POST', `/auto-bots/${bot.id}/close`, { confirm: true, positionIds: [0] })).status, 400);
      assert.equal((await call('POST', `/auto-bots/${bot.id}/close`, { confirm: true, positionIds: [1.5] })).status, 400);

      const foreign = await repo.createStrategy({ userId: 2, name: 'ajeno', template: 'alert_signal', underlying: 'BTC', params: { alertIds: [1] }, mode: 'shadow' });
      assert.equal((await call('POST', `/auto-bots/${foreign.id}/close`, { confirm: true })).status, 404);
      const strat = await repo.createStrategy({ userId: USER, name: 's', template: 'short_strangle', underlying: 'BTC', mode: 'shadow' });
      assert.equal((await call('POST', `/auto-bots/${strat.id}/close`, { confirm: true })).status, 404);
      assert.equal(runner.calls.length, 0);
    });
  } finally { restore(); }
});

test('POST /options/auto-bots/:id/close usa el libro del modo actual y devuelve { status, detail }', async () => {
  const runner = fakeCloseRunner((strategy, { mode }) => (mode === 'shadow'
    ? { status: 'closed', produced: [{ mode: 'shadow', type: 'close', reason: 'manual', detail: 'Cierre manual', booked: true }] }
    : { status: 'not_submitted', produced: [{ mode: 'live', type: 'skip', reason: 'no_liquidity', detail: 'Sin precio para BTC-261023-70000-C' }] }));
  const liveOrders = fakeLiveOrders();
  const { repo, restore } = useFakeServices({ runner, liveOrders });
  try {
    await withServer(async (call) => {
      const bot = (await call('POST', '/auto-bots', validBot)).json.data;
      const shadow = await call('POST', `/auto-bots/${bot.id}/close`, { confirm: true });
      assert.equal(shadow.status, 200);
      assert.deepEqual(shadow.json.data, { status: 'closed', detail: 'Cierre manual' });
      assert.deepEqual(runner.calls[0], { strategyId: bot.id, mode: 'shadow', positionIds: undefined });
      assert.equal(liveOrders.pendingChecks.length, 0, 'en sombra no se consulta el libro real');

      await repo.setMode(USER, bot.id, 'live');
      const live = await call('POST', `/auto-bots/${bot.id}/close`, { confirm: true, positionIds: [41, 42] });
      assert.equal(live.status, 200);
      assert.equal(live.json.data.status, 'not_submitted');
      assert.match(live.json.data.detail, /Sin precio para BTC-261023-70000-C/);
      assert.deepEqual(runner.calls[1], { strategyId: bot.id, mode: 'live', positionIds: [41, 42] });
      assert.deepEqual(liveOrders.pendingChecks[0], { userId: USER, strategyId: bot.id, positionIds: [41, 42] });
    });
  } finally { restore(); }
});

test('POST /options/auto-bots/:id/close en Real con un cierre en curso responde 409 CLOSE_PENDING', async () => {
  const runner = fakeCloseRunner();
  const { repo, restore } = useFakeServices({ runner, liveOrders: fakeLiveOrders({ pendingClose: true }) });
  try {
    await withServer(async (call) => {
      const bot = (await call('POST', '/auto-bots', validBot)).json.data;
      await repo.setMode(USER, bot.id, 'live');
      const res = await call('POST', `/auto-bots/${bot.id}/close`, { confirm: true });
      assert.equal(res.status, 409);
      assert.equal(res.json.code, 'CLOSE_PENDING');
      assert.match(res.json.message || JSON.stringify(res.json), /cierre en curso/);
      assert.equal(runner.calls.length, 0, 'no llama a closeManually');
    });
  } finally { restore(); }
});

test('POST /options/auto-bots/:id/orders/:orderId/cancel solo cancela órdenes propias no finales y no TP', async () => {
  const liveOrders = fakeLiveOrders();
  const { repo, restore } = useFakeServices({ runner: fakeCloseRunner(), liveOrders });
  try {
    await withServer(async (call) => {
      const bot = (await call('POST', '/auto-bots', validBot)).json.data;
      const other = await repo.createStrategy({ userId: 2, name: 'ajeno', template: 'alert_signal', underlying: 'BTC', params: { alertIds: [1] }, mode: 'live' });
      liveOrders.orders.push(
        { id: 501, strategyId: bot.id, userId: USER, action: 'open', purpose: 'standard', status: 'active', cancelRequested: false },
        { id: 502, strategyId: bot.id, userId: USER, action: 'close', purpose: 'standard', status: 'final', cancelRequested: false },
        { id: 503, strategyId: bot.id, userId: USER, action: 'close', purpose: 'take_profit', status: 'active', cancelRequested: false },
        { id: 504, strategyId: other.id, userId: 2, action: 'open', purpose: 'standard', status: 'active', cancelRequested: false },
        { id: 505, strategyId: bot.id, userId: USER, action: 'close', purpose: 'standard', status: 'active', cancelRequested: false },
      );
      const exit = await call('POST', `/auto-bots/${bot.id}/orders/505/cancel`);
      assert.equal(exit.status, 409);
      assert.equal(exit.json.code, 'EXIT_NOT_CANCELLABLE');
      assert.match(JSON.stringify(exit.json), /salidas no se pueden cancelar/);
      assert.equal(liveOrders.orders.find((o) => o.id === 505).cancelRequested, false);
      const final = await call('POST', `/auto-bots/${bot.id}/orders/502/cancel`);
      assert.equal(final.status, 409);
      const tp = await call('POST', `/auto-bots/${bot.id}/orders/503/cancel`);
      assert.equal(tp.status, 409);
      assert.equal((await call('POST', `/auto-bots/${bot.id}/orders/504/cancel`)).status, 404);
      assert.equal((await call('POST', `/auto-bots/${bot.id}/orders/999/cancel`)).status, 404);
      assert.equal((await call('POST', `/auto-bots/${other.id}/orders/504/cancel`)).status, 404);
      assert.deepEqual(liveOrders.cancels, []);

      const ok = await call('POST', `/auto-bots/${bot.id}/orders/501/cancel`);
      assert.equal(ok.status, 200);
      assert.equal(ok.json.data.id, 501);
      assert.equal(ok.json.data.cancelRequested, true);
      assert.deepEqual(liveOrders.cancels, [501]);
    });
  } finally { restore(); }
});

test('POST /options/auto-bots/:id/simulate valida la dirección, simula en sombra y responde 429 / 409', async () => {
  const runner = fakeCloseRunner();
  const shadowOnlyFlags = [];
  runner.runForSignal = async (_s, _signal, opts) => { shadowOnlyFlags.push(opts?.shadowOnly); return { produced: [] }; };
  const { repo, restore } = useFakeServices({ runner, liveOrders: fakeLiveOrders() });
  try {
    await withServer(async (call) => {
      const bot = (await call('POST', '/auto-bots', validBot)).json.data;
      assert.equal((await call('POST', `/auto-bots/${bot.id}/simulate`, { direction: 'neutral' })).status, 400);
      assert.equal((await call('POST', `/auto-bots/${bot.id}/simulate`, {})).status, 400);
      const ok = await call('POST', `/auto-bots/${bot.id}/simulate`, { direction: 'bullish' });
      assert.equal(ok.status, 200);
      assert.deepEqual(Object.keys(ok.json.data).sort(), ['decision', 'detail']);
      assert.deepEqual(shadowOnlyFlags, [true]);
      const limited = await call('POST', `/auto-bots/${bot.id}/simulate`, { direction: 'bearish' });
      assert.equal(limited.status, 429);
      assert.equal(limited.json.code, 'SIMULATE_RATE_LIMIT');
      const signals = (await call('GET', `/auto-bots/${bot.id}/signals`)).json.data;
      assert.equal(signals[0].simulated, true);

      const paused = await repo.createStrategy({ userId: USER, name: 'p', template: 'alert_signal', underlying: 'BTC', params: { alertIds: [1] }, mode: 'paused' });
      const res = await call('POST', `/auto-bots/${paused.id}/simulate`, { direction: 'bullish' });
      assert.equal(res.status, 409);
      assert.equal(res.json.code, 'BOT_PAUSED');
    });
  } finally { restore(); }
});

test('POST /options/auto-bots/:id/clone copia en sombra aunque el original sea Real', async () => {
  const { repo, restore } = useFakeServices();
  try {
    await withServer(async (call) => {
      const created = await call('POST', '/auto-bots', { ...validBot, params: { ...validBot.params, notify: { trades: false, errors: true } }, limits: { maxOrdersPerDay: 3 } });
      const id = created.json.data.id;
      repo.strategies.find((s) => s.id === id).mode = 'live';
      const res = await call('POST', `/auto-bots/${id}/clone`);
      assert.equal(res.status, 201);
      const copy = res.json.data;
      assert.notEqual(copy.id, id);
      assert.equal(copy.mode, 'shadow');
      assert.equal(copy.name, 'Bot BTC (copia)');
      assert.equal(copy.underlying, 'BTC');
      assert.deepEqual(copy.params.alertIds, [1, 2]);
      assert.equal(copy.params.quantity, 0.02);
      assert.deepEqual(copy.params.notify, { trades: false, errors: true });
      assert.equal(copy.limits.maxOrdersPerDay, 3);
      assert.equal(repo.strategies.find((s) => s.id === id).mode, 'live');
      assert.equal((await call('POST', '/auto-bots/9999/clone')).status, 404);
      const bad = await call('POST', '/auto-bots', { ...validBot, params: { notify: { trades: 'x' } } });
      assert.equal(bad.status, 400);
    });
  } finally { restore(); }
});

test('bots multi-subyacente: alta, cobertura por alertas, eligible-alerts con lista y edición', async () => {
  const { repo, restore } = useFakeServices();
  try {
    await withServer(async (call) => {
      // ETH no lo cubre la alerta 1 (solo BTC).
      const uncovered = await call('POST', '/auto-bots', { ...validBot, underlying: undefined, underlyings: ['BTC', 'ETH'], alertIds: [1] });
      assert.equal(uncovered.status, 400);
      assert.match(uncovered.json.error?.message || JSON.stringify(uncovered.json), /Ninguna alerta vinculada cubre ETH/);
      // Una alerta que no vigila ninguno de los subyacentes.
      assert.match(JSON.stringify((await call('POST', '/auto-bots', { ...validBot, underlyings: ['BTC', 'ETH'], alertIds: [2, 5] })).json), /no vigila BTC ni ETH/);
      for (const bad of [['BTC', 'btc'], ['BTC', 'LUNA'], [], ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'BTC']]) {
        assert.equal((await call('POST', '/auto-bots', { ...validBot, underlyings: bad })).status, 400, JSON.stringify(bad));
      }
      assert.equal((await call('POST', '/auto-bots', { name: 'x', alertIds: [1] })).status, 400, 'sin subyacente');

      const created = await call('POST', '/auto-bots', { name: 'Multi', underlyings: ['btc', 'ETH'], alertIds: [1, 2] });
      assert.equal(created.status, 201);
      const bot = created.json.data;
      assert.equal(bot.underlying, 'BTC');
      assert.deepEqual(bot.params.underlyings, ['BTC', 'ETH']);
      assert.deepEqual(bot.underlyings, ['BTC', 'ETH']);

      // Un bot de un solo subyacente no guarda la lista.
      const single = (await call('POST', '/auto-bots', { ...validBot, alertIds: [1] })).json.data;
      assert.equal(single.params.underlyings, undefined);
      assert.deepEqual(single.underlyings, ['BTC']);

      const eligible = await call('GET', '/auto-bots/eligible-alerts?underlyings=BTC,ETH');
      assert.equal(eligible.status, 200);
      assert.deepEqual(eligible.json.data.map((a) => [a.id, a.coveredUnderlyings]), [[1, ['BTC']], [2, ['BTC', 'ETH']]]);
      assert.equal((await call('GET', '/auto-bots/eligible-alerts?underlyings=BTC,LUNA')).status, 400);

      // Edición: añadir ETH con solo la alerta 1 → 400; con 1 y 2 → ok.
      assert.equal((await call('PUT', `/auto-bots/${single.id}`, { underlyings: ['BTC', 'ETH'] })).status, 400);
      const edited = await call('PUT', `/auto-bots/${single.id}`, { underlyings: ['ETH', 'BTC'], alertIds: [1, 2] });
      assert.equal(edited.status, 200);
      assert.equal(edited.json.data.underlying, 'BTC', 'el subyacente actual sigue primero');
      assert.deepEqual(edited.json.data.params.underlyings, ['BTC', 'ETH']);
      // Por /options/strategies no se cambian los subyacentes de un bot.
      assert.equal((await call('PUT', `/strategies/${single.id}`, { params: { underlyings: ['ETH'] } })).status, 400);
      assert.equal(repo.strategies.length, 2);
    });
  } finally { restore(); }
});

test('POST /options/auto-bots/:id/simulate acepta un subyacente del bot', async () => {
  const seen = [];
  const runner = { async runForSignal(_s, signal) { seen.push(signal.underlying); return { produced: [] }; } };
  const { restore } = useFakeServices({ runner });
  try {
    await withServer(async (call) => {
      const bot = (await call('POST', '/auto-bots', { name: 'Multi', underlyings: ['BTC', 'ETH'], alertIds: [1, 2] })).json.data;
      assert.equal((await call('POST', `/auto-bots/${bot.id}/simulate`, { direction: 'bullish', underlying: 'SOL' })).status, 400);
      assert.equal((await call('POST', `/auto-bots/${bot.id}/simulate`, { direction: 'bullish', underlying: 'ETH' })).status, 200);
      assert.deepEqual(seen, ['ETH']);
    });
  } finally { restore(); }
});
