const test = require('node:test');
const assert = require('node:assert/strict');
const { createOptionsStrategiesRepository } = require('../src/repositories/options-strategies.repository');

const positionRow = (over = {}) => ({
  id: '7', strategy_id: '4', user_id: '1', mode: 'shadow', symbol: 'BTC-261030-81500-P', side: 'BUY',
  quantity: '0.1', entry_price: '765', exit_price: null, opened_at: '1000', closed_at: null,
  pnl_usdt: null, fees_usdt: '0', premium_high: null, premium_high_at: null, premium_low: null,
  premium_low_at: null, premium_range_source: 'full', ...over,
});

function capturingDb(rows = [], rowCount = 1) {
  const calls = [];
  return { calls, async query(sql, args) { calls.push({ sql, args }); return { rows, rowCount }; } };
}

async function mapped(over) {
  const repo = createOptionsStrategiesRepository({ db: capturingDb([positionRow(over)]) });
  const [p] = await repo.listOpenPositions(4, 'shadow');
  return p.premiumRange;
}

test('premiumRange: muestras guardadas con su instante', async () => {
  assert.deepEqual(await mapped({ premium_high: '1100', premium_high_at: '5000', premium_low: '600', premium_low_at: '3000' }), {
    high: { price: 1100, at: 5000 }, low: { price: 600, at: 3000 }, partial: false,
  });
});

test('premiumRange: la salida cuenta como un punto más (vencimiento a 0 es el mínimo)', async () => {
  const range = await mapped({
    premium_high: '700', premium_high_at: '2000', premium_low: '300', premium_low_at: '4000',
    exit_price: '0', closed_at: '9000',
  });
  assert.deepEqual(range.low, { price: 0, at: 9000 });
  assert.deepEqual(range.high, { price: 700, at: 2000 });
  // TP por encima de lo muestreado: la salida es el máximo.
  const tp = await mapped({
    premium_high: '980', premium_high_at: '2000', premium_low: '700', premium_low_at: '1500',
    exit_price: '1025', closed_at: '4000',
  });
  assert.deepEqual(tp.high, { price: 1025, at: 4000 });
});

test('premiumRange: empate con la salida conserva el instante anterior', async () => {
  const range = await mapped({
    premium_high: '1025', premium_high_at: '2000', premium_low: '900', premium_low_at: '1500',
    exit_price: '1025', closed_at: '4000',
  });
  assert.deepEqual(range.high, { price: 1025, at: 2000 });
});

test('premiumRange: sin muestras solo la salida; sin registro o abierta sin muestras es null', async () => {
  const onlyExit = await mapped({ exit_price: '402.3948', closed_at: '9000' });
  assert.deepEqual(onlyExit, { high: { price: 402.3948, at: 9000 }, low: { price: 402.3948, at: 9000 }, partial: false });
  assert.equal(await mapped({ premium_range_source: null, exit_price: '5', closed_at: '9000' }), null);
  assert.equal(await mapped({}), null);
  assert.equal((await mapped({ premium_range_source: 'partial', premium_high: '1', premium_high_at: '2', premium_low: '1', premium_low_at: '2' })).partial, true);
});

test('recordPremiumSample: UPDATE atómico solo sobre abiertas, con el extremo previo de la fila', async () => {
  const db = capturingDb([], 1);
  const repo = createOptionsStrategiesRepository({ db });
  assert.equal(await repo.recordPremiumSample(7, 1410, 123456), true);
  const { sql, args } = db.calls[0];
  assert.match(sql, /UPDATE options_strategy_positions/);
  assert.match(sql, /premium_high = GREATEST\(premium_high, \$2\)/);
  assert.match(sql, /premium_low = LEAST\(premium_low, \$2\)/);
  assert.match(sql, /\$2 > premium_high THEN \$3/);
  assert.match(sql, /WHERE id = \$1 AND closed_at IS NULL/);
  assert.deepEqual(args, [7, 1410, 123456]);
  const closed = createOptionsStrategiesRepository({ db: capturingDb([], 0) });
  assert.equal(await closed.recordPremiumSample(7, 1, 2), false);
});

test('listClosedBuyPositions: con limit toma las más recientes y las devuelve de antigua a nueva', async () => {
  const db = capturingDb([]);
  const repo = createOptionsStrategiesRepository({ db });
  await repo.listClosedBuyPositions(4, { mode: 'shadow', since: 1000, limit: 1001 });
  await repo.listClosedBuyPositions(4, { mode: 'live' });
  const [limited, unlimited] = db.calls;
  assert.deepEqual(limited.args, [4, 'shadow', 1000, 1001]);
  assert.match(limited.sql, /ORDER BY opened_at DESC, id DESC\s+LIMIT \$4/);
  assert.match(limited.sql, /\)\s*recent\s+ORDER BY opened_at, id/);
  // Sin limit: LIMIT NULL en PostgreSQL = sin tope.
  assert.deepEqual(unlimited.args, [4, 'live', null, null]);
});
