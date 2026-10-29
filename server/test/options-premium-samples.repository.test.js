const test = require('node:test');
const assert = require('node:assert/strict');
const { createOptionsPremiumSamplesRepository } = require('../src/repositories/options-premium-samples.repository');

function capturingDb(rows = [], rowCount = 1) {
  const calls = [];
  return { calls, async query(sql, args) { calls.push({ sql, args }); return { rows, rowCount }; } };
}

test('insertSample: ON CONFLICT DO NOTHING; false si la marca ya existía', async () => {
  const db = capturingDb([], 0);
  const repo = createOptionsPremiumSamplesRepository({ db });
  assert.equal(await repo.insertSample(7, 1000, { bid: 1, ask: 2, spot: 3 }), false);
  assert.match(db.calls[0].sql, /ON CONFLICT DO NOTHING/);
  assert.deepEqual(db.calls[0].args, [7, 1000, 1, 2, 3]);
});

test('listPremiumSamples: agrupa por posición, ordena por at y devuelve números', async () => {
  const db = capturingDb([
    { position_id: '7', sampled_at: '1000', bid: '1.5', ask: null, spot: '80000' },
    { position_id: '7', sampled_at: '2000', bid: '1.6', ask: '1.9', spot: null },
    { position_id: '8', sampled_at: '1500', bid: null, ask: '4', spot: '2400' },
  ]);
  const repo = createOptionsPremiumSamplesRepository({ db });
  const map = await repo.listPremiumSamples([7, 8, 9]);
  assert.match(db.calls[0].sql, /ORDER BY position_id, sampled_at/);
  assert.deepEqual(map.get(7), [
    { at: 1000, bid: 1.5, ask: null, spot: 80000 },
    { at: 2000, bid: 1.6, ask: 1.9, spot: null },
  ]);
  assert.deepEqual(map.get(8), [{ at: 1500, bid: null, ask: 4, spot: 2400 }]);
  assert.equal(map.has(9), false);
  assert.equal((await repo.listPremiumSamples([])).size, 0);
});

test('deleteOlderThan: borra por sampled_at', async () => {
  const db = capturingDb([], 5);
  const repo = createOptionsPremiumSamplesRepository({ db });
  assert.equal(await repo.deleteOlderThan(123), 5);
  assert.match(db.calls[0].sql, /sampled_at < \$1/);
});
