'use strict';

// Pruebas de comportamiento que EJECUTAN el bytecode real de VolatilityShieldV1
// sobre una EVM en proceso (ver test/helpers/evm.js). A diferencia de
// VolatilityShieldV1.test.js (que valida compilación y artefacto), aquí
// llamamos a `beforeSwap` de verdad y observamos su efecto.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  createHookHarness,
  getRawRuntimeBytecode,
  HOOK_FLAG_BITS,
  ALL_HOOK_MASK,
  LP_FEE_OVERRIDE_FLAG,
} = require('./helpers/evm.js');

const BASE_FEE = 3000n;
const MAX_FEE_STEP = 500n;
const CAP_FEE = 6000n;
const UPDATE_INTERVAL_SECONDS = 5n * 60n;

function buildPoolKey(hookAddress, salt = 1) {
  const pad = (n) => n.toString(16).padStart(40, '0');
  return {
    currency0: `0x${pad(salt * 2 - 1)}`,
    currency1: `0x${pad(salt * 2)}`,
    fee: 0x800000, // fee dinámica: delega la tarifa de cada swap al hook
    tickSpacing: 60,
    hooks: hookAddress,
  };
}

const swapParams = { zeroForOne: true, amountSpecified: -1_000_000n, sqrtPriceLimitX96: 0n };

test('la dirección elegida para el hook coincide exactamente con la máscara de getHookPermissions()', async () => {
  const harness = await createHookHarness();
  const permissions = await harness.readHookPermissions();

  let expectedBits = 0n;
  for (const [name, bit] of Object.entries(HOOK_FLAG_BITS)) {
    if (permissions[name]) expectedBits |= BigInt(bit);
  }

  const addressBits = BigInt(harness.hookAddress) & ALL_HOOK_MASK;
  // Si el contrato ganara un flag nuevo (o perdiera beforeSwap) sin re-elegir
  // HOOK_ADDRESS, esta comparación deja de cuadrar: es la misma condición que
  // Hooks.validateHookPermissions exige en un despliegue real.
  assert.equal(addressBits, expectedBits);
  assert.equal(permissions.beforeSwap, true);
});

test('el runtime bytecode del arnés coincide con el artefacto de producción antes de parchear immutables', () => {
  const artifactPath = path.join(__dirname, '..', 'artifacts', 'VolatilityShieldV1.json');
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  assert.equal(getRawRuntimeBytecode(), artifact.runtimeBytecode);
});

test('el PoolManager simulado revierte ante cualquier selector que no sea extsload(bytes32)', async () => {
  const harness = await createHookHarness();
  const { exceptionError } = await harness.callPoolManagerMock(`0xdeadbeef${'00'.repeat(32)}`);
  assert.ok(exceptionError, 'debe revertir ante un selector desconocido');
});

test('dos pools distintos mantienen su propia tarifa: no comparten el slot0 simulado', async () => {
  const harness = await createHookHarness();
  const keyA = buildPoolKey(harness.hookAddress, 1);
  const keyB = buildPoolKey(harness.hookAddress, 2);

  await harness.setSlot0({ key: keyA, tick: 100 });
  await harness.setSlot0({ key: keyB, tick: 100 });
  await harness.beforeSwap({ key: keyA, params: swapParams, timestamp: 1_000n });
  await harness.beforeSwap({ key: keyB, params: swapParams, timestamp: 1_000n });

  // Cada pool gasta una primera ventana en fijar su referencia de TWAP; hasta
  // que no cierra, ninguno mueve tarifa (ver twap-manipulation.test.js).
  const referencia = 1_000n + UPDATE_INTERVAL_SECONDS;
  await harness.beforeSwap({ key: keyA, params: swapParams, timestamp: referencia });
  await harness.beforeSwap({ key: keyB, params: swapParams, timestamp: referencia });

  // Solo el pool A sufre un salto de tick grande tras el intervalo.
  await harness.setSlot0({ key: keyA, tick: 900_000 });
  const medida = referencia + UPDATE_INTERVAL_SECONDS + 1n;
  const afterA = await harness.beforeSwap({ key: keyA, params: swapParams, timestamp: medida });
  const afterB = await harness.beforeSwap({ key: keyB, params: swapParams, timestamp: medida });

  assert.notEqual(afterA.fee, afterB.fee, 'el pool B no debió heredar el movimiento de tarifa del pool A');
  assert.equal(
    afterB.fee,
    LP_FEE_OVERRIDE_FLAG | (BASE_FEE - MAX_FEE_STEP),
    'el pool B, sin volatilidad, inicia su descenso independiente hacia FLOOR_FEE',
  );
});

test('la primera llamada de un pool fija BASE_FEE con el flag de override activo', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);
  await harness.setSlot0({ key, tick: 100 });

  const { fee } = await harness.beforeSwap({ key, params: swapParams, timestamp: 1_000n });

  assert.equal(fee, LP_FEE_OVERRIDE_FLAG | BASE_FEE);
});

test('una llamada antes de UPDATE_INTERVAL no modifica la tarifa ni adelanta el tick de referencia', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);

  await harness.setSlot0({ key, tick: 100 });
  await harness.beforeSwap({ key, params: swapParams, timestamp: 1_000n });

  // Primera ventana: sólo fija la referencia del TWAP (100, el tick donde el
  // pool estuvo de verdad). A partir de aquí ya se puede medir movimiento.
  const referencia = 1_000n + UPDATE_INTERVAL_SECONDS;
  const first = await harness.beforeSwap({ key, params: swapParams, timestamp: referencia });

  // Movimiento de tick grande, pero todavía dentro del mismo UPDATE_INTERVAL:
  // no debe afectar la tarifa vigente.
  await harness.setSlot0({ key, tick: 900 });
  const second = await harness.beforeSwap({
    key,
    params: swapParams,
    timestamp: referencia + UPDATE_INTERVAL_SECONDS - 1n,
  });
  assert.equal(second.fee, first.fee);

  // Prueba de que la llamada sub-intervalo observó pero no cerró la ventana:
  // si hubiera movido el checkpoint, la ventana siguiente arrancaría con la
  // referencia ya en 900 y no habría movimiento que medir. Como el checkpoint
  // sigue en la referencia original (100), al cruzar el intervalo la tarifa SÍ
  // debe subir, saturada contra MAX_FEE_STEP.
  //
  // El TWAP de esa ventana sale exactamente 900, y conviene ser preciso sobre
  // por qué: por la convención del contrato, la observación sub-intervalo lee
  // 900 y se lo acredita a los 299 s anteriores, y la del cierre le acredita
  // los 2 s restantes (900*299 + 900*2 sobre 301 s). Se le acreditan los 301 s
  // completos, no 299. El arnés mueve slot0 sin swap de por medio y el hook no
  // puede saber en qué instante se movió el precio; en un pool real ese cambio
  // de tick habría sido un swap, y por tanto una observación.
  const third = await harness.beforeSwap({
    key,
    params: swapParams,
    timestamp: referencia + UPDATE_INTERVAL_SECONDS + 1n,
  });
  const secondRawFee = second.fee - LP_FEE_OVERRIDE_FLAG;
  const thirdRawFee = third.fee - LP_FEE_OVERRIDE_FLAG;
  assert.equal(
    thirdRawFee - secondRawFee,
    MAX_FEE_STEP,
    'la referencia debe seguir siendo el tick original (100), no el intermedio (900)',
  );
});

test('el valor devuelto por beforeSwap lleva LPFeeLibrary.OVERRIDE_FEE_FLAG activo', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);
  await harness.setSlot0({ key, tick: 100 });

  const { fee } = await harness.beforeSwap({ key, params: swapParams, timestamp: 1_000n });

  assert.equal(fee & LP_FEE_OVERRIDE_FLAG, LP_FEE_OVERRIDE_FLAG);
});

test('el delta devuelto por beforeSwap es exactamente cero: el hook no toca el accounting del swap', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);
  await harness.setSlot0({ key, tick: 100 });

  const { delta } = await harness.beforeSwap({ key, params: swapParams, timestamp: 1_000n });

  assert.equal(delta, 0n);
});

test('el selector devuelto corresponde a beforeSwap.selector', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);
  await harness.setSlot0({ key, tick: 100 });

  const { selector } = await harness.beforeSwap({ key, params: swapParams, timestamp: 1_000n });

  assert.equal(selector, harness.iface.getFunction('beforeSwap').selector);
});

test('tras UPDATE_INTERVAL la tarifa puede moverse, pero nunca más de MAX_FEE_STEP', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);

  await harness.setSlot0({ key, tick: 0 });
  await harness.beforeSwap({ key, params: swapParams, timestamp: 1_000n });

  // Primera ventana: sólo fija la referencia del TWAP, no mueve tarifa.
  const referencia = 1_000n + UPDATE_INTERVAL_SECONDS;
  const first = await harness.beforeSwap({ key, params: swapParams, timestamp: referencia });

  // Salto de tick enorme para forzar la saturación del paso hacia arriba.
  await harness.setSlot0({ key, tick: 5000 });
  const second = await harness.beforeSwap({
    key,
    params: swapParams,
    timestamp: referencia + UPDATE_INTERVAL_SECONDS + 1n,
  });

  const firstRawFee = first.fee - LP_FEE_OVERRIDE_FLAG;
  const secondRawFee = second.fee - LP_FEE_OVERRIDE_FLAG;
  assert.equal(secondRawFee - firstRawFee, MAX_FEE_STEP);
});

test('los ticks negativos fluyen correctamente por el encoder de slot0 y por el hook', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);

  await harness.setSlot0({ key, tick: -1000 });
  const first = await harness.beforeSwap({ key, params: swapParams, timestamp: 1_000n });
  assert.equal(first.fee, LP_FEE_OVERRIDE_FLAG | BASE_FEE);

  // Primera ventana: fija la referencia en -1000, el TWAP real del periodo.
  const referencia = 1_000n + UPDATE_INTERVAL_SECONDS;
  await harness.beforeSwap({ key, params: swapParams, timestamp: referencia });

  await harness.setSlot0({ key, tick: -1500 });
  const second = await harness.beforeSwap({
    key,
    params: swapParams,
    timestamp: referencia + UPDATE_INTERVAL_SECONDS + 1n,
  });
  assert.equal(second.fee - LP_FEE_OVERRIDE_FLAG, BASE_FEE + MAX_FEE_STEP);
});

test('la tarifa toca CAP_FEE tras suficientes intervalos saturados y nunca lo supera', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);

  let timestamp = 1_000n;
  let tick = 0;
  await harness.setSlot0({ key, tick });
  let result = await harness.beforeSwap({ key, params: swapParams, timestamp });

  // De BASE_FEE (3000) a CAP_FEE (6000) en pasos de MAX_FEE_STEP (500) son 6
  // intervalos, más uno que se va en fijar la referencia del TWAP: iteramos 8
  // para confirmar que, una vez tocado el techo, un intervalo adicional con la
  // misma señal saturada no lo perfora.
  for (let i = 0; i < 8; i += 1) {
    tick += 5000;
    timestamp += UPDATE_INTERVAL_SECONDS + 1n;
    await harness.setSlot0({ key, tick });
    result = await harness.beforeSwap({ key, params: swapParams, timestamp });
  }

  assert.equal(result.fee - LP_FEE_OVERRIDE_FLAG, CAP_FEE);
});
