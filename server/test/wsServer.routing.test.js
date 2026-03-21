const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');

const authService = require('../src/services/auth.service');
const hedgeRegistry = require('../src/services/hedge.registry');
const botRegistry = require('../src/services/bot.registry');
const hlRegistry = require('../src/services/hyperliquid.registry');
const hlWsClient = require('../src/websocket/hyperliquidWs');
const { createWsServer } = require('../src/websocket/wsServer');

function createFakeHedgeService({ userId, accountId, assets = [] }) {
  const listeners = new Map();
  return {
    userId,
    accountId,
    priceUpdates: [],
    fills: [],
    on(event, handler) {
      listeners.set(event, handler);
    },
    emit(event, ...args) {
      listeners.get(event)?.(...args);
    },
    getAll() {
      return assets.map((asset, index) => ({ id: index + 1, asset }));
    },
    onPriceUpdate(asset, price) {
      this.priceUpdates.push({ asset, price });
    },
    onFill(fill) {
      this.fills.push(fill);
    },
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `ws://${address.address}:${address.port}/ws`;
}

function waitForOpen(client) {
  return new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
}

function waitForMessage(client) {
  return new Promise((resolve, reject) => {
    client.once('message', (data) => resolve(JSON.parse(data.toString())));
    client.once('error', reject);
  });
}

function withWsServerTest(fn) {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalSubscribe = hlWsClient.subscribe;
  const originalAddSubscriber = hlWsClient.addSubscriber;
  const originalOnCreateHedge = hedgeRegistry.onCreate;
  const originalOnCreateBot = botRegistry.onCreate;
  const originalHlGet = hlRegistry.get;
  const originalHedgeGet = hedgeRegistry.get;
  const originalHedgeGetAll = hedgeRegistry.getAll;

  const server = http.createServer();

  let subscriber = null;
  let onCreateHedge = null;

  authService.validateSessionToken = async () => ({ id: 1, role: 'user', name: 'test' });
  hlWsClient.subscribe = () => {};
  hlWsClient.addSubscriber = (callback) => {
    subscriber = callback;
    return () => {};
  };
  hedgeRegistry.onCreate = (callback) => {
    onCreateHedge = callback;
    return () => {};
  };
  botRegistry.onCreate = () => {};

  const wss = createWsServer(server);

  return Promise.resolve()
    .then(() => fn({
      emitHlMessage: (message) => subscriber?.(message),
      registerHedgeService: (service) => onCreateHedge?.(service),
      setHyperliquidAccountResolver(resolver) {
        hlRegistry.get = resolver;
      },
      setHedgeResolvers({ get, getAll }) {
        hedgeRegistry.get = get;
        hedgeRegistry.getAll = getAll;
      },
    }))
    .finally(() => {
      authService.validateSessionToken = originalValidateSessionToken;
      hlWsClient.subscribe = originalSubscribe;
      hlWsClient.addSubscriber = originalAddSubscriber;
      hedgeRegistry.onCreate = originalOnCreateHedge;
      botRegistry.onCreate = originalOnCreateBot;
      hlRegistry.get = originalHlGet;
      hedgeRegistry.get = originalHedgeGet;
      hedgeRegistry.getAll = originalHedgeGetAll;
      wss.close();
      server.close();
    });
}

test('wsServer enruta ticks solo a servicios con assets indexados', async () => {
  await withWsServerTest(async ({
    emitHlMessage,
    registerHedgeService,
    setHyperliquidAccountResolver,
    setHedgeResolvers,
  }) => {
    const btcService = createFakeHedgeService({ userId: 1, accountId: 10, assets: ['BTC'] });
    const ethService = createFakeHedgeService({ userId: 2, accountId: 20, assets: ['ETH'] });

    setHyperliquidAccountResolver((userId, accountId) => ({
      address: `${userId}:${accountId}`,
    }));
    setHedgeResolvers({
      get: () => null,
      getAll: () => [btcService, ethService],
    });

    await registerHedgeService(btcService);
    await registerHedgeService(ethService);

    emitHlMessage({
      channel: 'allMids',
      data: {
        mids: {
          BTC: '70000',
          ETH: '2500',
          SOL: '140',
        },
      },
    });

    assert.deepEqual(btcService.priceUpdates, [{ asset: 'BTC', price: 70000 }]);
    assert.deepEqual(ethService.priceUpdates, [{ asset: 'ETH', price: 2500 }]);
  });
});

test('wsServer enruta fills por address indexado sin fallback global', async () => {
  await withWsServerTest(async ({
    emitHlMessage,
    registerHedgeService,
    setHyperliquidAccountResolver,
    setHedgeResolvers,
  }) => {
    const targetService = createFakeHedgeService({ userId: 7, accountId: 70, assets: ['BTC'] });
    const otherService = createFakeHedgeService({ userId: 8, accountId: 80, assets: ['ETH'] });

    setHyperliquidAccountResolver((userId, accountId) => {
      if (userId === 7 && accountId === 70) return { address: '0xTarget' };
      if (userId === 8 && accountId === 80) return { address: '0xOther' };
      return null;
    });
    setHedgeResolvers({
      get(userId, accountId) {
        if (userId === 7 && accountId === 70) return targetService;
        if (userId === 8 && accountId === 80) return otherService;
        return null;
      },
      getAll() {
        return [targetService, otherService];
      },
    });

    await registerHedgeService(targetService);
    await registerHedgeService(otherService);

    const fill = { oid: 111, px: '70000' };
    emitHlMessage({
      channel: 'userEvents',
      data: {
        user: '0xTARGET',
        fills: [fill],
      },
    });

    assert.deepEqual(targetService.fills, [fill]);
    assert.deepEqual(otherService.fills, []);
  });
});

test('wsServer retransmite partial_coverage al usuario autenticado', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalSubscribe = hlWsClient.subscribe;
  const originalAddSubscriber = hlWsClient.addSubscriber;
  const originalOnCreateHedge = hedgeRegistry.onCreate;
  const originalOnCreateBot = botRegistry.onCreate;
  const originalHlGet = hlRegistry.get;
  const originalHedgeGet = hedgeRegistry.get;
  const originalHedgeGetAll = hedgeRegistry.getAll;

  authService.validateSessionToken = async () => ({ id: 1, role: 'user', name: 'tester' });
  hlWsClient.subscribe = () => {};
  hlWsClient.addSubscriber = () => () => {};

  let onCreateHedge = null;
  hedgeRegistry.onCreate = (callback) => {
    onCreateHedge = callback;
    return () => {};
  };
  botRegistry.onCreate = () => {};
  hlRegistry.get = () => null;
  hedgeRegistry.get = () => null;
  hedgeRegistry.getAll = () => [];

  const server = http.createServer();
  const wss = createWsServer(server);
  const wsUrl = await listen(server);
  const hedgeService = createFakeHedgeService({ userId: 1, accountId: 10, assets: ['SOL'] });

  try {
    await onCreateHedge?.(hedgeService);

    const client = new WebSocket(wsUrl);
    await waitForOpen(client);
    client.send(JSON.stringify({ type: 'auth', token: 'valid-token' }));
    await waitForMessage(client); // connected

    const nextMessage = waitForMessage(client);
    hedgeService.emit(
      'partial_coverage',
      { id: 77, asset: 'SOL', status: 'entry_filled_pending_sl' },
      { actualSize: 0.1, expectedSize: 0.2, missingSize: 0.1 }
    );

    const message = await nextMessage;
    assert.equal(message.type, 'hedge_event');
    assert.equal(message.event, 'partial_coverage');
    assert.equal(message.hedge.id, 77);
    assert.equal(message.payload.missingSize, 0.1);
    client.close();
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    hlWsClient.subscribe = originalSubscribe;
    hlWsClient.addSubscriber = originalAddSubscriber;
    hedgeRegistry.onCreate = originalOnCreateHedge;
    botRegistry.onCreate = originalOnCreateBot;
    hlRegistry.get = originalHlGet;
    hedgeRegistry.get = originalHedgeGet;
    hedgeRegistry.getAll = originalHedgeGetAll;
    wss.clients.forEach((socket) => socket.terminate());
    wss.close();
    server.close();
  }
});
