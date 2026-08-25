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
//
// Qué distingue de verdad este archivo, medido ejecutando la batería contra las
// dos implementaciones anteriores y no supuesto:
//
//   - Contra la señal vieja de dos puntos (926e42c) fallan por ARITMÉTICA tres
//     casos: el del movimiento de 1000 ticks (3500 frente a 3000), el de las
//     seis ventanas encadenadas (6000 frente a 3150) y el del tick extremo. En
//     los dos primeros la aserción que discrimina va deliberadamente LA PRIMERA,
//     para que un fallo de ponderación temporal se cace por el número y no quede
//     enmascarado por el primer campo del struct que no cuadre.
//   - Los casos que leen `tickCumulative`/`lastTwapTick` no pueden discriminar
//     contra esa implementación porque allí esos campos ni existen. Valen como
//     guarda frente a regresiones FUTURAS que conserven la forma del struct, ya
//     que fijan el valor exacto del acumulador.
//   - Contra el TWAP con la semilla sin corregir (590a3bd) sólo fallan dos: el
//     del primer swap y el del tick extremo. Son los que atan el arreglo del
//     sesgo de la semilla; si alguien lo revierte, saltan por el número.
//   - El caso del ataque atómico pasa también con la implementación vieja: en
//     ese escenario la señal de dos puntos leía el tick ya revertido, así que
//     tampoco se dejaba envenenar. Se mantiene como guarda de que el acumulador
//     ignora el ruido intra-bloque, que es lo que de verdad comprueba.
//
// Varios casos gastan una primera ventana en fijar la referencia del TWAP antes
// de medir nada: desde el arreglo del sesgo de la semilla, la primera ventana
// que cierra no alimenta el EWMA. Montar el escenario sobre la segunda ventana
// evita medir una tarifa que el hook congela por construcción.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHookHarness, LP_FEE_OVERRIDE_FLAG } = require('./helpers/evm.js');

const BASE_FEE = 3000n;
const MAX_FEE_STEP = 500n;
const CAP_FEE = 6000n;
const WINDOW = 300n; // UPDATE_INTERVAL
const BLOCK = 12n; // duración de un bloque de Ethereum mainnet
const MIN_TICK = -887_272; // TickMath.MIN_TICK

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

test('el primer swap de un pool abre el acumulador en cero y NO toma el tick como referencia', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);

  const fee = await swapAt(harness, key, -321, 1_000n);

  const state = await harness.readPoolState(key);
  assert.equal(fee, BASE_FEE, 'sin historia que promediar, la tarifa arranca en BASE_FEE');
  assert.equal(state.tickCumulative, 0n, 'el acumulador arranca en cero');
  assert.equal(state.checkpointTickCumulative, 0n, 'el checkpoint arranca en cero');
  // El tick del primer swap (-321) no se guarda en ninguna parte: es un punto
  // instantáneo que elige el primer swapper y no puede ser la referencia.
  assert.equal(state.lastTwapTick, 0n, 'el tick del primer swap no se convierte en referencia');
  assert.equal(state.hasTwapReference, false, 'todavía no ha cerrado ninguna ventana');
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
  // Primera ventana: sólo fija la referencia (TWAP 0). El ataque se monta sobre
  // la SEGUNDA, para que la tarifa que se mide sea una que de verdad podría
  // moverse y no la que el hook congela por construcción.
  await swapAt(harness, key, 0, 1_000n + WINDOW);
  // El pool estuvo quieto en 0 hasta el bloque del ataque.
  await swapAt(harness, key, 0, 1_000n + 2n * WINDOW - BLOCK);
  // Mismo bloque: el atacante ya movió el precio a 1_000_000 y dispara su swap.
  await swapAt(harness, key, 1_000_000, 1_000n + 2n * WINDOW - BLOCK);
  // El atacante revirtió el precio en ese mismo bloque, así que durante los 12 s
  // siguientes el pool volvió a estar en 0.
  const fee = await swapAt(harness, key, 0, 1_000n + 2n * WINDOW);

  const state = await harness.readPoolState(key);
  assert.equal(state.tickCumulative, 0n, 'la manipulación intra-bloque aporta exactamente cero');
  assert.equal(state.lastTwapTick, 0n);
  assert.equal(fee, BASE_FEE, 'un movimiento de 1.000.000 de ticks revertido en el bloque no mueve la tarifa');
});

test('el mismo movimiento de 1000 ticks: sostenido toda la ventana sube la tarifa, mantenido un bloque no la mueve', async () => {
  const harness = await createHookHarness();
  const sostenido = buildPoolKey(harness.hookAddress, 1);
  const manipulado = buildPoolKey(harness.hookAddress, 2);

  // Ambos pools gastan una primera ventana en fijar la referencia (TWAP 0); la
  // comparación se hace sobre la segunda, que es la primera que mueve tarifa.
  await swapAt(harness, sostenido, 0, 1_000n);
  await swapAt(harness, sostenido, 0, 1_000n + WINDOW);
  await swapAt(harness, manipulado, 0, 1_000n);
  await swapAt(harness, manipulado, 0, 1_000n + WINDOW);

  // Movimiento real: el pool se queda en el tick 1000 durante toda la ventana.
  await swapAt(harness, sostenido, 1_000, 1_000n + WINDOW + WINDOW / 2n);
  const feeSostenido = await swapAt(harness, sostenido, 1_000, 1_000n + 2n * WINDOW);

  // Manipulación: el mismo tick 1000, pero sólo durante un bloque de la ventana.
  await swapAt(harness, manipulado, 0, 1_000n + 2n * WINDOW - BLOCK);
  const feeManipulado = await swapAt(harness, manipulado, 1_000, 1_000n + 2n * WINDOW);

  // Esta aserción va PRIMERO a propósito: es la única del test que distingue
  // por aritmética una ponderación temporal correcta de una rota. La señal de
  // dos puntos devuelve aquí 3500, igual que el movimiento real. Si va detrás
  // de las aserciones sobre el struct, un fallo de ponderación queda enmascarado
  // por el primer campo que no cuadre.
  assert.equal(feeManipulado, BASE_FEE, 'la manipulación no llega ni a cruzar VOL_THRESHOLD');
  assert.equal(feeSostenido, BASE_FEE + MAX_FEE_STEP, 'el movimiento real satura el paso de tarifa');

  const estadoSostenido = await harness.readPoolState(sostenido);
  const estadoManipulado = await harness.readPoolState(manipulado);
  assert.equal(estadoSostenido.lastTwapTick, 1_000n, 'el movimiento real se refleja entero en el TWAP');
  assert.equal(estadoManipulado.lastTwapTick, 40n, '1000 ticks durante 12 de 300 s pesan 40 ticks');
});

test('la influencia de una manipulación de un bloque sobre el TWAP es la fracción de ventana que ocupa', async () => {
  const harness = await createHookHarness();
  const sostenido = buildPoolKey(harness.hookAddress, 1);
  const manipulado = buildPoolKey(harness.hookAddress, 2);
  const MOVIMIENTO = 100_000;

  // Primera ventana de cada pool: sólo fija la referencia.
  await swapAt(harness, sostenido, 0, 1_000n);
  await swapAt(harness, sostenido, 0, 1_000n + WINDOW);
  await swapAt(harness, manipulado, 0, 1_000n);
  await swapAt(harness, manipulado, 0, 1_000n + WINDOW);

  await swapAt(harness, sostenido, MOVIMIENTO, 1_000n + WINDOW + WINDOW / 2n);
  await swapAt(harness, sostenido, MOVIMIENTO, 1_000n + 2n * WINDOW);

  await swapAt(harness, manipulado, 0, 1_000n + 2n * WINDOW - BLOCK);
  await swapAt(harness, manipulado, MOVIMIENTO, 1_000n + 2n * WINDOW);

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

  // Primera ventana de cada pool: sólo fija la referencia, no mueve tarifa.
  const ARRANQUE = 1_000n + WINDOW;
  await swapAt(harness, sostenido, 0, 1_000n);
  await swapAt(harness, sostenido, 0, ARRANQUE);
  await swapAt(harness, manipulado, 0, 1_000n);
  await swapAt(harness, manipulado, 0, ARRANQUE);

  let feeSostenido = BASE_FEE;
  let feeManipulado = BASE_FEE;
  // Seis ventanas: las que MAX_FEE_STEP necesita para llevar BASE_FEE a CAP_FEE.
  for (let ventana = 1n; ventana <= 6n; ventana += 1n) {
    const inicio = ARRANQUE + WINDOW * (ventana - 1n);
    const tick = Number(ventana) * 1_000;

    // Deriva real: el pool avanza 1000 ticks por ventana y se queda ahí.
    await swapAt(harness, sostenido, tick, inicio + WINDOW / 2n);
    feeSostenido = await swapAt(harness, sostenido, tick, inicio + WINDOW);

    // Deriva fingida: el atacante intenta imitarla poniendo el mismo tick, pero
    // sólo puede sostenerlo un bloque antes de que el arbitraje lo devuelva.
    await swapAt(harness, manipulado, 0, inicio + WINDOW - BLOCK);
    feeManipulado = await swapAt(harness, manipulado, tick, inicio + WINDOW);
  }

  // Primero el número que discrimina: la señal de dos puntos llega aquí a 6000,
  // exactamente el mismo techo que la deriva real.
  assert.equal(feeManipulado, 3_150n, 'seis manipulaciones encadenadas sólo arañan 150 sobre BASE_FEE');
  assert.equal(feeSostenido, CAP_FEE, 'la deriva real recorre los seis pasos hasta CAP_FEE');
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
  // -703000/301 = -2335,54...: truncar hacia cero daría -2335. Se redondea hacia
  // abajo porque truncar ensancha al doble el escalón que rodea al cero, y la
  // cuantización uniforme es lo que hace OracleLibrary.consult de Uniswap. El
  // precio es perder la simetría de reflexión: +703000/301 sí daría +2335.
  assert.equal(state.lastTwapTick, -2_336n);
});

test('un tick extremo presente sólo en el instante del primer swap no infla la tarifa', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);

  // El abuso que cierra este test: un LP inicializa el pool en el extremo del
  // rango, es el primer swapper, y a partir de ahí el pool se queda
  // absolutamente quieto en el tick 0. No hay ni un tick de volatilidad real en
  // toda la secuencia, así que la tarifa no debe moverse de BASE_FEE ni una vez.
  //
  // OJO con el alcance de este test: cubre el caso de duración CERO, el que era
  // gratis. El caso de duración no nula lo acota MAX_TICK_MOVE, y tiene sus
  // propios tests más abajo.
  await swapAt(harness, key, MIN_TICK, 1_000n);

  const tarifas = [];
  for (let ventana = 1n; ventana <= 10n; ventana += 1n) {
    tarifas.push(await swapAt(harness, key, 0, 1_000n + WINDOW * ventana));
  }

  // Antes de la corrección esta misma secuencia daba, medida sobre la EVM:
  //   3500, 4000, 4500, 5000, 5500, 5000, 4500, 4000, 3500, 3000
  // Un pico de 5500 —83% sobre BASE_FEE, a un solo paso del techo— sostenido
  // unos 45 minutos, cobrado a todo el que pasara por el pool. La causa era que
  // la referencia se sembraba con el tick instantáneo del primer swap y ese
  // valor entraba en shortEwma/longEwma, que son estado persistente: la
  // excursión sobrevivía a la ventana que la originó y drenaba al ritmo de
  // LONG_ALPHA_BPS. MAX_FEE_STEP sólo acotaba cada peldaño, no la suma.
  assert.deepEqual(tarifas, Array(10).fill(BASE_FEE), 'sin volatilidad real la tarifa no se mueve de BASE_FEE');

  // La referencia sí queda fijada al cerrar la primera ventana, con el TWAP
  // real de esa ventana (0, el tick donde estuvo el pool), no con el extremo.
  const state = await harness.readPoolState(key);
  assert.equal(state.hasTwapReference, true);
  assert.equal(state.lastTwapTick, 0n, 'la referencia es el TWAP medido, no el tick sembrado');
  assert.equal(state.shortEwma, 0n, 'el extremo nunca llegó a alimentar el EWMA');
  assert.equal(state.longEwma, 0n);
});

test('saltarse la primera ventana sólo retrasa la reacción un UPDATE_INTERVAL, no la anula', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);

  // Contrapartida aceptada del arreglo anterior: comprobamos que el coste es
  // exactamente una ventana de retraso, y que a partir de ahí la señal responde
  // igual que antes. El pool arranca en 0 y salta 5000 ticks en cada ventana.
  await swapAt(harness, key, 0, 1_000n);

  const primera = await swapAt(harness, key, 0, 1_000n + WINDOW);
  assert.equal(primera, BASE_FEE, 'la ventana que fija la referencia no mueve la tarifa');

  const segunda = await swapAt(harness, key, 5_000, 1_000n + WINDOW * 2n);
  assert.equal(segunda, BASE_FEE + MAX_FEE_STEP, 'la ventana siguiente ya reacciona con el paso completo');

  const tercera = await swapAt(harness, key, 10_000, 1_000n + WINDOW * 3n);
  assert.equal(tercera, BASE_FEE + 2n * MAX_FEE_STEP, 'y sigue escalando al ritmo de siempre');
});

// Un pool que fija su referencia en 0, da UN salto de `salto` ticks y se queda
// ahí quieto. Devuelve la tarifa de cada una de las `ventanas` siguientes: la
// primera mide el salto, las demás miden movimiento cero y sólo drenan el EWMA.
async function secuenciaTrasSalto(harness, key, salto, ventanas = 10n) {
  await swapAt(harness, key, 0, 1_000n);
  await swapAt(harness, key, 0, 1_000n + WINDOW); // ventana 1: fija la referencia
  const tarifas = [];
  for (let v = 1n; v <= ventanas; v += 1n) {
    tarifas.push(await swapAt(harness, key, salto, 1_000n + WINDOW * (v + 1n)));
  }
  return tarifas;
}

test('MAX_TICK_MOVE iguala el efecto de un salto de 887.272 ticks al de uno de 1.000', async () => {
  const harness = await createHookHarness();

  // Sin la cota, estas tres secuencias son distintas: el salto extremo mantiene
  // los EWMA saturados varias ventanas más y llega a un pico de 5500 frente al
  // de 4020 del salto de 1.000. Con la cota, las tres son idénticas: una sola
  // ventana no puede aportar más que MAX_TICK_MOVE, venga de donde venga.
  const deLaCota = await secuenciaTrasSalto(harness, buildPoolKey(harness.hookAddress, 1), 1_000);
  const intermedio = await secuenciaTrasSalto(harness, buildPoolKey(harness.hookAddress, 2), 35_491);
  const extremo = await secuenciaTrasSalto(harness, buildPoolKey(harness.hookAddress, 3), 887_272);

  assert.deepEqual(intermedio, deLaCota, 'un salto de 35.491 ticks no puede valer más que la cota');
  assert.deepEqual(extremo, deLaCota, 'un salto de 887.272 ticks tampoco');
  // El pico queda en 4020 en vez de 5500: sigue habiendo reacción —debe haberla,
  // un movimiento así merece tarifa alta— pero acotada y con drenaje corto.
  assert.deepEqual(deLaCota, [3500n, 4000n, 4020n, 3520n, 3045n, 3000n, 3000n, 3000n, 3000n, 3000n]);
});

test('un movimiento de MAX_TICK_MOVE ya exige CAP_FEE, así que la cota no recorta la primera reacción', async () => {
  const harness = await createHookHarness();

  // Invariante que justifica el valor de la cota: MAX_TICK_MOVE se eligió como el
  // movimiento a partir del cual el objetivo de tarifa YA pide CAP_FEE. Por eso
  // acotar ahí no le quita nada a la primera reacción — sólo impide que una
  // ventana deje los EWMA cargados para las diez siguientes.
  //
  // Este test se lee contra las constantes reales del contrato, así que si la
  // Task 3 retoca VOL_THRESHOLD o FEE_PER_TICK y la cota deja de saturar, salta
  // aquí en vez de degradar la señal en silencio.
  const cota = await harness.readConstant('MAX_TICK_MOVE');
  const alphaCorta = await harness.readConstant('SHORT_ALPHA_BPS');
  const alphaLarga = await harness.readConstant('LONG_ALPHA_BPS');
  const umbral = await harness.readConstant('VOL_THRESHOLD');
  const porTick = await harness.readConstant('FEE_PER_TICK');

  const señalMaxima = (cota * alphaCorta) / 10_000n - (cota * alphaLarga) / 10_000n;
  const objetivo = BASE_FEE + (señalMaxima - umbral) * porTick;

  assert.ok(señalMaxima > umbral, 'la cota debe superar VOL_THRESHOLD');
  assert.ok(
    objetivo >= CAP_FEE,
    `una muestra de ${cota} ticks debe seguir exigiendo CAP_FEE; da ${objetivo}`,
  );
});

test('la volatilidad sostenida sigue alcanzando CAP_FEE con la cota puesta', async () => {
  const harness = await createHookHarness();
  const key = buildPoolKey(harness.hookAddress);

  // Contrapeso del test anterior: la cota no puede volver sordo al hook. Ante un
  // régimen de volatilidad sostenida —el pool avanza 5.000 ticks cada ventana,
  // muy por encima de la cota— la tarifa tiene que seguir subiendo hasta el techo.
  await swapAt(harness, key, 0, 1_000n);
  await swapAt(harness, key, 0, 1_000n + WINDOW);

  let tarifa = BASE_FEE;
  for (let v = 1n; v <= 7n; v += 1n) {
    tarifa = await swapAt(harness, key, Number(v) * 5_000, 1_000n + WINDOW * (v + 1n));
  }

  assert.equal(tarifa, CAP_FEE, 'la volatilidad real y sostenida sigue llevando la tarifa al techo');
});

test('con la cota, sostener el tick extremo un bloque ya no devuelve la excursión completa', async () => {
  const harness = await createHookHarness();

  // Barrido sobre cuánto sostiene el abusador MIN_TICK dentro de la primera
  // ventana. Antes de la cota, 12 s bastaban para devolver la excursión entera
  // (pico 5500), igual que sostenerlo los 300 s. Con la cota, todas las
  // duraciones no nulas colapsan a la misma respuesta acotada.
  const picos = [];
  const duraciones = [1n, 12n, 60n, 150n, 300n];
  for (const [indice, duracion] of duraciones.entries()) {
    const key = buildPoolKey(harness.hookAddress, indice + 1);
    await swapAt(harness, key, MIN_TICK, 1_000n);
    if (duracion < WINDOW) {
      await swapAt(harness, key, MIN_TICK, 1_000n + duracion);
      await swapAt(harness, key, 0, 1_000n + WINDOW);
    } else {
      await swapAt(harness, key, MIN_TICK, 1_000n + WINDOW);
    }
    const tarifas = [];
    for (let v = 1n; v <= 10n; v += 1n) {
      tarifas.push(await swapAt(harness, key, 0, 1_000n + WINDOW * (v + 1n)));
    }
    picos.push(tarifas.reduce((maximo, valor) => (valor > maximo ? valor : maximo)));
  }

  assert.deepEqual(picos, [4020n, 4020n, 4020n, 4020n, 4020n], 'ninguna duración supera el pico acotado');
  assert.ok(picos.every((p) => p < 5_500n), 'la excursión completa de 5500 ya no es alcanzable');
});
