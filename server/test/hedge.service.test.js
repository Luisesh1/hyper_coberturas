const test = require('node:test');
const assert = require('node:assert/strict');

const HedgeService = require('../src/services/hedge.service');

function createService() {
  const repo = {
    create: async () => 2,
    save: async () => {},
    saveCycle: async () => {},
    loadAllByUser: async () => [],
  };

  const notifier = {
    created: () => {},
    updated: () => {},
    error: () => {},
  };

  const service = new HedgeService(1, { id: 10, alias: 'Test', address: '0x123' }, {}, null, { repo, notifier });
  service._placeEntryOrder = async () => {};
  return service;
}

test('permite una cobertura long y una short del mismo activo', async () => {
  const service = createService();

  service.hedges.set(1, {
    id: 1,
    asset: 'BTC',
    direction: 'short',
    status: 'entry_pending',
  });

  const hedge = await service.createHedge({
    asset: 'BTC',
    direction: 'long',
    entryPrice: 70000,
    exitPrice: 69000,
    size: 0.001,
    leverage: 5,
  });

  assert.equal(hedge.asset, 'BTC');
  assert.equal(hedge.direction, 'long');
});

test('rechaza una segunda cobertura activa con el mismo activo y direccion', async () => {
  const service = createService();

  service.hedges.set(1, {
    id: 1,
    asset: 'BTC',
    direction: 'short',
    status: 'entry_pending',
  });

  await assert.rejects(
    () =>
      service.createHedge({
        asset: 'BTC',
        direction: 'short',
        entryPrice: 70000,
        exitPrice: 71000,
        size: 0.001,
        leverage: 5,
      }),
    /Ya existe una cobertura SHORT activa para BTC/
  );
});
