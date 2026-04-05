const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const config = require('../src/config');
const authService = require('../src/services/auth.service');
const uniswapProtectionService = require('../src/services/uniswap-protection.service');
const protectedPoolRefreshService = require('../src/services/protected-pool-refresh.service');
const positionActionsService = require('../src/services/uniswap-position-actions.service');

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

test('GET /api/uniswap/protected-pools devuelve la lista del usuario autenticado', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalList = uniswapProtectionService.listProtectedPools;
  authService.validateSessionToken = async () => buildSessionUser();
  uniswapProtectionService.listProtectedPools = async (userId) => ([
    { id: 31, userId, status: 'active' },
  ]);

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/uniswap/protected-pools`, {
      headers: { Authorization: `Bearer ${buildToken()}` },
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.data[0].id, 31);
    assert.equal(json.data[0].userId, 1);
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    uniswapProtectionService.listProtectedPools = originalList;
    server.close();
  }
});

test('POST /api/uniswap/protected-pools/refresh fuerza refresh y devuelve la lista actualizada', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalRefresh = protectedPoolRefreshService.refreshUser;
  const originalList = uniswapProtectionService.listProtectedPools;
  const calls = [];

  authService.validateSessionToken = async () => buildSessionUser();
  protectedPoolRefreshService.refreshUser = async (userId) => {
    calls.push(['refresh', userId]);
  };
  uniswapProtectionService.listProtectedPools = async (userId) => {
    calls.push(['list', userId]);
    return [{ id: 41, userId, status: 'active' }];
  };

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/uniswap/protected-pools/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${buildToken()}` },
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(calls, [['refresh', 1], ['list', 1]]);
    assert.equal(json.data[0].id, 41);
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    protectedPoolRefreshService.refreshUser = originalRefresh;
    uniswapProtectionService.listProtectedPools = originalList;
    server.close();
  }
});

test('POST /api/uniswap/protected-pools crea la proteccion con el userId autenticado', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalCreate = uniswapProtectionService.createProtectedPool;
  const calls = [];
  authService.validateSessionToken = async () => buildSessionUser();
  uniswapProtectionService.createProtectedPool = async (payload) => {
    calls.push(payload);
    return { id: 88, status: 'active' };
  };

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/uniswap/protected-pools`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buildToken()}`,
      },
      body: JSON.stringify({
        accountId: 5,
        leverage: 10,
        configuredNotionalUsd: 1250,
        valueMultiplier: 1.25,
        stopLossDifferencePct: 0.05,
        pool: {
          mode: 'lp_position',
          version: 'v3',
          network: 'ethereum',
          identifier: '123',
          owner: '0x00000000000000000000000000000000000000AA',
          rangeLowerPrice: 49000,
          rangeUpperPrice: 51000,
          currentValueUsd: 1000,
          priceCurrent: 50000,
          inRange: true,
          token0: { symbol: 'BTC' },
          token1: { symbol: 'USDC' },
        },
      }),
    });
    const json = await res.json();

    assert.equal(res.status, 201);
    assert.equal(json.data.id, 88);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].userId, 1);
    assert.equal(calls[0].accountId, 5);
    assert.equal(calls[0].configuredNotionalUsd, 1250);
    assert.equal(calls[0].valueMultiplier, 1.25);
    assert.equal(calls[0].stopLossDifferencePct, 0.05);
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    uniswapProtectionService.createProtectedPool = originalCreate;
    server.close();
  }
});

test('POST /api/uniswap/protected-pools/:id/deactivate valida el id', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  authService.validateSessionToken = async () => buildSessionUser();
  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/uniswap/protected-pools/nope/deactivate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${buildToken()}` },
    });
    const json = await res.json();

    assert.equal(res.status, 400);
    assert.match(json.error, /ID invalido/i);
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    server.close();
  }
});

test('POST /api/uniswap/increase-liquidity/prepare delega al coordinador de acciones', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalPrepare = positionActionsService.preparePositionAction;
  const calls = [];

  authService.validateSessionToken = async () => buildSessionUser();
  positionActionsService.preparePositionAction = async (payload) => {
    calls.push(payload);
    return { action: 'increase-liquidity', txPlan: [] };
  };

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/uniswap/increase-liquidity/prepare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buildToken()}`,
      },
      body: JSON.stringify({
        network: 'ethereum',
        version: 'v3',
        walletAddress: '0x00000000000000000000000000000000000000AA',
        positionIdentifier: '123',
        amount0Desired: '0.1',
        amount1Desired: '100',
        slippageBps: 100,
      }),
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.data.action, 'increase-liquidity');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'increase-liquidity');
    assert.equal(calls[0].payload.positionIdentifier, '123');
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    positionActionsService.preparePositionAction = originalPrepare;
    server.close();
  }
});

test('POST /api/uniswap/modify-range/finalize usa userId autenticado al finalizar', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalFinalize = positionActionsService.finalizePositionAction;
  const calls = [];

  authService.validateSessionToken = async () => buildSessionUser();
  positionActionsService.finalizePositionAction = async (payload) => {
    calls.push(payload);
    return { action: 'modify-range', txHashes: payload.txHashes };
  };

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/uniswap/modify-range/finalize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buildToken()}`,
      },
      body: JSON.stringify({
        network: 'ethereum',
        version: 'v3',
        walletAddress: '0x00000000000000000000000000000000000000AA',
        positionIdentifier: '123',
        txHashes: ['0xabc'],
      }),
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.data.action, 'modify-range');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].userId, 1);
    assert.deepEqual(calls[0].txHashes, ['0xabc']);
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    positionActionsService.finalizePositionAction = originalFinalize;
    server.close();
  }
});
