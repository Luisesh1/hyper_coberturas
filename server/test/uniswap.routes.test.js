const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const config = require('../src/config');
const uniswapProtectionService = require('../src/services/uniswap-protection.service');

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

test('GET /api/uniswap/protected-pools devuelve la lista del usuario autenticado', async () => {
  const originalList = uniswapProtectionService.listProtectedPools;
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
    uniswapProtectionService.listProtectedPools = originalList;
    server.close();
  }
});

test('POST /api/uniswap/protected-pools crea la proteccion con el userId autenticado', async () => {
  const originalCreate = uniswapProtectionService.createProtectedPool;
  const calls = [];
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
    uniswapProtectionService.createProtectedPool = originalCreate;
    server.close();
  }
});

test('POST /api/uniswap/protected-pools/:id/deactivate valida el id', async () => {
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
    server.close();
  }
});
