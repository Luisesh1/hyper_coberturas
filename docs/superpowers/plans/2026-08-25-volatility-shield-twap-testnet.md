# Volatility Shield V1: EVM local, TWAP y pruebas de testnet

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Dejar `VolatilityShieldV1` verificable por comportamiento (no por
regex sobre la fuente), con la señal temporal resistente a manipulación y con
pruebas de fuzz, invariantes y ciclo completo contra un fork de Base Sepolia.

**Context:** Hoy `contracts/` compila el hook y lo prueba con tres casos que
NO ejecutan bytecode: uno mira el ABI, otro hace `assert.match` de regex
contra el `.sol`, y el tercero comprueba que el artefacto se genera. No existe
ninguna prueba de comportamiento. No hay Foundry, Hardhat ni nodo EVM en la
máquina, y la decisión tomada (2026-08-25) es NO depender de Foundry: la EVM
se ejecuta en proceso con `@ethereumjs/evm` dentro del harness `node --test`
que el paquete ya usa, para que corra igual en CI sin toolchain de sistema.

**Spec:** `docs/superpowers/specs/2026-08-24-gestor-contratos-hooks-v4-design.md`

**Tech Stack:** Solidity 0.8.26 (solc-js), Node `node:test`, `@ethereumjs/evm` 10.1.3, ethers v6.

## Global Constraints

- El hook NO usa custom accounting ni callbacks returns-delta: `beforeSwap`
  devuelve siempre `BeforeSwapDelta.wrap(0)` y su máscara de permisos declara
  únicamente `beforeSwap: true`. Cualquier cambio que altere eso es un defecto.
- La tarifa resultante siempre queda dentro de `[FLOOR_FEE, CAP_FEE]`
  (500..6000) y nunca se mueve más de `MAX_FEE_STEP` (500) por
  `UPDATE_INTERVAL` (5 minutos).
- El contrato no puede impedir retiros, quemas ni cierres de LP.
- Sólo información on-chain del propio pool: sin oráculos externos, sin
  volumen, sin profundidad, sin balance de inventario.
- Ninguna prueba puede firmar, desplegar ni enviar transacciones a una red
  real. El fork de Base Sepolia es de sólo lectura sobre RPC público.
- El artefacto reproducible (`artifacts/VolatilityShieldV1.json`) y su
  `runtimeBytecodeHash` deben seguir generándose igual: el registro de
  contratos del servidor depende de ese formato.

---

### Task 1: Harness de EVM en proceso

**Files:**
- Modify: `contracts/package.json`
- Create: `contracts/test/helpers/evm.js`
- Create: `contracts/test/hook-behaviour.test.js`

- [ ] Añadir `@ethereumjs/evm`, `@ethereumjs/statemanager`, `@ethereumjs/common`
  y `@ethereumjs/util` (10.1.3) como devDependencies de `contracts/`.
- [ ] Escribir `test/helpers/evm.js`: monta una EVM en proceso y expone
  utilidades para (a) inyectar código de runtime en una dirección arbitraria
  mediante el state manager — esto es lo que permite colocar el hook en una
  dirección cuyos bits bajos llevan el flag `BEFORE_SWAP` (0x80) que
  `BaseHook` valida en su constructor —, (b) instalar un PoolManager simulado
  cuyo `getSlot0` devuelva un tick configurable, y (c) llamar `beforeSwap`
  codificando/decodificando con la ABI del artefacto.
- [ ] Escribir pruebas de comportamiento que EJECUTEN el bytecode: la primera
  llamada fija `BASE_FEE` (3000); una llamada antes de `UPDATE_INTERVAL` no
  cambia la tarifa; el valor devuelto lleva `LPFeeLibrary.OVERRIDE_FEE_FLAG`;
  el delta devuelto es exactamente cero; el selector devuelto es el de
  `beforeSwap`.
- [ ] Reemplazar el caso que hace `assert.match` de regex contra el `.sol` por
  aserciones de comportamiento equivalentes. Una prueba que valida código
  fuente con expresiones regulares no prueba el contrato.
- [ ] Ejecutar `npm test --prefix contracts` y dejarlo en verde.

### Task 2: Señal temporal resistente a manipulación (TWAP)

**Files:**
- Modify: `contracts/src/VolatilityShieldV1.sol`
- Modify: `contracts/test/hook-behaviour.test.js`
- Create: `contracts/test/twap-manipulation.test.js`

- [ ] Escribir primero las pruebas de manipulación: un tick movido durante un
  único bloque (patrón flash-loan: mover, hacer swap, revertir) debe alterar
  la tarifa resultante de forma despreciable comparado con el mismo
  movimiento sostenido durante toda la ventana.
- [ ] Sustituir la lectura de tick puntual por un acumulador ponderado por
  tiempo: en cada `beforeSwap` acumular `tickCumulative += tickActual *
  segundosDesdeLaÚltimaObservación`, y en cada `UPDATE_INTERVAL` derivar
  `twapTick = (tickCumulative - tickCumulativeDelCheckpoint) / segundos
  transcurridos`. La ventana del TWAP es el propio `UPDATE_INTERVAL` (5 min).
- [ ] Alimentar el EWMA corto/largo existente con `twapTick` en vez del tick
  instantáneo. NO cambiar `SHORT_ALPHA_BPS`, `LONG_ALPHA_BPS`,
  `VOL_THRESHOLD`, `FEE_PER_TICK`, `MAX_FEE_STEP`, `BASE_FEE`, `CAP_FEE` ni
  `UPDATE_INTERVAL`: este task cambia QUÉ tick alimenta la fórmula, no la
  fórmula.
- [ ] Cuidar el desbordamiento y el signo: `tickCumulative` es acumulador con
  signo y debe soportar ticks negativos y el paso del tiempo sin revertir.
- [ ] Ejecutar las pruebas de comportamiento y de manipulación.

### Task 3: Hacer alcanzable el suelo de tarifa

**Files:**
- Modify: `contracts/src/VolatilityShieldV1.sol`
- Create: `contracts/test/fee-floor.test.js`

**Contexto:** `FLOOR_FEE` (500 = 5 bps) es hoy código muerto. `target` parte de
`BASE_FEE` (3000) y la señal sólo suma, así que la tarifa nunca baja de 30 bps
y el suelo nominal no se alcanza jamás. Decisión del dueño del producto
(2026-08-25): hacerlo alcanzable, para que en régimen de baja volatilidad el
pool pueda cobrar menos y atraer volumen.

- [ ] Escribir primero las pruebas: con volatilidad sostenidamente baja la
  tarifa desciende por debajo de `BASE_FEE` y converge al `FLOOR_FEE`; nunca
  lo cruza; al volver la volatilidad sube de nuevo hacia `BASE_FEE` y más allá.
- [ ] Hacer la señal bidireccional: cuando la señal de volatilidad queda por
  DEBAJO de `VOL_THRESHOLD`, el objetivo debe bajar desde `BASE_FEE` en
  proporción a esa distancia, igual que hoy sube cuando la supera. Elegir la
  pendiente de bajada de forma que el recorrido completo de 30 bps a 5 bps sea
  alcanzable en régimen de calma sostenida, y documentar la constante nueva.
- [ ] Revisar el orden de las comprobaciones de `_stepToward`: hoy los clamps
  de `FLOOR_FEE`/`CAP_FEE` están DESPUÉS de las ramas de paso máximo, así que
  esas ramas pueden devolver un valor sin acotar. Hoy no se manifiesta porque
  el objetivo sólo sube y ya llega acotado; con el camino de bajada sí puede.
  El clamp debe aplicarse al resultado final, pase por la rama que pase.
- [ ] `MAX_FEE_STEP` sigue limitando el movimiento en AMBAS direcciones: la
  tarifa no puede caer más de 5 bps por `UPDATE_INTERVAL`.
- [ ] Ejecutar la suite completa del paquete.

### Task 4: Fuzz por propiedades e invariantes

**Files:**
- Create: `contracts/test/hook-properties.test.js`
- Modify: `contracts/package.json`

- [ ] Escribir un generador pseudoaleatorio con semilla FIJA y reproducible
  (sin dependencias nuevas; la semilla debe imprimirse al fallar para poder
  reproducir el caso).
- [ ] Ejecutar secuencias aleatorias de swaps con ticks y saltos temporales
  arbitrarios (incluidos ticks negativos, saltos de un segundo, saltos de
  días y movimientos en los extremos del rango de tick de Uniswap) y afirmar
  las invariantes en CADA paso:
  - la tarifa devuelta siempre está en `[FLOOR_FEE, CAP_FEE]`;
  - entre dos actualizaciones consecutivas la tarifa nunca varía más de
    `MAX_FEE_STEP`;
  - el delta devuelto es siempre cero;
  - el selector devuelto es siempre el de `beforeSwap`;
  - la llamada nunca revierte por overflow con ticks en los límites.
- [ ] Añadir el script `test:properties` y encadenarlo en `npm test`.
- [ ] Ejecutar la suite completa del paquete.

### Task 5: Ciclo completo contra un fork de Base Sepolia

**Files:**
- Create: `contracts/test/base-sepolia-fork.test.js`
- Modify: `contracts/package.json`

- [ ] Cargar el estado real del `PoolManager` de Uniswap V4 en Base Sepolia
  por RPC público de sólo lectura y ejecutar contra él, en la EVM local, el
  ciclo de swaps que ejercita el hook. La prueba NO firma, NO despliega y NO
  envía nada a la red.
- [ ] La prueba debe SALTARSE (`test.skip`) de forma explícita y silenciosa
  cuando no hay red disponible, para que CI no dependa de un RPC externo, y
  debe indicar en el mensaje del skip cómo ejecutarla.
- [ ] Verificar que la máscara de permisos observada en el bytecode desplegado
  coincide exactamente con `beforeSwap` y nada más — la misma comprobación que
  el servidor exige para marcar una versión como verificada.
- [ ] Ejecutar la suite completa y `npm run check` en la raíz.
