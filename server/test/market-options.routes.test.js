const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || 'test-settings-key';

const app = require('../src/app');
const config = require('../src/config');
const authService = require('../src/services/auth.service');
const optionsModule = require('../src/services/deribit/deribit-options.service');

function token() {
  return jwt.sign({ userId: 1, username: 'tester', role: 'user' }, config.jwt.secret);
}

async function withServer(fn) {
  const originalAuth = authService.validateSessionToken;
  authService.validateSessionToken = async () => ({ id: 1, userId: 1, username: 'tester', role: 'user', active: true });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { address, port } = server.address();
  const call = async (method, path) => {
    const res = await fetch(`http://${address}:${port}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token()}` },
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

// Sustituye el servicio real por uno falso que registra las llamadas.
async function withFakeService(fn) {
  const original = optionsModule.deribitOptionsService;
  const calls = [];
  optionsModule.deribitOptionsService = {
    async listExpiries(...a) { calls.push(['listExpiries', ...a]); return [{ code: '10OCT26' }]; },
    async getStrikesJob(...a) { calls.push(['getStrikesJob', ...a]); return { status: 'done', strikes: [1] }; },
    async getCandles(...a) { calls.push(['getCandles', ...a]); return [{ time: 1, close: 2 }]; },
  };
  try {
    await withServer((call) => fn(call, calls));
  } finally {
    optionsModule.deribitOptionsService = original;
  }
}

test('expiries devuelve lo del servicio y pasa el subyacente en mayusculas', async () => {
  await withFakeService(async (call, calls) => {
    const r = await call('GET', '/market/options/expiries?underlying=eth');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { success: true, data: [{ code: '10OCT26' }] });
    assert.deepEqual(calls[0], ['listExpiries', 'ETH']);
  });
});

test('strikes devuelve lo del servicio, con retry opcional', async () => {
  await withFakeService(async (call, calls) => {
    const r = await call('GET', '/market/options/strikes?underlying=ETH&expiry=10oct26');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { success: true, data: { status: 'done', strikes: [1] } });
    assert.deepEqual(calls[0], ['getStrikesJob', 'ETH', '10OCT26', { retry: false }]);
    await call('GET', '/market/options/strikes?underlying=ETH&expiry=10OCT26&retry=1');
    assert.deepEqual(calls[1], ['getStrikesJob', 'ETH', '10OCT26', { retry: true }]);
  });
});

test('candles devuelve lo del servicio y aplica rango por defecto', async () => {
  await withFakeService(async (call, calls) => {
    const r = await call('GET', '/market/options/candles?instrument=ETH-31OCT25-4000-C&timeframe=1h&startTime=1000&endTime=5000');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { success: true, data: [{ time: 1, close: 2 }] });
    assert.deepEqual(calls[0], ['getCandles', { instrument: 'ETH-31OCT25-4000-C', timeframe: '1h', startMs: 1000, endMs: 5000 }]);
    await call('GET', '/market/options/candles?instrument=ETH-31OCT25-4000-C');
    const { startMs, endMs, timeframe } = calls[1][1];
    assert.equal(timeframe, '15m');
    assert.equal(endMs - startMs, 30 * 24 * 3600 * 1000);
  });
});

test('subyacente invalido o instrumento invalido dan 400', async () => {
  await withFakeService(async (call, calls) => {
    assert.equal((await call('GET', '/market/options/expiries?underlying=BNB')).status, 400);
    assert.equal((await call('GET', '/market/options/strikes?underlying=BNB&expiry=10OCT26')).status, 400);
    assert.equal((await call('GET', '/market/options/strikes?underlying=ETH')).status, 400);
    assert.equal((await call('GET', '/market/options/candles?instrument=foo')).status, 400);
    assert.equal(calls.length, 0);
  });
});
