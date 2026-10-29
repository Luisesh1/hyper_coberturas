const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const config = require('../src/config');
const authService = require('../src/services/auth.service');
const autoTradingService = require('../src/services/options/options-auto-trading.service');
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

test('GET /options/auto-bots/:id/exit-simulation responde la rejilla y valida mode', async () => {
  const repo = createFakeOptionsRepo();
  const premiumSamples = { listPremiumSamples: async () => new Map() };
  const origAuto = { ...autoTradingService };
  Object.assign(autoTradingService, createOptionsAutoTradingService({ repo, premiumSamples, alerts: { listAlerts: async () => [] } }));
  try {
    const id = (await repo.createStrategy({ userId: USER, name: 'Bot BTC', template: 'alert_signal', underlying: 'BTC', mode: 'shadow' })).id;
    await withServer(async (call) => {
      const res = await call('GET', `/auto-bots/${id}/exit-simulation?mode=shadow&since=1000`);
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.data.mode, 'shadow');
      assert.equal(res.json.data.since, 1000);
      assert.equal(res.json.data.scenarios.length, 216);
      assert.equal((await call('GET', `/auto-bots/${id}/exit-simulation?mode=foo`)).status, 400);
      assert.equal((await call('GET', '/auto-bots/9999/exit-simulation')).status, 404);
    });
  } finally { Object.assign(autoTradingService, origAuto); }
});
