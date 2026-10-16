const test = require('node:test');
const assert = require('node:assert/strict');
const template = require('../src/services/options/templates/alert-signal');

const symbol = 'BTC-261030-63000-C';
const row = { strike: 63000, call: {
  symbol, ask: 50, bid: 49, delta: 0.35, iv: 0.5,
  minQty: 0.01, stepSize: 0.01, maxQty: 10,
} };
const baseCtx = {
  now: Date.UTC(2026, 9, 15, 10),
  spot: 60000,
  chain: { underlying: 'BTC', expiry: '261030', spot: 60000, rows: [row] },
  positions: [],
  signal: { direction: 'bullish', eventId: 100 },
  tradesToday: 0,
};

test('alert_signal respeta el paso real de Binance y nunca supera cantidad configurada', () => {
  const params = template.validateParams({
    quantity: 0.035, capitalUsdt: 10, alertIds: [1],
  });
  const [action] = template.evaluate({ ...baseCtx, params });
  assert.equal(action.type, 'open');
  assert.equal(action.legs[0].quantity, 0.03);
  assert.equal(action.legs[0].symbol, symbol);
});

test('redondea hacia abajo bajo presupuesto y omite entradas que no cubren minQty', () => {
  let params = template.validateParams({ quantity: 0.05, capitalUsdt: 0.8, alertIds: [1] });
  let [action] = template.evaluate({ ...baseCtx, params });
  assert.equal(action.type, 'open');
  assert.equal(action.legs[0].quantity, 0.01);
  assert.ok(action.legs[0].quantity * action.legs[0].price <= params.capitalUsdt);
  params = template.validateParams({ quantity: 0.05, capitalUsdt: 0.2, alertIds: [1] });
  [action] = template.evaluate({ ...baseCtx, params });
  assert.equal(action.type, 'skip');
  assert.equal(action.reason, 'capital_limit');
});

test('el límite maxQty del exchange también se aplica a cada contrato', () => {
  const params = template.validateParams({ quantity: 1, capitalUsdt: 1000, alertIds: [1] });
  const limited = { ...row, call: { ...row.call, maxQty: 0.02 } };
  const [action] = template.evaluate({ ...baseCtx, chain: { ...baseCtx.chain, rows: [limited] }, params });
  assert.equal(action.type, 'open');
  assert.equal(action.legs[0].quantity, 0.02);
});
