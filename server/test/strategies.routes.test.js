const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const config = require('../src/config');
const authService = require('../src/services/auth.service');
const strategiesService = require('../src/services/strategies.service');
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

test('POST /api/strategies/validate-draft responde el contrato de validación draft', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalValidateDraftStrategy = strategiesService.validateDraftStrategy;
  authService.validateSessionToken = async () => buildSessionUser();
  strategiesService.validateDraftStrategy = async (_userId, body) => ({
    asset: 'BTC',
    timeframe: body.timeframe || '15m',
    signal: { type: 'long' },
    diagnostics: { candles: 250 },
  });

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/strategies/validate-draft`, {
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
    assert.equal(json.data.signal.type, 'long');
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    strategiesService.validateDraftStrategy = originalValidateDraftStrategy;
    server.close();
  }
});

test('POST /api/strategies/:id/backtest delega al flujo unificado de backtesting', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalSimulateBacktest = backtestingService.simulateBacktest;
  authService.validateSessionToken = async () => buildSessionUser();
  backtestingService.simulateBacktest = async (_userId, body) => ({
    config: {
      strategyId: body.strategyId,
      strategyMode: body.draftStrategy ? 'draft' : 'saved',
      asset: 'BTC',
      timeframe: '15m',
    },
    metrics: { trades: 4, netPnl: 22 },
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
    const res = await fetch(`${baseUrl}/api/strategies/11/backtest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buildToken()}`,
      },
      body: JSON.stringify({
        draftStrategy: {
          name: 'Draft override',
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
    assert.equal(json.data.config.strategyId, 11);
    assert.equal(json.data.config.strategyMode, 'draft');
    assert.equal(json.data.metrics.trades, 4);
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    backtestingService.simulateBacktest = originalSimulateBacktest;
    server.close();
  }
});
