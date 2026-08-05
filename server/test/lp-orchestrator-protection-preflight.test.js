const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runProtectionPreflight,
  PREFLIGHT_CHECKS,
} = require('../src/services/lp-orchestrator/protection-preflight');

// El pre-flight es un dry-run: no debe tocar nada. Todos los colaboradores
// se inyectan, así que los fakes describen exactamente el estado del mundo
// que cada test quiere probar.
function makeDeps({
  account = { id: 2, alias: 'principal' },
  universe = [{ name: 'ETH', maxLeverage: 25 }, { name: 'BTC', maxLeverage: 40 }],
  withdrawable = 5000,
  activeProtections = [],
  accountError = null,
  balanceError = null,
} = {}) {
  return {
    accountsService: {
      async resolveAccount() {
        if (accountError) throw accountError;
        return account;
      },
    },
    marketService: {
      async getAvailableAssets() { return universe; },
    },
    balanceCache: {
      async getSnapshot() {
        if (balanceError) throw balanceError;
        return { withdrawable, accountValue: withdrawable, positions: [] };
      },
    },
    protectedPoolRepository: {
      async listActiveByUser() { return activeProtections; },
    },
  };
}

function makePlan(overrides = {}) {
  return {
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    capitalUsd: 1000,
    protection: {
      enabled: true,
      accountId: 2,
      leverage: 3,
      configuredNotionalUsd: 1000,
      ...(overrides.protection || {}),
    },
    ...overrides,
  };
}

function checkById(result, id) {
  return result.checks.find((c) => c.id === id);
}

test('preflight: plan válido pasa los cinco checks', async () => {
  const result = await runProtectionPreflight(
    { userId: 1, plan: makePlan() },
    makeDeps()
  );

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(result.blockingReason, null);
  assert.equal(result.checks.length, PREFLIGHT_CHECKS.length);
  assert.ok(result.checks.every((c) => c.ok === true));
  assert.equal(result.computed.asset, 'ETH');
  assert.equal(result.computed.maxLeverage, 25);
  assert.equal(result.computed.notionalUsd, 1000);
  // 1000 / 3 = 333.33…
  assert.ok(Math.abs(result.computed.requiredMarginUsd - 333.34) < 0.02);
  assert.equal(result.computed.freeMarginUsd, 5000);
});

test('preflight: con la protección desactivada no consulta nada y pasa', async () => {
  let touched = false;
  const deps = makeDeps();
  deps.accountsService.resolveAccount = async () => { touched = true; return {}; };

  const plan = makePlan({ protection: { enabled: false } });
  const result = await runProtectionPreflight({ userId: 1, plan }, deps);

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.deepEqual(result.checks, []);
  assert.equal(touched, false, 'no debe resolver la cuenta si no hay cobertura');
});

test('preflight: cuenta que no resuelve bloquea y no evalúa el resto', async () => {
  const deps = makeDeps({ accountError: new Error('cuenta no encontrada') });
  const result = await runProtectionPreflight({ userId: 1, plan: makePlan() }, deps);

  assert.equal(result.ok, false);
  assert.equal(checkById(result, 'account').ok, false);
  assert.match(result.blockingReason, /cuenta no encontrada/i);
  // Los checks posteriores quedan sin evaluar, no marcados como aprobados.
  assert.equal(checkById(result, 'margin').ok, null);
});

test('preflight: par sin token volátil no es elegible para delta-neutral', async () => {
  const plan = makePlan({ token0Symbol: 'USDC', token1Symbol: 'USDT' });
  const result = await runProtectionPreflight({ userId: 1, plan }, makeDeps());

  assert.equal(result.ok, false);
  assert.equal(checkById(result, 'asset').ok, false);
  assert.match(checkById(result, 'asset').detail, /estables/i);
});

test('preflight: token volátil ausente en Hyperliquid bloquea', async () => {
  const deps = makeDeps({ universe: [{ name: 'BTC', maxLeverage: 40 }] });
  const result = await runProtectionPreflight({ userId: 1, plan: makePlan() }, deps);

  assert.equal(result.ok, false);
  assert.equal(checkById(result, 'asset').ok, false);
  assert.match(checkById(result, 'asset').detail, /ETH/);
});

test('preflight: leverage por encima del máximo del asset bloquea', async () => {
  const plan = makePlan({ protection: { leverage: 50 } });
  const result = await runProtectionPreflight({ userId: 1, plan }, makeDeps());

  assert.equal(result.ok, false);
  assert.equal(checkById(result, 'leverage').ok, false);
  assert.match(checkById(result, 'leverage').detail, /25/);
});

test('preflight: margen libre insuficiente bloquea con las cifras concretas', async () => {
  const deps = makeDeps({ withdrawable: 100 });
  const result = await runProtectionPreflight({ userId: 1, plan: makePlan() }, deps);

  assert.equal(result.ok, false);
  const margin = checkById(result, 'margin');
  assert.equal(margin.ok, false);
  assert.match(margin.detail, /100/);
  assert.match(margin.detail, /333/);
});

test('preflight: otra protección activa en el mismo asset y cuenta bloquea', async () => {
  const deps = makeDeps({
    activeProtections: [{ accountId: 2, inferredAsset: 'ETH', status: 'active' }],
  });
  const result = await runProtectionPreflight({ userId: 1, plan: makePlan() }, deps);

  assert.equal(result.ok, false);
  assert.equal(checkById(result, 'conflict').ok, false);
});

test('preflight: una protección activa en otra cuenta no bloquea', async () => {
  const deps = makeDeps({
    activeProtections: [{ accountId: 9, inferredAsset: 'ETH', status: 'active' }],
  });
  const result = await runProtectionPreflight({ userId: 1, plan: makePlan() }, deps);

  assert.equal(result.ok, true);
  assert.equal(checkById(result, 'conflict').ok, true);
});

test('preflight: sin notional configurado dimensiona desde el capital del plan', async () => {
  const plan = makePlan({
    capitalUsd: 2400,
    protection: { configuredNotionalUsd: null },
  });
  const result = await runProtectionPreflight({ userId: 1, plan }, makeDeps());

  assert.equal(result.computed.notionalUsd, 2400);
});

test('preflight: si el balance de Hyperliquid falla, el margen no se da por bueno', async () => {
  const deps = makeDeps({ balanceError: new Error('hl timeout') });
  const result = await runProtectionPreflight({ userId: 1, plan: makePlan() }, deps);

  assert.equal(result.ok, false);
  const margin = checkById(result, 'margin');
  assert.equal(margin.ok, false);
  assert.match(margin.detail, /hl timeout/);
});
