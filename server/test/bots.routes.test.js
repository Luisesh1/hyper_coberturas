const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const config = require('../src/config');
const authService = require('../src/services/auth.service');
const botsService = require('../src/services/bots.service');
const botRegistry = require('../src/services/bot.registry');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

function buildToken(payload = {}) {
  return jwt.sign({
    userId: 1,
    username: 'tester',
    role: 'user',
    ...payload,
  }, config.jwt.secret);
}

function buildSessionUser(overrides = {}) {
  return {
    id: 1,
    userId: 1,
    username: 'tester',
    name: 'Tester',
    role: 'user',
    active: true,
    createdAt: 1710000000000,
    updatedAt: 1710000000000,
    ...overrides,
  };
}

function buildBot(overrides = {}) {
  return {
    id: 21,
    strategyId: 11,
    strategyName: 'Trend Rider',
    accountId: 8,
    account: {
      id: 8,
      alias: 'Cuenta Alpha',
      address: '0x00000000000000000000000000000000000000AA',
      shortAddress: '0x0000...00AA',
    },
    asset: 'BTC',
    timeframe: '15m',
    params: { fastPeriod: 9 },
    leverage: 10,
    marginMode: 'cross',
    size: 100,
    stopLossPct: 1.5,
    takeProfitPct: 3,
    status: 'active',
    lastSignal: { type: 'hold' },
    lastError: null,
    lastEvaluatedAt: 1710000000000,
    lastCandleAt: 1710000000000,
    runtime: {
      state: 'retrying',
      consecutiveFailures: 2,
      nextRetryAt: 1710000900000,
      lastRecoveryAt: 1710000600000,
      lastRecoveryAction: 'market_data_failed',
      systemPauseReason: null,
      context: { stage: 'market_data' },
    },
    createdAt: 1710000000000,
    updatedAt: 1710000600000,
    ...overrides,
  };
}

test('GET /api/bots requiere autenticacion', async () => {
  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/bots`);
    const json = await res.json();

    assert.equal(res.status, 401);
    assert.match(json.error, /token requerido/i);
  } finally {
    server.close();
  }
});

test('GET /api/bots devuelve runtime persistido en lista y detalle', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalListBots = botsService.listBots;
  const originalGetBot = botsService.getBot;
  authService.validateSessionToken = async () => buildSessionUser();
  botsService.listBots = async () => [buildBot()];
  botsService.getBot = async () => buildBot();

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const [listRes, detailRes] = await Promise.all([
      fetch(`${baseUrl}/api/bots`, {
        headers: { Authorization: `Bearer ${buildToken()}` },
      }),
      fetch(`${baseUrl}/api/bots/21`, {
        headers: { Authorization: `Bearer ${buildToken()}` },
      }),
    ]);
    const listJson = await listRes.json();
    const detailJson = await detailRes.json();

    assert.equal(listRes.status, 200);
    assert.equal(listJson.data[0].runtime.state, 'retrying');
    assert.equal(listJson.data[0].runtime.consecutiveFailures, 2);
    assert.equal(detailJson.data.runtime.lastRecoveryAction, 'market_data_failed');
    assert.deepEqual(detailJson.data.runtime.context, { stage: 'market_data' });
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    botsService.listBots = originalListBots;
    botsService.getBot = originalGetBot;
    server.close();
  }
});

test('GET /api/bots/:id/runs devuelve historial con fecha y detalles estructurados', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalListBotRuns = botsService.listBotRuns;
  const originalGetBot = botsService.getBot;
  authService.validateSessionToken = async () => buildSessionUser();
  botsService.getBot = async () => buildBot();
  botsService.listBotRuns = async () => [{
    id: 1,
    botId: 21,
    status: 'error',
    action: 'market_data_failed',
    signal: null,
    candleTime: null,
    price: null,
    details: {
      stage: 'market_data',
      message: 'Sin velas',
      actionTaken: 'Reintento programado',
      nextRetryAt: 1710000900000,
    },
    createdAt: 1710000300000,
  }];

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/bots/21/runs`, {
      headers: { Authorization: `Bearer ${buildToken()}` },
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].action, 'market_data_failed');
    assert.equal(json.data[0].details.actionTaken, 'Reintento programado');
    assert.equal(json.data[0].createdAt, 1710000300000);
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    botsService.listBotRuns = originalListBotRuns;
    botsService.getBot = originalGetBot;
    server.close();
  }
});

test('POST /api/bots/:id/activate usa el registry y devuelve el bot actualizado', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalActivate = botRegistry.activate;
  const originalGetBot = botsService.getBot;
  let activatedBotId = null;

  authService.validateSessionToken = async () => buildSessionUser();
  botRegistry.activate = async (_userId, botId) => {
    activatedBotId = botId;
  };
  botsService.getBot = async () => buildBot({ status: 'active', runtime: { ...buildBot().runtime, state: 'healthy', consecutiveFailures: 0 } });

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/bots/21/activate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${buildToken()}` },
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(activatedBotId, 21);
    assert.equal(json.data.status, 'active');
    assert.equal(json.data.runtime.state, 'healthy');
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    botRegistry.activate = originalActivate;
    botsService.getBot = originalGetBot;
    server.close();
  }
});
