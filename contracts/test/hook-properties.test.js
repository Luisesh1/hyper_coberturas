'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHookHarness, LP_FEE_OVERRIDE_FLAG } = require('./helpers/evm.js');

const FLOOR_FEE = 500n;
const CAP_FEE = 6000n;
const MAX_FEE_STEP = 500n;
const MIN_TICK = -887_272;
const MAX_TICK = 887_272;

function createRng(seed) {
  let value = BigInt(seed) & 0xffff_ffffn;
  return () => {
    value ^= value << 13n;
    value ^= value >> 17n;
    value ^= value << 5n;
    value &= 0xffff_ffffn;
    return Number(value);
  };
}

function buildPoolKey(hookAddress, salt) {
  const pad = (n) => n.toString(16).padStart(40, '0');
  return {
    currency0: `0x${pad(salt * 2 - 1)}`,
    currency1: `0x${pad(salt * 2)}`,
    fee: 0x800000,
    tickSpacing: 60,
    hooks: hookAddress,
  };
}

const params = { zeroForOne: true, amountSpecified: -1_000_000n, sqrtPriceLimitX96: 0n };

test('propiedades: la tarifa, el delta y el selector sobreviven secuencias adversariales reproducibles', async () => {
  const seeds = [0x1a2b3c4d, 0xdecafbad];

  for (const seed of seeds) {
    const rng = createRng(seed);
    const harness = await createHookHarness();
    const key = buildPoolKey(harness.hookAddress, seed & 0xff);
    let timestamp = 1_000n;
    let previousFee = null;

    for (let step = 0; step < 96; step += 1) {
      const roll = rng();
      const tick = step % 17 === 0
        ? (step % 2 === 0 ? MIN_TICK : MAX_TICK)
        : (roll % (MAX_TICK - MIN_TICK + 1)) + MIN_TICK;
      // Incluye mismo bloque, segundos, una ventana y saltos de días, pero
      // mantiene el reloj monótono para que sea una secuencia EVM válida.
      const jump = [0, 1, 12, 299, 300, 301, 86_400, 7 * 86_400][rng() % 8];
      timestamp += BigInt(jump);

      await harness.setSlot0({ key, tick });
      let result;
      try {
        result = await harness.beforeSwap({ key, params, timestamp });
      } catch (error) {
        assert.fail(`seed=${seed} step=${step} tick=${tick} jump=${jump}: ${error.message}`);
      }

      const rawFee = result.fee - LP_FEE_OVERRIDE_FLAG;
      assert.ok(rawFee >= FLOOR_FEE && rawFee <= CAP_FEE, `seed=${seed} step=${step}: fee fuera de rango`);
      if (previousFee != null) {
        const delta = rawFee >= previousFee ? rawFee - previousFee : previousFee - rawFee;
        assert.ok(delta <= MAX_FEE_STEP, `seed=${seed} step=${step}: salto de fee ${delta}`);
      }
      assert.equal(result.delta, 0n, `seed=${seed} step=${step}: delta no nulo`);
      assert.equal(result.selector, harness.iface.getFunction('beforeSwap').selector, `seed=${seed} step=${step}: selector`);
      previousFee = rawFee;
    }
  }
});
