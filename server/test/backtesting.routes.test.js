const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const config = require('../src/config');
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
  const originalSimulateBacktest = backtestingService.simulateBacktest;
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
    backtestingService.simulateBacktest = originalSimulateBacktest;
    server.close();
  }
});
