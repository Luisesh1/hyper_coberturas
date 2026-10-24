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
    { eventId: '9001', direction: 'bullish', underlying: 'ETH' },
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
  // El subyacente de la señal viaja con la reentrada (bots multi-subyacente).
  assert.deepEqual(signal, { eventId: '9001', direction: 'bullish', underlying: 'ETH' });
});

test('reversal rechaza eventId inválido antes de tocar PostgreSQL', async () => {
  const repo = createOptionsLiveOrdersRepository({ db: {
    transaction() { throw Error('DB should not be touched'); },
  } });
  await assert.rejects(repo.queueReversal({ id: 4, userId: 7 },
    { eventId: 'bad', direction: 'bullish' }, { type: 'close', legs: [{ positionId: 91 }] }), /Invalid durable reversal/);
});

// ---------- reevaluación tras cancelar entradas pendientes ----------

const { OptionsLiveExecution } = require('../src/services/options/options-live-execution.service');
const NOW = 2_000_000_000_000;
const silent = { warn() {}, info() {}, error() {} };

function reevaluationEngine(rows, { status = 'evaluated' } = {}) {
  const calls = { reevaluated: [], reentries: [], marked: [], notified: [] };
  const db = { async query(sql) { calls.sql = sql; return { rows: rows() }; } };
  const base = createOptionsLiveOrdersRepository({ db, now: () => NOW });
  const repo = {
    listPendingReentries: base.listPendingReentries,
    async markReentry(id, s) { calls.marked.push([id, s]); return true; },
    async hasReentryOrder() { return false; },
    async claimIncidentNotification() { return true; },
  };
  const runner = {
    async reevaluateSignal(strategyId, signal) { calls.reevaluated.push({ strategyId, signal }); return { status }; },
    async executeDeferredReentry(strategyId, signal) { calls.reentries.push({ strategyId, signal }); return { status: 'submitted' }; },
  };
  const engine = new OptionsLiveExecution({ enabled: true, repo, runner, now: () => NOW, logger: silent,
    notify: async (userId, text) => calls.notified.push({ userId, text }), settlement: {} });
  return { engine, calls };
}

const reevaluateRow = (overrides = {}) => ({ id: '5', strategy_id: '4', user_id: '7', alert_event_id: '9002',
  signal: { eventId: '9002', direction: 'bullish', underlying: 'BTC' }, created_at: String(NOW - 60_000),
  kind: 'reevaluate', wait_order_ids: ['31'], ready: false, ...overrides });

test('reevaluation waits for canceled entry to be final', async () => {
  let row = reevaluateRow();
  const { engine, calls } = reevaluationEngine(() => [row]);
  await engine.processDeferredReentries();
  // ready sale de la consulta: ninguna orden de espera sin ser final.
  assert.match(calls.sql, /kind='reevaluate'/);
  assert.match(calls.sql, /o\.id=ANY\(r\.wait_order_ids\) AND o\.status<>'final'/);
  assert.deepEqual(calls.reevaluated, []);
  assert.deepEqual(calls.marked, []);
  row = reevaluateRow({ ready: true });
  const result = await engine.processDeferredReentries();
  assert.deepEqual(calls.reevaluated, [{ strategyId: 4, signal: { eventId: '9002', direction: 'bullish', underlying: 'BTC' } }]);
  // Nunca por el camino de la reentrada (que abriría sin evaluar la señal).
  assert.deepEqual(calls.reentries, []);
  assert.deepEqual(calls.marked, [[5, 'submitted']]);
  assert.equal(result.reevaluated, 1);
});

test('stale reevaluation expires without opening', async () => {
  const { engine, calls } = reevaluationEngine(() => [reevaluateRow({ ready: true, created_at: String(NOW - 31 * 60_000) })]);
  const result = await engine.processDeferredReentries();
  assert.equal(result.expired, 1);
  assert.deepEqual(calls.reevaluated, []);
  assert.deepEqual(calls.marked, [[5, 'expired']]);
  assert.equal(calls.notified.length, 1);
  assert.match(calls.notified[0].text, /Giro caducado/);
  assert.match(calls.notified[0].text, /No se abrió una posición nueva/);
});

test('reevaluation that queues a reversal or keeps waiting leaves the request pending', async () => {
  for (const status of ['reversal_queued', 'waiting', 'disabled']) {
    const { engine, calls } = reevaluationEngine(() => [reevaluateRow({ ready: true })], { status });
    await engine.processDeferredReentries();
    assert.equal(calls.reevaluated.length, 1);
    assert.deepEqual(calls.marked, [], status);
  }
});

test('reversal from a reevaluation turns the pending request into a reentry', async () => {
  const calls = [];
  const db = {
    async transaction(fn) {
      return fn({
        async query(sql, args) {
          calls.push({ sql, args });
          if (sql.includes('FROM options_strategies')) return { rows: [{ id: 4, user_id: 7, mode: 'live', template: 'alert_signal' }] };
          if (sql.includes('FROM options_strategy_positions')) return {
            rows: [{ id: '91', user_id: '7', strategy_id: '4', symbol: SYMBOL, side: 'BUY', quantity: '0.1' }],
          };
          return { rows: [], rowCount: 1 };
        },
      });
    },
  };
  const repo = createOptionsLiveOrdersRepository({ db, now: () => 1000 });
  await repo.queueReversal({ id: 4, userId: 7 }, { eventId: '9002', direction: 'bullish' },
    { type: 'close', legs: [{ positionId: 91, symbol: SYMBOL, side: 'SELL', quantity: 0.1 }] });
  const insert = calls.find((o) => o.sql.includes('INSERT INTO options_live_reentries'));
  assert.match(insert.sql, /ON CONFLICT \(strategy_id,alert_event_id\) DO UPDATE SET kind='reentry'/);
  assert.match(insert.sql, /WHERE options_live_reentries\.kind='reevaluate' AND options_live_reentries\.status='pending'/);
});
