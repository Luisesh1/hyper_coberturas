const test = require('node:test');
const assert = require('node:assert/strict');
const { compareExposure, createOptionsLiveOrdersRepository } =
  require('../src/repositories/options-live-orders.repository');

test('exposición: concilia neto largo y corto del mismo símbolo', () => {
  const rows = [
    { symbol: 'BTC-261030-60000-C', side: 'BUY', quantity: '0.4' },
    { symbol: 'BTC-261030-60000-C', side: 'SELL', quantity: '0.1' },
  ];
  assert.equal(compareExposure(rows, [{
    symbol: 'BTC-261030-60000-C', side: 'LONG', quantity: '0.3', quoteAsset: 'USDT',
  }]), true);
});

test('exposición: posición manual o ledger desactualizado bloquean entradas', () => {
  assert.throws(() => compareExposure([], [{
    symbol: 'BTC-261030-60000-C', side: 'LONG', quantity: '0.1',
  }]), /exposure mismatch/i);
  assert.throws(() => compareExposure([{ symbol: 'BTC-261030-60000-C', side: 'BUY', quantity: '0.1' }], []), /exposure mismatch/i);
  assert.throws(() => compareExposure([], null), /not an array/);
  assert.throws(() => compareExposure([], [{
    symbol: 'BTC-261030-60000-C', side: 'INVALID', quantity: '0',
  }]), /direction/i);
  assert.throws(() => compareExposure([], [{
    symbol: 'BTC-261030-60000-C', side: 'SHORT', quantity: '0.1',
  }]), /direction disagrees/);
  assert.throws(() => compareExposure([], [{
    symbol: 'BTC-261030-60000-C', side: 'LONG', quantity: '0', quoteAsset: 'BTC',
  }]), /quote asset/);
});

test('lote: revalida posición Binance bajo lock antes de crear órdenes', async () => {
  const calls = [];
  const tx = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM options_strategies')) return {
        rows: [{ id: 5, user_id: 7, mode: 'live', underlying: 'BTC' }],
      };
      if (sql.includes('FROM options_live_batches')) return { rows: [] };
      if (sql.includes('FROM options_strategy_positions')) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      throw new Error('Unexpected query: ' + sql);
    },
  };
  const repo = createOptionsLiveOrdersRepository({
    db: { transaction: (callback) => callback(tx) }, now: () => 1000,
  });
  await assert.rejects(repo.beginBatch({
    strategy: { id: 5, userId: 7 }, action: 'open', key: 'alert:7:open',
    deadlineAt: 601000, exchangePositions: [{
      symbol: 'BTC-261030-60000-C', side: 'LONG', quantity: '0.1',
    }],
    legs: [{ symbol: 'BTC-261030-60000-C', side: 'BUY', quantity: 0.1, price: 100 }],
  }), /exposure mismatch/i);
  assert.ok(calls.some((c) => c.sql.includes('pg_advisory_xact_lock')));
  assert.equal(calls.some((c) => c.sql.includes('INSERT INTO options_live_batches')), false);
});


test('preflight de cierre rechaza sobreventa, posición ajena y cierres duplicados antes del POST', async () => {
  const calls = [];
  const held = { id: '91', strategy_id: '5', user_id: '7', mode: 'live',
    symbol: 'BTC-261030-60000-C', side: 'BUY', quantity: '0.1' };
  const tx = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('FROM options_strategies')) return {
        rows: [{ id: 5, user_id: 7, mode: 'live', underlying: 'BTC' }],
      };
      if (sql.includes('FROM options_live_batches')) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes("FROM options_live_orders") && sql.includes("purpose='take_profit'")) return { rows: [] };
      if (sql.includes('FROM options_strategy_positions') && sql.includes('GROUP BY')) {
        return { rows: [{ symbol: held.symbol, side: held.side, quantity: held.quantity }] };
      }
      if (sql.includes('FROM options_strategy_positions') && sql.includes('FOR UPDATE')) {
        return { rows: [held] };
      }
      throw new Error('Unexpected SQL ' + sql);
    },
  };
  const repo = createOptionsLiveOrdersRepository({
    db: { transaction: (fn) => fn(tx) }, now: () => 1000,
  });
  const base = { strategy: { id: 5, userId: 7 }, action: 'close',
    key: 'close:1', deadlineAt: 601000,
    exchangePositions: [{ symbol: held.symbol, side: 'LONG', quantity: '0.1' }] };
  const leg = { positionId: 91, symbol: held.symbol, side: 'SELL', quantity: 0.2, price: 100 };
  await assert.rejects(repo.beginBatch({ ...base, legs: [leg] }), /exceeds verified/);
  await assert.rejects(repo.beginBatch({ ...base, legs: [leg, leg] }), /duplicate closing position/);
  await assert.rejects(repo.beginBatch({ ...base, legs: [{ ...leg, quantity: 0.05, side: 'BUY' }] }), /exceeds verified/);
  held.strategy_id = '999';
  await assert.rejects(repo.beginBatch({ ...base, legs: [{ ...leg, quantity: 0.05 }] }), /exceeds verified/);
  assert.equal(calls.some((sql) => sql.includes('INSERT INTO options_live_batches')), false);
});

test('liberar conciliación solo modifica el lease exacto de quien lo adquirió', async () => {
  const calls = [];
  const repo = createOptionsLiveOrdersRepository({
    db: { query: async (sql, args) => {
      calls.push({ sql, args });
      return { rowCount: args[1] === 1234 ? 1 : 0 };
    } },
  });
  assert.equal(await repo.releaseReconcile(10, 1234), true);
  assert.equal(await repo.releaseReconcile(10, 1111), false);
  assert.equal(await repo.releaseReconcile(10, null), false);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /reconcile_lease_until=\$2/);
});

test('markSending exige deadline vigente en la transición SQL atómica', async () => {
  const nowMs = 100_000;
  const repo = createOptionsLiveOrdersRepository({
    now: () => nowMs,
    db: { async query(sql, args) {
      assert.match(sql, /status='queued'/);
      assert.match(sql, /NOT cancel_requested/);
      assert.match(sql, /deadline_at > \$2/);
      assert.deepEqual(args, [13, nowMs]);
      return { rows: [] };
    } },
  });
  // PostgreSQL no reclama la fila si expiró o tiene cancelRequested.
  assert.equal(await repo.markSending(13), null);
});

test('markRejected solo devuelve a la cola una orden sending sin id de Binance ni fills', async () => {
  const repo = createOptionsLiveOrdersRepository({
    now: () => 5,
    db: { async query(sql, args) {
      assert.match(sql, /status='queued'/);
      assert.match(sql, /cancel_requested=TRUE/);
      assert.match(sql, /status='sending'/);
      assert.match(sql, /exchange_order_id IS NULL/);
      assert.match(sql, /processed_qty=0/);
      assert.equal(args[0], 21);
      return { rowCount: 0 };
    } },
  });
  assert.equal(await repo.markRejected(21, 'rechazo'), false);
});

test('requestCancel solo marca una orden propia del bot, no final y no TP', async () => {
  const calls = [];
  let rows = [{ id: 9, batch_id: 1, strategy_id: 5, user_id: 7, action: 'open', symbol: 'BTC-261030-60000-C',
    side: 'BUY', requested_qty: '0.1', limit_price: '100', processed_qty: '0', status: 'active',
    purpose: 'standard', cancel_requested: true, created_at: '1', deadline_at: '2' }];
  const repo = createOptionsLiveOrdersRepository({
    db: { async query(sql, params) { calls.push({ sql, params }); return { rows }; } }, now: () => 1234,
  });
  const order = await repo.requestCancel({ userId: 7, strategyId: 5, orderId: 9 });
  assert.equal(order.id, 9);
  assert.equal(order.cancelRequested, true);
  const { sql, params } = calls[0];
  assert.match(sql, /UPDATE options_live_orders SET cancel_requested=TRUE/);
  assert.match(sql, /user_id=\$2/);
  assert.match(sql, /strategy_id=\$3/);
  assert.match(sql, /status<>'final'/);
  assert.match(sql, /purpose<>'take_profit'/);
  assert.match(sql, /action='open'/);
  assert.deepEqual(params, [9, 7, 5, 1234]);
  rows = [];
  assert.equal(await repo.requestCancel({ userId: 7, strategyId: 5, orderId: 9 }), null);
  await assert.rejects(repo.requestCancel({ userId: 7, strategyId: 5, orderId: 'x' }), /Invalid/);
});

test('hasPendingClose detecta cierres reales no finales o salidas diferidas en posiciones abiertas', async () => {
  const calls = [];
  let rows = [{ id: 3 }];
  const repo = createOptionsLiveOrdersRepository({
    db: { async query(sql, params) { calls.push({ sql, params }); return { rows }; } },
  });
  assert.equal(await repo.hasPendingClose({ userId: 7, strategyId: 5, positionIds: [3, 4] }), true);
  assert.deepEqual(calls[0].params, [7, 5, [3, 4]]);
  assert.match(calls[0].sql, /closed_at IS NULL/);
  assert.match(calls[0].sql, /mode='live'/);
  assert.match(calls[0].sql, /action='close'/);
  assert.match(calls[0].sql, /purpose<>'take_profit'/);
  assert.match(calls[0].sql, /options_live_exit_requests/);
  rows = [];
  assert.equal(await repo.hasPendingClose({ userId: 7, strategyId: 5 }), false);
  assert.deepEqual(calls[1].params, [7, 5, null]);
});

test('lote: el símbolo debe ser de un subyacente del bot (varios con params.underlyings)', async () => {
  const ETH = 'ETH-261030-4000-C';
  const run = async (row) => {
    const tx = {
      async query(sql) {
        if (sql.includes('FROM options_strategies')) return { rows: [row] };
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (sql.includes('INSERT INTO options_live_batches')) return { rows: [{ id: '1' }] };
        if (sql.includes('INSERT INTO options_live_orders')) return { rows: [{
          id: '2', batch_id: '1', strategy_id: '5', user_id: '7', action: 'open', position_id: null,
          symbol: ETH, side: 'BUY', requested_qty: '0.1', limit_price: '100', processed_qty: '0',
          client_order_id: 'HC1L0', exchange_order_id: null, status: 'queued', purpose: 'standard',
          created_at: '1000', deadline_at: '601000', updated_at: '1000',
        }] };
        return { rows: [] };
      },
    };
    const repo = createOptionsLiveOrdersRepository({ db: { transaction: (callback) => callback(tx) }, now: () => 1000 });
    return repo.beginBatch({
      strategy: { id: 5, userId: 7 }, action: 'open', key: 'alert:8:open', deadlineAt: 601000,
      exchangePositions: [], legs: [{ symbol: ETH, side: 'BUY', quantity: 0.1, price: 100 }],
    });
  };
  const base = { id: 5, user_id: 7, mode: 'live', underlying: 'BTC' };
  await assert.rejects(run(base), /does not match strategy underlying/);
  const orders = await run({ ...base, params: { underlyings: ['BTC', 'ETH'] } });
  assert.equal(orders[0].symbol, ETH);
});

test('lote: beginBatch guarda auto_signal_id (null si no viene)', async () => {
  const inserts = [];
  const tx = {
    async query(sql, params) {
      if (sql.includes('FROM options_strategies')) return { rows: [{ id: 5, user_id: 7, mode: 'live', underlying: 'BTC' }] };
      if (sql.includes('INSERT INTO options_live_batches')) { inserts.push({ sql, params }); return { rows: [{ id: '1' }] }; }
      if (sql.includes('INSERT INTO options_live_orders')) return { rows: [{
        id: '2', batch_id: '1', strategy_id: '5', user_id: '7', action: 'open', position_id: null,
        symbol: 'BTC-261030-60000-C', side: 'BUY', requested_qty: '0.1', limit_price: '100', processed_qty: '0',
        client_order_id: 'HC1L0', status: 'queued', purpose: 'standard', created_at: '1000', deadline_at: '601000',
      }] };
      return { rows: [] };
    },
  };
  const repo = createOptionsLiveOrdersRepository({ db: { transaction: (fn) => fn(tx) }, now: () => 1000 });
  const base = { strategy: { id: 5, userId: 7 }, action: 'open', deadlineAt: 601000, exchangePositions: [],
    legs: [{ symbol: 'BTC-261030-60000-C', side: 'BUY', quantity: 0.1, price: 100 }] };
  await repo.beginBatch({ ...base, key: 'alert:1:open', autoSignalId: 31 });
  await repo.beginBatch({ ...base, key: 'alert:2:open' });
  assert.match(inserts[0].sql, /auto_signal_id/);
  assert.equal(inserts[0].params[7], 31);
  assert.equal(inserts[1].params[7], null);
});

test('requestCancelEntries marca las entradas no finales del subyacente y devuelve sus ids', async () => {
  const calls = [];
  const repo = createOptionsLiveOrdersRepository({
    now: () => 1234,
    db: { async query(sql, params) { calls.push({ sql, params }); return { rows: [{ id: '9' }, { id: '12' }] }; } },
  });
  assert.deepEqual(await repo.requestCancelEntries({ userId: 7, strategyId: 5, underlying: 'eth' }), [9, 12]);
  const { sql, params } = calls[0];
  assert.match(sql, /UPDATE options_live_orders SET cancel_requested=TRUE/);
  assert.match(sql, /action='open'/);
  assert.match(sql, /purpose<>'take_profit'/);
  assert.match(sql, /status<>'final'/);
  assert.match(sql, /symbol LIKE \$3/);
  assert.match(sql, /RETURNING id/);
  assert.deepEqual(params, [7, 5, 'ETH-%', 1234]);
  await assert.rejects(repo.requestCancelEntries({ userId: 7, strategyId: 5, underlying: 'E%' }), /Invalid/);
  await assert.rejects(repo.requestCancelEntries({ userId: 'x', strategyId: 5, underlying: 'ETH' }), /Invalid/);
  assert.equal(calls.length, 1);
});

/**
 * BD falsa con estado para la cola de reentradas/reevaluaciones: guarda lo
 * insertado y calcula `ready` con la regla de cada `kind` solo si la SQL de
 * listPendingReentries contiene el predicado correspondiente.
 */
function reentriesDb({ orders }) {
  const reentries = [];
  const calls = [];
  const query = async (sql, args) => {
    calls.push({ sql, args });
    if (sql.includes('FROM options_strategies') && sql.includes('FOR UPDATE')) {
      return { rows: [{ id: 4, user_id: 7, mode: 'live', template: 'alert_signal' }] };
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM options_live_orders') && sql.includes('FOR UPDATE')) {
      return { rows: orders.filter((o) => args[0].includes(o.id) && o.user_id === args[1] && o.strategy_id === args[2])
        .map((o) => ({ id: String(o.id) })) };
    }
    if (sql.startsWith('UPDATE options_live_reentries')) return { rows: [] };
    if (sql.includes('INSERT INTO options_live_reentries')) {
      if (reentries.some((r) => r.strategy_id === args[0] && r.alert_event_id === args[2])) return { rows: [] };
      reentries.push({ id: reentries.length + 1, strategy_id: args[0], user_id: args[1], alert_event_id: args[2],
        signal: JSON.parse(args[3]), wait_order_ids: args[4], created_at: args[5], kind: 'reevaluate', status: 'pending' });
      return { rows: [{ id: reentries.length }] };
    }
    if (sql.includes('FROM options_live_reentries')) {
      assert.match(sql, /r\.kind/);
      assert.match(sql, /CASE WHEN r\.kind='reevaluate'/);
      assert.match(sql, /o\.id=ANY\(r\.wait_order_ids\) AND o\.status<>'final'/);
      assert.match(sql, /p\.id=ANY\(r\.wait_position_ids\) AND p\.closed_at IS NULL/);
      return { rows: reentries.filter((r) => r.status === 'pending').map((r) => ({
        ...r, signal: JSON.stringify(r.signal),
        ready: !orders.some((o) => r.wait_order_ids.includes(o.id) && o.status !== 'final'),
      })) };
    }
    throw new Error('Unexpected SQL: ' + sql);
  };
  return { reentries, calls, query, transaction: (fn) => fn({ query }) };
}

test('queueSignalReevaluation no es ready mientras una orden de espera no es final y sí al finalizarla', async () => {
  const orders = [
    { id: 9, user_id: 7, strategy_id: 4, status: 'active' },
    { id: 12, user_id: 7, strategy_id: 4, status: 'final' },
  ];
  const db = reentriesDb({ orders });
  const repo = createOptionsLiveOrdersRepository({ db, now: () => 1000 });
  const queued = await repo.queueSignalReevaluation({ id: 4, userId: 7 },
    { eventId: '9002', direction: 'bearish', underlying: 'ETH' }, [9, 12]);
  assert.equal(queued, true);
  const insert = db.calls.find((c) => c.sql.includes('INSERT INTO options_live_reentries'));
  assert.match(insert.sql, /'reevaluate'/);
  assert.match(insert.sql, /wait_order_ids/);
  assert.match(insert.sql, /ON CONFLICT \(strategy_id,alert_event_id\) DO NOTHING/);
  assert.deepEqual(insert.args[4], [9, 12]);
  assert.ok(db.calls.some((c) => c.sql.includes('pg_advisory_xact_lock')));
  let [pending] = await repo.listPendingReentries();
  assert.equal(pending.kind, 'reevaluate');
  assert.deepEqual(pending.signal, { eventId: '9002', direction: 'bearish', underlying: 'ETH' });
  assert.equal(pending.ready, false);
  orders[0].status = 'final';
  [pending] = await repo.listPendingReentries();
  assert.equal(pending.ready, true);
  // Un segundo intento del mismo evento no duplica la cola.
  await repo.queueSignalReevaluation({ id: 4, userId: 7 },
    { eventId: '9002', direction: 'bearish', underlying: 'ETH' }, [9]);
  assert.equal(db.reentries.length, 1);
});

test('queueSignalReevaluation: una señal nueva sustituye la reevaluación pendiente del mismo subyacente', async () => {
  const calls = [];
  const rows = [
    { id: 1, strategy_id: 4, alert_event_id: '9002', kind: 'reevaluate', status: 'pending',
      signal: { eventId: '9002', direction: 'bearish', underlying: 'BTC', signalId: 61 } },
    { id: 2, strategy_id: 4, alert_event_id: '9003', kind: 'reevaluate', status: 'pending',
      signal: { eventId: '9003', direction: 'bearish', underlying: 'ETH', signalId: 62 } },
  ];
  const query = async (sql, args) => {
    calls.push({ sql, args });
    if (sql.includes('FROM options_strategies') && sql.includes('FOR UPDATE')) {
      return { rows: [{ id: 4, user_id: 7, mode: 'live', template: 'alert_signal', underlying: 'BTC' }] };
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM options_live_orders') && sql.includes('FOR UPDATE')) return { rows: [{ id: '9' }] };
    if (sql.startsWith('UPDATE options_live_reentries')) {
      assert.match(sql, /kind='reevaluate' AND status='pending'/);
      assert.match(sql, /alert_event_id<>\$2/);
      const hit = rows.filter((r) => r.strategy_id === args[0] && r.alert_event_id !== args[1] &&
        r.kind === 'reevaluate' && r.status === 'pending' &&
        String(r.signal.underlying ?? args[3]).toUpperCase() === args[2]);
      hit.forEach((r) => { r.status = 'expired'; });
      return { rows: hit.map((r) => ({ signal: r.signal })) };
    }
    if (sql.startsWith('UPDATE options_auto_signals')) return { rows: [] };
    if (sql.includes('INSERT INTO options_live_reentries')) return { rows: [{ id: 3 }] };
    throw new Error('Unexpected SQL: ' + sql);
  };
  const repo = createOptionsLiveOrdersRepository({ db: { transaction: (fn) => fn({ query }) }, now: () => 5000 });
  assert.equal(await repo.queueSignalReevaluation({ id: 4, userId: 7 },
    { eventId: '9010', direction: 'bullish', underlying: 'btc', signalId: 70 }, [9]), true);
  assert.deepEqual(rows.map((r) => r.status), ['expired', 'pending']);
  const resolve = calls.find((c) => c.sql.startsWith('UPDATE options_auto_signals'));
  assert.match(resolve.sql, /decision='pending'/);
  assert.match(resolve.sql, /strategy_id=\$2/);
  assert.deepEqual(resolve.args[0], [61]);
  assert.equal(resolve.args[2], 'Real: sustituida por una señal posterior');
  // Sustituir y encolar en la misma transacción, bajo el lock de usuario.
  const order = calls.map((c) => c.sql);
  assert.ok(order.findIndex((q) => q.includes('pg_advisory_xact_lock')) <
    order.findIndex((q) => q.startsWith('UPDATE options_live_reentries')));
  assert.ok(order.findIndex((q) => q.startsWith('UPDATE options_live_reentries')) <
    order.findIndex((q) => q.includes('INSERT INTO options_live_reentries')));
});

test('queueSignalReevaluation valida evento, órdenes propias y estrategia viva', async () => {
  const orders = [{ id: 9, user_id: 7, strategy_id: 4, status: 'active' }];
  const db = reentriesDb({ orders });
  const repo = createOptionsLiveOrdersRepository({ db, now: () => 1000 });
  const strategy = { id: 4, userId: 7 };
  await assert.rejects(repo.queueSignalReevaluation(strategy, { eventId: 'x', direction: 'bearish' }, [9]),
    /Invalid durable reevaluation/);
  await assert.rejects(repo.queueSignalReevaluation(strategy, { eventId: '1', direction: 'up' }, [9]),
    /Invalid durable reevaluation/);
  await assert.rejects(repo.queueSignalReevaluation(strategy, { eventId: '1', direction: 'bearish' }, [0]),
    /Invalid durable reevaluation/);
  assert.equal(db.calls.length, 0);
  // Orden de otro bot: no se puede esperar por ella.
  await assert.rejects(repo.queueSignalReevaluation(strategy, { eventId: '1', direction: 'bearish' }, [9, 77]),
    /do not belong/);
  assert.equal(db.reentries.length, 0);
  const paused = createOptionsLiveOrdersRepository({ now: () => 1, db: { transaction: (fn) => fn({ async query(sql) {
    if (sql.includes('FROM options_strategies')) return { rows: [{ id: 4, user_id: 7, mode: 'shadow', template: 'alert_signal' }] };
    throw new Error('Unexpected SQL: ' + sql);
  } }) } });
  assert.equal(await paused.queueSignalReevaluation(strategy, { eventId: '1', direction: 'bearish' }, [9]), false);
});

test('listPendingReentries mantiene kind=reentry por defecto', async () => {
  const repo = createOptionsLiveOrdersRepository({ db: { async query() {
    return { rows: [{ id: '1', strategy_id: '4', user_id: '7', alert_event_id: '5', signal: { eventId: '5' },
      created_at: '10', kind: null, ready: true }] };
  } } });
  const [r] = await repo.listPendingReentries();
  assert.equal(r.kind, 'reentry');
  assert.equal(r.ready, true);
});

test('batchEntryOutcome suma 0,10 + 0,05 a precio medio ponderado y con comisiones sumadas', async () => {
  const calls = [];
  const repo = createOptionsLiveOrdersRepository({ db: { async query(sql, args) {
    calls.push({ sql, args });
    if (sql.includes('FROM options_live_batches')) return { rows: [{
      id: '3', auto_signal_id: '31', order_id: '8', symbol: 'BTC-261030-60000-C', side: 'BUY', requested_qty: '0.2',
    }] };
    if (sql.includes('FROM options_live_fills')) return { rows: [
      { quantity: '0.1', price: '700', fee_usdt: '2.04' },
      { quantity: '0.05', price: '730', fee_usdt: '1.02' },
    ] };
    throw new Error('Unexpected SQL: ' + sql);
  } } });
  const out = await repo.batchEntryOutcome(3);
  assert.equal(out.autoSignalId, 31);
  assert.equal(out.requested, 0.2);
  assert.equal(out.filled, 0.15);
  assert.equal(out.avgPrice, 710);
  assert.equal(out.feesUsdt, 3.06);
  assert.equal(out.symbol, 'BTC-261030-60000-C');
  assert.equal(out.side, 'BUY');
  assert.deepEqual(calls.map((c) => c.args), [[3], [3]]);
  assert.match(calls[1].sql, /JOIN options_live_orders o ON o\.id=f\.live_order_id/);
  assert.match(calls[1].sql, /o\.batch_id=\$1/);
});

test('batchEntryOutcome: sin fills avgPrice null; lote inexistente null', async () => {
  let batchRows = [{ id: '3', auto_signal_id: null, order_id: '8', symbol: 'S', side: 'BUY', requested_qty: '0.1' }];
  const repo = createOptionsLiveOrdersRepository({ db: { async query(sql) {
    if (sql.includes('FROM options_live_batches')) return { rows: batchRows };
    return { rows: [] };
  } } });
  assert.deepEqual(await repo.batchEntryOutcome(3), {
    autoSignalId: null, requested: 0.1, filled: 0, avgPrice: null, feesUsdt: 0, symbol: 'S', side: 'BUY',
    cancelRequested: false, rejected: false,
  });
  batchRows = [];
  assert.equal(await repo.batchEntryOutcome(4), null);
});

test('batchEntryOutcome only reads open batches: a close batch returns null', async () => {
  const repo = createOptionsLiveOrdersRepository({ db: { async query(sql) {
    if (sql.includes('FROM options_live_batches')) {
      // El lote 3 es un cierre: solo aparece si la consulta no filtra por acción.
      return { rows: /b\.action='open'/.test(sql) ? [] : [{
        id: '3', auto_signal_id: '31', order_id: '8', symbol: 'S', side: 'SELL', requested_qty: '0.1' }] };
    }
    return { rows: [] };
  } } });
  assert.equal(await repo.batchEntryOutcome(3), null);
});

test('batchEntryOutcome reports cancel requests and Binance rejections', async () => {
  const repo = createOptionsLiveOrdersRepository({ db: { async query(sql) {
    if (sql.includes('FROM options_live_batches')) return { rows: [
      { id: '3', auto_signal_id: '31', order_id: '8', symbol: 'S', side: 'BUY', requested_qty: '0.1',
        cancel_requested: true, last_error: 'Rechazada por Binance: -2010' },
    ] };
    return { rows: [] };
  } } });
  const out = await repo.batchEntryOutcome(3);
  assert.equal(out.cancelRequested, true);
  assert.equal(out.rejected, true);
});

function finishDb({ autoSignalId = null, actionKey = 'alert:55:open', processed = '0.2', remaining = 0,
  strategyRowCount = 1 } = {}) {
  const calls = [];
  const tx = { async query(sql, args) {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT * FROM options_live_orders')) return { rows: [
      { id: 9, batch_id: 3, strategy_id: 4, status: 'active', processed_qty: processed } ] };
    if (sql.includes('COUNT(*)')) return { rows: [{ n: remaining }] };
    if (sql.includes('FROM options_live_batches WHERE id=$1')) return { rows: [
      { strategy_id: 4, action_key: actionKey, action: 'open', auto_signal_id: autoSignalId } ] };
    if (sql.includes('SUM(processed_qty)')) return { rows: [{ qty: processed }] };
    if (sql.includes('FROM options_live_batches b JOIN')) return { rows: [
      { id: 3, auto_signal_id: autoSignalId, order_id: 9, symbol: 'ETH-261031-2500-C', side: 'BUY',
        requested_qty: '0.2', cancel_requested: false, last_error: null } ] };
    if (sql.includes('FROM options_live_fills')) return { rows: [{ quantity: processed, price: '715', fee_usdt: '1.5' }] };
    if (sql.includes('UPDATE options_strategies')) return { rows: [], rowCount: strategyRowCount };
    return { rows: [] };
  } };
  return { calls, db: { transaction: (fn) => fn(tx) } };
}

test('finishOrder resolves a linked entry signal inside its transaction', async () => {
  const linked = finishDb({ autoSignalId: '31' });
  const repo = createOptionsLiveOrdersRepository({ db: linked.db, now: () => 1 });
  const seen = [];
  const out = await repo.finishOrder(9, '77', 0.2, { resolveSignal: (o) => {
    seen.push(o);
    return { decision: 'opened', detail: 'Real: x', feesUsdt: 1.5, feesEstimated: false };
  } });
  assert.deepEqual(out, { batchId: 3, completed: true, action: 'open', autoSignalId: 31,
    blocked: false, signalResolved: true });
  assert.equal(seen[0].filled, 0.2);
  assert.equal(seen[0].feesUsdt, 1.5);
  const update = linked.calls.find((c) => c.sql.includes('UPDATE options_auto_signals'));
  assert.match(update.sql, /WHERE id = \$1 AND decision IN \('pending','opened'\)/);
  assert.deepEqual(update.args, [31, 'opened', 'Real: x', 1.5, false]);
  // Sin resolutor queda el texto genérico de siempre (nunca 'pending' para siempre).
  const legacy = finishDb({ autoSignalId: '31' });
  const old = createOptionsLiveOrdersRepository({ db: legacy.db, now: () => 1 });
  assert.equal((await old.finishOrder(9, '77', 0.2)).signalResolved, false);
  assert.ok(legacy.calls.some((c) => /alert_event_id=\$2 AND decision='pending'/.test(c.sql)));
  const open = finishDb({ remaining: 1 });
  const pending = createOptionsLiveOrdersRepository({ db: open.db, now: () => 1 });
  assert.deepEqual(await pending.finishOrder(9, '77', 0.2), { batchId: 3, completed: false, blocked: false });
});

test('finishOrder writes the underlying block in the same transaction', async () => {
  const d = finishDb({ remaining: 1 });
  const repo = createOptionsLiveOrdersRepository({ db: d.db, now: () => 1 });
  const out = await repo.finishOrder(9, '77', 0.2,
    { block: { underlying: 'eth', reason: 'Resto no operable de 0,005 contratos en X', at: 50 } });
  assert.equal(out.blocked, true);
  const i = d.calls.findIndex((c) => c.sql.includes('UPDATE options_strategies'));
  const fin = d.calls.findIndex((c) => c.sql.includes("SET status='final'"));
  assert.ok(i > fin && fin >= 0);
  assert.match(d.calls[i].sql, /jsonb_set\(\s*COALESCE\(state, '\{\}'::jsonb\), '\{blockedUnderlyings\}'/);
  assert.deepEqual(d.calls[i].args, [4, 'ETH', 'Resto no operable de 0,005 contratos en X', 50]);
  // Fila de estrategia ausente: la transacción falla (y no se finaliza).
  const gone = createOptionsLiveOrdersRepository({ db: finishDb({ strategyRowCount: 0 }).db, now: () => 1 });
  await assert.rejects(gone.finishOrder(9, '77', 0.2, { block: { underlying: 'ETH', reason: 'r' } }),
    /cannot block underlying/);
  await assert.rejects(repo.finishOrder(9, '77', 0.2, { block: { underlying: 'ETH-X', reason: 'r' } }),
    /Invalid underlying block/);
});

function applyTradeDb({ action = 'close', position = null } = {}) {
  const calls = [];
  const tx = { async query(sql, args) {
    calls.push({ sql, args });
    if (sql.includes('FROM options_live_orders') && sql.includes('FOR UPDATE')) return { rows: [{
      id: 9, user_id: 7, strategy_id: 5, action, symbol: 'BTC-261030-60000-C',
      side: action === 'open' ? 'BUY' : 'SELL', position_id: position ? position.id : null,
      purpose: 'exit', processed_qty: '0', requested_qty: '1', exchange_order_id: '77' }] };
    if (sql.includes('INSERT INTO options_live_fills')) return { rows: [{ id: 1 }] };
    if (sql.includes('FROM options_strategy_positions') && sql.includes('FOR UPDATE')) {
      return { rows: position ? [position] : [] };
    }
    return { rows: [], rowCount: 1 };
  } };
  return { calls, repo: createOptionsLiveOrdersRepository({ db: { transaction: (fn) => fn(tx) }, now: () => 1 }) };
}
const livePosition = (quantity, fees, entry = fees) => ({ id: 91, strategy_id: '5', user_id: '7', mode: 'live',
  symbol: 'BTC-261030-60000-C', side: 'BUY', quantity: String(quantity), entry_price: '100',
  opened_at: '10', fees_usdt: String(fees), entry_fee_usdt: entry == null ? null : String(entry) });

test('live open records the trade fee as the entry fee', async () => {
  const d = applyTradeDb({ action: 'open' });
  assert.equal(await d.repo.applyTrade({ id: 9 }, { id: 't1', quantity: '0.4', price: 120, fee: 0.8, at: 50 }), true);
  const ins = d.calls.find((c) => c.sql.includes('INSERT INTO options_strategy_positions'));
  assert.match(ins.sql, /fees_usdt,entry_fee_usdt\)/);
  assert.equal(ins.args.at(-1), 0.8);
  assert.equal(ins.args.at(-2), 0.8);
});

test('live full close splits entry and exit fees', async () => {
  const d = applyTradeDb({ position: livePosition(0.4, 1.2) });
  await d.repo.applyTrade({ id: 9 }, { id: 't2', quantity: '0.4', price: 130, fee: 0.3, at: 60 });
  const upd = d.calls.find((c) => c.sql.includes('UPDATE options_strategy_positions'));
  assert.match(upd.sql, /entry_fee_usdt=\$7,exit_fee_usdt=\$8/);
  const [, , , , fees, , entry, exit] = upd.args;
  assert.ok(Math.abs(entry - 1.2) < 1e-12);
  assert.equal(exit, 0.3);
  assert.ok(Math.abs(fees - (entry + exit)) < 1e-12);
});

test('live partial close allocates entry fee proportionally and keeps the breakdown summing to fees_usdt', async () => {
  const d = applyTradeDb({ position: livePosition(0.4, 1.2) });
  await d.repo.applyTrade({ id: 9 }, { id: 't3', quantity: '0.1', price: 130, fee: 0.05, at: 60 });
  const upd = d.calls.find((c) => c.sql.includes('UPDATE options_strategy_positions'));
  assert.match(upd.sql, /SET quantity=\$2,fees_usdt=\$3,entry_fee_usdt=\$3 WHERE id=\$1/);
  const [, remainingQty, remainingFees] = upd.args;
  assert.ok(Math.abs(remainingQty - 0.3) < 1e-12);
  assert.ok(Math.abs(remainingFees - 0.9) < 1e-12);
  const ins = d.calls.find((c) => c.sql.includes('INSERT INTO options_strategy_positions'));
  assert.match(ins.sql, /fees_usdt,close_reason,entry_fee_usdt,exit_fee_usdt,/);
  const fees = ins.args[10];
  const entry = ins.args[12];
  const exit = ins.args[13];
  assert.ok(Math.abs(entry - 0.3) < 1e-12);
  assert.equal(exit, 0.05);
  assert.ok(Math.abs(fees - (entry + exit)) < 1e-12);
  // Entre las dos filas se conserva la comisión de entrada original.
  assert.ok(Math.abs(remainingFees + entry - 1.2) < 1e-12);
});

test('live partial close: la parte cerrada hereda el rango de prima muestreado', async () => {
  const position = { ...livePosition(0.4, 1.2), premium_high: '150', premium_high_at: '20',
    premium_low: '90', premium_low_at: '30', premium_range_source: 'full' };
  const d = applyTradeDb({ position });
  await d.repo.applyTrade({ id: 9 }, { id: 't4', quantity: '0.1', price: 130, fee: 0.05, at: 60 });
  const ins = d.calls.find((c) => c.sql.includes('INSERT INTO options_strategy_positions'));
  assert.match(ins.sql, /premium_high,premium_high_at,premium_low,premium_low_at,premium_range_source\)/);
  assert.deepEqual(ins.args.slice(14), ['150', '20', '90', '30', 'full']);
});

test('lote: con solo una ENTRADA sin resolver se admite un cierre; otra entrada o un cierre pendiente bloquean', async () => {
  const held = { id: '91', strategy_id: '5', user_id: '7', mode: 'live',
    symbol: 'BTC-261030-60000-C', side: 'BUY', quantity: '0.1' };
  let unresolved = [];
  const inserts = [];
  const tx = {
    async query(sql) {
      if (sql.includes('FROM options_strategies')) return { rows: [{ id: 5, user_id: 7, mode: 'live', underlying: 'BTC' }] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes("b.status <> 'completed'")) return { rows: unresolved };
      if (sql.includes('action_key=$2')) return { rows: [] };
      if (sql.includes('FROM options_strategy_positions') && sql.includes('GROUP BY')) {
        return { rows: [{ symbol: held.symbol, side: held.side, quantity: held.quantity }] };
      }
      if (sql.includes('FROM options_strategy_positions') && sql.includes('FOR UPDATE')) return { rows: [held] };
      if (sql.includes("purpose='take_profit'")) return { rows: [] };
      if (sql.includes('options_live_exit_requests')) return { rows: [] };
      if (sql.includes('INSERT INTO options_live_batches')) { inserts.push(sql); return { rows: [{ id: '9' }] }; }
      if (sql.includes('INSERT INTO options_live_orders')) return { rows: [{
        id: '2', batch_id: '9', strategy_id: '5', user_id: '7', action: 'close', position_id: '91',
        symbol: held.symbol, side: 'SELL', requested_qty: '0.1', limit_price: '100', processed_qty: '0',
        client_order_id: 'HC9L0', status: 'queued', purpose: 'standard', created_at: '1000', deadline_at: '601000',
      }] };
      return { rows: [] };
    },
  };
  const repo = createOptionsLiveOrdersRepository({ db: { transaction: (fn) => fn(tx) }, now: () => 1000 });
  const exchangePositions = [{ symbol: held.symbol, side: 'LONG', quantity: '0.1' }];
  const close = { strategy: { id: 5, userId: 7 }, action: 'close', key: 'close:1:91', deadlineAt: 601000,
    exchangePositions, legs: [{ positionId: 91, symbol: held.symbol, side: 'SELL', quantity: 0.1, price: 100 }] };
  const open = { strategy: { id: 5, userId: 7 }, action: 'open', key: 'alert:9:open', deadlineAt: 601000,
    exchangePositions, legs: [{ symbol: 'BTC-261030-61000-C', side: 'BUY', quantity: 0.1, price: 100 }] };
  unresolved = [{ id: '3', action: 'open' }];
  const orders = await repo.beginBatch(close);
  assert.equal(orders.length, 1);
  assert.equal(inserts.length, 1);
  assert.equal(await repo.beginBatch(open), null);
  unresolved = [{ id: '3', action: 'open' }, { id: '4', action: 'close' }];
  assert.equal(await repo.beginBatch(close), null);
  unresolved = [{ id: '4', action: 'close' }];
  assert.equal(await repo.beginBatch(close), null);
  assert.equal(inserts.length, 1);
});

test('lote: un cierre sobre el contrato de una entrada propia en reposo se difiere y pide cancelarla', async () => {
  // Carrera: la entrada se registró después del preflight (deferExitIfProtected)
  // y antes de esta transacción. Enviar el cierre podría cruzarse con la propia
  // compra o dejarla comprando lo que el stop acaba de cerrar.
  const held = { id: '91', strategy_id: '5', user_id: '7', mode: 'live',
    symbol: 'BTC-261030-60000-C', side: 'BUY', quantity: '0.1' };
  const calls = [];
  const tx = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM options_strategies')) return { rows: [{ id: 5, user_id: 7, mode: 'live', underlying: 'BTC' }] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes("b.status <> 'completed'")) return { rows: [{ action: 'open' }] };
      if (sql.includes('FROM options_strategy_positions') && sql.includes('GROUP BY')) {
        return { rows: [{ symbol: held.symbol, side: held.side, quantity: held.quantity }] };
      }
      if (sql.includes('FROM options_strategy_positions') && sql.includes('FOR UPDATE')) return { rows: [held] };
      if (sql.startsWith('SELECT') && sql.includes('FROM options_live_orders') && sql.includes("action='open'")) {
        return { rows: [{ id: '44', purpose: 'standard' }] };
      }
      if (sql.startsWith('SELECT') && sql.includes('FROM options_live_orders')) return { rows: [] };
      return { rows: [] };
    },
  };
  const repo = createOptionsLiveOrdersRepository({ db: { transaction: (fn) => fn(tx) }, now: () => 1000 });
  const result = await repo.beginBatch({
    strategy: { id: 5, userId: 7 }, action: 'close', key: 'close:1:91', deadlineAt: 601000,
    exchangePositions: [{ symbol: held.symbol, side: 'LONG', quantity: '0.1' }],
    legs: [{ positionId: 91, symbol: held.symbol, side: 'SELL', quantity: 0.1, price: 100 }],
  });
  assert.equal(result, null);
  const exit = calls.find((c) => c.sql.includes('INSERT INTO options_live_exit_requests'));
  assert.ok(exit, 'la salida queda registrada para reintentarse al conciliar la entrada');
  assert.match(exit.sql, /entry_race_cancel/);
  const cancel = calls.find((c) => c.sql.startsWith('UPDATE options_live_orders SET cancel_requested=TRUE'));
  assert.ok(cancel, 'se pide cancelar la entrada en reposo');
  assert.match(cancel.sql, /action='open' AND symbol=ANY/);
  assert.deepEqual(cancel.params[3], [held.symbol]);
  assert.equal(calls.some((c) => c.sql.includes('INSERT INTO options_live_batches')), false);
});
