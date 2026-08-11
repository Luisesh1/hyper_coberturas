const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const config = require('../src/config');
const authService = require('../src/services/auth.service');
const backtestingService = require('../src/services/backtesting.service');

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

test('POST /api/backtesting/simulate requiere autenticacion', async () => {
  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/backtesting/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategyId: 11 }),
    });
    const json = await res.json();

    assert.equal(res.status, 401);
    assert.match(json.error, /token requerido/i);
  } finally {
    server.close();
  }
});

test('POST /api/backtesting/simulate responde data para usuario autenticado', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalSimulateBacktest = backtestingService.simulateBacktest;
  authService.validateSessionToken = async () => buildSessionUser();
  backtestingService.simulateBacktest = async (userId, body) => ({
    config: { strategyId: body.strategyId, asset: 'BTC', timeframe: '15m' },
    metrics: { trades: 1 },
    candles: [],
    trades: [],
    signals: [],
    positionSegments: [],
    equitySeries: [],
    drawdownSeries: [],
    overlays: [],
    assumptions: {},
    userId,
  });

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/backtesting/simulate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buildToken()}`,
      },
      body: JSON.stringify({ strategyId: 11 }),
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.config.strategyId, 11);
    assert.equal(json.data.userId, 1);
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    backtestingService.simulateBacktest = originalSimulateBacktest;
    server.close();
  }
});

test('POST /api/backtesting/simulate acepta draftStrategy sin strategyId', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalSimulateBacktest = backtestingService.simulateBacktest;
  authService.validateSessionToken = async () => buildSessionUser();
  backtestingService.simulateBacktest = async (_userId, body) => ({
    config: {
      strategyId: null,
      strategyName: body.draftStrategy?.name || 'Draft Alpha',
      strategyMode: 'draft',
      asset: 'BTC',
      timeframe: '15m',
    },
    metrics: { trades: 1 },
    candles: [],
    trades: [],
    signals: [],
    positionSegments: [],
    equitySeries: [],
    drawdownSeries: [],
    overlays: [],
    assumptions: {},
    benchmarks: {},
  });

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/backtesting/simulate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buildToken()}`,
      },
      body: JSON.stringify({
        draftStrategy: {
          name: 'Draft Alpha',
          assetUniverse: ['BTC'],
          timeframe: '15m',
          defaultParams: {},
          scriptSource: 'module.exports.evaluate = async () => signal.hold();',
        },
      }),
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.config.strategyMode, 'draft');
    assert.equal(json.data.config.strategyId, null);
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    backtestingService.simulateBacktest = originalSimulateBacktest;
    server.close();
  }
});

test('POST /api/backtesting/run ejecuta una sola vez y devuelve el mismo job completado', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalSimulateBacktest = backtestingService.simulateBacktest;
  let executions = 0;
  authService.validateSessionToken = async () => buildSessionUser();
  backtestingService.simulateBacktest = async () => {
    executions += 1;
    return { metrics: { trades: 4 }, config: { strategyId: 11 } };
  };

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/backtesting/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buildToken()}`,
      },
      body: JSON.stringify({ strategyId: 11, asset: 'BTC', timeframe: '15m' }),
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.data.status, 'completed');
    assert.equal(json.data.result.metrics.trades, 4);
    assert.equal(executions, 1);
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    backtestingService.simulateBacktest = originalSimulateBacktest;
    server.close();
  }
});
