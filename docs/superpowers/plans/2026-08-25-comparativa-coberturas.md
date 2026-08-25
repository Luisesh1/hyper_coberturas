# Comparativa de coberturas: las 3 políticas en paralelo

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Que cada pool protegido evalúe siempre las tres políticas de
cobertura (una real, dos en sombra), y mover la comparación a un desplegable
sobre la gráfica de Métricas.

**Spec:** `docs/superpowers/specs/2026-08-25-comparativa-coberturas-design.md`
(léelo: contiene la semántica exacta de qué cambia y qué no al elegir política).

**Tech Stack:** Node/Express, PostgreSQL (JSONB), React 18 + Vite,
lightweight-charts, `node:test` en servidor y vitest en cliente.

## Global Constraints

- La ruta de ejecución REAL no cambia de comportamiento. Los tests existentes
  de zonas y rebalanceo deben pasar **sin modificarse**; si hay que tocarlos,
  es señal de que la extracción cambió la semántica y eso es un defecto.
- El tick corre cada 2 s: evaluar tres políticas NO puede añadir ninguna
  llamada de red (RPC, Hyperliquid, DB extra). Sólo aritmética sobre datos ya
  cargados en ese tick.
- Migraciones aditivas. Nunca se reescribe ni se inventa historia: lo que no
  se midió se representa como hueco, jamás como cero.
- Con la política viva seleccionada, Métricas debe dar exactamente los mismos
  números que da hoy.
- Sólo la política viva ejecuta órdenes. Las de sombra jamás tocan
  `TradingService` ni emiten una orden real.

---

### Task 1: Extraer la decisión legacy a una función pura

**Files:**
- Create: `server/src/services/legacy-zones-policy.service.js`
- Create: `server/test/legacy-zones-policy.test.js`
- Modify: `server/src/services/protected-pool-delta-neutral/evaluate.js`

**Contexto:** `decideNetProfitV1` ya es pura (entradas explícitas, devuelve
`nextState`, no muta nada). La decisión legacy no: el booleano
`shouldRebalance` se arma en `evaluate.js:829-835` mezclando estado
persistido, `Date.now()`, la posición real leída de Hyperliquid y señales del
orquestador. Sin extraerla no se puede simular legacy en sombra.

- [ ] Escribir pruebas de `decideLegacyZones` que fijen el comportamiento
  actual: zona muerta central, disparo urgente por cruce de banda, disparo por
  temporizador con su piso de notional, forzado del orquestador, y posición
  nueva sin hedge.
- [ ] Extraer `decideLegacyZones({...})` con la misma forma de contrato que
  `decideNetProfitV1`: entradas explícitas (zona, multiplicadores, bandas,
  `centerDeadZonePct`, `lastRebalanceAt`, `forceReason`/`forceRebalance`,
  reloj inyectable), sin IO, devolviendo `{ decision, targetQty, gate, nextState }`.
- [ ] Hacer que la ruta de ejecución real llame a esa misma función, para que
  la política viva y su versión en sombra sean el mismo código.
- [ ] Ejecutar `npm test --prefix server` completo y confirmar que los tests
  preexistentes de zonas y rebalanceo pasan SIN modificarse.

### Task 2: Motor de tres políticas por tick

**Files:**
- Modify: `server/src/services/protected-pool-delta-neutral/evaluate.js`
- Modify: `server/src/services/protected-pool-delta-neutral/pricing.js`
- Modify: `server/src/services/net-profit-policy.service.js`
- Create: `server/test/multi-policy-shadow.test.js`

- [ ] Escribir pruebas de que, sea cual sea la política viva, las otras dos
  acumulan estado de sombra independiente, y de que ninguna sombra emite
  órdenes.
- [ ] Generalizar el bloque de sombra de `evaluate.js:723-791` para iterar
  sobre las políticas no vivas en vez de una sola.
- [ ] `strategy_state_json.shadowSnapshot` (singular) pasa a `shadowSnapshots`
  indexado por política, cada una con su `shadowPolicyState` y su
  `shadowFundingSourceUsd`. Conservar el throttle de escritura de 30 s.
- [ ] Leer un `shadowSnapshot` viejo (singular) como la política que fuera
  sombra en ese momento; NO reconstruir lo que las otras habrían hecho.
- [ ] Eliminar el mecanismo viejo `config.deltaNeutral.shadowMode` y sus
  multiplicadores de zona alternativos, subsumido por esta comparación.
- [ ] Ejecutar la suite del servidor.

### Task 3: Contabilidad por política en el orquestador

**Files:**
- Modify: `server/src/services/lp-orchestrator/accounting.js`
- Modify: `server/src/services/lp-orchestrator.service.js`
- Modify: `server/test/lp-orchestrator-accounting.test.js`

- [ ] Escribir pruebas de acumulación independiente por política, incluido el
  caso kill+recreate del LP (el baseline por política evita el doble conteo).
- [ ] Convertir los cinco acumuladores planos `shadow*Usd` en una estructura
  anidada por política, con un `shadowBaseline` por política en
  `strategy_state_json`.
- [ ] Generalizar `applyShadowStateDelta` y `readShadowStateFromProtection`
  para operar sobre una política nombrada.
- [ ] Los registros viejos entran con la estructura nueva vacía (el repo ya
  mergea contra `DEFAULT_ACCOUNTING`). Sin migración SQL.
- [ ] Ejecutar la suite del servidor.

### Task 4: Bloque `policies` en el snapshot horario

**Files:**
- Modify: `server/src/services/orchestrator-metrics.service.js`
- Create: `server/test/orchestrator-metrics-policies.test.js`

- [ ] Escribir pruebas de que `breakdown_json.policies` trae las tres
  políticas con desglose simétrico y que `isLive` marca la real de esa hora.
- [ ] Añadir a `computeBreakdown` el bloque `policies` descrito en el spec:
  por política, `hedgeRealizedPnlUsd`, `hedgeUnrealizedPnlUsd`,
  `hedgeFundingUsd`, `hedgeExecutionFeesUsd`, `hedgeSlippageUsd`,
  `hlAccountUsd` e `isLive`.
- [ ] Cambio estrictamente aditivo: ninguna columna existente se toca y el
  `breakdown_json` anterior sigue siendo válido.
- [ ] Ejecutar la suite del servidor.

### Task 5: Eliminar la UI de sombra

**Files:**
- Delete: `client/src/pages/UniswapPools/components/ShadowPolicyCard.jsx`
- Delete: `client/src/pages/UniswapPools/components/ShadowPolicyCard.module.css`
- Delete: `client/src/pages/UniswapPools/components/ShadowPolicyCard.test.jsx`
- Modify: `client/src/pages/UniswapPools/components/ProtectedPoolCard.jsx`
- Modify: `client/src/pages/LpOrchestrator/components/AccountingPanel.jsx`
- Modify: `client/src/pages/LpOrchestrator/components/AccountingPanel.test.jsx`

- [ ] Borrar `ShadowPolicyCard` (componente, CSS y test) y su uso en
  `ProtectedPoolCard.jsx` (import en la línea 12, render en la 367).
- [ ] Quitar de `AccountingPanel.jsx` la sección de sombra: `hasShadowData`,
  `shadowNetUsd`, `shadowEdgeUsd`, `shadowItems` y su bloque JSX, más los
  casos de test que la cubren.
- [ ] Verificar por búsqueda que no queda ninguna referencia a
  `ShadowPolicyCard`, `shadowSnapshot` ni `shadowNetPnlUsd` en el cliente.
- [ ] Ejecutar `npm run test --prefix client` y el lint del cliente.

### Task 6: Desplegable de política en la gráfica de Métricas

**Files:**
- Modify: `client/src/pages/Metricas/components/OrchestratorMetricChart.jsx`
- Create: `client/src/pages/Metricas/components/OrchestratorMetricChart.test.jsx`

- [ ] Escribir pruebas primero (hoy este componente no tiene ninguna): con la
  política viva seleccionada produce los mismos valores que hoy; elegir otra
  cambia `hlAccountUsd`, `totalUsd`, `Δ rango` y el PnL total; `walletUsd`,
  `lpUsd`, `lpFeesUsd` y `priceDriftUsd` quedan intactos; un snapshot sin
  bloque `policies` se dibuja como hueco y NUNCA como cero.
- [ ] Añadir el desplegable de política. Por defecto, la viva: la vista de
  entrada de Métricas no cambia respecto a hoy.
- [ ] `PNL_COMPONENTS` deja de ser una lista fija de nueve claves planas: los
  cinco componentes de cobertura se leen de `policies[<política>]` y los del
  LP se siguen leyendo como hoy.
- [ ] La gráfica debe indicar visiblemente a qué cobertura pertenece lo que se
  está viendo, y si ese punto es medición real o simulación.
- [ ] Ejecutar tests y lint del cliente, y `npm run check` en la raíz.
