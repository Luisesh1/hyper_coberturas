const test = require('node:test');
const assert = require('node:assert/strict');
const { createOptionsStrategiesRepository } = require('../src/repositories/options-strategies.repository');

const signalRow = (over = {}) => ({
  id: '31', strategy_id: '4', alert_id: '11', alert_event_id: '9001', alert_name: 'A', direction: 'bullish',
  asset: 'BTC', score: '3', decision: 'opened', detail: 'ok', simulated: false, created_at: '1000',
  fees_usdt: '4.08', fees_estimated: false, ...over,
});

function capturingDb(rows = []) {
  const calls = [];
  return { calls, async query(sql, args) { calls.push({ sql, args }); return { rows }; } };
}

test('mapAutoSignal expone feesUsdt y feesEstimated', async () => {
  const db = capturingDb([signalRow(), signalRow({ id: '32', fees_usdt: null, fees_estimated: true })]);
  const repo = createOptionsStrategiesRepository({ db });
  const [a, b] = await repo.listAutoSignals(4);
  assert.equal(a.feesUsdt, 4.08);
  assert.equal(a.feesEstimated, false);
  assert.equal(b.feesUsdt, null);
  assert.equal(b.feesEstimated, true);
});

test('resolveAutoSignal sobrescribe pending y el opened provisional, con comisiones', async () => {
  const db = capturingDb([signalRow({ decision: 'ignored', fees_usdt: '0', fees_estimated: false })]);
  const repo = createOptionsStrategiesRepository({ db });
  const out = await repo.resolveAutoSignal(31, { decision: 'ignored', detail: 'Sin ejecución', feesUsdt: 0, feesEstimated: false });
  assert.equal(out.decision, 'ignored');
  assert.equal(out.feesUsdt, 0);
  const { sql, args } = db.calls[0];
  assert.match(sql, /UPDATE options_auto_signals/);
  assert.match(sql, /decision IN \('pending','opened'\)/);
  assert.match(sql, /fees_usdt = COALESCE\(\$4::numeric, fees_usdt\)/);
  assert.match(sql, /fees_estimated = COALESCE\(\$5::boolean, fees_estimated\)/);
  assert.deepEqual(args, [31, 'ignored', 'Sin ejecución', 0, false]);
  await repo.resolveAutoSignal(31, { decision: 'opened' });
  assert.deepEqual(db.calls[1].args, [31, 'opened', null, null, null]);
  db.calls.length = 0;
  const empty = createOptionsStrategiesRepository({ db: capturingDb([]) });
  assert.equal(await empty.resolveAutoSignal(31, { decision: 'closed' }), null);
  await assert.rejects(repo.resolveAutoSignal(31, { decision: 'pending' }), /Invalid signal decision/);
});

test('setAutoSignalFees fija comisión y si es estimada', async () => {
  const db = capturingDb([signalRow({ decision: 'pending', fees_usdt: '7.14', fees_estimated: true })]);
  const repo = createOptionsStrategiesRepository({ db });
  const out = await repo.setAutoSignalFees(31, { feesUsdt: 7.14, feesEstimated: true });
  assert.equal(out.feesUsdt, 7.14);
  assert.equal(out.feesEstimated, true);
  assert.match(db.calls[0].sql, /SET fees_usdt = \$2, fees_estimated = \$3/);
  assert.deepEqual(db.calls[0].args, [31, 7.14, true]);
});

test('setUnderlyingBlock fusiona en state.blockedUnderlyings en SQL sin pisar otras claves', async () => {
  const db = capturingDb([{ id: '4', user_id: '7', name: 'B', template: 'alert_signal', underlying: 'BTC',
    params: {}, limits: {}, mode: 'live', created_at: '1', updated_at: '1',
    state: { lastReasons: { BTC: 'x' }, blockedUnderlyings: { ETH: { reason: 'insufficient_balance', at: 5 } } } }]);
  const repo = createOptionsStrategiesRepository({ db });
  const out = await repo.setUnderlyingBlock(4, 'eth', { reason: 'insufficient_balance', at: 5 });
  assert.deepEqual(out.state.blockedUnderlyings.ETH, { reason: 'insufficient_balance', at: 5 });
  const { sql, args } = db.calls[0];
  assert.match(sql, /jsonb_set/);
  assert.match(sql, /'\{blockedUnderlyings\}'/);
  assert.match(sql, /\|\| jsonb_build_object\(\$2::text/);
  assert.doesNotMatch(sql, /SET state = \$/);
  assert.deepEqual(args, [4, 'ETH', 'insufficient_balance', 5]);
  await assert.rejects(repo.setUnderlyingBlock(4, '', { reason: 'x', at: 1 }), /Invalid underlying/);
});

test('clearUnderlyingBlock quita solo la clave del subyacente', async () => {
  const db = capturingDb([]);
  const repo = createOptionsStrategiesRepository({ db });
  assert.equal(await repo.clearUnderlyingBlock(4, 'btc'), null);
  const { sql, args } = db.calls[0];
  assert.match(sql, /\(state->'blockedUnderlyings'\) - \$2::text/);
  assert.match(sql, /jsonb_typeof\(state->'blockedUnderlyings'\) = 'object'/);
  assert.deepEqual(args, [4, 'BTC']);
});
