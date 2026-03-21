const test = require('node:test');
const assert = require('node:assert/strict');

const HedgeService = require('../src/services/hedge.service');

function createService({ hlOverrides = {}, notifierOverrides = {} } = {}) {
  const repo = {
    create: async () => 2,
    save: async () => {},
    saveCycle: async () => {},
    loadAllByUser: async () => [],
  };

  const events = {
    created: 0,
    updated: 0,
    errors: [],
    partialCoverage: [],
  };

  const notifier = {
    created: () => { events.created += 1; },
    updated: () => { events.updated += 1; },
    opened: () => {},
    reconciled: () => {},
    protectionMissing: () => {},
    partialCoverage: (_hedge, payload) => { events.partialCoverage.push(payload); },
    cycleComplete: () => {},
    cancelled: () => {},
    error: (_hedge, err) => { events.errors.push(err.message); },
    ...notifierOverrides,
  };

  const hl = {
    getOpenOrders: async () => [],
    getPosition: async () => null,
    getUserFills: async () => [],
    cancelOrder: async () => ({}),
    placeOrder: async () => ({ oid: 999 }),
    getAllMids: async () => ({ BTC: '69900', ETH: '2490' }),
    getAssetMeta: async () => ({ index: 0, szDecimals: 5 }),
    updateLeverage: async () => ({}),
    ...hlOverrides,
  };

  const service = new HedgeService(
    1,
    { id: 10, alias: 'Test', address: '0x123' },
    hl,
    null,
    { repo, notifier }
  );

  service._placeEntryOrder = async () => {};
  return { service, events };
}

function buildHedge(overrides = {}) {
  return {
    id: 1,
    userId: 1,
    accountId: 10,
    account: { id: 10, alias: 'Test', address: '0x123' },
    asset: 'BTC',
    direction: 'short',
    entryPrice: 70000,
    exitPrice: 71000,
    dynamicAnchorPrice: 70000,
    size: 0.00771,
    leverage: 5,
    label: 'BTC Hedge',
    marginMode: 'isolated',
    status: 'entry_pending',
    createdAt: Date.now() - 60_000,
    openedAt: null,
    closedAt: null,
    openPrice: null,
    closePrice: null,
    unrealizedPnl: null,
    entryOid: 111,
    slOid: null,
    assetIndex: 0,
    szDecimals: 5,
    positionSize: null,
    error: null,
    cycles: [],
    cycleCount: 0,
    positionKey: '1:10:1:1:0',
    closingStartedAt: null,
    slPlacedAt: null,
    lastFillAt: null,
    lastReconciledAt: Date.now() - 60_000,
    entryFillOid: null,
    entryFillTime: null,
    entryFeePaid: 0,
    fundingAccum: 0,
    entryPlacedAt: Date.now() - 20_000,
    partialCoverageInfo: null,
    ...overrides,
  };
}

function bindRealPlaceEntryOrder(service) {
  service._placeEntryOrder = HedgeService.prototype._placeEntryOrder.bind(service);
}

test('permite una cobertura long y una short del mismo activo', async () => {
  const { service } = createService();

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
  const { service } = createService();

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

test('retarget pending hedge ignora al propio hedge en validacion de duplicados', async () => {
  let cancelCalls = 0;
  let placed = 0;
  const { service } = createService({
    hlOverrides: {
      cancelOrder: async () => { cancelCalls += 1; },
    },
  });
  const hedge = buildHedge({
    id: 5,
    asset: 'ETH',
    direction: 'long',
    entryPrice: 3500,
    exitPrice: 3325,
    size: 0.5,
    entryOid: 909,
    status: 'entry_pending',
  });
  service.hedges.set(hedge.id, hedge);
  service._ensureEntryConfig = async () => {};
  service._placeEntryOrder = async () => { placed += 1; };

  await service.retargetPendingHedge(hedge.id, {
    entryPrice: 3000,
    exitPrice: 2850,
    label: 'ETH Reentrada long',
  });

  assert.equal(cancelCalls, 1);
  assert.equal(placed, 1);
  assert.equal(hedge.entryPrice, 3000);
  assert.equal(hedge.exitPrice, 2850);
  assert.equal(hedge.label, 'ETH Reentrada long');
});

test('update open hedge exit ignora al propio hedge en validacion de duplicados', async () => {
  let ensured = 0;
  const { service } = createService();
  const hedge = buildHedge({
    id: 6,
    asset: 'ETH',
    direction: 'long',
    entryPrice: 3500,
    exitPrice: 3325,
    size: 0.5,
    status: 'open_protected',
    slOid: 888,
  });
  service.hedges.set(hedge.id, hedge);
  service._ensureEntryConfig = async () => {};
  service._ensureStopLoss = async () => {
    ensured += 1;
    hedge.status = 'open_protected';
    return { placed: true, transitioned: false };
  };

  await service.updateOpenHedgeExit(hedge.id, 3200);

  assert.equal(hedge.exitPrice, 3200);
  assert.equal(ensured, 1);
});

test('update open hedge dynamic anchor conserva entryPrice historico y recoloca SL', async () => {
  let ensured = 0;
  const { service } = createService();
  const hedge = buildHedge({
    id: 7,
    asset: 'ETH',
    direction: 'long',
    entryPrice: 90.9,
    dynamicAnchorPrice: 90.9,
    exitPrice: 90.85455,
    size: 0.5,
    status: 'open_protected',
    slOid: 777,
  });
  service.hedges.set(hedge.id, hedge);
  service._ensureEntryConfig = async () => {};
  service._ensureStopLoss = async () => {
    ensured += 1;
    hedge.status = 'open_protected';
    hedge.slOid = 999;
    return { placed: true, transitioned: false };
  };

  await service.updateOpenHedgeDynamicAnchor(hedge.id, {
    dynamicAnchorPrice: 110,
    exitPrice: 109.945,
    label: 'ETH Proteccion alza',
  });

  assert.equal(hedge.entryPrice, 90.9);
  assert.equal(hedge.dynamicAnchorPrice, 110);
  assert.equal(hedge.exitPrice, 109.945);
  assert.equal(hedge.label, 'ETH Proteccion alza');
  assert.equal(ensured, 1);
});

test('prioriza fill existente antes de forzar una IOC', async () => {
  let placeCalls = 0;
  let recovered = 0;
  const { service } = createService({
    hlOverrides: {
      getPosition: async () => ({ szi: '-0.00771', entryPx: '69920', unrealizedPnl: '0' }),
      placeOrder: async () => {
        placeCalls += 1;
        return { oid: 555 };
      },
    },
  });
  const hedge = buildHedge();

  service._recoverEntryFromExchange = async (target) => {
    recovered += 1;
    target.status = 'entry_filled_pending_sl';
    return true;
  };

  await service._reconcileTriggeredEntry(hedge, {
    currentPrice: 69900,
    openOrders: [{ oid: 111 }],
    openOrdersAvailable: true,
    source: 'monitor',
  });

  assert.equal(recovered, 1);
  assert.equal(placeCalls, 0);
  assert.equal(hedge.status, 'entry_filled_pending_sl');
});

test('regresion: monitor y websocket no pueden abrir dos veces el mismo ciclo', async () => {
  let getOpenOrdersCalls = 0;
  let cancelCalls = 0;
  let placeCalls = 0;
  const { service } = createService({
    hlOverrides: {
      getOpenOrders: async () => {
        getOpenOrdersCalls += 1;
        return getOpenOrdersCalls === 1 ? [{ oid: 111 }] : [];
      },
      cancelOrder: async () => {
        cancelCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
      placeOrder: async () => {
        placeCalls += 1;
        return { oid: 222 };
      },
    },
  });
  const hedge = buildHedge();

  service._ensureEntryConfig = async () => {};
  service._recoverEntryFromExchange = async () => false;

  await Promise.all([
    service._reconcileTriggeredEntry(hedge, { currentPrice: 69900, source: 'monitor' }),
    service._handleEntryTrigger(hedge, 69900),
  ]);

  assert.equal(cancelCalls, 1);
  assert.equal(placeCalls, 1);
  assert.equal(hedge.entryOid, 222);
});

test('no envia IOC si la cancelacion del trigger falla', async () => {
  let placeCalls = 0;
  const { service } = createService({
    hlOverrides: {
      getOpenOrders: async () => [{ oid: 111 }],
      cancelOrder: async () => {
        throw new Error('cancel failed');
      },
      placeOrder: async () => {
        placeCalls += 1;
        return { oid: 333 };
      },
    },
  });
  const hedge = buildHedge();

  service._ensureEntryConfig = async () => {};
  service._recoverEntryFromExchange = async () => false;

  await service._reconcileTriggeredEntry(hedge, {
    currentPrice: 69900,
    openOrders: [{ oid: 111 }],
    openOrdersAvailable: true,
    source: 'monitor',
  });

  assert.equal(placeCalls, 0);
  assert.equal(hedge.entryOid, 111);
  assert.match(hedge.error, /cancelacion no confirmada/);
  assert.equal(hedge.status, 'entry_pending');
});

test('si la orden desaparece pero la posicion ya existe, reconcilia sin abrir otra entrada', async () => {
  let placeCalls = 0;
  let recovered = 0;
  const { service } = createService({
    hlOverrides: {
      getOpenOrders: async () => [],
      getPosition: async () => ({ szi: '-0.00771', entryPx: '69920', unrealizedPnl: '0' }),
      placeOrder: async () => {
        placeCalls += 1;
        return { oid: 444 };
      },
    },
  });
  const hedge = buildHedge();

  service._recoverEntryFromExchange = async (target) => {
    recovered += 1;
    target.status = 'entry_filled_pending_sl';
    return true;
  };

  await service._reconcileTriggeredEntry(hedge, {
    currentPrice: 69900,
    openOrders: [],
    openOrdersAvailable: true,
    source: 'monitor',
  });

  assert.equal(recovered, 1);
  assert.equal(placeCalls, 0);
  assert.equal(hedge.status, 'entry_filled_pending_sl');
});

test('si la orden desaparece sin fill ni posicion, permite una sola IOC', async () => {
  let placeCalls = 0;
  const { service } = createService({
    hlOverrides: {
      getOpenOrders: async () => [],
      getPosition: async () => null,
      getUserFills: async () => [],
      placeOrder: async () => {
        placeCalls += 1;
        return { oid: 555 };
      },
    },
  });
  const hedge = buildHedge({
    asset: 'ETH',
    label: 'ETH Hedge',
    entryPrice: 2500,
    exitPrice: 2550,
    size: 0.2,
    entryOid: 777,
  });

  service._ensureEntryConfig = async () => {};

  await service._reconcileTriggeredEntry(hedge, {
    currentPrice: 2490,
    openOrders: [],
    openOrdersAvailable: true,
    source: 'monitor',
  });

  assert.equal(placeCalls, 1);
  assert.equal(hedge.entryOid, 555);
  assert.equal(hedge.asset, 'ETH');
});

test('bloquea una nueva stop entry mientras el rescate IOC sigue en progreso', async () => {
  let placeTriggerEntryCalls = 0;
  let resolvePlaceOrder;
  let markPlaceOrderStarted;
  const placeOrderStarted = new Promise((resolve) => { markPlaceOrderStarted = resolve; });
  const placeOrderPending = new Promise((resolve) => { resolvePlaceOrder = resolve; });
  const { service } = createService({
    hlOverrides: {
      cancelOrder: async () => ({}),
      getOpenOrders: async () => [],
      getPosition: async () => null,
      placeOrder: async () => {
        markPlaceOrderStarted();
        return placeOrderPending;
      },
      placeTriggerEntry: async () => {
        placeTriggerEntryCalls += 1;
        return 4321;
      },
    },
  });
  const hedge = buildHedge();

  service._ensureEntryConfig = async () => {};
  service._recoverEntryFromExchange = async () => false;
  bindRealPlaceEntryOrder(service);

  const rescuePromise = service._reconcileTriggeredEntry(hedge, {
    currentPrice: 69900,
    openOrders: [{ oid: 111 }],
    openOrdersAvailable: true,
    source: 'monitor',
  });

  await placeOrderStarted;
  const placeResult = await service._placeEntryOrder(hedge, {
    openOrders: [],
    openOrdersAvailable: true,
  });

  assert.equal(placeResult.placed, false);
  assert.equal(placeResult.reason, 'transition_in_progress');
  assert.equal(placeTriggerEntryCalls, 0);

  resolvePlaceOrder({ oid: 222 });
  await rescuePromise;
  assert.equal(hedge.entryOid, 222);
});

test('monitor no rearma una entry faltante si el rescate sigue en progreso', async () => {
  let placeTriggerEntryCalls = 0;
  const { service } = createService({
    hlOverrides: {
      getOpenOrders: async () => [],
      getPosition: async () => null,
      placeTriggerEntry: async () => {
        placeTriggerEntryCalls += 1;
        return 1234;
      },
    },
  });
  const hedge = buildHedge({
    entryOid: null,
    entryPlacedAt: null,
  });

  hedge._entryRescueInProgress = true;
  service.hedges.set(hedge.id, hedge);
  bindRealPlaceEntryOrder(service);
  service._ensureEntryConfig = async () => {};

  await service._monitorPositions();

  assert.equal(placeTriggerEntryCalls, 0);
  assert.equal(hedge.entryOid, null);
});

test('monitor no recoloca una entry desaparecida si el rescate sigue en progreso', async () => {
  let placeTriggerEntryCalls = 0;
  let recoverCalls = 0;
  const { service } = createService({
    hlOverrides: {
      getOpenOrders: async () => [],
      getPosition: async () => null,
      placeTriggerEntry: async () => {
        placeTriggerEntryCalls += 1;
        return 9876;
      },
    },
  });
  const hedge = buildHedge();

  hedge._entryRescueInProgress = true;
  service.hedges.set(hedge.id, hedge);
  bindRealPlaceEntryOrder(service);
  service._ensureEntryConfig = async () => {};
  service._recoverEntryFromExchange = async () => {
    recoverCalls += 1;
    return false;
  };

  await service._monitorPositions();

  assert.equal(placeTriggerEntryCalls, 0);
  assert.equal(recoverCalls, 0);
  assert.equal(hedge.entryOid, 111);
});

test('marca error si detecta una posicion mayor al tamano esperado', async () => {
  let placeCalls = 0;
  const cancelledOids = [];
  const { service, events } = createService({
    hlOverrides: {
      getOpenOrders: async () => [{ oid: 111, coin: 'BTC', side: 'A', sz: '0.00771', reduceOnly: false }],
      cancelOrder: async (_assetIndex, oid) => { cancelledOids.push(oid); },
      getPosition: async () => ({ szi: '-0.01542', entryPx: '69920', unrealizedPnl: '0' }),
      placeOrder: async () => {
        placeCalls += 1;
        return { oid: 666 };
      },
    },
  });
  const hedge = buildHedge();

  await service._reconcileTriggeredEntry(hedge, {
    currentPrice: 69900,
    openOrders: [{ oid: 111 }],
    openOrdersAvailable: true,
    source: 'monitor',
  });

  assert.equal(placeCalls, 0);
  assert.equal(hedge.status, 'error');
  assert.match(hedge.error, /Posicion sobredimensionada detectada/);
  assert.equal(events.errors.length, 1);
  assert.deepEqual(cancelledOids, [111]);
});

test('fill parcial cancela entradas remanentes y notifica cobertura insuficiente', async () => {
  const cancelledOids = [];
  let ensured = 0;
  const { service, events } = createService({
    hlOverrides: {
      getAllMids: async () => ({ BTC: '69960', ETH: '2490' }),
      getPosition: async () => ({ szi: '-0.004', entryPx: '69950', unrealizedPnl: '0' }),
      getOpenOrders: async () => [
        { oid: 991, coin: 'BTC', side: 'A', sz: '0.00771', reduceOnly: false },
      ],
      cancelOrder: async (_assetIndex, oid) => { cancelledOids.push(oid); },
    },
  });
  const hedge = buildHedge();

  service._ensureStopLoss = async (target) => {
    ensured += 1;
    target.status = 'open_protected';
    return { placed: true, transitioned: true };
  };

  await service._onEntryFill(hedge, {
    oid: 111,
    px: '69950',
    sz: '0.004',
    time: Date.now(),
    fee: '0.01',
  });

  assert.equal(ensured, 1);
  assert.equal(hedge.status, 'open_protected');
  assert.equal(hedge.positionSize, 0.004);
  assert.deepEqual(cancelledOids, [991]);
  assert.equal(events.partialCoverage.length, 1);
  assert.match(events.partialCoverage[0].message, /Cobertura parcial detectada/);
});

test('fill parcial cancela todas las entradas relacionadas aunque tengan tamano distinto', async () => {
  const cancelledOids = [];
  let ensured = 0;
  const { service, events } = createService({
    hlOverrides: {
      getAllMids: async () => ({ BTC: '69960', ETH: '2490' }),
      getPosition: async () => ({ szi: '-0.004', entryPx: '69950', unrealizedPnl: '0' }),
      getOpenOrders: async () => [
        { oid: 991, coin: 'BTC', side: 'A', sz: '0.00771', reduceOnly: false },
        { oid: 992, coin: 'BTC', side: 'A', sz: '0.00321', reduceOnly: false },
        { oid: 993, coin: 'BTC', side: 'B', sz: '0.004', reduceOnly: true },
      ],
      cancelOrder: async (_assetIndex, oid) => { cancelledOids.push(oid); },
    },
  });
  const hedge = buildHedge();

  service._ensureStopLoss = async (target) => {
    ensured += 1;
    target.status = 'open_protected';
    return { placed: true, transitioned: true };
  };

  await service._onEntryFill(hedge, {
    oid: 111,
    px: '69950',
    sz: '0.004',
    time: Date.now(),
    fee: '0.01',
  });

  assert.equal(ensured, 1);
  assert.equal(hedge.status, 'open_protected');
  assert.equal(hedge.positionSize, 0.004);
  assert.deepEqual(cancelledOids.sort((a, b) => a - b), [991, 992]);
  assert.equal(events.partialCoverage.length, 1);
});

test('no duplica la alerta de cobertura parcial si el tamano abierto no cambia', async () => {
  const { service, events } = createService();
  const hedge = buildHedge();

  const first = await service._notifyPartialCoverage(hedge, 0.004, 'entry_fill');
  const second = await service._notifyPartialCoverage(hedge, 0.004, 'entry_fill');

  assert.ok(first);
  assert.equal(second, first);
  assert.equal(events.partialCoverage.length, 1);
  assert.equal(hedge.partialCoverageInfo.actualSize, 0.004);
  assert.ok(Math.abs(hedge.partialCoverageInfo.missingSize - 0.00371) < 1e-12);
});

test('reutiliza un SL existente si slOid se perdio antes de recolocarlo', async () => {
  let placeSlCalls = 0;
  const { service } = createService({
    hlOverrides: {
      getPosition: async () => ({ szi: '-0.00771', entryPx: '69920', unrealizedPnl: '0' }),
      getOpenOrders: async () => [{
        oid: 4321,
        coin: 'BTC',
        side: 'B',
        sz: '0.00771',
        reduceOnly: true,
      }],
      placeSL: async () => {
        placeSlCalls += 1;
        return 9999;
      },
    },
  });
  const hedge = buildHedge({
    status: 'entry_filled_pending_sl',
    entryOid: null,
    slOid: null,
    positionSize: 0.00771,
  });

  const result = await service._ensureStopLoss(hedge);

  assert.equal(placeSlCalls, 0);
  assert.equal(result.placed, false);
  assert.equal(hedge.slOid, 4321);
  assert.equal(hedge.status, 'open_protected');
});
