# Optimización de rentabilidad de los LPs orquestados

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que los orquestadores LP vivos pasen de PnL neto negativo a positivo, atacando el sumidero real —el costo de ejecución por exceso de rebalanceos— sin aumentar el riesgo de liquidación del short.

> ⚠️ **REVISADO 2026-08-10 (post-deploy).** El plan nació apuntando a **dos** sumideros. El primero, la sub-cobertura del hedge, **resultó no existir**: era un artefacto de `hedge_beta`, un estimador roto. La cobertura real es 0.99–1.10. Toda la Fase 2 quedó eliminada. Lo que sigue vivo es el costo de ejecución, ya atacado en `f719f06`. El histórico se conserva a propósito: explica por qué existen tareas que hoy están tachadas.

**Architecture:** El plan se ordena por dependencia, no por tamaño del hallazgo. Primero se contiene riesgo abierto (Fase 0), luego se instrumenta (Fase 1) — y esa instrumentación fue justo la que demostró que el sumidero de cobertura no existía, matando la Fase 2 entera. Queda la palanca maestra, gamma vía ancho de rango (Fase 3), y la eficiencia de ejecución (Fase 4), que viene después porque su beneficio solo es atribuible con la instrumentación puesta. Cierra con validación y reporte semanal (Fase 5).

**Lección de método:** instrumentar ANTES de diagnosticar evitó gastar la Fase 2 entera persiguiendo un problema inexistente. El orden fue lo que salvó el trabajo.

**Tech Stack:** Node 20 (CommonJS), `node --test` + `node:assert/strict` en servidor, Vitest en cliente, PostgreSQL vía `pg`, dashboard `scripts/hedge-followup.sh` (solo lectura).

## Global Constraints

- Servidor en CommonJS (`require`/`module.exports`). No ESM en `server/`.
- Tests de servidor con `node --test`; se ejecutan con `npm --prefix server run test`. Ver memoria `run-server-tests` (node 22 vía nvm + `NODE_ENV=development`).
- Inyección de dependencias existente: constructor recibe `deps = {}` y cae al módulo real con `deps.x || require('./x')`. Nunca se mockea `pg` ni se toca la red en tests.
- Logs estructurados: `this.logger.warn('snake_case_event', { campo: valor })`. Nunca `console.log` en `src/`.
- Lint obligatorio antes de commit: `npm --prefix server run lint`.
- **Ninguna tarea de este plan escribe en la base de producción.** El diagnóstico va por `scripts/hedge-followup.sh` (read-only con guard anti-escritura). Cambios de rango/tamaño de posición los firma el usuario.
- Al terminar: rebuild de nginx+server en docker prod y push a `origin/main` (memoria `deploy-and-push-workflow`).

## Contexto medido (2026-08-10)

Flota viva: **#35** (pp8, $138), **#36** (pp9, $143), **#37** (pp10, $997) — todos v4 ETH/USDC en Arbitrum. **El 78% del capital está en #37.** Los del baseline anterior (#4/#5, v3) están archivados desde el 30 jul.

Los tres pierden dinero (descomposición completa, `check` = 0.0000):

| orch | fees | h_real | exec_fees | h_slip | drift | net PnL |
|---|---|---|---|---|---|---|
| 35 | +0.90 | −0.27 | 0.05 | 0.05 | −1.24 | **−0.36** |
| 36 | +0.95 | −1.01 | 0.13 | 0.04 | −1.29 | **−1.08** |
| 37 | +7.78 | −8.58 | 1.00 | 2.02 | −10.71 | **−14.11** |

~~**(A) Sub-cobertura.**~~ **DESCARTADO.** `hedge_beta` daba 0.29–0.50, pero es un estimador roto (patas asíncronas, ver Tarea 7b). La cobertura real `actualQty/deltaQty` es **0.99–1.10**. No hay sub-cobertura. Sí hay, en cambio, **sobre**-cobertura en #35 (1.06), que también cuesta dinero.

**(B) Costo de ejecución por frecuencia.** Los pools 0.05% usan rangos ~40% más angostos y rebalancean 2.5–4.5× más:

| orch | fee tier | ancho rango | rebal/día | costo | % capital |
|---|---|---|---|---|---|
| 35 | 0.3% | 4.19% | 1.49 | 0.09 | 0.09% |
| 36 | 0.05% | 2.59% | 3.66 | 0.13 | 0.12% |
| 37 | 0.05% | 2.49% | **6.71** | 2.72 | **0.31%** (~34% anualizado) |

El costo *por rebalanceo* normalizado por capital es idéntico (0.0096–0.0139%): todo el diferencial es frecuencia, causada por gamma ≈ 1/ancho².

**La tensión central del plan** (escrita cuando se creían dos sumideros): subir cobertura aumentaba el turnover, bajar turnover aumentaba el residual. Al caer (A), la tensión se disuelve: **solo hay que bajar el turnover**, sin nada que lo contrapese. Eso hace la Fase 3 —ensanchar el rango para bajar gamma— más atractiva aún, no menos: ya no cede nada a cambio.

En #37 la firma del problema es que el drift (−10.71) y el PnL del hedge (−8.58) **pierden a la vez**. Con la cobertura al 99%, eso solo se explica por re-cubrir contra ruido: whipsaw, no exposición descubierta.

## Riesgos abiertos detectados

- ~~**pp8** rozó 8.4% de distancia a liquidación~~ → era el **mínimo histórico** de la ventana, no el estado actual. Medido en vivo: 14.9%. Sin problema.
- **#36 y #37** están en fase `urgent_adjust`; time-in-range cayó de 93% a 78.5% en 24h.
- ~~**pp6 y pp7**: posibles shorts abiertos sin orquestador~~ → **DESCARTADO**, verificado contra Hyperliquid: la cuenta tiene una sola posición y es el hedge vivo de #35.
- ⚠️ **#37 a 8.4% de liquidación** (real, medido en vivo) mientras el sistema reporta 13.7%. Ver Tarea 2c.

## File Structure

| Fichero | Responsabilidad | Tarea |
|---|---|---|
| `scripts/hedge-followup.sh` | Dashboard read-only; ya trae secciones 0/2b/3b/6 nuevas | 4, 14 |
| `server/src/services/orchestrator-metrics.service.js` (~L278-367) | Atribución de PnL; exponer `hedgeBeta` y conciliar términos | 5 |
| `server/src/services/protected-pool-delta-neutral.service.js` (~L2335) | Loguear delta modelado vs realizado por ciclo | 6 |
| ~~`delta-neutral-math.service.js`~~ | ~~foco del diagnóstico v4~~ — descartado, el delta está sano | ~~7, 8~~ |
| `server/src/services/lp-orchestrator/range-recommender.js` (L80-84) | Añadir término de costo de cobertura al lazo de angostamiento | 10 |
| `server/src/services/protected-pool-delta-neutral.helpers.js` (`deriveBandSettings`, L378-413) | Banda de no-trade + intervalo mínimo | 11, 12 |
| `server/weekly-hedge-report.js` | Cobertura real como KPI; `hedge_beta` degradado a diagnóstico marcado no fiable | 14 |

---

## Fase 0 — Contención de riesgo (inmediato, sin código)

- [x] **Tarea 1: ~~Verificar los shorts huérfanos de pp6/pp7~~ → NO EXISTEN.** ✅ Resuelta consultando la API pública de Hyperliquid (`clearinghouseState`, solo lectura, solo requiere la dirección — **no hacía falta intervención manual**). La cuenta que comparten pp6/pp7/pp8 (`0x1ecC…`) tiene **exactamente una posición**: ETH −0.0451, que es el hedge vivo de #35. No hay nada colgando.
- [x] **Tarea 1b: ~~pp7 está SIN cobertura~~ → FALSA ALARMA MÍA.** ❌ Afirmé que pp7 tenía ~$38 de delta ETH sin cubrir leyendo `lastDeltaQty` 0.020477 / `lastActualQty` 0.000000 de `strategy_state_json`. **Eran filas congeladas**: un orquestador archivado (#33, el 5 ago) deja de escribir su estado, así que esos valores quedaron como estaban y los leí como si fuesen actuales. La verdad on-chain dice que no hay exposición descubierta.

  **Lección para el playbook:** `strategy_state_json` de un orquestador archivado es histórico, no estado. Antes de declarar un riesgo a partir de esa tabla, contrastar con `clearinghouseState` de Hyperliquid.
- [ ] **Tarea 2b (NUEVA): #35 está sobre-cubierto y la desviación CRECE.** Cobertura 1.0564 → 1.0715 en ~1h: el delta del LP baja (0.042933 → 0.042091) mientras el hedge se queda clavado en 0.045100. Estar net-short cuesta igual que estar expuesto, y las dos métricas viejas lo ocultaban.

  **Mecanismo identificado** (`delta_neutral_preflight_result`, protección 8): `poolValueUsd` $89.28, `driftUsd` $5.99.

  | umbral | valor | ¿lo supera el drift? |
  |---|---|---|
  | urgente 3% (`f719f06`) | $2.68 | **sí** |
  | timer 12% (preexistente) | $10.71 | no |

  No se corrige porque (a) ningún `boundary_cross`/`price_band` ha disparado, así que la rama urgente no se evalúa, y (b) el brazo del temporizador exige $10.71, casi el doble del drift actual. **La banda de no-trade nueva NO es la culpable** — el drift la supera holgadamente. El cuello de botella es `DEFAULT_MIN_REBALANCE_NOTIONAL_PCT = 12`, demasiado grueso para un LP de $89: obliga a acumular un 12% de desviación antes de mover un dedo.

  Opción a evaluar: bajar el 12% del timer, o dejar que la rama urgente cubra también el caso "drift persistente sin trigger de borde". Ojo con la interacción — bajarlo sube la frecuencia de rebalanceo, que es justo el sumidero (B).
- [x] **Tarea 2: ~~Revisar margen de #35~~ → SIN PROBLEMA.** El 8.4% que reportaba el dashboard era el *mínimo histórico* de la ventana de 7d, de un rebalanceo pasado. La distancia real medida en vivo es **14.9%**. Margen holgado.

- [x] **Tarea 2c: ~~#37 a 8.4% mientras el sistema reporta 13.7%~~ → ARREGLADO** (`c44056f`, desplegado). El monitoreo ya lee la distancia en vivo; verificado en prod: #35 15.1%, #36 17.3%, #37 **8.5%** 🟠, coincidiendo con la medición on-chain. La gestión de la posición de #37 la lleva el usuario.

  Detalle del diagnóstico original: Contraste medido contra Hyperliquid en vivo (ETH ~$1876):

  | orq | reporta | **real** |
  |---|---|---|
  | 35 | 8.4% | 14.9% |
  | 36 | 12.2% | 17.2% |
  | **37** | 13.7% | **8.4%** ⚠️ |

  **Causa: `distance_to_liq_pct` solo se escribe cuando ocurre un rebalanceo.** El reporte hace `min()` sobre los rebalanceos de la ventana, así que si no hay rebalanceos el número se congela. El último fue a las 15:26 UTC; desde entonces el precio se movió y la distancia real de #37 se deterioró sin que nada lo reflejara. **La métrica de riesgo se queda obsoleta justo cuando no hay actividad** — y #37 concentra el 78% del capital.

  **Arreglo aplicado:** `OrchestratorMetricsService.computeLiveDistanceToLiqPct(positions, asset, px)` — helper puro sin IO (`snap.positions` ya venía de `balanceCacheService`, no hay llamada de red nueva). Se persiste como `hedgeTracking.distanceToLiqPct` en cada snapshot, así que además queda histórico. Dashboard y reporte muestran el valor en vivo como el que manda y el mínimo de la ventana al lado, para que la divergencia sea visible. 6 tests, incluido dato-ausente → `null` y nunca `0` (un cero pintaría 🔴 de liquidación inminente sobre una posición sana).
- [ ] **Tarea 3: Decidir exposición de #37.** Concentra el 78% del capital, tiene la mayor quema (~34% anualizado en ejecución). Opciones: (a) reducir tamaño hasta cerrar Fases 2–3, (b) ensanchar rango ya (Tarea 9), (c) dejarlo y aceptar la quema mientras dura el diagnóstico. **Decisión del usuario** — es la que más mueve la aguja del portafolio.

## Fase 1 — Instrumentación (no se puede optimizar lo que no se mide bien)

- [x] **Tarea 4: Retirar `ratio_tgt_delta` como evidencia de cobertura.** ✅ Hecho en los tres sitios que lo afirmaban: cabecera de la sección 2 del dashboard (ahora "DIAGNÓSTICO DEL REBALANCEO" con la advertencia explícita), línea de lectura rápida al pie, y el reporte semanal (Tarea 14). Memoria `hedge-periodic-analysis` actualizada con la advertencia. La columna se conserva como diagnóstico —`fill_ratio` y `drift_usd` sí son observaciones independientes— pero ya no se presenta como KPI de cobertura; ese rol es de `hedge_beta` (sección 3b). Detalle original: Hoy da 1.00 siempre porque `delta_qty_before`, `target_qty_after` y `actual_qty_after` se escriben del mismo valor calculado en el rebalanceo: confirma que el multiplicador de zona es 1.0, **no** que se cubra la exposición real. Los tres v4 pasan ese check estando a media cobertura. El KPI de cobertura pasa a ser `hedge_beta` (sección 3b del dashboard). Documentar el cambio de criterio en la memoria `hedge-periodic-analysis`.
- [x] **Tarea 5: Conciliar la atribución de PnL.** ✅ **Cerrada con corrección: la premisa era falsa.** No falta ningún término — `recomputeNetPnl` (`accounting.js:80-93`) ya incluye `gasSpentUsd`, `swapSlippageUsd`, `hedgeUnrealizedPnlUsd`, `hedgeExecutionFeesUsd` y `hedgeSlippageUsd`. El gap venía de que el query del dashboard solo seleccionaba 4 de los 9 términos. Corregido: la sección 3 ahora muestra la descomposición completa con una columna `check` que verifica el cuadre (**0.0000 en las cuatro filas**).
- [x] **Tarea 6: Loguear delta modelado vs realizado por ciclo.** ✅ Evento `delta_neutral_delta_diagnostic` en `protected-pool-delta-neutral.service.js`. La comparación decisiva es `modelValueRatio` = valor del LP según `calculatePoolValueAtPrice` (reconstruido desde `snapshot.liquidity` + ticks) vs el `currentValueUsd` del snapshot: si se desvía de ~1.0, la liquidez de entrada está mal y el delta hereda el error. Incluye `version` (para el corte v3/v4) e `inRange` (para descartar el confusor de los cruces de borde).

## Fase 2 — Diagnóstico del gap de cobertura v4

> ### ⚠️ Evidencia post-deploy (2026-08-10 21:2x) — la hipótesis de abajo está DESCARTADA
>
> Con `delta_neutral_delta_diagnostic` ya en producción, **250 muestras** dicen:
>
> | métrica | `modelValueRatio` |
> |---|---|
> | mín / mediana / máx | 1.0082 / 1.0086 / 1.0123 |
> | media | 1.0092 |
>
> Sesgo constante de +0.9% y dispersión de 0.4 pp, igual de estrecho dentro de rango (48 muestras) que fuera (202). **La reconstrucción de liquidez y el cálculo de delta v4 están sanos** — un error del 0.9% no explica una cobertura que cae a la mitad. Además, en los ciclos observados `deltaQty == volatileAmount` exactamente y el hedge cubre el 99.1% de su target (0.4622 sobre 0.4663).
>
> **CONFIRMADO — el sumidero (A) no existe.** La cobertura medida directamente como `actualQty / deltaQty`, dentro del mismo ciclo de evaluación y sin pasar por `hl_account_usd`:
>
> | protección | orq | cobertura |
> |---|---|---|
> | 9 | #36 | 0.9996 |
> | 10 | #37 | 0.9912 |
> | 8 | #35 | 1.0564 – 1.0967 (**sobre**-cubierto) |
>
> El hedge cubre 99–110% del delta, no el 29–50% que reportaba `hedge_beta`. **`hedge_beta` sobre `hl_account_usd` es un estimador roto**: mide valor de cuenta (margen + PnL no realizado) con apalancamiento aislado 10x, no el notional del short.
>
> ⚠️ *Fuerza de la evidencia:* para las protecciones 9 y 10 las ~190 lecturas son idénticas (mín = mediana = máx), o sea posición estática — es **una** observación repetida, no 190 independientes. Concluyente contra "30–50%", pero hace falta una ventana con movimiento de precio para cuantificar la cobertura media en el tiempo.
>
> **Consecuencias:**
> - Las Tareas 7 y 8 pierden su objeto: no hay gap de cobertura v4 que diagnosticar.
> - El criterio de aceptación `hedge_beta ≥ 0.85` de la Tarea 15 **no es válido** y hay que sustituirlo por `actualQty/deltaQty`.
> - El plan se reduce al sumidero (B), el coste de ejecución, ya atacado en `f719f06`.
> - **Nuevo hallazgo:** #35 está sobre-cubierto un 6–10%. Estar net-short cuesta dinero igual que estar sub-cubierto; merece tarea propia.
>
> Se deja todo tal cual **a la espera de tu decisión** sobre cómo re-enfocar la Fase 2. No borrar esta nota al reescribirla: es la razón del cambio.


- [x] **Tarea 7: ~~Comparación controlada v3 vs v4 del cálculo de delta~~ → ELIMINADA.** No hay gap de cobertura que diagnosticar. `modelValueRatio` (250 muestras) sale 1.0082–1.0123, así que el delta v4 está sano, y la cobertura real es 0.99–1.10.
- [x] **Tarea 8: ~~Corregir la causa encontrada en la Tarea 7~~ → ELIMINADA.** Sin objeto.
- [x] **Tarea 7b (NUEVA, hecha): Por qué miente `hedge_beta`.** ✅ **Causa raíz: las dos patas no se muestrean sincronizadas.** Medido sobre 7d:

  | orq | intervalos | `Δlp = 0` | `Δhl = 0` | LP congelado con HL moviéndose |
  |---|---|---|---|---|
  | 35 | 124 | **66 (53%)** | 0 | 66 |
  | 36 | 87 | 17 | 1 | 17 |
  | 37 | 87 | 7 | 1 | 7 |

  `lp_usd` se queda congelado en hasta el 53% de los intervalos (snapshots cada ~58 min) mientras `hl_account_usd` se actualiza siempre. Eso mete puntos con regresor 0 cuando el valor real sí cambió — error en la variable independiente, que hunde la pendiente hacia 0. En #35 la fracción congelada (53%) explica casi exactamente el déficit del beta (0.50).

  Descartado por el camino: **no** es atenuación por el filtro. Un barrido de umbrales (0.5%/1%/3%/10%/sin filtro) da el beta **constante**, y casi todos los incrementos ya pasaban el filtro del 1%.

  La aritmética cuadra como `beta = |corr| × (sd_dhl/sd_dlp)`: #35 → 0.486 × 1.02 = 0.50 ✓, #37 → 0.508 × 0.58 = 0.30 ✓. En #37 queda un segundo defecto sin explicar (la pata HL se mueve el 58% de la LP con solo 8% de intervalos congelados); **no atribuido por falta de evidencia**.

  Herramienta reutilizable: `FOLLOWUP_BETA_SWEEP=1 scripts/hedge-followup.sh`.

## Fase 3 — Palanca maestra: gamma / ancho de rango

- [ ] **Tarea 9: Ensanchar el rango de #36/#37 a ~4%.** Sin código, es configuración. De 2.5% → 4.2% baja gamma ~2.8× y la frecuencia de rebalanceo en proporción. Cede concentración de fees, pero el neto actual ya es negativo: el trade-off vigente está perdiendo. Medir 7 días contra la línea base de este documento.
- [x] **Tarea 10: Meter costo de cobertura en `recommendRangeWidthPct`.** ✅ Implementada. Nuevo feedback `narrow_blocked_by_hedge_cost`: si `(hedgeExecutionFees + hedgeSlippage) / lpFees` supera `maxHedgeCostRatio` (default **1/3**, alineado con el `costToRewardThreshold` que ya usaba el servicio), el lazo deja de angostar. Calibrado contra datos reales: #37 da 0.39 → bloquea; #35 da 0.11 y #36 0.18 → siguen angostando. **Solo bloquea angostar, nunca fuerza ensanchar** — ensanchar es decisión de riesgo (time-in-range), no de costo. Se excluye el PnL realizado del hedge a propósito: un hedge sano lo tiene distinto de cero por diseño y meterlo confundiría cobertura con costo. 4 tests nuevos.

<details><summary>Detalle original de la tarea</summary> Hoy (`range-recommender.js:80-84`) angosta el rango ×0.85 cuando time-in-range > 90%, sin ningún término de costo de hedge. Los tres orquestadores están en 93–100% TIR, así que el lazo los empuja a rangos cada vez más estrechos —y por tanto a más gamma y más comisiones. **Es el bug conceptual de fondo: optimiza captura de fees contra una función objetivo incompleta.** Añadir la restricción de no angostar si el costo de cobertura del período supera una fracción configurable de las fees capturadas.
</details>

## Fase 4 — Eficiencia de ejecución

- [x] **Tarea 11: Banda de no-trade en el hedge.** ✅ Implementada. **Hallazgo: la primitiva ya existía** (`minRebalanceNotionalUsd`) pero solo se aplicaba al brazo del temporizador; `boundary_cross` y `price_band` disparaban orden sin ningún piso económico. Nuevo `resolveUrgentMinRebalanceNotionalUsd` con porcentaje propio (`DELTA_NEUTRAL_URGENT_MIN_NOTIONAL_PCT`, default **3%** del valor vivo del LP). Es deliberadamente más bajo que el 12% del timer: un cruce de borde es más urgente que un tick de reloj, así que frena lo económicamente irrelevante sin abrir hueco de cobertura. Las rutas de riesgo (reducir a cero, hedge huérfano sin posición, force manual) siguen sin gate. Evento `delta_neutral_urgent_rebalance_skipped_below_band` para medir cuánto frena. 6 tests nuevos, incluido uno que fija que el churn real de pp10 (drifts 11.44–20.69 sobre umbral $29.91) queda frenado mientras los movimientos genuinos (119.78, 839.92) siguen pasando.
- [ ] **Tarea 12: Intervalo mínimo entre rebalanceos.** ⏸️ **Diferida a propósito.** El mecanismo ya existe (`minDwellMs`, default 60s). Se intentó subirlo a 5 min y **se revirtió**: la Tarea 11 ya frena el churn medido (los drifts encadenados de pp10 caen bajo su umbral), así que apilar ambas violaría la regla de secuencia de este mismo plan —quedaría inatribuible cuál produjo el efecto— y añadiría hasta 5 min de retraso en re-coberturas genuinas sin beneficio demostrado. **Reevaluar solo si tras medir la Tarea 11 sigue habiendo ráfagas.**
- [ ] **Tarea 13: Órdenes maker en rebalanceos no urgentes.** Usar maker para `timer_and_drift` y reservar taker para `boundary_cross`, donde la urgencia justifica el spread. Reduce el fee por trade sin reducir cobertura. Requiere manejo de órdenes no llenadas (timeout → fallback a taker).

## Fase 5 — Validación y seguimiento

- [x] **Tarea 14: Actualizar el reporte semanal y el dashboard.** ✅ Hecho, con dos correcciones sobre lo planificado:
  - El fichero **ya estaba commiteado** (`3a83255`); la memoria que decía que solo vivía en el contenedor estaba desactualizada. No había nada que rescatar.
  - No hizo falta añadir `hedge_beta`: la query `eff` **ya lo calculaba** sobre primeras diferencias. El problema real era otro — usaba un filtro **absoluto** `abs(Δ) < 1.5 USD` para descartar saltos de rebalanceo, que en un orquestador de ~$1000 como #37 filtra sus movimientos normales y sesga el beta. Cambiado a relativo (1% del total).
  - Se eliminó el ratio tautológico y, de paso, un **bug latente**: la query devolvía `protected_pool_id` pero se indexaba con `idx(cov.rows, 'pp')` y se consultaba por `orchestrator_id`, así que la línea "Cobertura efectiva" salía `N/A` casi siempre. Su lugar lo ocupa ahora el costo de cobertura como % de las fees, con semáforo al mismo umbral de 1/3 que usa el recomendador.
- [ ] **Tarea 15: Criterios de aceptación.** Medir a 7 y 14 días contra la línea base de este documento:
  - **cobertura real `actualQty/deltaQty` dentro de 1.00 ± 0.03** (hoy: #36 1.00 ✅, #37 0.99 ✅, #35 **1.06 ❌ sobre-cubierto**). ⚠️ NO usar `hedge_beta`: es un estimador roto, ver Tarea 7b.
  - costo de ejecución ≤ 0.10% del capital / semana (hoy 0.31% en #37)
  - `dist_liq_pct` > 8% en todo momento — **no negociable**, ninguna mejora de rentabilidad justifica cruzarlo
  - PnL neto por orquestador en tendencia positiva, con la atribución de la Tarea 5 cuadrando

## Orden de ejecución y dependencias

```
Fase 0 (riesgo)     ──> independiente, hacer ya
Fase 1 (medir)      ──> prerrequisito de todo lo demás
   Tarea 6 ─────────> Tarea 7 ──> Tarea 8      (gap de cobertura, sumidero A)
   Tarea 5 ─────────> Tarea 15                 (sin conciliación no hay validación)
Fase 3 (Tarea 9)    ──> se puede adelantar: es config, reversible y ayuda a A y B
Fase 4              ──> después de Fase 1, si no el beneficio no es atribuible
```

**Advertencia de secuencia:** no ejecutar Fases 3 y 4 en paralelo sin la instrumentación de la Fase 1. Ambas mueven la frecuencia de rebalanceo, y sin atribución no se podrá saber cuál de las dos produjo (o destruyó) el resultado.
