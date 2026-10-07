const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const config = require('../src/config');
const authService = require('../src/services/auth.service');
const crossChain = require('../src/services/cross-chain');

const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';
const BODY = {
  walletAddress: WALLET,
  network: 'base',
  version: 'v4',
  token0: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 },
  token1: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  totalUsdTarget: 1000,
  targetWeightToken0Pct: 50,
  profile: 'low',
};

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
    const res = await fetch(`http://${address}:${port}/api/cross-chain${path}`, {
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

function stub(overrides) {
  const original = { ...crossChain.service };
  Object.assign(crossChain.service, overrides);
  return () => Object.assign(crossChain.service, original);
}

function withMode(mode) {
  const original = config.crossChainFunding.mode;
  config.crossChainFunding.mode = mode;
  return () => { config.crossChainFunding.mode = original; };
}

test('GET /config informa el modo', async () => {
  const restore = withMode('read');
  try {
    await withServer(async (call) => {
      const res = await call('GET', '/config');
      assert.equal(res.status, 200);
      assert.equal(res.json.data.mode, 'read');
    });
  } finally { restore(); }
});

test('con el modo off las rutas no existen', async () => {
  const restore = withMode('off');
  try {
    await withServer(async (call) => {
      assert.equal((await call('POST', '/funding-analysis', BODY)).status, 404);
      assert.equal((await call('GET', '/config')).json.data.mode, 'off');
    });
  } finally { restore(); }
});

test('POST /funding-analysis valida y devuelve el análisis público', async () => {
  const restoreMode = withMode('read');
  let seen;
  const restore = stub({
    analyze: async (input) => { seen = input; return { needsCrossChain: true, steps: [{ quote: { tx: { data: '0xsecret' } }, txs: [], costs: {} }] }; },
  });
  try {
    await withServer(async (call) => {
      const bad = await call('POST', '/funding-analysis', { ...BODY, profile: 'turbo' });
      assert.equal(bad.status, 400);
      const res = await call('POST', '/funding-analysis', { ...BODY, thresholdPct: 5, forcedSources: ['ethereum:native'] });
      assert.equal(res.status, 200);
      assert.equal(seen.thresholdPct, 5);
      assert.deepEqual(seen.forcedSources, ['ethereum:native']);
      assert.ok(!JSON.stringify(res.json).includes('0xsecret'));
    });
  } finally { restore(); restoreMode(); }
});

test('en modo read no se ejecuta nada', async () => {
  const restoreMode = withMode('read');
  try {
    await withServer(async (call) => {
      const res = await call('POST', '/plans', BODY);
      assert.equal(res.status, 403);
      assert.equal(res.json.code, 'FEATURE_DISABLED');
    });
  } finally { restoreMode(); }
});

test('en modo execute se crea el plan y se preparan y registran pasos del usuario', async () => {
  const restoreMode = withMode('execute');
  const seen = {};
  const restore = stub({
    createPlan: async (args) => { seen.create = args; return { id: 5, steps: [] }; },
    planView: (plan) => ({ id: plan.id, view: true }),
    getActivePlan: async (args) => { seen.active = args; return null; },
    getPlanView: async (args) => { seen.view = args; return { id: args.planId }; },
    prepareStep: async (args) => { seen.prepare = args; return { txs: [] }; },
    submitStep: async (args) => { seen.submit = args; return { order: 1 }; },
    skipStep: async (args) => ({ skipped: args.order }),
    continueWithArrived: async () => ({ status: 'partial' }),
    discardPlan: async () => ({ status: 'discarded' }),
  });
  try {
    await withServer(async (call) => {
      const created = await call('POST', '/plans', BODY);
      assert.equal(created.status, 201);
      assert.equal(seen.create.userId, 1);
      assert.deepEqual(created.json.data, { id: 5, view: true });

      assert.equal((await call('GET', `/plans/active?walletAddress=${WALLET}`)).json.data, null);
      assert.equal(seen.active.walletAddress, WALLET);

      assert.equal((await call('GET', '/plans/5')).json.data.id, 5);
      assert.equal(seen.view.userId, 1);

      await call('POST', '/plans/5/steps/2/prepare', { speedUp: true });
      assert.deepEqual(seen.prepare, { userId: 1, planId: 5, order: 2, speedUp: true });

      const badSubmit = await call('POST', '/plans/5/steps/2/submitted', { kind: 'bridge' });
      assert.equal(badSubmit.status, 400);
      await call('POST', '/plans/5/steps/2/submitted', {
        kind: 'bridge', txHash: '0x' + 'a'.repeat(64), nonce: 3,
        fees: { profile: 'low', maxFeePerGas: '10', maxPriorityFeePerGas: '1', gasLimit: '21000' },
      });
      assert.equal(seen.submit.nonce, 3);
      assert.equal(seen.submit.fees.profile, 'low');

      assert.equal((await call('POST', '/plans/5/steps/2/skip')).json.data.skipped, 2);
      assert.equal((await call('POST', '/plans/5/continue')).json.data.status, 'partial');
      assert.equal((await call('POST', '/plans/5/discard')).json.data.status, 'discarded');
    });
  } finally { restore(); restoreMode(); }
});

test('el panel de balances no requiere plan: GET /balances', async () => {
  const restoreMode = withMode('read');
  const restore = stub({ getBalances: async ({ walletAddress }) => ({ walletAddress, networks: [] }) });
  try {
    await withServer(async (call) => {
      const res = await call('GET', `/balances?walletAddress=${WALLET}`);
      assert.equal(res.status, 200);
      assert.equal(res.json.data.walletAddress, WALLET);
      assert.equal((await call('GET', '/balances')).status, 400);
    });
  } finally { restore(); restoreMode(); }
});
