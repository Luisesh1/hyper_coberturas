const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ensureAtrBandTarget } = require('../src/services/options/options-atr-band-target');
const { atrBandTakeProfit } = require('../src/services/options/options-atr-band-tp');
const { createOptionsStrategiesRepository } = require('../src/repositories/options-strategies.repository');
const { createOptionsLiveOrdersRepository } = require('../src/repositories/options-live-orders.repository');
const alertSignal = require('../src/services/options/templates/alert-signal');

const NOW = Date.UTC(2026, 9, 16, 10);
const SYMBOL = 'BTC-261030-100000-C';
const BAND = { close: 99900, atr: 75, upper: 100050, lower: 99750, multiplier: 2 };
const params = alertSignal.validateParams({ takeProfitMode: 'atr_band', atrBandInterval: '15m', atrBandLength: 20, atrBandMultiplier: 2, tpMaxGainPct: 200 });

function deps({ band = BAND, inputs = { tickSize: 0.1, minPrice: 0 } } = {}) {
  const calls = { band: [], inputs: 0, saved: [] };
  const market = {
    async getAtrBand(underlying, opts) { calls.band.push({ underlying, ...opts }); if (band instanceof Error) throw band; return band; },
    async getVolatilityInputs() { calls.inputs++; return inputs; },
  };
  const repo = {
    async setTpTarget(id, price, meta) {
      calls.saved.push({ id, price, meta });
      return { id, tpTargetPrice: price, tpTargetMeta: meta };
    },
  };
  return { market, repo, calls };
}

const position = { id: 9, symbol: SYMBOL, side: 'BUY', entryPrice: 100, quantity: 0.1, tpTargetPrice: null };

test('ensureAtrBandTarget: calcula con el spot dado, persiste precio y metadatos', async () => {
  const { market, repo, calls } = deps();
  const out = await ensureAtrBandTarget(position, params, { market, repo, spot: 100000, now: NOW });
  assert.deepEqual(calls.band, [{ underlying: 'BTC', interval: '15m', length: 20, multiplier: 2 }]);
  const expected = atrBandTakeProfit({ fillPrice: 100, spot: 100000, type: 'C', band: BAND, tickSize: 0.1, minPrice: 0, maxGainPct: 200 });
  assert.equal(expected.price, 150);
  assert.equal(out.tpTargetPrice, 150);
  assert.equal(calls.saved.length, 1);
  assert.equal(calls.saved[0].id, 9);
  assert.equal(calls.saved[0].price, 150);
  assert.deepEqual(calls.saved[0].meta, {
    spot: 100000, interval: '15m', length: 20, multiplier: 2,
    bandValue: expected.bandValue, distancePct: expected.distancePct, leverage: expected.leverage,
    rawGainPct: expected.rawGainPct, appliedGainPct: expected.appliedGainPct, capped: false,
    computedAt: NOW,
  });
  assert.equal(calls.inputs, 1, 'sin tick explícito lo pide a getVolatilityInputs');
});

test('ensureAtrBandTarget: con tick explícito no llama a getVolatilityInputs; con objetivo nunca recalcula', async () => {
  const { market, repo, calls } = deps();
  await ensureAtrBandTarget(position, params, { market, repo, spot: 100000, tickSize: 0.1, minPrice: 0, now: NOW });
  assert.equal(calls.inputs, 0);
  const fixed = await ensureAtrBandTarget({ ...position, tpTargetPrice: 222 }, params, { market, repo, spot: 1, now: NOW });
  assert.equal(fixed.tpTargetPrice, 222);
  assert.equal(calls.band.length, 1, 'con objetivo guardado no vuelve a pedir la banda');
  assert.equal(calls.saved.length, 1);
});

test('ensureAtrBandTarget: otros modos no hacen nada; sin velas, tick o spot queda pendiente', async () => {
  const { market, repo, calls } = deps();
  const fixedMode = alertSignal.validateParams({});
  assert.equal((await ensureAtrBandTarget(position, fixedMode, { market, repo, spot: 100000 })).tpTargetPrice, null);
  assert.equal(calls.band.length, 0);
  assert.equal((await ensureAtrBandTarget(position, params, { market, repo, spot: null })).tpTargetPrice, null);
  const noBand = deps({ band: null });
  assert.equal((await ensureAtrBandTarget(position, params, { ...noBand, spot: 100000 })).tpTargetPrice, null);
  const noTick = deps({ inputs: { tickSize: null, minPrice: null } });
  assert.equal((await ensureAtrBandTarget(position, params, { ...noTick, spot: 100000 })).tpTargetPrice, null);
  assert.equal(calls.saved.length + noBand.calls.saved.length + noTick.calls.saved.length, 0);
  const failing = deps({ band: new Error('klines caídas') });
  await assert.rejects(ensureAtrBandTarget(position, params, { ...failing, spot: 100000 }), /klines/);
});

test('ensureAtrBandTarget: si otro proceso ya lo fijó, devuelve el valor ganador guardado', async () => {
  const { market } = deps();
  const repo = { async setTpTarget() { return { id: 9, tpTargetPrice: 175, tpTargetMeta: { spot: 1 } }; } };
  const out = await ensureAtrBandTarget(position, params, { market, repo, spot: 100000, tickSize: 0.1, minPrice: 0 });
  assert.equal(out.tpTargetPrice, 175);
  assert.deepEqual(out.tpTargetMeta, { spot: 1 });
});

test('migración 044 añade tp_target_price y tp_target_meta', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/044_options_position_tp_target.sql'), 'utf8');
  assert.match(sql, /ALTER TABLE options_strategy_positions/);
  assert.match(sql, /tp_target_price NUMERIC/);
  assert.match(sql, /tp_target_meta JSONB/);
});

test('repositorio: setTpTarget solo escribe si está vacío y mapPosition expone el objetivo', async () => {
  const queries = [];
  const row = { id: '9', strategy_id: '1', user_id: '7', mode: 'shadow', symbol: SYMBOL, side: 'BUY', quantity: '0.1',
    entry_price: '100', opened_at: String(NOW), fees_usdt: '0.1', tp_target_price: '150', tp_target_meta: { spot: 100000 } };
  const db = { async query(sql, args) {
    queries.push({ sql, args });
    if (sql.includes('UPDATE options_strategy_positions')) return { rows: [] };
    return { rows: [row] };
  } };
  const repo = createOptionsStrategiesRepository({ db });
  const out = await repo.setTpTarget(9, 150, { spot: 100000 });
  assert.match(queries[0].sql, /tp_target_price IS NULL/);
  assert.equal(queries[0].args[1], 150);
  assert.equal(queries[0].args[2], JSON.stringify({ spot: 100000 }));
  assert.match(queries[1].sql, /SELECT \* FROM options_strategy_positions WHERE id = \$1/);
  assert.equal(out.tpTargetPrice, 150);
  assert.deepEqual(out.tpTargetMeta, { spot: 100000 });

  const [listed] = await repo.listOpenPositions(1, 'shadow');
  assert.equal(listed.tpTargetPrice, 150);
  const empty = createOptionsStrategiesRepository({ db: { async query() { return { rows: [{ ...row, tp_target_price: null, tp_target_meta: null }] }; } } });
  const [none] = await empty.listOpenPositions(1, 'shadow');
  assert.equal(none.tpTargetPrice, null);
  assert.equal(none.tpTargetMeta, null);
});

test('repositorio real: listMissingTpPositions trae el objetivo guardado', async () => {
  let seen = '';
  const db = { async query(sql) {
    seen = sql;
    return { rows: [{ id: '9', strategy_id: '4', user_id: '7', symbol: SYMBOL, side: 'BUY', quantity: '0.2',
      entry_price: '100', params: { takeProfitMode: 'atr_band' }, underlying: 'BTC',
      tp_target_price: '150', tp_target_meta: '{"spot":100000}' }] };
  } };
  const repo = createOptionsLiveOrdersRepository({ db, now: () => NOW });
  const [p] = await repo.listMissingTpPositions();
  assert.match(seen, /p\.tp_target_price/);
  assert.equal(p.tpTargetPrice, 150);
  assert.deepEqual(p.tpTargetMeta, { spot: 100000 });
});

function deadlineTx(params) {
  const sqls = [];
  const tx = { async query(sql, args) {
    sqls.push(sql);
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM options_strategy_positions')) {
      return { rows: [{ id: '100', user_id: '7', strategy_id: '4', symbol: SYMBOL, params }] };
    }
    if (sql.includes('INSERT INTO options_live_exit_requests')) return { rows: [] };
    if (sql.includes('UPDATE options_live_orders SET cancel_requested')) return { rowCount: 1 };
    throw Error('Unexpected SQL: ' + sql + args);
  } };
  return { sqls, repo: createOptionsLiveOrdersRepository({ db: { transaction: (f) => f(tx) }, now: () => NOW }) };
}
const tpOrder = { id: 33, purpose: 'take_profit', userId: 7, strategyId: 4, positionId: 100, symbol: SYMBOL };

test('repositorio real: el plazo del TP NO crea salida por tiempo en atr_band', async () => {
  const atr = deadlineTx({ takeProfitMode: 'atr_band' });
  assert.equal(await atr.repo.requestDeadlineExit(tpOrder), false);
  assert.ok(!atr.sqls.some((s) => s.includes('INSERT INTO options_live_exit_requests')));

  const fixed = deadlineTx({ takeProfitMode: 'fixed' });
  assert.equal(await fixed.repo.requestDeadlineExit(tpOrder), true);
  assert.ok(fixed.sqls.some((s) => s.includes('INSERT INTO options_live_exit_requests')));
  const legacy = deadlineTx({});
  assert.equal(await legacy.repo.requestDeadlineExit(tpOrder), true, 'bots sin la clave siguen con salida por tiempo');
});
