const test = require('node:test');
const assert = require('node:assert/strict');
const { getSqrtPriceX96AtTick, MIN_TICK, MAX_TICK } = require('../src/services/uniswap/v4-tick-math');

test('TickMath V4 reproduce los valores exactos de referencia', () => {
  assert.equal(getSqrtPriceX96AtTick(0), 79228162514264337593543950336n);
  assert.equal(getSqrtPriceX96AtTick(1), 79232123823359799118286999568n);
  assert.equal(getSqrtPriceX96AtTick(-1), 79224201403219477170569942574n);
  assert.equal(getSqrtPriceX96AtTick(MIN_TICK), 4295128739n);
  assert.equal(getSqrtPriceX96AtTick(MAX_TICK), 1461446703485210103287273052203988822378723970342n);
});

test('TickMath V4 rechaza ticks fuera de los límites on-chain', () => {
  assert.throws(() => getSqrtPriceX96AtTick(MAX_TICK + 1), RangeError);
  assert.throws(() => getSqrtPriceX96AtTick(MIN_TICK - 1), RangeError);
});
