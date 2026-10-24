const test = require('node:test');
const assert = require('node:assert/strict');
const { createOptionsLiveExercisesRepository } =
  require('../src/repositories/options-live-exercises.repository');

const proof = {
  userId: 7, symbol: 'BTC-261016-60000-C', side: 'BUY',
  recordId: '1125899906842624042', quantity: 0.2,
  payoffUsdt: 500, feeUsdt: 1.25, exercisedAt: 1770969600000,
};

function stub({ positions = [] , oldRecord = null } = {}) {
  const calls = [];
  const tx = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('SELECT * FROM options_live_exercises')) {
      return { rows: oldRecord ? [oldRecord] : [] };
    }
    if (sql.includes('SELECT * FROM options_strategy_positions')) {
      return { rows: positions };
    }
    if (sql.startsWith('UPDATE options_strategy_positions')) return { rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  return {
    calls,
    repo: createOptionsLiveExercisesRepository({
      db: { transaction: (fn) => fn(tx) }, now: () => 1770969900000,
    }),
  };
}
const position = (id, strategyId, quantity, entry) => ({
  id, user_id: 7, strategy_id: strategyId, side: 'BUY', mode: 'live',
  quantity: String(quantity), entry_price: String(entry),
  fees_usdt: '0.5', opened_at: 1770000000000,
});

test('ejercicio real: liquida proporcionalmente varios lotes/bots y conserva auditoría', async () => {
  const f = stub({ positions: [position(1, 8, 0.1, 120), position(2, 9, 0.1, 140)] });
  assert.equal(await f.repo.applyExercise(proof), true);
  const updates = f.calls.filter((c) => c.sql.startsWith('UPDATE options_strategy_positions'));
  const events = f.calls.filter((c) => c.sql.includes('INSERT INTO options_strategy_events'));
  assert.equal(updates.length, 2);
  assert.equal(events.length, 2);
  assert.equal(updates[0].params[1], 2500); // payoff / 0.2
  assert.equal(updates[1].params[1], 2500);
  assert.ok(Math.abs(updates[0].params[4] - 1.125) < 1e-9);
  assert.ok(Math.abs(updates[0].params[3] - (2500 - 120) * 0.1 + 1.125) < 1e-9);
  assert.equal(f.calls.filter((c) => c.sql.includes('INSERT INTO options_live_exercises')).length, 1);
  assert.ok(events[0].params[3].includes(proof.recordId));
});
test('ejercicio real: rechaza cantidad inconsistente ANTES de registrar evento', async () => {
  const f = stub({ positions: [position(1, 8, 0.1, 120)] });
  await assert.rejects(f.repo.applyExercise(proof), /quantity does not match/);
  assert.equal(f.calls.some((c) => c.sql.includes('INSERT INTO options_live_exercises')), false);
});
test('ejercicio real: un mismo recordId se aplica una sola vez tras reinicio', async () => {
  const f = stub({ oldRecord: {
    symbol: proof.symbol, position_side: 'LONG',
    quantity: '0.2', payoff_usdt: '500', fee_usdt: '1.25',
  } });
  assert.equal(await f.repo.applyExercise(proof), false);
  assert.equal(f.calls.some((c) => c.sql.includes('UPDATE options_strategy_positions')), false);
  await assert.rejects(f.repo.applyExercise({ ...proof, payoffUsdt: 900 }), /differs from Binance/);
});

test('live exercise books the exercise fee and keeps the entry fee', async () => {
  const f = stub({ positions: [position(1, 8, 0.1, 120), position(2, 9, 0.1, 140)] });
  await f.repo.applyExercise(proof);
  const updates = f.calls.filter((c) => c.sql.startsWith('UPDATE options_strategy_positions'));
  for (const u of updates) {
    assert.match(u.sql, /entry_fee_usdt=COALESCE\(entry_fee_usdt,\$6\),exercise_fee_usdt=\$7/);
    const [, , , , fees, entry, exercise] = u.params;
    assert.equal(entry, 0.5);
    assert.ok(Math.abs(exercise - 0.625) < 1e-12);
    assert.ok(Math.abs(fees - (entry + exercise)) < 1e-12);
  }
});
