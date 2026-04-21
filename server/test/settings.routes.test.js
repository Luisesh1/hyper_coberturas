const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const config = require('../src/config');
const authService = require('../src/services/auth.service');
const settingsService = require('../src/services/settings.service');
const tgRegistry = require('../src/services/telegram.registry');
const telegramCommandService = require('../src/services/telegram-command.service');
const hyperliquidAccountsService = require('../src/services/hyperliquid-accounts.service');

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

test('GET /api/settings devuelve defaults resumidos y mascara el token de Telegram', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalGetTelegram = settingsService.getTelegram;
  const originalGetWallet = settingsService.getWallet;
  const originalGetEtherscan = settingsService.getEtherscan;
  const originalGetAlchemy = settingsService.getAlchemy;
  const originalGetDeltaNeutralRiskControls = settingsService.getDeltaNeutralRiskControls;
  const originalListAccounts = hyperliquidAccountsService.listAccounts;

  settingsService.getTelegram = async () => ({
    token: '1234567890',
    chatId: '999',
  });
  settingsService.getWallet = async () => ({
    id: 7,
    alias: 'Cuenta principal',
    address: '0xabc',
    hasPrivateKey: true,
  });
  settingsService.getEtherscan = async () => ({
    apiKey: 'secret-key',
  });
  settingsService.getAlchemy = async () => ({
    apiKey: 'alchemy-secret',
  });
  settingsService.getDeltaNeutralRiskControls = async () => ({
    riskPauseLiqDistancePct: 7,
    marginTopUpLiqDistancePct: 10,
  });
  hyperliquidAccountsService.listAccounts = async () => ([
    { id: 1, isDefault: true },
    { id: 2, isDefault: false },
  ]);
  authService.validateSessionToken = async () => buildSessionUser();

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${buildToken()}` },
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.data.telegram.enabled, true);
    assert.equal(json.data.telegram.token, '123456***');
    assert.equal(json.data.wallet.alias, 'Cuenta principal');
    assert.equal(json.data.etherscan.hasApiKey, true);
    assert.deepEqual(json.data.hyperliquidAccounts, {
      count: 2,
      hasDefault: true,
    });
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    settingsService.getTelegram = originalGetTelegram;
    settingsService.getWallet = originalGetWallet;
    settingsService.getEtherscan = originalGetEtherscan;
    settingsService.getAlchemy = originalGetAlchemy;
    settingsService.getDeltaNeutralRiskControls = originalGetDeltaNeutralRiskControls;
    hyperliquidAccountsService.listAccounts = originalListAccounts;
    server.close();
  }
});

test('PUT /api/settings/telegram valida token y chatId requeridos', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  authService.validateSessionToken = async () => buildSessionUser();
  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/settings/telegram`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buildToken()}`,
      },
      body: JSON.stringify({ token: '', chatId: '' }),
    });
    const json = await res.json();

    assert.equal(res.status, 400);
    assert.match(json.error, /token y chatId son requeridos/i);
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    server.close();
  }
});

test('PUT /api/settings/telegram recarga Telegram y refresca el listener de comandos', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalSetTelegram = settingsService.setTelegram;
  const originalReload = tgRegistry.reload;
  const originalRefreshConfigs = telegramCommandService.refreshConfigs;
  const calls = [];

  authService.validateSessionToken = async () => buildSessionUser();
  settingsService.setTelegram = async (userId, payload) => {
    calls.push({ type: 'set', userId, payload });
  };
  tgRegistry.reload = async (userId) => {
    calls.push({ type: 'reload', userId });
  };
  telegramCommandService.refreshConfigs = async () => {
    calls.push({ type: 'refresh-configs' });
  };

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/settings/telegram`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buildToken()}`,
      },
      // Token con formato válido: <bot_id>:<secret> (ver TELEGRAM_TOKEN_REGEX).
      body: JSON.stringify({ token: '1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', chatId: '999999' }),
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.deepEqual(calls, [
      { type: 'set', userId: 1, payload: { token: '1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', chatId: '999999' } },
      { type: 'reload', userId: 1 },
      { type: 'refresh-configs' },
    ]);
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    settingsService.setTelegram = originalSetTelegram;
    tgRegistry.reload = originalReload;
    telegramCommandService.refreshConfigs = originalRefreshConfigs;
    server.close();
  }
});
