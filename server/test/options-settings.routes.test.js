const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || 'test-settings-key';

const app = require('../src/app');
const config = require('../src/config');
const authService = require('../src/services/auth.service');
const settingsRepository = require('../src/repositories/settings.repository');
const optionsCredentials = require('../src/services/options/options-credentials.service');

const API_KEY = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH1111222233334444';
const API_SECRET = 'SecretSecretSecretSecret1234567890abcdefABCDEF';

function token() {
  return jwt.sign({ userId: 1, username: 'tester', role: 'user' }, config.jwt.secret);
}

// Servidor con repositorio de settings en memoria (cifrado real).
async function withServer(fn) {
  const store = new Map();
  const originalRepo = { ...settingsRepository };
  settingsRepository.getByKey = async (userId, key) => {
    const value = store.get(`${userId}:${key}`);
    return value === undefined ? null : { value, updated_at: 1 };
  };
  settingsRepository.upsert = async (userId, key, value) => { store.set(`${userId}:${key}`, value); };
  settingsRepository.deleteByKey = async (userId, key) => { store.delete(`${userId}:${key}`); };

  const originalAuth = authService.validateSessionToken;
  authService.validateSessionToken = async () => ({ id: 1, userId: 1, username: 'tester', role: 'user', active: true });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { address, port } = server.address();
  const call = async (method, path, body) => {
    const res = await fetch(`http://${address}:${port}/api/settings${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  try {
    await fn(call, store);
  } finally {
    authService.validateSessionToken = originalAuth;
    Object.assign(settingsRepository, originalRepo);
    server.close();
  }
}

test('PUT/GET/DELETE /settings/binance-options nunca devuelven el secret', async () => {
  await withServer(async (call) => {
    let res = await call('GET', '/binance-options');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { configured: false, alias: '', apiKeyMasked: '' });

    res = await call('PUT', '/binance-options', { alias: 'Principal', apiKey: API_KEY, apiSecret: API_SECRET });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { configured: true, alias: 'Principal', apiKeyMasked: 'AAAA…4444' });
    assert.ok(!res.text.includes(API_SECRET));
    assert.ok(!res.text.includes(API_KEY));

    // Secret vacío: conserva el anterior.
    res = await call('PUT', '/binance-options', { alias: 'Otro', apiKey: API_KEY, apiSecret: '' });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.alias, 'Otro');

    res = await call('DELETE', '/binance-options');
    assert.equal(res.status, 200);
    assert.equal(res.json.data.configured, false);
    assert.equal((await call('GET', '/binance-options')).json.data.configured, false);
  });
});

test('PUT /settings/binance-options valida el cuerpo', async () => {
  await withServer(async (call) => {
    const cases = [
      {},
      { apiKey: API_KEY },
      { apiKey: 123, apiSecret: API_SECRET },
      { apiKey: 'corta', apiSecret: API_SECRET },
      { apiKey: API_KEY, apiSecret: 'secret con espacios y símbolos!!' },
      { alias: 'x'.repeat(61), apiKey: API_KEY, apiSecret: API_SECRET },
    ];
    for (const body of cases) {
      const res = await call('PUT', '/binance-options', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.json.code, 'VALIDATION_ERROR');
    }
  });
});

test('POST /settings/binance-options/test sin credenciales devuelve 400', async () => {
  await withServer(async (call) => {
    const res = await call('POST', '/binance-options/test');
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'BINANCE_OPTIONS_NOT_CONFIGURED');
  });
});

test('POST /settings/binance-options/test devuelve los checks', async () => {
  optionsCredentials.__setClientFactoryForTests(() => ({
    getAccount: async () => ({ asset: [{ asset: 'USDT', equity: '10' }] }),
    getApiRestrictions: async () => ({ ipRestrict: true, enableVanillaOptions: true, enableWithdrawals: true }),
  }));
  try {
    await withServer(async (call) => {
      await call('PUT', '/binance-options', { apiKey: API_KEY, apiSecret: API_SECRET });
      const res = await call('POST', '/binance-options/test');
      assert.equal(res.status, 200);
      const statuses = Object.fromEntries(res.json.data.checks.map((c) => [c.id, c.status]));
      assert.equal(statuses.ip_restriction, 'ok');
      assert.equal(statuses.withdrawals_disabled, 'warn');
    });
  } finally {
    optionsCredentials.__setClientFactoryForTests(null);
  }
});

test('GET/PUT /settings/options-limits con defaults y validación', async () => {
  await withServer(async (call, store) => {
    let res = await call('GET', '/options-limits');
    assert.deepEqual(res.json.data, { maxMarginUsdt: 5000, maxDailyLossUsdt: 500, maxLiveStrategies: 3, notifyTelegram: true });

    res = await call('PUT', '/options-limits', { maxLiveStrategies: 5, notifyTelegram: false });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.maxLiveStrategies, 5);
    assert.equal(res.json.data.notifyTelegram, false);
    // options_limits no es sensible: se guarda en JSON plano.
    assert.ok(store.get('1:options_limits').startsWith('{'));

    for (const body of [{ maxMarginUsdt: -1 }, { maxLiveStrategies: 2.5 }, { notifyTelegram: 1 }, [1, 2]]) {
      const bad = await call('PUT', '/options-limits', body);
      assert.equal(bad.status, 400, JSON.stringify(body));
    }
  });
});
