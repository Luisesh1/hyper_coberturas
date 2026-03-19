const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');

const authService = require('../src/services/auth.service');
const hedgeRegistry = require('../src/services/hedge.registry');
const botRegistry = require('../src/services/bot.registry');
const hlWsClient = require('../src/websocket/hyperliquidWs');
const { createWsServer } = require('../src/websocket/wsServer');

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

function waitForEventSequence(client, executor) {
  return new Promise((resolve, reject) => {
    let message = null;
    let closed = null;

    const onMessage = (data) => {
      message = JSON.parse(data.toString());
      if (closed) finish();
    };
    const onClose = (code, reason) => {
      closed = { code, reason: reason.toString() };
      if (message) finish();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };

    function cleanup() {
      client.off('message', onMessage);
      client.off('close', onClose);
      client.off('error', onError);
    }

    function finish() {
      cleanup();
      resolve({ message, closed });
    }

    client.on('message', onMessage);
    client.on('close', onClose);
    client.on('error', onError);

    Promise.resolve()
      .then(executor)
      .catch((err) => {
        cleanup();
        reject(err);
      });
  });
}

test.skip('WebSocket rechaza token de usuario inexistente por query param', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalSubscribe = hlWsClient.subscribe;
  const originalAddSubscriber = hlWsClient.addSubscriber;
  const originalOnCreateHedge = hedgeRegistry.onCreate;
  const originalOnCreateBot = botRegistry.onCreate;

  authService.validateSessionToken = async () => {
    throw new Error('Sesión inválida');
  };
  hlWsClient.subscribe = () => {};
  hlWsClient.addSubscriber = () => () => {};
  hedgeRegistry.onCreate = () => {};
  botRegistry.onCreate = () => {};

  const server = http.createServer();
  const wss = createWsServer(server);
  const wsUrl = await listen(server);

  try {
    const client = new WebSocket(`${wsUrl}?token=valid-signed-token`);
    await waitForOpen(client);
    const { message, closed } = await waitForEventSequence(client, async () => {});

    assert.equal(message.type, 'error');
    assert.match(message.message, /sesión inválida/i);
    assert.equal(closed.code, 4001);
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    hlWsClient.subscribe = originalSubscribe;
    hlWsClient.addSubscriber = originalAddSubscriber;
    hedgeRegistry.onCreate = originalOnCreateHedge;
    botRegistry.onCreate = originalOnCreateBot;
    wss.clients.forEach((socket) => socket.terminate());
    wss.close();
    server.close();
  }
});

test.skip('WebSocket autentica con el usuario vigente y no con claims stale del token', async () => {
  const originalValidateSessionToken = authService.validateSessionToken;
  const originalSubscribe = hlWsClient.subscribe;
  const originalAddSubscriber = hlWsClient.addSubscriber;
  const originalOnCreateHedge = hedgeRegistry.onCreate;
  const originalOnCreateBot = botRegistry.onCreate;

  authService.validateSessionToken = async () => ({
    id: 7,
    username: 'actual-user',
    name: 'Actual User',
    role: 'superuser',
    active: true,
  });
  hlWsClient.subscribe = () => {};
  hlWsClient.addSubscriber = () => () => {};
  hedgeRegistry.onCreate = () => {};
  botRegistry.onCreate = () => {};

  const server = http.createServer();
  const wss = createWsServer(server);
  const wsUrl = await listen(server);

  try {
    const client = new WebSocket(wsUrl);
    await waitForOpen(client);
    const nextMessage = waitForMessage(client);
    client.send(JSON.stringify({ type: 'auth', token: 'signed-token-with-old-claims' }));
    const message = await nextMessage;

    assert.equal(message.type, 'connected');
    const [socket] = [...wss.clients];
    assert.equal(socket.userId, 7);
    assert.equal(socket.userRole, 'superuser');
    client.close();
  } finally {
    authService.validateSessionToken = originalValidateSessionToken;
    hlWsClient.subscribe = originalSubscribe;
    hlWsClient.addSubscriber = originalAddSubscriber;
    hedgeRegistry.onCreate = originalOnCreateHedge;
    botRegistry.onCreate = originalOnCreateBot;
    wss.clients.forEach((socket) => socket.terminate());
    wss.close();
    server.close();
  }
});
