const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const config = require('../src/config');
const TradingService = require('../src/services/trading.service');
const hlRegistry = require('../src/services/hyperliquid.registry');
const tgRegistry = require('../src/services/telegram.registry');
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

function patchTradingDeps() {
  const originalResolveAccount = hyperliquidAccountsService.resolveAccount;
  const originalGetOrCreateHl = hlRegistry.getOrCreate;
  const originalGetOrCreateTg = tgRegistry.getOrCreate;

  hyperliquidAccountsService.resolveAccount = async (_userId, accountId) => ({
    id: Number(accountId || 8),
    alias: 'Cuenta Alpha',
    address: '0x00000000000000000000000000000000000000AA',
    shortAddress: '0x0000...00AA',
    label: 'Cuenta Alpha · 0x0000...00AA',
  });
  hlRegistry.getOrCreate = async () => ({});
  tgRegistry.getOrCreate = async () => ({});

  return () => {
    hyperliquidAccountsService.resolveAccount = originalResolveAccount;
    hlRegistry.getOrCreate = originalGetOrCreateHl;
    tgRegistry.getOrCreate = originalGetOrCreateTg;
  };
}

test('POST /api/trading/open valida side y size', async () => {
  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/trading/open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buildToken()}`,
      },
      body: JSON.stringify({ asset: 'BTC', side: 'buy', size: -1 }),
    });
    const json = await res.json();

    assert.equal(res.status, 400);
    assert.match(json.error, /side debe ser 'long' o 'short'/i);
  } finally {
    server.close();
  }
});

test('POST /api/trading/close responde la cuenta y el resultado del cierre', async () => {
  const releaseDeps = patchTradingDeps();
  const originalClose = TradingService.prototype.closePosition;
  TradingService.prototype.closePosition = async function closePosition({ asset, size }) {
    return {
      success: true,
      action: 'close',
      account: this.account,
      asset,
      closedSize: size ?? 0.01,
      closePrice: '50000.00',
    };
  };

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/trading/close`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buildToken()}`,
      },
      body: JSON.stringify({ accountId: 8, asset: 'BTC', size: 0.01 }),
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.action, 'close');
    assert.equal(json.data.account.alias, 'Cuenta Alpha');
    assert.equal(json.data.asset, 'BTC');
  } finally {
    TradingService.prototype.closePosition = originalClose;
    releaseDeps();
    server.close();
  }
});

test('POST /api/trading/sltp responde el resultado y mantiene el contrato JSON', async () => {
  const releaseDeps = patchTradingDeps();
  const originalSetSLTP = TradingService.prototype.setSLTP;
  TradingService.prototype.setSLTP = async function setSLTP(payload) {
    return {
      account: this.account,
      result: {
        ok: true,
        asset: payload.asset,
      },
    };
  };

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/trading/sltp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buildToken()}`,
      },
      body: JSON.stringify({
        accountId: 8,
        asset: 'BTC',
        side: 'long',
        size: 0.01,
        slPrice: 49000,
        tpPrice: 51000,
      }),
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.account.id, 8);
    assert.equal(json.data.result.ok, true);
  } finally {
    TradingService.prototype.setSLTP = originalSetSLTP;
    releaseDeps();
    server.close();
  }
});

test('DELETE /api/trading/orders/:asset/:oid valida el oid', async () => {
  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/trading/orders/BTC/not-a-number`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${buildToken()}`,
      },
    });
    const json = await res.json();

    assert.equal(res.status, 400);
    assert.match(json.error, /oid debe ser un numero/i);
  } finally {
    server.close();
  }
});
