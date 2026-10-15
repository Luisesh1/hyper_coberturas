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
