'use strict';

// Pruebas de resistencia a manipulación de la señal de volatilidad.
//
// La señal antigua comparaba dos puntos: el tick del instante del swap contra
// el tick del checkpoint anterior. Quien controlara el precio en el instante
// exacto del muestreo sesgaba la lectura entera casi gratis (mover el precio,
// disparar el swap objetivo, revertir en el mismo bloque). La señal nueva es
// un promedio ponderado por el tiempo que cada tick estuvo vigente, así que un
// tick sostenido durante un solo bloque pesa `12/300 = 4%` de la ventana.
//
// Aquí no se mide "la tarifa cambió menos": se miden los números concretos del
// acumulador (`tickCumulative`) y del TWAP derivado (`lastTwapTick`), que el
// getter público del mapping `poolState` expone. La tarifa satura contra
// CAP_FEE y MAX_FEE_STEP, y esa saturación esconde la magnitud real de la
// señal; el acumulador no.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHookHarness, LP_FEE_OVERRIDE_FLAG } = require('./helpers/evm.js');

const BASE_FEE = 3000n;
const MAX_FEE_STEP = 500n;
const CAP_FEE = 6000n;
const WINDOW = 300n; // UPDATE_INTERVAL
const BLOCK = 12n; // duración de un bloque de Ethereum mainnet

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

// Un swap ejecutado en `timestamp`, precedido por un periodo en el que el pool
// estuvo en `tick`. Es la semántica que asume el hook: el tick que lee en
// `beforeSwap` es el que dejó el swap anterior, y por tanto el que ha regido
// durante todo el hueco entre ambos.
async function swapAt(harness, key, tick, timestamp) {
  await harness.setSlot0({ key, tick });
  const { fee } = await harness.beforeSwap({ key, params: swapParams, timestamp });
  return fee - LP_FEE_OVERRIDE_FLAG;
}

test('el primer swap de un pool abre el acumulador en cero y siembra la referencia con el tick actual', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);

  const fee = await swapAt(harness, key, -321, 1_000n);

  const state = await harness.readPoolState(key);
  assert.equal(fee, BASE_FEE, 'sin historia que promediar, la tarifa arranca en BASE_FEE');
  assert.equal(state.tickCumulative, 0n, 'el acumulador arranca en cero');
  assert.equal(state.checkpointTickCumulative, 0n, 'el checkpoint arranca en cero');
  assert.equal(state.lastTwapTick, -321n, 'la referencia se siembra con el único dato disponible');
  assert.equal(state.lastObservedAt, 1_000n);
  assert.equal(state.lastUpdatedAt, 1_000n);
});

test('dos swaps en el mismo bloque no revierten y el segundo no aporta nada al acumulador', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);

  await swapAt(harness, key, 0, 1_000n);
  await swapAt(harness, key, 500, 1_100n);
  const afterFirst = await harness.readPoolState(key);

  // Mismo timestamp: el hueco desde la observación anterior es cero, así que
  // el tick que traiga este swap pesa cero por mucho que se salga de rango.
  await swapAt(harness, key, 7_000, 1_100n);
  const afterSecond = await harness.readPoolState(key);

  assert.equal(afterFirst.tickCumulative, 500n * 100n, 'tick 500 vigente durante 100 s');
  assert.equal(afterSecond.tickCumulative, afterFirst.tickCumulative, 'el swap del mismo bloque no mueve el acumulador');
  assert.equal(afterSecond.lastObservedAt, 1_100n);
});

test('un tick manipulado y revertido dentro del mismo bloque no aporta absolutamente nada al TWAP', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);

  await swapAt(harness, key, 0, 1_000n);
  // El pool estuvo quieto en 0 hasta el bloque del ataque.
  await swapAt(harness, key, 0, 1_288n);
  // Mismo bloque: el atacante ya movió el precio a 1_000_000 y dispara su swap.
  await swapAt(harness, key, 1_000_000, 1_288n);
  // El atacante revirtió el precio en ese mismo bloque, así que durante los 12 s
  // siguientes el pool volvió a estar en 0.
  const fee = await swapAt(harness, key, 0, 1_300n);

  const state = await harness.readPoolState(key);
  assert.equal(state.tickCumulative, 0n, 'la manipulación intra-bloque aporta exactamente cero');
  assert.equal(state.lastTwapTick, 0n);
  assert.equal(fee, BASE_FEE, 'un movimiento de 1.000.000 de ticks revertido en el bloque no mueve la tarifa');
});

test('el mismo movimiento de 1000 ticks: sostenido toda la ventana sube la tarifa, mantenido un bloque no la mueve', async () => {
  const harness = await createHookHarness();
  const sostenido = buildPoolKey(harness.hookAddress, 1);
  const manipulado = buildPoolKey(harness.hookAddress, 2);

  // Movimiento real: el pool se queda en el tick 1000 durante toda la ventana.
  await swapAt(harness, sostenido, 0, 1_000n);
  await swapAt(harness, sostenido, 1_000, 1_150n);
  const feeSostenido = await swapAt(harness, sostenido, 1_000, 1_000n + WINDOW);

  // Manipulación: el mismo tick 1000, pero sólo durante un bloque de la ventana.
  await swapAt(harness, manipulado, 0, 1_000n);
  await swapAt(harness, manipulado, 0, 1_000n + WINDOW - BLOCK);
  const feeManipulado = await swapAt(harness, manipulado, 1_000, 1_000n + WINDOW);

  const estadoSostenido = await harness.readPoolState(sostenido);
  const estadoManipulado = await harness.readPoolState(manipulado);

  assert.equal(estadoSostenido.lastTwapTick, 1_000n, 'el movimiento real se refleja entero en el TWAP');
  assert.equal(estadoManipulado.lastTwapTick, 40n, '1000 ticks durante 12 de 300 s pesan 40 ticks');
  assert.equal(feeSostenido, BASE_FEE + MAX_FEE_STEP, 'el movimiento real satura el paso de tarifa');
  assert.equal(feeManipulado, BASE_FEE, 'la manipulación no llega ni a cruzar VOL_THRESHOLD');
});

test('la influencia de una manipulación de un bloque sobre el TWAP es la fracción de ventana que ocupa', async () => {
  const harness = await createHookHarness();
  const sostenido = buildPoolKey(harness.hookAddress, 1);
  const manipulado = buildPoolKey(harness.hookAddress, 2);
  const MOVIMIENTO = 100_000;

  await swapAt(harness, sostenido, 0, 1_000n);
  await swapAt(harness, sostenido, MOVIMIENTO, 1_150n);
  await swapAt(harness, sostenido, MOVIMIENTO, 1_000n + WINDOW);

  await swapAt(harness, manipulado, 0, 1_000n);
  await swapAt(harness, manipulado, 0, 1_000n + WINDOW - BLOCK);
  await swapAt(harness, manipulado, MOVIMIENTO, 1_000n + WINDOW);

  const twapSostenido = (await harness.readPoolState(sostenido)).lastTwapTick;
  const twapManipulado = (await harness.readPoolState(manipulado)).lastTwapTick;

  assert.equal(twapSostenido, 100_000n);
  assert.equal(twapManipulado, 4_000n, '100.000 ticks durante 12 de 300 s pesan 4.000');
  // 300/12 = 25: la atenuación es exactamente la relación ventana/bloque.
  assert.equal(twapSostenido / twapManipulado, WINDOW / BLOCK);
});

test('repetir la manipulación en cada ventana no acerca la tarifa al techo que sí alcanza el movimiento real', async () => {
  const harness = await createHookHarness();
  const sostenido = buildPoolKey(harness.hookAddress, 1);
  const manipulado = buildPoolKey(harness.hookAddress, 2);

  await swapAt(harness, sostenido, 0, 1_000n);
  await swapAt(harness, manipulado, 0, 1_000n);

  let feeSostenido = BASE_FEE;
  let feeManipulado = BASE_FEE;
  // Seis ventanas: las que MAX_FEE_STEP necesita para llevar BASE_FEE a CAP_FEE.
  for (let ventana = 1n; ventana <= 6n; ventana += 1n) {
    const inicio = 1_000n + WINDOW * (ventana - 1n);
    const tick = Number(ventana) * 1_000;

    // Deriva real: el pool avanza 1000 ticks por ventana y se queda ahí.
    await swapAt(harness, sostenido, tick, inicio + WINDOW / 2n);
    feeSostenido = await swapAt(harness, sostenido, tick, inicio + WINDOW);

    // Deriva fingida: el atacante intenta imitarla poniendo el mismo tick, pero
    // sólo puede sostenerlo un bloque antes de que el arbitraje lo devuelva.
    await swapAt(harness, manipulado, 0, inicio + WINDOW - BLOCK);
    feeManipulado = await swapAt(harness, manipulado, tick, inicio + WINDOW);
  }

  assert.equal(feeSostenido, CAP_FEE, 'la deriva real recorre los seis pasos hasta CAP_FEE');
  assert.equal(feeManipulado, 3_150n, 'seis manipulaciones encadenadas sólo arañan 150 sobre BASE_FEE');
  // 150 de 3000: la manipulación consigue el 5% del efecto del movimiento real.
  assert.equal((feeManipulado - BASE_FEE) * 20n, feeSostenido - BASE_FEE);
});

test('el acumulador soporta ticks negativos y redondea el TWAP hacia abajo', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);

  await swapAt(harness, key, -1_000, 1_000n);
  await swapAt(harness, key, -1_000, 1_100n); // -1000 durante 100 s
  await swapAt(harness, key, -3_000, 1_301n); // -3000 durante 201 s

  const state = await harness.readPoolState(key);
  assert.equal(state.tickCumulative, -703_000n, '-1000*100 + -3000*201');
  // -703000/301 = -2335,54...: truncar hacia cero daría -2335. Se redondea
  // hacia abajo para que un pool en ticks negativos reciba el mismo trato que
  // su reflejo en positivos, igual que hace OracleLibrary.consult de Uniswap.
  assert.equal(state.lastTwapTick, -2_336n);
});
