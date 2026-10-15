const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || 'test-settings-key';

const app = require('../src/app');
const config = require('../src/config');
const db = require('../src/db');
const authService = require('../src/services/auth.service');
const optionsMarket = require('../src/services/options/options-market.service');
const optionsCredentials = require('../src/services/options/options-credentials.service');

function token() {
  return jwt.sign({ userId: 1, username: 'tester', role: 'user' }, config.jwt.secret);
}

async function withServer(fn) {
  const originalAuth = authService.validateSessionToken;
  authService.validateSessionToken = async () => ({ id: 1, userId: 1, username: 'tester', role: 'user', active: true });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { address, port } = server.address();
  const call = async (method, path, body) => {
    const res = await fetch(`http://${address}:${port}/api${path}`, {
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

function stub(target, overrides) {
  const original = {};
  for (const key of Object.keys(overrides)) original[key] = target[key];
  Object.assign(target, overrides);
  return () => Object.assign(target, original);
}

// Cliente falso que registra lo que recibe; nunca toca la red.
function fakeClient(overrides = {}) {
  const calls = [];
  const client = {
    calls,
    async placeOrder(args) { calls.push(['placeOrder', args]); return { orderId: '4611875134427365377', status: 'ACCEPTED' }; },
    async cancelOrder(args) { calls.push(['cancelOrder', args]); return { status: 'CANCELLED' }; },
    async getUserTrades(args) { calls.push(['getUserTrades', args]); return []; },
    ...overrides,
  };
  return client;
}

test('las rutas de opciones exigen autenticación', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { address, port } = server.address();
  try {
    const res = await fetch(`http://${address}:${port}/api/options/underlyings`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('GET /options/chain valida underlying y delega en el servicio de mercado', async () => {
  const seen = [];
  const restore = stub(optionsMarket, {
    getChain: async (u, e) => { seen.push([u, e]); return { underlying: 'BTC', spot: 1, expiries: [], expiry: e, rows: [] }; },
  });
  try {
    await withServer(async (call) => {
      assert.equal((await call('GET', '/options/chain')).status, 400);
      const res = await call('GET', '/options/chain?underlying=BTC&expiry=261031');
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.data.expiry, '261031');
      assert.deepEqual(seen, [['BTC', '261031']]);
    });
  } finally { restore(); }
});

test('POST /options/orders valida el cuerpo antes de llamar a Binance', async () => {
  const client = fakeClient();
  const restore = stub(optionsCredentials, { getClientForUser: async () => client });
  const valid = { symbol: 'BTC-261031-68000-C', side: 'BUY', quantity: 0.1, price: 1250 };
  try {
    await withServer(async (call) => {
      const cases = [
        { ...valid, symbol: 'BTCUSDT' },
        { ...valid, side: 'HOLD' },
        { ...valid, quantity: 0 },
        { ...valid, quantity: 'abc' },
        { ...valid, price: -5 },
        { ...valid, price: undefined },
        { ...valid, postOnly: 'yes' },
        { ...valid, clientOrderId: 'con espacios!' },
      ];
      for (const body of cases) {
        const res = await call('POST', '/options/orders', body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.json.code, 'VALIDATION_ERROR');
      }
      assert.equal(client.calls.length, 0);

      const ok = await call('POST', '/options/orders', { ...valid, side: 'sell', reduceOnly: true });
      assert.equal(ok.status, 201);
      assert.equal(ok.json.data.orderId, '4611875134427365377');
      assert.deepEqual(client.calls[0], ['placeOrder', {
        symbol: 'BTC-261031-68000-C', side: 'SELL', quantity: 0.1, price: 1250, postOnly: false, reduceOnly: true, clientOrderId: undefined,
      }]);
    });
  } finally { restore(); }
});

test('POST /options/orders sin credenciales devuelve 400 BINANCE_OPTIONS_NOT_CONFIGURED', async () => {
  const settingsService = require('../src/services/settings.service');
  const restore = stub(settingsService, { getBinanceOptions: async () => null });
  try {
    await withServer(async (call) => {
      const res = await call('POST', '/options/orders', { symbol: 'BTC-261031-68000-C', side: 'BUY', quantity: 1, price: 10 });
      assert.equal(res.status, 400);
      assert.equal(res.json.code, 'BINANCE_OPTIONS_NOT_CONFIGURED');
    });
  } finally { restore(); }
});

test('DELETE /options/orders/:symbol/:orderId valida y cancela', async () => {
  const client = fakeClient();
  const restore = stub(optionsCredentials, { getClientForUser: async () => client });
  try {
    await withServer(async (call) => {
      assert.equal((await call('DELETE', '/options/orders/BTC-261031-68000-C/abc')).status, 400);
      assert.equal((await call('DELETE', '/options/orders/nope/123')).status, 400);
      const res = await call('DELETE', '/options/orders/BTC-261031-68000-C/4611875134427365377');
      assert.equal(res.status, 200);
      assert.deepEqual(client.calls, [['cancelOrder', { symbol: 'BTC-261031-68000-C', orderId: '4611875134427365377' }]]);
    });
  } finally { restore(); }
});

test('GET /options/trades valida days', async () => {
  const client = fakeClient({
    async getUserTrades() {
      return [
        { id: 1, orderId: 9, symbol: 'BTC-261031-68000-C', side: 'BUY', price: '100', quantity: '1', fee: '0.1', realizedProfit: '0', time: 1 },
        { id: 2, orderId: 10, symbol: 'BTC-261031-68000-C', side: 'SELL', price: '120', quantity: '1', fee: '0.1', realizedProfit: '20', time: 2 },
      ];
    },
  });
  const restore = stub(optionsCredentials, { getClientForUser: async () => client });
  try {
    await withServer(async (call) => {
      assert.equal((await call('GET', '/options/trades?days=0')).status, 400);
      assert.equal((await call('GET', '/options/trades?days=1000')).status, 400);
      const res = await call('GET', '/options/trades?days=7');
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.data.map((t) => t.id), ['2', '1']);
      assert.equal(res.json.data[0].realizedPnl, 20);
    });
  } finally { restore(); }
});

test('GET /options/account resume balance, margen y griegas', async () => {
  const client = fakeClient({
    async getAccount() {
      return {
        asset: [{ asset: 'USDT', equity: '1000', available: '800', unrealizedPNL: '-12.5' }],
        greek: [
          { underlying: 'BTCUSDT', delta: '0.5', gamma: '0.001', theta: '-10', vega: '20' },
          { underlying: 'ETHUSDT', delta: '-0.2', gamma: '0.002', theta: '-5', vega: '4' },
        ],
      };
    },
  });
  const restore = stub(optionsCredentials, { getClientForUser: async () => client });
  try {
    await withServer(async (call) => {
      const res = await call('GET', '/options/account');
      assert.equal(res.status, 200);
      assert.equal(res.json.data.balanceUsdt, 1000);
      assert.equal(res.json.data.marginUsedUsdt, 200);
      assert.equal(res.json.data.unrealizedPnlUsdt, -12.5);
      assert.ok(Math.abs(res.json.data.greeks.delta - 0.3) < 1e-9);
      assert.equal(res.json.data.greeks.theta, -15);
    });
  } finally { restore(); }
});

test('GET /options/positions cruza el origen con options_strategy_positions si existe', async () => {
  const client = fakeClient({
    async getPositions() {
      return [
        { symbol: 'BTC-261031-68000-C', side: 'SHORT', quantity: '-2', entryPrice: '1500', markPrice: '1400', unrealizedPNL: '200' },
        { symbol: 'ETH-261031-2500-P', side: 'LONG', quantity: '1', entryPrice: '50', markPrice: '55', unrealizedPNL: '5' },
      ];
    },
  });
  const restoreCreds = stub(optionsCredentials, { getClientForUser: async () => client });
  const restoreMarket = stub(optionsMarket, {
    getMarks: async () => [{ symbol: 'BTC-261031-68000-C', delta: '0.5', theta: '-40' }],
  });
  const restoreDb = stub(db, {
    query: async () => ({ rows: [{ symbol: 'BTC-261031-68000-C', name: 'Strangle BTC' }] }),
  });
  try {
    await withServer(async (call) => {
      const res = await call('GET', '/options/positions');
      assert.equal(res.status, 200);
      const [btc, eth] = res.json.data;
      assert.equal(btc.side, 'SHORT');
      assert.equal(btc.quantity, 2);
      assert.equal(btc.delta, -1);
      assert.equal(btc.theta, 80);
      assert.equal(btc.origin, 'Strangle BTC');
      assert.equal(eth.origin, 'manual');
      assert.equal(eth.delta, null);
    });

    // Sin la tabla (migración 031 aún no aplicada) todo es manual.
    db.query = async () => { throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); };
    await withServer(async (call) => {
      const res = await call('GET', '/options/positions');
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.data.map((p) => p.origin), ['manual', 'manual']);
    });
  } finally {
    restoreDb();
    restoreMarket();
    restoreCreds();
  }
});
