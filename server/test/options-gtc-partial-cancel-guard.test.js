const test = require('node:test');
const assert = require('node:assert/strict');
const { isOrderableRemainder } =
  require('../src/services/options/options-live-execution.service');

const SYMBOL = 'ETH-261023-2500-C';
const exchange = (minQty, stepSize, maxQty = '10') => ({
  optionSymbols: [{
    symbol: SYMBOL, status: 'TRADING',
    filters: [{ filterType: 'LOT_SIZE', minQty, stepSize, maxQty }],
  }],
});

test('GTC residual: Binance minQty and stepSize are checked exactly', () => {
  const info = exchange('0.01', '0.01');
  assert.equal(isOrderableRemainder(info, SYMBOL, 0.005), false);
  assert.equal(isOrderableRemainder(info, SYMBOL, 0.01), true);
  assert.equal(isOrderableRemainder(info, SYMBOL, 0.015), false);
  assert.equal(isOrderableRemainder(info, SYMBOL, 0.02), true);
  assert.equal(isOrderableRemainder(info, SYMBOL, 10.01), false);
});

test('GTC residual: minQty origin, not zero, determines allowed increments', () => {
  const info = exchange('0.005', '0.01');
  assert.equal(isOrderableRemainder(info, SYMBOL, 0.005), true);
  assert.equal(isOrderableRemainder(info, SYMBOL, 0.01), false);
  assert.equal(isOrderableRemainder(info, SYMBOL, 0.015), true);
});

test('GTC residual: missing or invalid filters fail closed', () => {
  assert.throws(() => isOrderableRemainder({}, SYMBOL, 0.01), /lot constraints/);
  assert.throws(() => isOrderableRemainder(exchange('0', '0.01'), SYMBOL, 0.01), /lot constraints/);
  assert.throws(() => isOrderableRemainder(exchange('0.01', '0'), SYMBOL, 0.01), /lot constraints/);
  assert.throws(() => isOrderableRemainder(exchange('0.01', '0.01'), SYMBOL, NaN), /lot constraints/);
});
