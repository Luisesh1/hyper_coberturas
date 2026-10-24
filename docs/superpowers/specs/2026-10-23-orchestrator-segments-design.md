# Tramos del orquestador LP — diseño

Fecha: 2026-10-23 · Rama: `feat/orchestrator-segments`

## Por qué

Un orquestador LP vive mucho más que cualquiera de sus LPs: cada ajuste de
rango, cada cambio de liquidez y cada LP nuevo cambian la posición que se
cubre, pero el orquestador guarda un único contexto continuo. El dato de un LP
pasa al siguiente sin frontera y se mezcla con él.

Caso real, orquestador #57 (ETH/USDC 0.3 % v4 Arbitrum, «Borde de rango»,
protección #30), revisado en producción el 2026-10-23:

- Tuvo tres LPs (07-10, ajuste 15-10 → tokenId 217346, ajuste 21-10 →
  224599). La tarjeta muestra «Apertura 2.668,73», que queda fuera del rango
  actual (2.401,9–2.628,1). Es el precio del **primer** LP (bloque 508253208):
  `_evaluateOne` copia `priceAtOpen*` e `initialValueUsd*` del snapshot
  anterior cuando el escaneo ligero no los trae, sin comprobar que sea la
  misma posición (`lp-orchestrator.service.js`, «Carry-forward»).
- La contabilidad ya descarta la deriva cuando cambia el `identifier`
  (`computeAccountingDelta`), pero por eso mismo la deriva del LP viejo entre
  su último tick y el ajuste (el rato de firma) no se atribuye a nadie, y no
  hay forma de ver el P&L de cada LP por separado.
- La cobertura vive en una sola fila de `protected_uniswap_pools` y la
  migración al tokenId nuevo (`migratePositionIdentity`) conserva entero
  `strategy_state_json`. `range_exit_v1` y `terminal_range_v1` detectan el
  rango nuevo por `rangeKey`, pero `net_profit_v1/v2` no: arrastran el cerrojo
  de salida superior, cooldown, dwell, tope de fills y el presupuesto diario
  de V2, y además se las llama sin el `forceRebalance` de `lp_range_changed`.
- Un forzado `lp_range_changed` se pierde (no se guarda como
  `pendingForceReason`) si la evaluación forzada sale antes por
  `snapshot_refresh_pending`, `snapshot_invalid`, `spot_stale` o lock ocupado.
- Mientras se firma un ajuste, la cobertura sigue dimensionada para el LP
  viejo (en el #57 eran 0,0048 ETH, ~3 %, porque el LP viejo estaba fuera de
  rango por arriba). Al finalizar se corrigió en 2 s (0,1071 ETH), pero en la
  tarjeta ese hueco es indistinguible de un fallo.

El usuario quiere más robustez en el orquestador: que cada tramo tenga su
propio contexto, como si fuera un orquestador independiente pero vinculado,
con trazabilidad y contabilidad histórica. La interfaz actual le gusta y no se
rediseña.

## Objetivos

1. **Tramo** = periodo en que el orquestador gestiona una misma posición con
   una misma configuración de cobertura. Cada tramo tiene su contexto propio y
   nada de un tramo se hereda en las decisiones del siguiente.
2. De cada tramo se puede responder:
   - **apertura y cierre:** fecha, precio, rango, capital, tokenId;
   - **por qué se cerró:** motivo (salida por abajo/arriba, manual, cambio de
     capital, LP cerrado…), quién lo firmó y las tx;
   - **su P&L propio:** fees, deriva de precio, cobertura realizada y no
     realizada, funding, comisiones, slippage, gas, swaps;
   - **cómo lo cubrió la cobertura:** short al abrir, cada reajuste y el %
     cubierto a lo largo del tramo.
3. **El total del orquestador es la suma de sus tramos** (cerrados + el
   abierto). Si algo no cuadra con el acumulado actual, se muestra como
   diferencia explícita; no se esconde.
4. Los orquestadores existentes (incluido el #57) se parten en tramos
   reconstruidos desde sus registros, marcados como **aproximados**.
5. Mientras se firma un ajuste, el tramo viejo queda «cerrando» y la tarjeta
   dice que la cobertura espera al LP nuevo.

## No objetivos

- No se cambia la regla de reentrada de «Borde de rango» (`range_exit_v1`
  sigue yendo al delta del momento y congelándose). Se tratará aparte.
- No se cambia el comportamiento del hedge durante la firma (solo se muestra).
- No se rediseña la tarjeta ni la página del orquestador.
- No se cierra ni reabre el short de Hyperliquid entre tramos.

## Anti-objetivos (sería un fracaso aunque funcione)

- Que el total del orquestador cambie en silencio respecto a hoy sin que se vea
  dónde está la diferencia.
- Que un tramo nuevo herede cualquier dato de decisión del anterior
  (precio de apertura, cooldowns, cerrojos, presupuestos, baselines).
- Que la reconstrucción histórica se presente como exacta.
- Que abrir/cerrar tramo pueda dejar la cobertura sin evaluar o el orquestador
  a medio escribir (todo corte es atómico).

## Qué abre un tramo nuevo (decisión del usuario)

Cualquier cambio del LP o de cómo se cubre:

| Evento | Dónde ocurre hoy | Motivo de cierre del tramo anterior |
|---|---|---|
| Ajuste de rango / rebalanceo (`modify-range`, `rebalance`) | `recordTxFinalized` | `range_exit_below`, `range_exit_above` o `manual_rerange` según el lado del precio respecto al rango viejo al iniciar la acción |
| Cerrar LP y adjuntar otro (`close-*` + `attachLp`/adopción/`retry-commit`) | cierre en `recordTxFinalized`, apertura en `attachLp` | `lp_closed`; entre el cierre y el siguiente LP no hay tramo abierto |
| Aumentar / reducir liquidez (`increase-liquidity`, `decrease-liquidity`) | `recordTxFinalized` | `capital_change` |
| Reinvertir fees (`reinvest-fees`) | `recordTxFinalized` | `capital_change` (también cambia la liquidez) |
| Cambio de política de cobertura | hoy **no** llega a la protección viva: `updateConfig` solo propaga `normalizeLiveTunables`; la política nueva se aplica al adjuntar el siguiente LP, que ya abre tramo | `policy_change` — reservado; si algún día se cambia la política en caliente, ese cambio debe abrir tramo |

`collect-fees` no abre tramo (no cambia la posición ni la cobertura); se
registra como evento del tramo abierto.

## Modelo

Tabla nueva `lp_orchestrator_segments` (migración 048):

- `id`, `orchestrator_id` (FK, cascade), `seq` (1, 2, 3… por orquestador,
  único con `orchestrator_id`).
- `status`: `open` · `closing` (firma en curso) · `closed`.
- `accuracy`: `exact` · `approximate` (reconstruido).
- Identidad: `position_identifier`, `pool_address`, `protected_pool_id`,
  `policy_version`.
- Apertura: `opened_at`, `open_price`, `range_lower_price`,
  `range_upper_price`, `open_value_usd`, `open_amount0`, `open_amount1`,
  `open_reason` (`create`, `adopt`, `rerange`, `capital_change`, `attach`,
  `backfill`), `open_tx_hashes_json`.
- Cierre: `closing_started_at`, `closed_at`, `close_price`,
  `close_value_usd`, `close_reason` (tabla de arriba), `close_tx_hashes_json`.
- Contabilidad del tramo: `accounting_json`, misma forma que la del
  orquestador (`normalizeAccounting`) pero solo de este tramo.
- Baselines del tramo: `hedge_baseline_json` (foto del estado del hedge al
  abrir), `shadow_baselines_json`, `lp_baseline_snapshot_json` (snapshot del
  LP al abrir, incluido su `priceAtOpen`).
- Cobertura: `hedge_open_qty`, `hedge_close_qty`, y un resumen
  `coverage_json` (mín/máx/promedio ponderado por tiempo del % cubierto,
  número de reajustes).
- `created_at`, `updated_at`.

`lp_orchestrator_action_log` y `protected_pool_delta_rebalance_log` ganan una
columna `segment_id` nullable (con índice) para atribuir cada entrada a su
tramo. El orquestador gana `active_segment_id`.

Invariante: un orquestador `active` con LP tiene exactamente un tramo `open`
o `closing`; sin LP, ninguno.

## Corte entre tramos (decisiones de Claude aprobadas por el usuario)

- **Short:** no se cierra. En el corte se toma una foto de
  `readHedgeStateFromProtection` (realizado, no realizado, funding, comisiones,
  slippage). Lo acumulado hasta la foto pertenece al tramo que cierra; el
  siguiente arranca con esa foto como baseline. Igual para cada política
  sombra.
- **LP:** se valora justo antes (último snapshot del LP viejo con liquidez) y
  justo después (snapshot del LP nuevo). Fees y deriva hasta el corte son del
  tramo viejo; el nuevo arranca con su propio snapshot como baseline — nunca
  se compara el snapshot de un LP con el de otro.
- **Gas y swaps del ajuste:** se cargan al tramo **nuevo** (son el coste de
  abrirlo).
- **Apertura:** cada tramo guarda su propio precio de apertura (el del momento
  del corte o del mint) y su valor inicial. Se elimina el carry-forward de
  `priceAtOpen*`/`initialValue*` entre posiciones distintas: solo se conservan
  si el `identifier` del snapshot anterior es el mismo que el actual.
- **Total del orquestador** = Σ `accounting_json` de los tramos. El
  `accounting_json` del orquestador pasa a ser un valor derivado (recalculado al
  escribir cualquier tramo), y se conserva el acumulado previo al despliegue
  para poder mostrar la diferencia contra la suma reconstruida.
- **Atomicidad:** cerrar un tramo, abrir el siguiente, actualizar
  `active_segment_id` y la contabilidad derivada ocurren en una sola
  transacción (`_withTransaction`).
- **Hueco de valor entre el LP viejo y el nuevo** (decisión de Claude): el
  tramo viejo se valora **al precio del finalize**, no al último tick. La
  deriva del rato de firma y las fees cobradas dentro del ajuste son del tramo
  viejo. Lo que vuelve a la wallet sin redesplegar y el capital añadido o
  retirado en el mismo ajuste son `capitalAdjustmentsUsd` (no P&L). Gas y
  slippage de swaps son del tramo nuevo. Con eso, valor de cierre del viejo +
  ajustes de capital − costes = valor de apertura del nuevo, y la suma de
  tramos cuadra.

### Dónde se hace el corte (decisión de Claude)

- Hoy no existe ningún `tx_started`: el cliente solo llama a
  `recordTxFinalized` después de firmar, y solo desde `LpOrchestratorPage`. La
  migración de la protección al tokenId nuevo (`migratePositionIdentity`)
  ocurre antes, en `uniswap/actions/finalize.js`, por donde pasa **toda**
  acción (también la página de pools).
- Por eso el **reinicio del estado de decisión** de la protección va en
  `finalize.js`, en la misma escritura que la migración y bajo el lock de
  evaluación de esa protección; aplica también a protecciones sin
  orquestador, que tienen el mismo fallo.
- El **corte contable del tramo** va en `recordTxFinalized` (allí están la
  acción, el gas y el lado del precio). Si el cambio de posición llega por
  otro camino (`_reconcileActivePosition`, finalize que el servidor no
  recibió), el orquestador corta igual con `close_reason = unknown` al detectar
  el tokenId nuevo.
- «Ajuste en curso» necesita una llamada nueva del cliente al empezar a firmar
  (`POST /lp-orchestrators/:id/action-started`). Solo existe en el flujo del
  orquestador; un ajuste hecho desde otra página no pasa por `closing`.

## Estado de cobertura limpio por tramo (decisión del usuario)

Al abrir un tramo, la protección reinicia el estado de **decisión** de su
política y del motor; conserva solo lo que es de la posición de Hyperliquid y
de la contabilidad:

- Se reinician: `rangeExitPolicyState`, `terminalRangePolicyState`,
  `netProfitPolicyState` (cerrojo superior, cooldown, dwell, fills,
  presupuesto diario), `minDwellUntil`, `zoneState`,
  `lastObservedBoundarySide`, `lastSnapshotPrice`, `lastRebalanceAt`,
  `nakedExposure*`, `positionMissing*` del LP, `truthPending`, y el estado de
  **decisión** de cada sombra (`shadowPolicyState`). La posición simulada de
  cada sombra (cantidad, precio medio, acumuladores) se conserva, igual que el
  short real, para que la comparativa siga teniendo sentido entre tramos
  (decisión de Claude).
- Se conservan: lectura de la posición del short, acumuladores realizados y
  de fills (`lastReconciledFillsAt`, `hedgeRealizedPnlUsd`, funding…), para que
  la foto de corte siga cuadrando con Hyperliquid.
- El tramo nuevo dispara una evaluación forzada (`segment_opened`). Con
  «Borde de rango» eso lleva el short al delta del LP nuevo, como ya pasa hoy.
- Un forzado que no se pudo ejecutar se guarda como `pendingForceReason` en
  **todas** las salidas tempranas de `_evaluateProtectionUnlocked`
  (`snapshot_refresh_pending`, `snapshot_invalid`, `spot_stale`, lock ocupado),
  no solo en `min_dwell_active`.
- `net_profit_v1/v2` reciben `forceRebalance` como el resto de políticas.

La lista exacta de claves a reiniciar vive en una sola función con test, para
que una clave nueva del motor tenga que decidirse explícitamente.

## Ajustar la cobertura sin sobreoperar (petición del usuario)

Reiniciar el estado de decisión **no** significa reiniciar la posición:

- El paso de un tramo al siguiente es **una sola orden** por la diferencia
  entre el short actual y el objetivo del tramo nuevo (reducir o aumentar).
  Nunca cerrar todo para volver a abrir una parte, ni abrir y cerrar en la
  misma transición.
- El motor ya ejecuta así (`_runSingleAdjustment`/`_runTwap` mandan
  `|objetivo − actual|`); el diseño lo convierte en invariante con test: ni el
  corte de tramo, ni el forzado `segment_opened`, ni el flujo de «ajuste en
  curso» pueden producir una secuencia cierre total + reapertura.
- Si la diferencia queda por debajo del mínimo de orden, no se opera (se
  adopta lo que hay, como ya hacen `range_exit_v1` y `terminal_range_v1`).
- La foto de corte del short es contable: no requiere ninguna orden.

Observación para decidir aparte (fuera de este alcance, ligada a la regla de
reentrada): en el #57, desde el 22-10 «Borde de rango» rebotó 8 veces en el
borde inferior (2.401,9) con ajustes de ~0,007 ETH (~17 $) en cada salida y
reentrada. Cada uno es incremental, pero el conjunto es sobreoperar.

## Ajuste en curso

- Cuando el cliente empieza a firmar una acción que abrirá tramo (llamada
  nueva `action-started`, ver «Dónde se hace el corte»), el tramo abierto pasa
  a `closing` con `closing_started_at`.
- La tarjeta, con el tramo en `closing`, muestra «Ajuste en curso: la
  cobertura espera al LP nuevo» en vez del % cubierto. Sin cambios en el hedge.
- Al finalizar, el corte cierra el tramo y abre el siguiente. Si la firma se
  abandona (sin finalize en un tiempo razonable y la posición vieja sigue con
  liquidez), el tramo vuelve a `open`; si la posición vieja quedó vacía, se
  mantiene `closing` y el flujo de reanudación existente (`redeployResume`,
  `reconcile`) es quien lo cierra.
- Mientras hay tramo `closing`, el orquestador no marca `position_not_found`
  por la posición vieja vacía (hoy lo hace durante la firma).

## Reconstrucción histórica

Script idempotente (`server/src/scripts/backfill-orchestrator-segments.js`,
con `--dry-run` y `--orchestrator <id>`):

- Corta la historia de cada orquestador en los `attach_lp`, `tx_finalized`
  de las acciones que abren tramo y `kill_lp` del registro de acciones.
- Por tramo usa lo que haya: `accounting_snapshot` más cercanos a cada corte
  para el P&L, `protected_pool_delta_rebalance_log` para la cobertura,
  `positionIdentifier` del registro para la identidad.
- Todos los tramos reconstruidos quedan `accuracy = approximate`. El tramo
  abierto al desplegar arranca `exact` desde ese momento (su parte anterior al
  despliegue queda aproximada; el builder decide si eso es un tramo partido o
  un campo `exact_since`).
- **El total nunca cambia por desplegar** (decisión de Claude, por el
  anti-objetivo). La migración 048 crea para cada orquestador un tramo
  `historico` (`approximate`) con su `accounting_json` actual, cerrado en el
  despliegue, y abre el tramo vivo desde ahí. El backfill, cuando el usuario lo
  escriba, **sustituye** ese tramo histórico por los tramos reconstruidos más
  una línea «diferencia de reconstrucción» con lo que no se pudo atribuir, de
  modo que la suma siga igual al total anterior. Se puede desplegar el código
  sin haber corrido el backfill.
- Se ejecuta primero en local y en `--dry-run` contra producción; el usuario
  decide cuándo escribir.

## Interfaz (dentro de lo que ya existe)

- Sección «Tramos» en el panel de contabilidad (`AccountingPanel`) o en el
  cajón del registro (`ActionLogDrawer`): lista del más reciente al más
  antiguo, con nº, fechas, rango, motivo de cierre, P&L neto y % cubierto
  medio; al desplegar, el desglose de P&L y los reajustes del short. Insignia
  «aproximado» en los reconstruidos y la diferencia contra el acumulado.
- La barra de rango y la «Apertura» de la tarjeta leen el tramo abierto.
- El aviso de «Ajuste en curso» en la tarjeta.
- Móvil primero: la lista debe funcionar a 390 px.
- API: `GET /api/lp-orchestrators/:id/segments` (lista con resumen) y
  `GET /api/lp-orchestrators/:id/segments/:segmentId` (detalle con eventos y
  reajustes).

## Restricciones

- Node/Express + PostgreSQL 16; migraciones numeradas (la siguiente libre es
  048). Tests con `node --test` en `server/test/` y Vitest en el cliente; E2E
  Playwright contra Docker en `localhost:5174`.
- Trabajo en el worktree `~/Documentos/CODE/testbotCobertura-tramos`; otras
  sesiones comparten el checkout principal.
- Todo umbral comparado contra el tamaño de la posición debe ser relativo
  (regla del proyecto).
- No hay acceso SSH a producción: cualquier verificación allí es por la API
  autenticada o por SQL que ejecuta el usuario.

## Pruebas que deben existir

- Reproducción del #57: tres LPs con dos ajustes; el tramo 3 tiene su propia
  apertura dentro de su rango y su P&L no incluye la deriva entre snapshots de
  LPs distintos.
- Corte: la suma de tramos es igual al total; gas/swap del ajuste en el tramo
  nuevo; la foto del short reparte realizado/no realizado sin perder nada.
- Estado limpio: tras un tramo nuevo, `net_profit_v2` con presupuesto diario
  agotado y cerrojo superior puesto del rango anterior decide con estado
  limpio; `range_exit_v1` re-ancla.
- Forzado no se pierde en cada salida temprana.
- Transición de tramo con short vivo: exactamente una orden, del tamaño de la
  diferencia y en el sentido correcto; ninguna secuencia cierre total +
  reapertura.
- No hay `position_not_found` durante un tramo `closing`.
- Backfill idempotente y marcado como aproximado.

## Lo que queda al builder

- Forma exacta de las columnas JSON y nombres finales.
- Si el resumen de cobertura se calcula al vuelo o se materializa.
- Cómo partir el tramo abierto en el despliegue (tramo partido o
  `exact_since`).
- Plazo para considerar abandonada una firma en `closing`.
- Ubicación final de la sección «Tramos» (contabilidad o cajón), según quepa
  mejor en móvil.
