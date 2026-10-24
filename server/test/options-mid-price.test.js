const test = require('node:test');
const assert = require('node:assert/strict');
const { midLimitPrice } = require('../src/services/options/options-mid-price');

test('mid on the grid rounds toward the fill', () => {
  assert.equal(midLimitPrice({ bid: 700, ask: 725, side: 'BUY', tickSize: 5, minPrice: 5 }), 715);
  assert.equal(midLimitPrice({ bid: 700, ask: 725, side: 'SELL', tickSize: 5, minPrice: 5 }), 710);
  assert.equal(midLimitPrice({ bid: 700, ask: 720, side: 'BUY', tickSize: 5, minPrice: 5 }), 710);
});
test('one-tick spread rounds to the executable side', () => {
  assert.equal(midLimitPrice({ bid: 700, ask: 705, side: 'BUY', tickSize: 5, minPrice: 5 }), 705);
  assert.equal(midLimitPrice({ bid: 700, ask: 705, side: 'SELL', tickSize: 5, minPrice: 5 }), 700);
});
test('no valid mid without both sides or with a crossed book', () => {
  for (const q of [{ bid: 0, ask: 725 }, { bid: 700, ask: null }, { bid: 730, ask: 725 }]) {
    assert.equal(midLimitPrice({ ...q, side: 'BUY', tickSize: 5, minPrice: 5 }), null);
  }
});
test('works with decimal ticks without float drift', () => {
  assert.equal(midLimitPrice({ bid: 0.6, ask: 0.9, side: 'BUY', tickSize: 0.1, minPrice: 0.1 }), 0.8);
});
test('without tickSize returns the raw mid', () => {
  assert.equal(midLimitPrice({ bid: 700, ask: 725, side: 'BUY' }), 712.5);
});
