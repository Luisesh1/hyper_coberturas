const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || 'test-settings-key';

const settingsService = require('../src/services/settings.service');
const settingsRepository = require('../src/repositories/settings.repository');
const credentials = require('../src/services/options/options-credentials.service');

const API_KEY = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH1111222233334444';
const API_SECRET = 'SecretSecretSecretSecret1234567890abcdefABCDEF';

// Repositorio en memoria: ejercita el cifrado real de settings.service.
function withMemoryRepo(fn) {
  const store = new Map();
  const original = { ...settingsRepository };
  settingsRepository.getByKey = async (userId, key) => {
    const value = store.get(`${userId}:${key}`);
    return value === undefined ? null : { value, updated_at: 1 };
  };
  settingsRepository.upsert = async (userId, key, value) => { store.set(`${userId}:${key}`, value); };
  settingsRepository.deleteByKey = async (userId, key) => { store.delete(`${userId}:${key}`); };
  return Promise.resolve()
    .then(() => fn(store))
    .finally(() => Object.assign(settingsRepository, original));
}

test('binance_options es una clave sensible y options_limits no', () => {
  assert.ok(settingsService.SENSITIVE_KEYS.has('binance_options'));
  assert.ok(!settingsService.SENSITIVE_KEYS.has('options_limits'));
});

test('set guarda cifrado y get solo devuelve la key enmascarada', () => withMemoryRepo(async (store) => {
  const saved = await credentials.set(1, { alias: 'Mi cuenta', apiKey: API_KEY, apiSecret: API_SECRET });
  assert.deepEqual(saved, { configured: true, alias: 'Mi cuenta', apiKeyMasked: 'AAAA…4444' });

  const raw = store.get('1:binance_options');
  assert.ok(raw.startsWith(settingsService.ENCRYPTED_PREFIX));
  assert.ok(!raw.includes(API_KEY));
  assert.ok(!raw.includes(API_SECRET));

  const got = await credentials.get(1);
  assert.equal(JSON.stringify(got).includes(API_SECRET), false);
  assert.equal(JSON.stringify(got).includes(API_KEY), false);
}));

test('un secret vacío conserva el anterior; una key nueva exige su secret', () => withMemoryRepo(async () => {
  await credentials.set(1, { alias: 'A', apiKey: API_KEY, apiSecret: API_SECRET });
  await credentials.set(1, { alias: 'Renombrada', apiKey: API_KEY, apiSecret: '' });
  const stored = await settingsService.getBinanceOptions(1);
  assert.equal(stored.apiSecret, API_SECRET);
  assert.equal(stored.alias, 'Renombrada');

  // key vacía + secret vacío = solo cambia el alias
  await credentials.set(1, { alias: 'Otra', apiKey: '', apiSecret: '' });
  assert.equal((await settingsService.getBinanceOptions(1)).apiKey, API_KEY);

  await assert.rejects(
    () => credentials.set(1, { apiKey: 'ZZZZYYYYXXXXWWWWVVVV0000', apiSecret: '' }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
}));

test('set valida key y secret en el primer alta', () => withMemoryRepo(async () => {
  await assert.rejects(() => credentials.set(1, { apiKey: '', apiSecret: API_SECRET }), /apiKey es requerida/);
  await assert.rejects(() => credentials.set(1, { apiKey: API_KEY, apiSecret: '' }), /apiSecret es requerido/);
  await assert.rejects(() => credentials.set(1, { apiKey: 'con espacios y $$', apiSecret: API_SECRET }), /formato inválido/);
}));

test('remove borra las credenciales y getClientForUser falla sin ellas', () => withMemoryRepo(async () => {
  await credentials.set(1, { apiKey: API_KEY, apiSecret: API_SECRET });
  const removed = await credentials.remove(1);
  assert.equal(removed.configured, false);
  assert.equal((await credentials.get(1)).configured, false);
  await assert.rejects(() => credentials.getClientForUser(1), (err) => err.code === 'BINANCE_OPTIONS_NOT_CONFIGURED' && err.status === 400);
}));

test('getLimits devuelve defaults y setLimits valida y mezcla', () => withMemoryRepo(async () => {
  assert.deepEqual(await credentials.getLimits(1), {
    maxMarginUsdt: 5000, maxDailyLossUsdt: 500, maxLiveStrategies: 3, notifyTelegram: true,
  });
  const next = await credentials.setLimits(1, { maxMarginUsdt: 1000, notifyTelegram: false });
  assert.deepEqual(next, { maxMarginUsdt: 1000, maxDailyLossUsdt: 500, maxLiveStrategies: 3, notifyTelegram: false });
  assert.deepEqual(await credentials.getLimits(1), next);
  await assert.rejects(() => credentials.setLimits(1, { maxDailyLossUsdt: -1 }), (err) => err.status === 400);
  await assert.rejects(() => credentials.setLimits(1, { maxLiveStrategies: 1.5 }), (err) => err.status === 400);
  await assert.rejects(() => credentials.setLimits(1, { notifyTelegram: 'si' }), (err) => err.status === 400);
}));

test('test() reporta firma, cuenta, permisos, IP y retiros', () => withMemoryRepo(async () => {
  await credentials.set(1, { apiKey: API_KEY, apiSecret: API_SECRET });
  credentials.__setClientFactoryForTests(() => ({
    getAccount: async () => ({ asset: [{ asset: 'USDT', equity: '1234.5' }] }),
    getApiRestrictions: async () => ({ ipRestrict: false, enableVanillaOptions: true, enableWithdrawals: false }),
  }));
  try {
    const { checks } = await credentials.test(1);
    const byId = Object.fromEntries(checks.map((c) => [c.id, c.status]));
    assert.deepEqual(byId, {
      signature: 'ok',
      options_account: 'ok',
      trading_permission: 'ok',
      ip_restriction: 'warn',
      withdrawals_disabled: 'ok',
    });
  } finally {
    credentials.__setClientFactoryForTests(null);
  }
}));

test('test() marca fail con credenciales rechazadas y warn sin apiRestrictions', () => withMemoryRepo(async () => {
  await credentials.set(1, { apiKey: API_KEY, apiSecret: API_SECRET });
  const authErr = Object.assign(new Error('Binance Opciones rechazó las credenciales: Invalid API-key'), { code: 'BINANCE_OPTIONS_AUTH_ERROR' });
  credentials.__setClientFactoryForTests(() => ({
    getAccount: async () => { throw authErr; },
    getApiRestrictions: async () => { throw new Error('sin acceso'); },
  }));
  try {
    const { checks } = await credentials.test(1);
    const byId = Object.fromEntries(checks.map((c) => [c.id, c.status]));
    assert.equal(byId.signature, 'fail');
    assert.equal(byId.options_account, 'fail');
    assert.equal(byId.trading_permission, 'warn');
    assert.equal(byId.ip_restriction, 'warn');
    assert.equal(byId.withdrawals_disabled, 'warn');
    assert.ok(!JSON.stringify(checks).includes(API_SECRET));
  } finally {
    credentials.__setClientFactoryForTests(null);
  }
}));

test('test() da la firma por buena si Binance rechaza la petición por negocio', () => withMemoryRepo(async () => {
  await credentials.set(1, { apiKey: API_KEY, apiSecret: API_SECRET });
  const rejected = Object.assign(new Error('Binance Opciones rechazó la petición: Some other reason'), {
    code: 'BINANCE_OPTIONS_REJECTED',
    details: { endpoint: '/eapi/v1/marginAccount', httpStatus: 400, binanceCode: -1100 },
  });
  credentials.__setClientFactoryForTests(() => ({
    getAccount: async () => { throw rejected; },
    getApiRestrictions: async () => ({ ipRestrict: true, enableVanillaOptions: true, enableWithdrawals: false }),
  }));
  try {
    const { checks } = await credentials.test(1);
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    assert.equal(byId.signature.status, 'ok');
    assert.equal(byId.options_account.status, 'fail');
    assert.equal(byId.options_account.detail, rejected.message);
  } finally {
    credentials.__setClientFactoryForTests(null);
  }
}));

test('test() explica que la cuenta de opciones no está activada o sin saldo (-2018)', () => withMemoryRepo(async () => {
  await credentials.set(1, { apiKey: API_KEY, apiSecret: API_SECRET });
  const noBalance = Object.assign(new Error('Binance Opciones rechazó la petición: Balance is insufficient.'), {
    code: 'BINANCE_OPTIONS_REJECTED',
    details: { endpoint: '/eapi/v1/marginAccount', httpStatus: 400, binanceCode: -2018 },
  });
  credentials.__setClientFactoryForTests(() => ({
    getAccount: async () => { throw noBalance; },
    getApiRestrictions: async () => ({ ipRestrict: true, enableVanillaOptions: true, enableWithdrawals: false }),
  }));
  try {
    const { checks } = await credentials.test(1);
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    assert.equal(byId.signature.status, 'ok');
    assert.equal(byId.options_account.status, 'fail');
    assert.match(byId.options_account.detail, /no está activada o no tiene saldo/);
    assert.match(byId.options_account.detail, /cartera de Opciones/);
  } finally {
    credentials.__setClientFactoryForTests(null);
  }
}));
