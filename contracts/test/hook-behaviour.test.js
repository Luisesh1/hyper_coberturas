'use strict';

// Pruebas de comportamiento que EJECUTAN el bytecode real de VolatilityShieldV1
// sobre una EVM en proceso (ver test/helpers/evm.js). A diferencia de
// VolatilityShieldV1.test.js (que valida compilación y artefacto), aquí
// llamamos a `beforeSwap` de verdad y observamos su efecto.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHookHarness, LP_FEE_OVERRIDE_FLAG } = require('./helpers/evm.js');

const BASE_FEE = 3000n;
const MAX_FEE_STEP = 500n;
const UPDATE_INTERVAL_SECONDS = 5n * 60n;

function buildPoolKey(hookAddress) {
  return {
    currency0: '0x0000000000000000000000000000000000000001',
    currency1: '0x0000000000000000000000000000000000000002',
    fee: 0x800000, // fee dinámica: delega la tarifa de cada swap al hook
    tickSpacing: 60,
    hooks: hookAddress,
  };
}

const swapParams = { zeroForOne: true, amountSpecified: -1_000_000n, sqrtPriceLimitX96: 0n };

test('la primera llamada de un pool fija BASE_FEE con el flag de override activo', async () => {
  const harness = await createHookHarness();
  await harness.setSlot0({ tick: 100 });

  const { fee } = await harness.beforeSwap({
    key: buildPoolKey(harness.hookAddress),
    params: swapParams,
    timestamp: 1_000n,
  });

  assert.equal(fee, LP_FEE_OVERRIDE_FLAG | BASE_FEE);
});

test('una llamada antes de UPDATE_INTERVAL no modifica la tarifa vigente', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);

  await harness.setSlot0({ tick: 100 });
  const first = await harness.beforeSwap({ key, params: swapParams, timestamp: 1_000n });

  // Movimiento de tick grande, pero todavía dentro del mismo UPDATE_INTERVAL:
  // no debe afectar la tarifa vigente.
  await harness.setSlot0({ tick: 900 });
  const second = await harness.beforeSwap({
    key,
    params: swapParams,
    timestamp: 1_000n + UPDATE_INTERVAL_SECONDS - 1n,
  });

  assert.equal(second.fee, first.fee);
});

test('el valor devuelto por beforeSwap lleva LPFeeLibrary.OVERRIDE_FEE_FLAG activo', async () => {
  const harness = await createHookHarness();
  await harness.setSlot0({ tick: 100 });

  const { fee } = await harness.beforeSwap({
    key: buildPoolKey(harness.hookAddress),
    params: swapParams,
    timestamp: 1_000n,
  });

  assert.equal(fee & LP_FEE_OVERRIDE_FLAG, LP_FEE_OVERRIDE_FLAG);
});

test('el delta devuelto por beforeSwap es exactamente cero: el hook no toca el accounting del swap', async () => {
  const harness = await createHookHarness();
  await harness.setSlot0({ tick: 100 });

  const { delta } = await harness.beforeSwap({
    key: buildPoolKey(harness.hookAddress),
    params: swapParams,
    timestamp: 1_000n,
  });

  assert.equal(delta, 0n);
});

test('el selector devuelto corresponde a beforeSwap.selector', async () => {
  const harness = await createHookHarness();
  await harness.setSlot0({ tick: 100 });

  const { selector } = await harness.beforeSwap({
    key: buildPoolKey(harness.hookAddress),
    params: swapParams,
    timestamp: 1_000n,
  });

  assert.equal(selector, harness.iface.getFunction('beforeSwap').selector);
});

test('tras UPDATE_INTERVAL la tarifa puede moverse, pero nunca más de MAX_FEE_STEP', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);

  await harness.setSlot0({ tick: 0 });
  const first = await harness.beforeSwap({ key, params: swapParams, timestamp: 1_000n });

  // Salto de tick enorme para forzar la saturación del paso hacia arriba.
  await harness.setSlot0({ tick: 5000 });
  const second = await harness.beforeSwap({
    key,
    params: swapParams,
    timestamp: 1_000n + UPDATE_INTERVAL_SECONDS + 1n,
  });

  const firstRawFee = first.fee - LP_FEE_OVERRIDE_FLAG;
  const secondRawFee = second.fee - LP_FEE_OVERRIDE_FLAG;
  assert.equal(secondRawFee - firstRawFee, MAX_FEE_STEP);
});
