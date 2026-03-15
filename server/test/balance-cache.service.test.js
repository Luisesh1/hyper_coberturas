const test = require('node:test');
const assert = require('node:assert/strict');

const hlRegistry = require('../src/services/hyperliquid.registry');
const cacheService = require('../src/services/balance-cache.service');

function withPatched(object, patches) {
  const originals = {};
  for (const [key, value] of Object.entries(patches)) {
    originals[key] = object[key];
    object[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(originals)) {
      object[key] = value;
    }
  };
}

test('getSnapshot deduplica refresh concurrente de la misma cuenta', async () => {
  let calls = 0;
  const release = withPatched(hlRegistry, {
    getOrCreate: async () => ({
      getClearinghouseState: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          marginSummary: { accountValue: '101.5', totalMarginUsed: '10', totalNtlPos: '50' },
          withdrawable: '91.5',
          assetPositions: [],
        };
      },
      getOpenOrders: async () => [],
    }),
  });

  try {
    const [first, second] = await Promise.all([
      cacheService.getSnapshot(1, 10, { force: true }),
      cacheService.getSnapshot(1, 10, { force: true }),
    ]);
    assert.equal(calls, 1);
    assert.equal(first.accountValue, 101.5);
    assert.equal(second.accountValue, 101.5);
  } finally {
    cacheService.invalidateAccount(1, 10);
    release();
  }
});

test('enrichAccounts fuerza refresh solo para la cuenta seleccionada', async () => {
  const calls = [];
  const release = withPatched(hlRegistry, {
    getOrCreate: async (_userId, accountId) => ({
      getClearinghouseState: async () => {
        calls.push(accountId);
        return {
          marginSummary: { accountValue: String(accountId * 10), totalMarginUsed: '0', totalNtlPos: '0' },
          withdrawable: '0',
          assetPositions: [],
        };
      },
      getOpenOrders: async () => [],
    }),
  });

  try {
    cacheService.invalidateAccount(1, 1);
    cacheService.invalidateAccount(1, 2);

    await cacheService.getBalance(1, 1, { force: true });
    calls.length = 0;

    const result = await cacheService.enrichAccounts(1, [
      { id: 1, alias: 'A', address: '0x1' },
      { id: 2, alias: 'B', address: '0x2' },
    ], { forceAccountId: 2 });

    assert.equal(result[0].balanceUsd, 10);
    assert.equal(result[1].balanceUsd, 20);
    assert.deepEqual(calls, [2]);
  } finally {
    cacheService.invalidateAccount(1, 1);
    cacheService.invalidateAccount(1, 2);
    release();
  }
});
