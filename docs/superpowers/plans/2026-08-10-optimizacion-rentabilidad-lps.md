# Optimización de rentabilidad de los LPs orquestados

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que los orquestadores LP vivos pasen de PnL neto negativo a positivo, atacando los dos sumideros medidos —sub-cobertura del hedge y costo de ejecución por exceso de rebalanceos— sin aumentar el riesgo de liquidación del short.

**Architecture:** El plan se ordena por dependencia, no por tamaño del hallazgo. Primero se contiene riesgo abierto (Fase 0), luego se instrumenta (Fase 1) porque hoy el KPI principal es tautológico y el PnL no cuadra; recién entonces se diagnostica el gap de cobertura v4 (Fase 2) y se mueve la palanca maestra —gamma vía ancho de rango— que es la única que mejora los dos sumideros a la vez (Fase 3). La eficiencia de ejecución (Fase 4) viene después porque su beneficio solo es atribuible con la instrumentación puesta. Cierra con validación y actualización del reporte semanal (Fase 5).

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

Los tres pierden dinero:

| orch | fees | residual | net PnL | fees+residual | **gap sin explicar** |
|---|---|---|---|---|---|
| 35 | +0.90 | −1.54 | −0.33 | −0.64 | **+0.31** |
| 36 | +0.95 | −2.32 | −1.03 | −1.37 | **+0.34** |
| 37 | +7.78 | −19.39 | −13.69 | −11.61 | **−2.08** |

Dos sumideros independientes, ambos confirmados con datos:

**(A) Sub-cobertura.** `hedge_beta` medido sobre primeras diferencias de snapshots: 0.495 / 0.476 / **0.293**. Los v3 llegaban a 0.87–0.92. Corte v3/v4 limpio, causa raíz sin confirmar.

**(B) Costo de ejecución por frecuencia.** Los pools 0.05% usan rangos ~40% más angostos y rebalancean 2.5–4.5× más:

| orch | fee tier | ancho rango | rebal/día | costo | % capital |
|---|---|---|---|---|---|
| 35 | 0.3% | 4.19% | 1.49 | 0.09 | 0.09% |
| 36 | 0.05% | 2.59% | 3.66 | 0.13 | 0.12% |
| 37 | 0.05% | 2.49% | **6.71** | 2.72 | **0.31%** (~34% anualizado) |

El costo *por rebalanceo* normalizado por capital es idéntico (0.0096–0.0139%): todo el diferencial es frecuencia, causada por gamma ≈ 1/ancho².

**La tensión central del plan:** subir cobertura (arregla A) aumenta el turnover (empeora B); bajar turnover (arregla B) aumenta el residual (empeora A). **La única palanca que mejora ambos es reducir gamma ensanchando el rango**, porque un delta que se mueve más lento necesita menos re-cobertura *y* deriva menos entre rebalanceos. Por eso la Fase 3 es la palanca maestra y no un "nice to have".

## Riesgos abiertos detectados

- **pp8** rozó 8.4% de distancia a liquidación esta semana (umbral de alarma: 8%).
- **#36 y #37** están en fase `urgent_adjust`; time-in-range cayó de 93% a 78.5% en 24h.
- **pp6 y pp7** (del archivado #33) se rebalancearon por última vez el 5 ago y `dist_liq` de pp7 viene NULL: posibles shorts abiertos sin orquestador gestionándolos.

## File Structure

| Fichero | Responsabilidad | Tarea |
|---|---|---|
| `scripts/hedge-followup.sh` | Dashboard read-only; ya trae secciones 0/2b/3b/6 nuevas | 4, 14 |
| `server/src/services/orchestrator-metrics.service.js` (~L278-367) | Atribución de PnL; exponer `hedgeBeta` y conciliar términos | 5 |
| `server/src/services/protected-pool-delta-neutral.service.js` (~L2335) | Loguear delta modelado vs realizado por ciclo | 6 |
| `server/src/services/delta-neutral-math.service.js` (`computeDeltaNeutralMetrics`, L239) | Cálculo de delta/gamma; foco del diagnóstico v4 | 7, 8 |
| `server/src/services/lp-orchestrator/range-recommender.js` (L80-84) | Añadir término de costo de cobertura al lazo de angostamiento | 10 |
| `server/src/services/protected-pool-delta-neutral.helpers.js` (`deriveBandSettings`, L378-413) | Banda de no-trade + intervalo mínimo | 11, 12 |
| `server/weekly-hedge-report.js` (L83) | Reemplazar el ratio tautológico por `hedge_beta` | 14 |

---

## Fase 0 — Contención de riesgo (inmediato, sin código)

- [ ] **Tarea 1: Verificar los shorts huérfanos de pp6/pp7.** Confirmar en Hyperliquid si el orquestador archivado #33 dejó posiciones cortas abiertas. Un short sin orquestador no se rebalancea ni se vigila: es riesgo de liquidación no monitoreado. Si están abiertos, cerrarlos manualmente (lo firma el usuario).
- [ ] **Tarea 2: Revisar margen de #35.** pp8 tocó 8.4%. Confirmar el leverage efectivo y decidir si bajarlo. Criterio del playbook: `dist_liq_pct > 8%` en todo momento.
- [ ] **Tarea 3: Decidir exposición de #37.** Concentra el 78% del capital, tiene el peor `hedge_beta` (0.293) y la mayor quema (~34% anualizado en ejecución). Opciones: (a) reducir tamaño hasta cerrar Fases 2–3, (b) ensanchar rango ya (Tarea 9), (c) dejarlo y aceptar la quema mientras dura el diagnóstico. **Decisión del usuario** — es la que más mueve la aguja del portafolio.

## Fase 1 — Instrumentación (no se puede optimizar lo que no se mide bien)

- [x] **Tarea 4: Retirar `ratio_tgt_delta` como evidencia de cobertura.** ✅ Hecho en los tres sitios que lo afirmaban: cabecera de la sección 2 del dashboard (ahora "DIAGNÓSTICO DEL REBALANCEO" con la advertencia explícita), línea de lectura rápida al pie, y el reporte semanal (Tarea 14). Memoria `hedge-periodic-analysis` actualizada con la advertencia. La columna se conserva como diagnóstico —`fill_ratio` y `drift_usd` sí son observaciones independientes— pero ya no se presenta como KPI de cobertura; ese rol es de `hedge_beta` (sección 3b). Detalle original: Hoy da 1.00 siempre porque `delta_qty_before`, `target_qty_after` y `actual_qty_after` se escriben del mismo valor calculado en el rebalanceo: confirma que el multiplicador de zona es 1.0, **no** que se cubra la exposición real. Los tres v4 pasan ese check estando a media cobertura. El KPI de cobertura pasa a ser `hedge_beta` (sección 3b del dashboard). Documentar el cambio de criterio en la memoria `hedge-periodic-analysis`.
- [x] **Tarea 5: Conciliar la atribución de PnL.** ✅ **Cerrada con corrección: la premisa era falsa.** No falta ningún término — `recomputeNetPnl` (`accounting.js:80-93`) ya incluye `gasSpentUsd`, `swapSlippageUsd`, `hedgeUnrealizedPnlUsd`, `hedgeExecutionFeesUsd` y `hedgeSlippageUsd`. El gap venía de que el query del dashboard solo seleccionaba 4 de los 9 términos. Corregido: la sección 3 ahora muestra la descomposición completa con una columna `check` que verifica el cuadre (**0.0000 en las cuatro filas**).
- [x] **Tarea 6: Loguear delta modelado vs realizado por ciclo.** ✅ Evento `delta_neutral_delta_diagnostic` en `protected-pool-delta-neutral.service.js`. La comparación decisiva es `modelValueRatio` = valor del LP según `calculatePoolValueAtPrice` (reconstruido desde `snapshot.liquidity` + ticks) vs el `currentValueUsd` del snapshot: si se desvía de ~1.0, la liquidez de entrada está mal y el delta hereda el error. Incluye `version` (para el corte v3/v4) e `inRange` (para descartar el confusor de los cruces de borde).

## Fase 2 — Diagnóstico del gap de cobertura v4

- [ ] **Tarea 7: Comparación controlada v3 vs v4 del cálculo de delta.** Hipótesis: `computeDeltaNeutralMetrics` subestima el delta en posiciones v4. Evidencia a favor: corte limpio (v3 beta 0.87–0.92 vs v4 0.29–0.50) y toda la flota viva es v4. **Confusor a descartar primero:** la serie cruda de delta se mueve mucho por cruces de banda legítimos (un LP ETH/USDC fuera de rango por arriba queda todo en USDC con delta≈0), así que la comparación debe hacerse **solo en momentos dentro de rango**, usando los datos de la Tarea 6. Validar contra un fork local de Arbitrum (memoria `e2e-fork-validation`).
- [ ] **Tarea 8: Corregir la causa encontrada en la Tarea 7.** Alcance dependiente del diagnóstico. Test de regresión que fije el delta esperado para una posición v4 conocida, con los multiplicadores **inyectados**, no leídos de `config` (ver memoria `orchestrator-hedge-residual-rootcause`: ese error hizo que un test pasara en CI y fallara en prod).

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
  - `hedge_beta` ≥ 0.85 en los tres (hoy 0.29–0.50)
  - `d_corr` ≤ −0.75 (hoy −0.49 a −0.72)
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
