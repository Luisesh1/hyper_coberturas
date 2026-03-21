const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getTrackedPositionSize,
  normalizeStatus,
  rowToHedge,
} = require('../src/services/hedge.state');

test('normalizeStatus convierte open sin sl en entry_filled_pending_sl', () => {
  assert.equal(normalizeStatus({ status: 'open', sl_oid: null }), 'entry_filled_pending_sl');
});

test('normalizeStatus convierte open con sl en open_protected', () => {
  assert.equal(normalizeStatus({ status: 'open', sl_oid: 10 }), 'open_protected');
});

test('getTrackedPositionSize prioriza el tamaño real de la posición', () => {
  assert.equal(getTrackedPositionSize({ size: 1, positionSize: 0.4 }), 0.4);
  assert.equal(getTrackedPositionSize({ size: 1, positionSize: null }), 1);
});

test('rowToHedge normaliza campos numéricos clave', () => {
  const hedge = rowToHedge({
    id: 1,
    user_id: 2,
    asset: 'BTC',
    direction: 'short',
    entry_price: '70000',
    exit_price: '71000',
    size: '0.001',
    leverage: 5,
    label: 'test',
    margin_mode: 'isolated',
    status: 'open',
    entry_oid: '11',
    sl_oid: '12',
    asset_index: 0,
    sz_decimals: 5,
    position_size: '0.0007',
    dynamic_anchor_price: '70500',
    open_price: '69900',
    close_price: null,
    unrealized_pnl: '1.23',
    error: null,
    cycle_count: 2,
    created_at: '1',
    opened_at: '2',
    closed_at: null,
    position_key: 'pk',
    closing_started_at: null,
    sl_placed_at: '3',
    last_fill_at: '4',
    last_reconciled_at: '5',
    entry_fill_oid: '22',
    entry_fill_time: '6',
    entry_fee_paid: '0.1',
    funding_accum: '0.2',
  });

  assert.equal(hedge.status, 'open_protected');
  assert.equal(hedge.positionSize, 0.0007);
  assert.equal(hedge.openPrice, 69900);
  assert.equal(hedge.dynamicAnchorPrice, 70500);
  assert.equal(hedge.entryOid, 11);
  assert.equal(hedge.slOid, 12);
});
