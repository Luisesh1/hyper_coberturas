const test = require('node:test');
const assert = require('node:assert/strict');
const { createOptionsLiveOrdersRepository } = require('../src/repositories/options-live-orders.repository');
const SYMBOL = 'BTC-261030-60000-P';

test('reversal guarda cierre, cancelación y señal para reentrada dentro de la misma transacción', async () => {
  const calls = [];
  let transactions = 0;
  const db = {
    async transaction(fn) {
      transactions++;
      return fn({
        async query(sql, args) {
          calls.push({ sql, args });
          if (sql.includes('FROM options_strategies')) return {
            rows: [{ id: 4, user_id: 7, mode: 'live', template: 'alert_signal' }],
          };
          if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
          if (sql.includes('FROM options_strategy_positions')) return {
            rows: [{ id: '91', user_id: '7', strategy_id: '4',
              symbol: SYMBOL, side: 'BUY', quantity: '0.1' }],
          };
          if (sql.includes('INSERT INTO options_live_exit_requests')) return { rows: [] };
          if (sql.includes('UPDATE options_live_orders')) return { rowCount: 1 };
          if (sql.includes('INSERT INTO options_live_reentries')) return { rows: [] };
          throw Error('Unexpected SQL: ' + sql);
        },
      });
    },
  };
  const repo = createOptionsLiveOrdersRepository({ db, now: () => 1000 });
  const result = await repo.queueReversal(
    { id: 4, userId: 7 },
    { eventId: '9001', direction: 'bullish' },
    { type: 'close', legs: [{ positionId: 91, symbol: SYMBOL, side: 'SELL', quantity: 0.1 }] }
  );
  assert.equal(result, true);
  assert.equal(transactions, 1);
  assert.ok(calls.some((o) => o.sql.includes('pg_advisory_xact_lock')));
  assert.ok(calls.some((o) => o.sql.includes('INSERT INTO options_live_exit_requests')));
  assert.ok(calls.some((o) => o.sql.includes('cancel_requested=TRUE')));
  const reentry = calls.find((o) => o.sql.includes('INSERT INTO options_live_reentries'));
  assert.equal(reentry.args[2], '9001');
  assert.deepEqual(reentry.args[4], [91]);
  const signal = JSON.parse(reentry.args[3]);
  assert.deepEqual(signal, { eventId: '9001', direction: 'bullish' });
});

test('reversal rechaza eventId inválido antes de tocar PostgreSQL', async () => {
  const repo = createOptionsLiveOrdersRepository({ db: {
    transaction() { throw Error('DB should not be touched'); },
  } });
  await assert.rejects(repo.queueReversal({ id: 4, userId: 7 },
    { eventId: 'bad', direction: 'bullish' }, { type: 'close', legs: [{ positionId: 91 }] }), /Invalid durable reversal/);
});
