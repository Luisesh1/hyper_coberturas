const test = require('node:test');
const assert = require('node:assert/strict');

const { WalletMetricsService } = require('../src/services/wallet-metrics.service');

function fakeRepo(wallets, lastAt = new Map()) {
  const saved = [];
  return {
    saved,
    syncCalls: 0,
    async syncFromOrchestrators() { this.syncCalls += 1; return { changed: 0 }; },
    async listActiveForCapture() { return wallets; },
    async getLatestCapturedAt() { return lastAt; },
    async saveCapture(walletId, snapshot, detail) {
      saved.push({ walletId, snapshot, detail });
      return snapshot;
    },
  };
}

const NOW = 1_800_000_000_000;

test('captureAll: lee una vez una direccion compartida y guarda un punto por wallet', async () => {
  const repo = fakeRepo([
    { id: 1, userId: 10, address: '0xaa', lastDetail: null },
    { id: 2, userId: 20, address: '0xaa', lastDetail: null },
    { id: 3, userId: 10, address: '0xbb', lastDetail: null },
  ]);
  const calls = [];
  const svc = new WalletMetricsService({
    repo,
    now: () => NOW,
    collect: async ({ userId, address }) => {
      calls.push({ userId, address });
      return { hl: { ok: true, usd: 10, items: [] } };
    },
  });

  const res = await svc.captureAll();
  assert.equal(repo.syncCalls, 1);
  assert.deepEqual(calls, [{ userId: 10, address: '0xaa' }, { userId: 10, address: '0xbb' }]);
  assert.deepEqual(res, { captured: 3, failed: 0 });
  assert.deepEqual(repo.saved.map((s) => s.walletId), [1, 2, 3]);
  assert.equal(repo.saved[0].snapshot.totalUsd, 10);
  assert.equal(repo.saved[0].detail.capturedAt, NOW);
});

test('captureAll: una fuente caida reusa el ultimo detalle de la propia wallet', async () => {
  const lastDetail = { sources: { hl: { usd: 70, items: [], lastOkAt: NOW - 3600_000 } } };
  const repo = fakeRepo([{ id: 1, userId: 10, address: '0xaa', lastDetail }]);
  const svc = new WalletMetricsService({
    repo,
    now: () => NOW,
    collect: async () => ({ hl: { ok: false, error: 'down' } }),
  });
  await svc.captureAll();
  const { snapshot } = repo.saved[0];
  assert.equal(snapshot.hlUsd, 70);
  assert.equal(snapshot.isPartial, true);
  assert.deepEqual(snapshot.staleSources, [{ key: 'hl', lastOkAt: NOW - 3600_000 }]);
});

test('captureAll onlyDue: omite wallets con un punto de hace menos de 50 min', async () => {
  const repo = fakeRepo(
    [
      { id: 1, userId: 10, address: '0xaa', lastDetail: null },
      { id: 2, userId: 10, address: '0xbb', lastDetail: null },
      { id: 3, userId: 10, address: '0xcc', lastDetail: null },
    ],
    new Map([[1, NOW - 10 * 60_000], [2, NOW - 2 * 3600_000]])
  );
  const seen = [];
  const svc = new WalletMetricsService({
    repo,
    now: () => NOW,
    collect: async ({ address }) => { seen.push(address); return {}; },
  });
  await svc.captureAll({ onlyDue: true });
  assert.deepEqual(seen, ['0xbb', '0xcc']);
});

test('captureAll: un fallo al leer una direccion no frena las demas', async () => {
  const repo = fakeRepo([
    { id: 1, userId: 10, address: '0xaa', lastDetail: null },
    { id: 2, userId: 10, address: '0xbb', lastDetail: null },
  ]);
  const svc = new WalletMetricsService({
    repo,
    now: () => NOW,
    collect: async ({ address }) => {
      if (address === '0xaa') throw new Error('boom');
      return {};
    },
  });
  const res = await svc.captureAll();
  assert.deepEqual(res, { captured: 1, failed: 1 });
  assert.equal(svc.running, false);
});
