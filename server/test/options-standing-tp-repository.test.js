const test = require('node:test');
const assert = require('node:assert/strict');
const { createOptionsLiveOrdersRepository } = require('../src/repositories/options-live-orders.repository');

const SYMBOL = 'BTC-261030-100000-C';
const held = { id: '100', strategy_id: '4', user_id: '7', symbol: SYMBOL,
  mode: 'live', side: 'BUY', quantity: '0.2', closed_at: null };
const strategy = { id: 4, userId: 7 };

test('deferExitIfProtected registra cierre durable y solicita cancelar TP bajo advisory lock', async () => {
  const sqls = [];
  const tx = { async query(sql, args) {
    sqls.push({ sql, args });
    if (sql.includes('FROM options_strategies')) return {
      rows: [{ id: 4, user_id: 7, mode: 'live' }],
    };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM options_strategy_positions')) return { rows: [held] };
    if (sql.includes('SELECT id FROM options_live_orders')) return { rows: [{ id: 15 }] };
    if (sql.includes('INSERT INTO options_live_exit_requests')) return { rows: [] };
    if (sql.includes('UPDATE options_live_orders SET cancel_requested')) return { rowCount: 1 };
    throw Error('Unexpected SQL: ' + sql);
  } };
  const repo = createOptionsLiveOrdersRepository({
    db: { transaction: (f) => f(tx) }, now: () => 50000,
  });
  assert.equal(await repo.deferExitIfProtected(strategy, {
    type: 'close', reason: 'stop_loss',
    legs: [{ positionId: 100, symbol: SYMBOL, side: 'SELL', quantity: 0.2 }],
  }), true);
  assert.ok(sqls.some((x) => x.sql.includes('pg_advisory_xact_lock')));
  assert.ok(sqls.some((x) => x.sql.includes('INSERT INTO options_live_exit_requests')));
  assert.ok(sqls.some((x) => x.sql.includes('cancel_requested=TRUE')));
});

test('beginStandingTp registra TP reduceOnly como close en el ledger sin POST', async () => {
  const sqls = [];
  const tx = { async query(sql, args) {
    sqls.push({ sql, args });
    if (sql.includes('FROM options_strategies')) return {
      rows: [{ id: 4, user_id: 7, mode: 'live', template: 'alert_signal', underlying: 'BTC' }],
    };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM options_strategy_positions')) return { rows: [held] };
    if (sql.includes('UNION ALL SELECT id FROM options_live_exit_requests')) return { rows: [] };
    if (sql.includes('SELECT COUNT(*)::int AS n FROM options_live_orders')) return { rows: [{ n: 0 }] };
    if (sql.includes('INSERT INTO options_live_batches')) return { rows: [{ id: '28' }] };
    if (sql.includes('INSERT INTO options_live_orders')) return { rows: [{
      id: '33', batch_id: '28', strategy_id: '4', user_id: '7',
      action: 'close', position_id: '100', symbol: SYMBOL, side: 'SELL',
      requested_qty: '0.2', limit_price: '180', processed_qty: '0',
      client_order_id: 'HCsT0', exchange_order_id: null, status: 'queued',
      purpose: 'take_profit', created_at: '50000', deadline_at: '100000', updated_at: '50000',
    }] };
    throw Error('Unexpected SQL ' + sql);
  } };
  const repo = createOptionsLiveOrdersRepository({ db: { transaction: (f) => f(tx) },
    now: () => 50000 });
  const out = await repo.beginStandingTp({ position: {
    id: 100, strategyId: 4, userId: 7, symbol: SYMBOL, side: 'BUY', quantity: 0.2,
  }, price: 180, deadlineAt: 100000 });
  assert.equal(out.purpose, 'take_profit');
  assert.equal(out.status, 'queued');
  assert.equal(out.positionId, 100);
  assert.ok(sqls.some((x) => x.sql.includes("purpose='take_profit'")));
  assert.ok(sqls.some((x) => x.sql.includes("'take_profit') RETURNING *")));
  assert.ok(!sqls.some((x) => x.sql.includes('placeOrder')));
});

test('el identificador de TP activo bloquea nueva orden de take-profit por posición', async () => {
  const repo = createOptionsLiveOrdersRepository({
    db: { async query(sql, args) {
      assert.match(sql, /purpose='take_profit'/);
      assert.deepEqual(args, [[100]]);
      return { rows: [{ id: 3 }] };
    } },
  });
  assert.equal(await repo.hasStandingTp([100]), true);
  assert.equal(await repo.hasStandingTp([]), false);
  await assert.rejects(() => repo.hasStandingTp([-1]), /Invalid TP/);
});
