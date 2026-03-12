const test = require('node:test');
const assert = require('node:assert/strict');

const HedgeService = require('../src/services/hedge.service');

function createService(hlOverrides = {}) {
  const hl = {
    getAssetMeta: async () => ({ index: 0, szDecimals: 5 }),
    updateLeverage: async () => {},
    getPosition: async () => null,
    placeTriggerEntry: async () => 123,
    ...hlOverrides,
  };

  const repo = {
    save: async () => {},
    saveCycle: async () => {},
    loadAllByUser: async () => [],
  };

  const notifier = {
    updated: () => {},
    created: () => {},
    error: () => {},
  };

  return new HedgeService(1, hl, null, { repo, notifier });
}

test('aplica leverage isolated del hedge antes de colocar la entry stop', async () => {
  const calls = [];
  const service = createService({
    updateLeverage: async (...args) => {
      calls.push(args);
    },
  });

  const hedge = {
    id: 99,
    asset: 'BTC',
    direction: 'long',
    size: 0.00042,
    leverage: 20,
    marginMode: 'isolated',
    status: 'entry_pending',
    assetIndex: null,
    szDecimals: null,
    positionSize: null,
    cycles: [],
    cycleCount: 0,
  };

  const result = await service._placeEntryOrder(hedge, { openOrders: [], openOrdersAvailable: true });

  assert.equal(result.placed, true);
  assert.deepEqual(calls, [[0, false, 20]]);
});
