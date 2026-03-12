const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const app = require('../src/app');
const db = require('../src/db');
const hlWsClient = require('../src/websocket/hyperliquidWs');
const runtimeStatus = require('../src/runtime/status');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://${address.address}:${address.port}`;
}

test('GET /api/health responde liveness', async () => {
  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/health`);
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.status, 'ok');
    assert.ok(json.requestId);
  } finally {
    server.close();
  }
});

test('GET /api/health/ready responde degraded cuando runtime no está listo', async () => {
  const originalEnsureConnection = db.ensureConnection;
  const originalIsConnected = hlWsClient.isConnected;
  const originalSnapshot = runtimeStatus.snapshot;

  db.ensureConnection = async () => {};
  hlWsClient.isConnected = false;
  runtimeStatus.snapshot = () => ({
    bootstrapped: false,
    lastBootstrapAt: null,
    lastBootstrapError: 'boot_failed',
  });

  const server = http.createServer(app);
  const baseUrl = await listen(server);

  try {
    const res = await fetch(`${baseUrl}/api/health/ready`);
    const json = await res.json();

    assert.equal(res.status, 503);
    assert.equal(json.status, 'degraded');
    assert.equal(json.checks.db, true);
    assert.equal(json.checks.bootstrapped, false);
  } finally {
    db.ensureConnection = originalEnsureConnection;
    hlWsClient.isConnected = originalIsConnected;
    runtimeStatus.snapshot = originalSnapshot;
    server.close();
  }
});
