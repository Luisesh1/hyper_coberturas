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
