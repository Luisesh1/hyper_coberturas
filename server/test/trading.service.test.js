const test = require('node:test');
const assert = require('node:assert/strict');

const TradingService = require('../src/services/trading.service');
const balanceCacheService = require('../src/services/balance-cache.service');

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

function createTrading(overrides = {}) {
  const hl = {
    getAssetMeta: async () => ({ index: 0, szDecimals: 3 }),
    getAllMids: async () => ({ BTC: '50000' }),
    getClearinghouseState: async () => ({
      marginSummary: { accountValue: '1000', totalMarginUsed: '100', totalNtlPos: '500' },
      withdrawable: '900',
      assetPositions: [],
    }),
    updateLeverage: async () => {},
    placeOrder: async () => ({ statuses: ['ok'] }),
    getOpenOrders: async () => [],
    getAssetIndex: async () => 0,
    cancelOrder: async () => ({ ok: true }),
    ...overrides.hl,
  };

  const tgCalls = [];
  const tg = {
    notifyTradeOpen: (payload) => tgCalls.push(['open', payload]),
    notifyTradeClose: (payload) => tgCalls.push(['close', payload]),
    ...overrides.tg,
  };

  const account = {
    id: 8,
    alias: 'Cuenta Alpha',
    address: '0x00000000000000000000000000000000000000AA',
    shortAddress: '0x0000...00AA',
    label: 'Cuenta Alpha · 0x0000...00AA',
  };

  return {
    account,
    tgCalls,
    service: new TradingService(1, account, hl, tg),
  };
}

test('getAccountState reutiliza snapshot cacheado y expone metadata de cuenta', async () => {
  const { service, account } = createTrading();
  const release = withPatched(balanceCacheService, {
    getSnapshot: async () => ({
      accountValue: 1200,
      totalMarginUsed: 150,
      totalNtlPos: 600,
      withdrawable: 1050,
      positions: [{ asset: 'BTC', side: 'long' }],
      openOrders: [],
      lastUpdatedAt: 456,
    }),
  });

  try {
    const state = await service.getAccountState();
    assert.equal(state.account.alias, account.alias);
    assert.equal(state.accountValue, 1200);
    assert.equal(state.positions.length, 1);
  } finally {
    release();
  }
});

test('openPosition refresca cache y notifica incluyendo la cuenta', async () => {
  const { service, tgCalls, account } = createTrading();
  const cacheCalls = [];
  const release = withPatched(balanceCacheService, {
    refreshSnapshot: async (userId, accountId) => cacheCalls.push([userId, accountId]),
  });

  try {
    const result = await service.openPosition({
      asset: 'BTC',
      side: 'long',
      size: 0.01,
      leverage: 5,
      marginMode: 'cross',
    });

    assert.equal(result.account.alias, account.alias);
    assert.deepEqual(cacheCalls, [[1, 8]]);
    assert.equal(tgCalls[0][0], 'open');
    assert.equal(tgCalls[0][1].account.alias, account.alias);
  } finally {
    release();
  }
});
