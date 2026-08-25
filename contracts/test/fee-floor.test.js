'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHookHarness, LP_FEE_OVERRIDE_FLAG } = require('./helpers/evm.js');

const FLOOR_FEE = 500n;
const BASE_FEE = 3000n;
const MAX_FEE_STEP = 500n;
const WINDOW = 300n;

function buildPoolKey(hookAddress) {
  return {
    currency0: '0x0000000000000000000000000000000000000001',
    currency1: '0x0000000000000000000000000000000000000002',
    fee: 0x800000,
    tickSpacing: 60,
    hooks: hookAddress,
  };
}

const params = { zeroForOne: true, amountSpecified: -1_000_000n, sqrtPriceLimitX96: 0n };

async function swapAt(harness, key, tick, timestamp) {
  await harness.setSlot0({ key, tick });
  const { fee } = await harness.beforeSwap({ key, params, timestamp });
  return fee - LP_FEE_OVERRIDE_FLAG;
}

test('la calma sostenida baja la tarifa hasta FLOOR_FEE sin cruzarlo y la volatilidad la vuelve a subir', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);
  const fees = [];

  await swapAt(harness, key, 0, 1_000n);
  // Primera ventana: sólo fija la referencia TWAP.
  await swapAt(harness, key, 0, 1_000n + WINDOW);

  for (let window = 2n; window <= 7n; window += 1n) {
    fees.push(await swapAt(harness, key, 0, 1_000n + window * WINDOW));
  }

  assert.ok(fees.some((fee) => fee < BASE_FEE), 'la tarifa debe bajar de BASE_FEE en calma');
  assert.equal(fees.at(-1), FLOOR_FEE, 'la tarifa converge al suelo nominal de 5 bps');
  for (let index = 1; index < fees.length; index += 1) {
    assert.ok(fees[index - 1] - fees[index] <= MAX_FEE_STEP, 'el descenso respeta MAX_FEE_STEP');
    assert.ok(fees[index] >= FLOOR_FEE, 'el suelo nunca se cruza');
  }

  const afterVolatility = await swapAt(harness, key, 1_000, 1_000n + 8n * WINDOW);
  assert.equal(afterVolatility - FLOOR_FEE, MAX_FEE_STEP, 'la volatilidad devuelve la tarifa hacia la base');
});
