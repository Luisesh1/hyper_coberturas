# Tramos del orquestador LP — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partir la vida de cada orquestador LP en tramos con contexto, P&L y
cobertura propios, de modo que nada de un LP o rango anterior intervenga en las
decisiones ni en la contabilidad del siguiente.

**Architecture:** Tabla `lp_orchestrator_segments`. La contabilidad del tramo se
**deriva por resta**: cada tramo guarda la contabilidad acumulada del
orquestador al abrirse (`baseline_accounting_json`). Un tramo cerrado congela
`acumulado_al_cerrar − baseline`, y el abierto calcula `acumulado_actual −
baseline`. Por construcción, la suma de tramos es el total, y el acumulado
existente sigue siendo la única fuente (desplegar no cambia el total). El
corte ocurre en `recordTxFinalized` antes de cargar gas y swaps (que caen en el
tramo nuevo). El reinicio del estado de decisión de la cobertura ocurre en
`finalize.js`, bajo el lock de evaluación de la protección.

**Tech Stack:** Node/Express, PostgreSQL 16 (migraciones SQL numeradas),
`node:test`; React 18 + Vite + Vitest; Playwright contra Docker.

**Spec:** `docs/superpowers/specs/2026-10-23-orchestrator-segments-design.md`

## Global Constraints

- Trabajar en el worktree `~/Documentos/CODE/testbotCobertura-tramos`, rama `feat/orchestrator-segments`; nunca cambiar de rama en el checkout principal.
- La siguiente migración libre es **048** (`server/src/db/migrations/048_lp_orchestrator_segments.sql`). El migrador registra por número.
- Acciones que abren tramo: `modify-range`, `rebalance`, `increase-liquidity`, `decrease-liquidity`, `reinvest-fees`; además `attachLp` (crear, adoptar o `retry-commit`). `close-to-usdc`/`close-keep-assets` solo cierran. `collect-fees` no abre tramo.
- Motivos de cierre: `range_exit_below`, `range_exit_above`, `manual_rerange`, `capital_change`, `lp_closed`, `policy_change` (reservado), `unknown`.
- Motivos de apertura: `create`, `adopt`, `rerange`, `capital_change`, `attach`, `backfill`, `deploy`.
- Estados: `open` · `closing` · `closed`. Exactitud: `exact` · `approximate`.
- Gas y slippage de swaps del ajuste van al tramo **nuevo**. La deriva del LP viejo durante la firma y las fees cobradas en el ajuste van al tramo **viejo**, valoradas al precio del finalize.
- La cobertura nunca cierra todo para reabrir: una transición = como mucho una orden por `|objetivo − actual|`, y ninguna si queda bajo el mínimo de orden.
- Todo umbral comparado contra el tamaño de la posición es relativo.
- UI: sin rediseño de la tarjeta; la lista de tramos debe verse bien a 390 px. Textos en español.
- Tests del servidor: `cd server && node --test test/<file>`; suite completa `cd server && npm test`; lint `npm run lint` en `server/` y `client/`. Tests del cliente: `cd client && npx vitest run <file>`. E2E: `npm run test:e2e` contra Docker en `localhost:5174`.

## Review Focus

1. **Un finalize que llega dos veces** (el cliente reintenta tras un timeout): no debe cortar dos tramos. La idempotencia actual por `txHashes` corre antes del corte → test en Task 5.
2. **Un ajuste cuyo `recordTxFinalized` nunca llega** (hecho desde la página de pools o con la pestaña cerrada): el tramo debe cortarse igual cuando `_evaluateOne` vea el tokenId nuevo, con `close_reason = unknown` → test en Task 5.
3. **Orquestador sin protección** (cobertura desactivada): el corte funciona sin foto del hedge ni reinicio de la cobertura → test en Task 5.
4. **Firma abandonada a medias:** un tramo `closing` no puede quedarse así para siempre si la posición vieja sigue con liquidez → test en Task 6.
5. **LP cerrado y otro adjuntado más tarde:** entre medias no hay tramo abierto, y la suma sigue siendo igual al total → test en Task 5.

---

### Task 1: Matemática pura de tramos

**Files:**
- Create: `server/src/services/lp-orchestrator/segments.js`
- Test: `server/test/lp-orchestrator-segments.test.js`

**Interfaces:**
- Consumes: `normalizeAccounting`, `recomputeNetPnl` de `server/src/services/lp-orchestrator/accounting.js`; `buildLpValuation` de `server/src/services/protected-pool-delta-neutral/terminal-range.js`.
- Produces:
  - `SEGMENT_OPENING_ACTIONS: Set<string>` (las cinco acciones de Global Constraints).
  - `SEGMENT_CLOSING_ACTIONS: Set<string>` (`close-to-usdc`, `close-keep-assets`).
  - `subtractAccounting(current, baseline) -> accounting`: resta campo a campo todos los numéricos de `normalizeAccounting`, incluidas las entradas de `shadowPolicies` por política. `totalNetPnlUsd` se recalcula con `recomputeNetPnl`. Con `baseline` null devuelve `normalizeAccounting(current)`.
  - `classifyCloseReason({ action, price, rangeLowerPrice, rangeUpperPrice }) -> string`: para `modify-range`/`rebalance` devuelve `range_exit_below` si `price < lower`, `range_exit_above` si `price > upper` y `manual_rerange` en otro caso. Las acciones de capital devuelven `capital_change`, las de cierre `lp_closed` y el resto `unknown`.
  - `estimateSigningDriftUsd(lastSnapshot, finalizePrice) -> number`: `buildLpValuation(lastSnapshot).valueAt(finalizePrice) − Number(lastSnapshot.currentValueUsd)`. Devuelve 0 si la valoración no es posible (snapshot sin liquidez, precio no finito).
  - `summarizeCoverage(rebalances, { openedAt, closedAt, now }) -> { adjustments, openQty, lastQty, minPct, maxPct, avgPct }`: recibe filas de `protected_pool_delta_rebalance_log` mapeadas (`createdAt`, `actualQtyAfter`, `targetQtyAfter`). El % es `actualQtyAfter / targetQtyAfter × 100`, y `avgPct` se pondera por el tiempo que estuvo vigente cada fila dentro del intervalo.

- [ ] **Step 1: Write the failing tests**

```js
test('subtractAccounting: tramo = acumulado - baseline y el neto se recalcula', () => {
  const base = { lpFeesUsd: 10, gasSpentUsd: 1, hedgeRealizedPnlUsd: 5, priceDriftUsd: -2, lpCount: 1 };
  const cur  = { lpFeesUsd: 14, gasSpentUsd: 1.5, hedgeRealizedPnlUsd: 3, priceDriftUsd: -6, lpCount: 2 };
  const seg = subtractAccounting(cur, base);
  assert.equal(seg.lpFeesUsd, 4);
  assert.equal(seg.hedgeRealizedPnlUsd, -2);
  assert.equal(seg.lpCount, 1);
  assert.equal(seg.totalNetPnlUsd, recomputeNetPnl(seg).totalNetPnlUsd);
});
test('subtractAccounting: la suma de tramos telescopica es el total', () => {
  const a0 = {}, a1 = { lpFeesUsd: 3, priceDriftUsd: 1 }, a2 = { lpFeesUsd: 7, priceDriftUsd: -4 };
  const s1 = subtractAccounting(a1, a0), s2 = subtractAccounting(a2, a1);
  assert.equal(s1.lpFeesUsd + s2.lpFeesUsd, 7);
  assert.equal(s1.priceDriftUsd + s2.priceDriftUsd, -4);
});
test('classifyCloseReason por lado del precio y por accion', () => {
  const r = { rangeLowerPrice: 2401.9, rangeUpperPrice: 2628.1 };
  assert.equal(classifyCloseReason({ action: 'modify-range', price: 2377.5, ...r }), 'range_exit_below');
  assert.equal(classifyCloseReason({ action: 'rebalance', price: 2700, ...r }), 'range_exit_above');
  assert.equal(classifyCloseReason({ action: 'modify-range', price: 2500, ...r }), 'manual_rerange');
  assert.equal(classifyCloseReason({ action: 'increase-liquidity', price: 2500, ...r }), 'capital_change');
  assert.equal(classifyCloseReason({ action: 'close-keep-assets', price: 2500, ...r }), 'lp_closed');
});
test('estimateSigningDriftUsd es 0 sin valoracion posible', () => {
  assert.equal(estimateSigningDriftUsd({ liquidity: '0' }, 2500), 0);
  assert.equal(estimateSigningDriftUsd(null, 2500), 0);
});
test('summarizeCoverage pondera por tiempo', () => {
  const rows = [
    { createdAt: 0, actualQtyAfter: 0.1, targetQtyAfter: 0.1 },   // 100 % durante 30
    { createdAt: 30, actualQtyAfter: 0.05, targetQtyAfter: 0.1 }, // 50 % durante 70
  ];
  const s = summarizeCoverage(rows, { openedAt: 0, closedAt: 100 });
  assert.equal(s.adjustments, 2);
  assert.equal(s.minPct, 50);
  assert.equal(s.maxPct, 100);
  assert.equal(Math.round(s.avgPct), 65);
});
```

Añade un caso de `estimateSigningDriftUsd` con un snapshot ETH/USDC real tomado de un fixture existente (`server/test/fixtures` o de `terminal-range-policy.test.js`). Comprueba el signo: si el precio baja, un LP con ETH pierde valor.

- [ ] **Step 2: Run** `cd server && node --test test/lp-orchestrator-segments.test.js`. Expected: FAIL (módulo inexistente).
- [ ] **Step 3: Implement** `segments.js` con las firmas de arriba.
- [ ] **Step 4: Run** el mismo comando. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lp-orchestrator): segment accounting math`.

---

### Task 2: Migración 048 y repositorio de tramos

**Files:**
- Create: `server/src/db/migrations/048_lp_orchestrator_segments.sql`
- Create: `server/src/repositories/lp-orchestrator-segment.repository.js`
- Modify: `server/src/repositories/lp-orchestrator.repository.js` (mapear `active_segment_id` → `activeSegmentId`; `appendActionLog` acepta `entry.segmentId`)
- Modify: `server/src/repositories/protected-pool-delta-rebalance.repository.js` (aceptar y guardar `segmentId` al insertar)
- Test: `server/test/lp-orchestrator-segment.repository.test.js` (integración gateada por `SEGMENTS_TEST_DATABASE_URL`, mismo patrón que `cross-chain-plan.repository.test.js`) y un test unitario del `mapRow`

**Interfaces:**
- Produces (repositorio, todos aceptan `executor` opcional como último argumento):
  - `create({ orchestratorId, positionIdentifier, poolAddress, protectedPoolId, policyVersion, openedAt, openPrice, rangeLowerPrice, rangeUpperPrice, openValueUsd, openAmount0, openAmount1, openReason, openTxHashes, baselineAccounting, hedgeBaseline, shadowBaselines, lpBaselineSnapshot, hedgeOpenQty, accuracy='exact' }) -> segment` (asigna `seq = max+1` del orquestador en la misma sentencia)
  - `getActive(orchestratorId) -> segment|null` (status `open` o `closing`)
  - `getById(orchestratorId, segmentId) -> segment|null`
  - `listByOrchestrator(orchestratorId) -> segment[]` (seq desc)
  - `markClosing(segmentId, { at }) -> id|null` (solo desde `open`)
  - `reopen(segmentId) -> id|null` (solo desde `closing`)
  - `close(segmentId, { closedAt, closePrice, closeValueUsd, closeReason, closeTxHashes, accounting, hedgeCloseQty, coverage }) -> id|null` (solo desde `open|closing`)
  - `replaceHistorical(orchestratorId, segments[]) -> void`: borra los tramos **cerrados** del orquestador con `open_reason IN ('deploy','backfill')` (el histórico sembrado por la 048 o un backfill anterior; nunca el tramo vivo) e inserta los dados por delante, renumerando `seq` de todos para mantener el orden temporal. Lo usa la Task 8.
  - El objeto `segment` usa camelCase de todas las columnas del spec más `baselineAccounting`.
- Produces (orquestador): `updateActiveSegment(userId, id, segmentId, executor)` en `lp-orchestrator.repository.js`.

Contenido de la migración (decidido):
- `CREATE TABLE lp_orchestrator_segments` con las columnas del spec (sección «Modelo») más `baseline_accounting_json TEXT NOT NULL`. `UNIQUE (orchestrator_id, seq)`. Índice parcial único `(orchestrator_id) WHERE status IN ('open','closing')`, que garantiza el invariante de un solo tramo vivo.
- `ALTER TABLE lp_orchestrators ADD COLUMN active_segment_id INTEGER REFERENCES lp_orchestrator_segments(id) ON DELETE SET NULL`.
- `ALTER TABLE lp_orchestrator_action_log ADD COLUMN segment_id INTEGER` y `ALTER TABLE protected_pool_delta_rebalance_log ADD COLUMN segment_id INTEGER`, cada una con su índice.
- **Siembra que no cambia el total:** para cada orquestador, un tramo `seq=1`, `status='closed'`, `accuracy='approximate'`, `open_reason='deploy'`, `close_reason='unknown'`, `opened_at=created_at`, `closed_at = now`, `baseline_accounting_json = '{}'` y `accounting_json = accounting_json` del orquestador. Para los `status='active'` con `active_position_identifier`, además un tramo `seq=2`, `open`, `exact`, `open_reason='deploy'`, `baseline_accounting_json = accounting_json` actual, `position_identifier`, `protected_pool_id` y el rango desde `last_evaluation_json`, y se fija `active_segment_id`. Las fechas en ms (`(EXTRACT(EPOCH FROM now())*1000)::bigint`).

- [ ] **Step 1: Write the failing tests:**
  - (a) `mapRow` convierte JSON y numéricos.
  - (b) Integración, gateada: aplica las migraciones `008`, `014`, `016`, `017`, `018` y `048` en un esquema temporal (o toda la carpeta si es más simple). Inserta un orquestador activo con `accounting_json` `{"lpFeesUsd":5}` y aplica la 048. Hay 2 tramos, el `seq=1` lleva `lpFeesUsd: 5` y el `seq=2` tiene baseline 5.
  - (c) `create` de un segundo tramo vivo viola el índice parcial.
  - (d) `markClosing` → `reopen` → `close` respeta las transiciones (devuelve null fuera de orden).
- [ ] **Step 2: Run** `cd server && node --test test/lp-orchestrator-segment.repository.test.js`. Expected: FAIL. Con `SEGMENTS_TEST_DATABASE_URL` sin definir, solo corre (a).
- [ ] **Step 3: Implement** la migración y el repositorio.
- [ ] **Step 4: Run** de nuevo, y además con la base de Docker: `SEGMENTS_TEST_DATABASE_URL=postgres://testbot:<pass>@localhost:<puerto>/testbot` (lee usuario y puerto de `docker-compose.yml`; el test usa un esquema desechable). Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): lp orchestrator segments table (048)`.

---

### Task 3: Estado de decisión limpio al abrir tramo

**Files:**
- Create: `server/src/services/protected-pool-delta-neutral/segment-reset.js`
- Modify: `server/src/services/protected-pool-delta-neutral.service.js` (método `resetForNewSegment`)
- Modify: `server/src/services/uniswap/actions/finalize.js` (`updateProtectionRecords`: invocarlo para `SEGMENT_OPENING_ACTIONS`)
- Test: `server/test/delta-neutral-segment-reset.test.js`

**Interfaces:**
- Consumes: `SEGMENT_OPENING_ACTIONS` (Task 1).
- Produces:
  - `DECISION_STATE_KEYS: readonly string[]` y `resetDecisionStateForNewSegment(strategyState) -> strategyState`. Borra exactamente: `rangeExitPolicyState`, `rangeExitPolicyGate`, `terminalRangePolicyState`, `terminalRangePolicyGate`, `netProfitPolicyState`, `netProfitPolicyGate`, `pendingRotationBudgetIncrement`, `minDwellUntil`, `zoneState`, `lastObservedBoundarySide`, `lastSnapshotPrice`, `lastRebalanceAt`, `nakedExposureSince`, `nakedExposureTier`, `nakedExposureByDesign`, `positionMissingSince`, `positionMissingConsecutiveCount`, `truthPending`, `lastSyntheticInRange`, `nextEligibleAttemptAt`, `cooldownReason`. Pone `shadowSnapshots[p].shadowPolicyState = {}` en cada política y conserva la posición simulada. Fija `pendingForceReason = 'segment_opened'`. Conserva todo lo demás, en particular `lastReconciledFillsAt`, `hedgeRealizedPnlUsd`, `executionFeesUsd`, `slippageUsd`, `fundingAccumUsd`, `fundingAllTimeBaselineUsd`, `policyVersion`, `executionIntent` y `terminalRangeConfig`.
  - `ProtectedPoolDeltaNeutralService#resetForNewSegment(protection) -> Promise<void>`: espera a la evaluación en curso (`this.evaluationLocks.get(id)`) y escribe el estado reiniciado con `repo.updateStrategyState`, sin columnas de decisión. Luego pone `shadowPolicyState = {}` en cada entrada de `this.shadowStates` cuya clave empiece por `${id}:`. El método `evaluateProtection` posterior (lo dispara el orquestador o el tick) encuentra `pendingForceReason`.
- Llamada en `finalize.js`: tras `migratePositionIdentity` y también en la rama sin cambio de identidad si `action` es de capital, `await protectedPoolDeltaNeutralService.resetForNewSegment(await protectedPoolRepo.getById(userId, protection.id))`, solo si `protection.protectionMode === 'delta_neutral'`. El error se registra (`warn`) y no rompe el finalize.

- [ ] **Step 1: Write the failing tests:**
  - `resetDecisionStateForNewSegment` borra cada clave de `DECISION_STATE_KEYS` y conserva los acumuladores (afirmación clave por clave).
  - **Guarda contra claves olvidadas:** un test enumera las claves que `evaluate.js` escribe en `nextState` (lista literal en el test) y exige que cada una esté en `DECISION_STATE_KEYS` o en una lista `KEPT_STATE_KEYS` exportada. Así, una clave nueva obliga a decidir.
  - `resetForNewSegment` espera a una evaluación en curso: un fake `evaluationLocks` con una promesa que resuelve tarde; la escritura ocurre después.
  - Con el arnés de `delta-neutral-rerange-stale-snapshot.test.js`: tras el reset, una `net_profit_v2` con `rotationBudgetCount` agotado del día y `upperExitConfirmed: true` decide `rebalance` sobre el LP nuevo, sin `daily_rotation_budget` ni `upper_rearm_confirming`.
- [ ] **Step 2: Run** `cd server && node --test test/delta-neutral-segment-reset.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** el helper, el método y la llamada en `finalize.js`.
- [ ] **Step 4: Run** el test y `node --test test/delta-neutral-rerange-stale-snapshot.test.js test/range-exit-ciclo-vida.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(hedge): start each segment with clean decision state`.

---

### Task 4: Forzados que no se pierden y `net_profit` con forzado

**Files:**
- Modify: `server/src/services/protected-pool-delta-neutral/evaluate.js`
- Modify: `server/src/services/protected-pool-delta-neutral.service.js` (`_withProtectionEvaluationLock`, rama lock ocupado)
- Modify: `server/src/services/net-profit-policy.service.js`
- Test: `server/test/delta-neutral-pending-force.test.js` (ampliar) y `server/test/net-profit-policy.test.js` (ampliar, o crearlo si no existe)

**Interfaces:**
- Produces: `decideNetProfitV1({ ..., forceRebalance = false })`. Con `forceRebalance` se salta el cerrojo y la confirmación superior, `dwell`, `cooldown`, `fill_cap`, `daily_rotation_budget` y `min_notional` (drift completo, no la parte del 75 %/50 %). Se ajusta a `|delta − actual|` en **una** orden, y si esa orden queda bajo `minOrderNotionalUsd` devuelve `hold` con gate `forced_within_min_notional`.
- En `evaluate.js`, `persistPendingForce(state, { forceReason, forceRebalance }) -> state` (local) se aplica a los estados que se escriben en las salidas tempranas `snapshot_invalid`, `spot_stale` y `metrics_ineligible`. En `snapshot_refresh_pending`, que hoy no escribe estado, se añade una escritura `updateStrategyState` solo con `pendingForceReason`. El lock ocupado en `_withProtectionEvaluationLock` hace lo mismo cuando `options.forceRebalance`.
- La llamada a `decideNetProfitV1` en `evaluate.js` pasa `forceRebalance` y `minOrderNotionalUsd: resolveMinOrderNotionalUsd(activeProtection)`.

- [ ] **Step 1: Write the failing tests:**
  - Por cada una de las cuatro salidas tempranas: evaluar con `forceRebalance: true, forceReason: 'lp_range_changed'` deja `strategyState.pendingForceReason === 'lp_range_changed'`.
  - `decideNetProfitV1` con `forceRebalance` y estado `{ upperExitConfirmed: true, cooldownUntil: now+1e6, rotationBudgetCount: 99, rotationBudgetDay: hoy }` devuelve `rebalance` con `adjustQty === delta − actual` (una sola orden).
  - Con `forceRebalance` y `|delta − actual| × price < minOrderNotionalUsd` devuelve `hold` (`forced_within_min_notional`).
- [ ] **Step 2: Run** `cd server && node --test test/delta-neutral-pending-force.test.js test/net-profit-policy.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** lo mismo y `npm test` en `server/`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(hedge): keep forced re-hedges and honor them under net_profit`.

---

### Task 5: Corte de tramos en el orquestador

**Files:**
- Modify: `server/src/services/lp-orchestrator.service.js` (`recordTxFinalized`, `attachLp`, `_evaluateOne`, `_reconcileActivePosition`/`reconcileOne`; método nuevo `_cutSegment`)
- Modify: `server/test/lp-orchestrator.service.test.js` (repo fake de tramos)
- Test: `server/test/lp-orchestrator-segment-cut.test.js`

**Interfaces:**
- Consumes: Task 1 (todo) y Task 2 (repositorio, inyectado como `deps.segmentRepository`, por defecto el real).
- Produces: `LpOrchestratorService#_cutSegment(orch, { action, closeReason, finalizePrice, txHashes, newSnapshot|null, openReason, executor }) -> { closedSegmentId, openedSegmentId|null }`, que dentro de una transacción hace:
  1. Si hay protección, aplica al acumulado del orquestador el delta del hedge y de las sombras hasta ahora (`applyHedgeStateDelta`, `applyShadowStatesDelta`, igual que `_evaluateOne`) y actualiza `hedgeBaseline`/`shadowBaselines`.
  2. Si cambia el tokenId o la acción es de cierre, suma `estimateSigningDriftUsd(orch.lastEvaluation.poolSnapshot, finalizePrice)` a `priceDriftUsd`.
  3. Cierra el tramo vivo con `accounting = subtractAccounting(acumulado, baseline)`, `closePrice`, `closeValueUsd` (valor de cierre = último valor + deriva) y `coverage` (filas de rebalanceo del intervalo).
  4. Si `newSnapshot`, abre el tramo nuevo con `baselineAccounting = acumulado` (antes de gas y swaps), su apertura (`openPrice = newSnapshot.priceCurrent`, rango, valor, cantidades), `lpBaselineSnapshot = newSnapshot` y `hedgeOpenQty`.
  5. `updateActiveSegment` y `updateAccounting`.
- Orden en `recordTxFinalized` para `SEGMENT_OPENING_ACTIONS ∪ SEGMENT_CLOSING_ACTIONS`: después de la idempotencia y de la verificación, **antes** de `applyTxCostDelta`, `_cutSegment(...)`. El `applyTxCostDelta` existente cae así en el tramo nuevo. En las acciones de cierre no se abre tramo, y el flush de cierre existente se mantiene (el paso 1 ya lo hizo; no duplicar el delta).
- `attachLp` abre el tramo (`openReason`: `create`, `adopt` o `attach` según el llamador) dentro de su transacción actual.
- `_evaluateOne`: si `pool.identifier` difiere del `positionIdentifier` del tramo vivo (o `reconcile.reconciled`), `_cutSegment` con `closeReason: 'unknown'`, `openReason: 'rerange'` y `finalizePrice = pool.priceCurrent`.
- `_evaluateOne` (carry-forward): copiar `priceAtOpen*` e `initialValue*` del snapshot anterior **solo** si `String(prevSnapshot.identifier) === String(pool.identifier)`. Si no, `hasPriceAtOpen` es falso y se hace el scan completo.
- `appendActionLog` en el orquestador pasa `segmentId: orch.activeSegmentId`. El insert de `protected_pool_delta_rebalance_log` resuelve `segment_id` por `protected_pool_id` → orquestador activo → `active_segment_id` (subconsulta en el insert).

- [ ] **Step 1: Write the failing tests** (`lp-orchestrator-segment-cut.test.js`, con los fakes de `lp-orchestrator.service.test.js` más un repo de tramos en memoria):
  - **Caso #57:** tres LPs (`attachLp` → `modify-range` 217346 → `modify-range` 224599). Hay 3 tramos y el 3.º tiene `openPrice` dentro de `[2401.9, 2628.1]`. El `lastEvaluation.poolSnapshot.priceAtOpen` tras la siguiente evaluación no es 2668.73, sino el del LP nuevo.
  - **Gas al tramo nuevo:** el gas de `expected.gasCostUsd = 0.5` aparece en el tramo abierto y no en el cerrado.
  - **Suma:** Σ `subtractAccounting` de los tramos cerrados + el abierto === `orch.accounting` en cada campo numérico.
  - **Foto del hedge:** con `realized 10 / unrealized 4` antes del corte y `realized 10 / unrealized 6` después, el tramo cerrado lleva `+4` no realizado y el nuevo arranca en 0.
  - **Review Focus 1:** llamar dos veces a `recordTxFinalized` con los mismos `txHashes` deja un solo corte.
  - **Review Focus 2:** sin `recordTxFinalized`, `_evaluateOne` con un `pool.identifier` nuevo corta con `close_reason = 'unknown'`.
  - **Review Focus 3:** un orquestador sin `activeProtectedPoolId` corta sin llamar a `readHedgeStateFromProtection`.
  - **Review Focus 5:** `close-keep-assets` cierra (`lp_closed`) sin tramo vivo, y un `attachLp` posterior abre `seq` siguiente. La suma sigue cuadrando.
  - **Una sola orden:** tras un `modify-range` con short 0.0048 y delta nuevo 0.1072, el fake `protectedPoolDeltaNeutralService.evaluateProtection` recibe una sola llamada forzada. Con el ejecutor fake de `execution.js` (ver `protected-pool-delta-neutral.service.test.js`), la secuencia de órdenes es exactamente `[{ side: 'short', size: 0.1024 }]`, sin `closePosition` previo.
- [ ] **Step 2: Run** `cd server && node --test test/lp-orchestrator-segment-cut.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** lo mismo y `npm test` en `server/`. Expected: PASS (actualiza los fakes de los tests existentes si piden `segmentRepository`; inyecta un fake no-op por defecto en esos tests).
- [ ] **Step 5: Commit** `feat(lp-orchestrator): cut segments on LP changes`.

---

### Task 6: «Ajuste en curso»

**Files:**
- Modify: `server/src/routes/lp-orchestrator.routes.js` (`POST /:id/action-started`, body `{ action }` validado contra `SEGMENT_OPENING_ACTIONS ∪ SEGMENT_CLOSING_ACTIONS`)
- Modify: `server/src/schemas/lp-orchestrator.schema.js`
- Modify: `server/src/services/lp-orchestrator.service.js` (`markActionStarted`, y `_evaluateOne` con tramo `closing`)
- Modify: `client/src/features/uniswap-pools/hooks/usePositionActionFlow.js` (opción `onExecuteStarted`, llamada al principio de `handleExecute`, antes de la primera firma)
- Modify: `client/src/pages/UniswapPools/components/PositionActionModal.jsx` (prop `onExecuteStarted` pasada al hook)
- Modify: `client/src/services/api.js` (`lpOrchestratorApi.actionStarted(id, action)`)
- Modify: `client/src/pages/LpOrchestrator/LpOrchestratorPage.jsx` (pasa `onExecuteStarted`)
- Modify: `client/src/pages/LpOrchestrator/components/OrchestratorCard.jsx` (aviso)
- Test: `server/test/lp-orchestrator-segment-closing.test.js`, `client/src/features/uniswap-pools/hooks/usePositionActionFlow.test.js` (ampliar o crear), `client/src/pages/LpOrchestrator/components/OrchestratorCard.test.jsx` (ampliar o crear)

**Interfaces:**
- Produces: `LpOrchestratorService#markActionStarted({ userId, orchestratorId, action }) -> orchestrator`. Pasa el tramo vivo a `closing` (idempotente) y registra un log `kind: 'decision'`, `reason: 'action_started'`.
- `CLOSING_ABANDON_MS = 30 * 60_000` (decisión: el plazo lo deja el spec al builder).
- `_evaluateOne` con tramo `closing`:
  - Mientras la posición vieja está vacía o no aparece, no cuenta para `position_not_found`: devuelve `{ skipped: 'segment_closing' }` antes del contador de ausencias.
  - Si pasaron `CLOSING_ABANDON_MS` desde `closingStartedAt` y la posición vieja **tiene** liquidez, `reopen`.
  - Si está vacía y aparece un tokenId nuevo, corta (Task 5, `unknown`).
- El payload de `GET /lp-orchestrators` y `/:id` incluye `activeSegment: { id, seq, status, openedAt, openPrice, rangeLowerPrice, rangeUpperPrice, closingStartedAt } | null` (en `lp-orchestrator.repository.js`, por join o segunda consulta en `listForUser`/`getById`).
- Tarjeta: con `activeSegment.status === 'closing'`, sustituye el texto de % cubierto por **«Ajuste en curso: la cobertura espera al LP nuevo»**.

- [ ] **Step 1: Write the failing tests:**
  - Servidor: `markActionStarted` pasa a `closing` y es idempotente.
  - Servidor: en `closing` con la posición vacía no hay `position_not_found` tras 3 evaluaciones.
  - **Review Focus 4:** en `closing` con más de 30 min y la posición vieja con liquidez, vuelve a `open`.
  - Cliente: `handleExecute` llama a `onExecuteStarted` antes de `sendTransaction`.
  - Cliente: la tarjeta muestra el texto exacto con `activeSegment.status = 'closing'`.
- [ ] **Step 2: Run** `cd server && node --test test/lp-orchestrator-segment-closing.test.js` y `cd client && npx vitest run src/features/uniswap-pools/hooks src/pages/LpOrchestrator/components/OrchestratorCard.test.jsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** El fallo de `actionStarted` en el cliente solo se registra: nunca bloquea la firma.
- [ ] **Step 4: Run** lo mismo. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lp-orchestrator): show adjustment in progress while signing`.

---

### Task 7: API y sección «Tramos»

**Files:**
- Modify: `server/src/routes/lp-orchestrator.routes.js` (`GET /:id/segments`, `GET /:id/segments/:segmentId`)
- Modify: `server/src/services/lp-orchestrator.service.js` (`listSegments`, `getSegment`)
- Modify: `client/src/services/api.js` (`listSegments`, `getSegment`)
- Create: `client/src/pages/LpOrchestrator/components/SegmentsSection.jsx` + `.module.css` (tokens del tema, claro y oscuro)
- Create: `client/src/pages/LpOrchestrator/components/segmentsSummary.js` (formato puro)
- Modify: `client/src/pages/LpOrchestrator/components/AccountingPanel.jsx` (monta `SegmentsSection` debajo del desglose; en `compact` no)
- Modify: `client/src/pages/LpOrchestrator/components/OrchestratorCard.jsx` (la «Apertura» y la barra usan `activeSegment.openPrice` cuando existe)
- Test: `server/test/lp-orchestrator-segments-api.test.js`, `client/src/pages/LpOrchestrator/components/segmentsSummary.test.js`, `client/src/pages/LpOrchestrator/components/SegmentsSection.test.jsx`, `e2e/orchestrator-segments.spec.js`

**Interfaces:**
- `listSegments(userId, orchestratorId) -> { segments: SegmentSummary[], totals: { sumNetPnlUsd, orchestratorNetPnlUsd, differenceUsd } }`, donde `SegmentSummary = { id, seq, status, accuracy, openedAt, closedAt, rangeLowerPrice, rangeUpperPrice, openPrice, closePrice, openReason, closeReason, accounting, coverage }`. En el tramo vivo, `accounting = subtractAccounting(orch.accounting, baseline)` y `coverage` se calcula al vuelo.
- `getSegment(...) -> SegmentSummary & { events: actionLogEntry[], rebalances: rebalanceRow[] }` (filtrados por `segment_id`).
- Textos (decididos):
  - Motivos: `range_exit_below` «Salió por abajo», `range_exit_above` «Salió por arriba», `manual_rerange` «Ajuste manual», `capital_change` «Cambio de capital», `lp_closed` «LP cerrado», `policy_change` «Cambio de cobertura», `unknown` «Sin registrar».
  - Insignia: «aproximado».
  - Línea de diferencia: «Diferencia de reconstrucción».
- Fila por tramo: `#seq`, fechas, rango, motivo de cierre, P&L neto y % cubierto medio. Al desplegar: el desglose de P&L con los mismos rótulos que `AccountingPanel` y la lista de reajustes del short. A 390 px, la fila apila sus datos en dos líneas.

- [ ] **Step 1: Write the failing tests:**
  - API: la lista viene en orden `seq desc`, con `totals.differenceUsd === 0` en un orquestador sin backfill (la siembra de la 048 cuadra).
  - `segmentsSummary`: devuelve los rótulos exactos de cada motivo.
  - `SegmentsSection`: pinta la insignia «aproximado» y la línea de diferencia solo si es ≠ 0.
  - E2E (escritorio y 390 px, con la API simulada como en `orchestrator-price-at-open.spec.js`): la sección muestra 3 tramos y la «Apertura» de la tarjeta está dentro del rango.
- [ ] **Step 2: Run** `cd server && node --test test/lp-orchestrator-segments-api.test.js` y `cd client && npx vitest run src/pages/LpOrchestrator/components/segments`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** lo mismo y `npx playwright test e2e/orchestrator-segments.spec.js` con Docker levantado (`docker compose up --build -d` desde el worktree, puerto 5174). Expected: PASS.
- [ ] **Step 5: Commit** `feat(lp-orchestrator): segments section in accounting panel`.

---

### Task 8: Reconstrucción histórica

**Files:**
- Create: `server/src/scripts/backfill-orchestrator-segments.js`
- Create: `server/src/services/lp-orchestrator/segment-backfill.js` (puro)
- Test: `server/test/lp-orchestrator-segment-backfill.test.js`

**Interfaces:**
- `buildHistoricalSegments({ orchestrator, actionLog, rebalances, historicalSegment }) -> { segments, differenceUsd }`, puro. `historicalSegment` es el tramo cerrado sembrado por la 048 (`open_reason='deploy'`, `status='closed'`) o, si ya hubo backfill, la suma de los tramos `backfill`:
  - Corta en `attach_lp`, `tx_finalized` de `SEGMENT_OPENING_ACTIONS ∪ SEGMENT_CLOSING_ACTIONS` y `kill_lp`, siempre **antes** de `historicalSegment.closedAt` (el despliegue).
  - Por tramo: `lpFeesUsd`/`priceDriftUsd` = suma de `accountingDelta` de las filas `kind='decision'` del intervalo; `gasSpentUsd`/`swapSlippageUsd` = `accountingDelta` del `tx_finalized` que lo abre; cobertura con `summarizeCoverage`. El P&L del hedge histórico no se puede partir: va a la diferencia.
  - Todos `accuracy='approximate'`, `open_reason='backfill'`.
  - `differenceUsd = historicalSegment.accounting.totalNetPnlUsd − Σ tramos.totalNetPnlUsd`, que se guarda como un tramo más con `close_reason='unknown'`, `open_reason='backfill'` y solo la diferencia en `priceDriftUsd`, rotulado «Diferencia de reconstrucción». Así la suma no cambia.
- Script: `node src/scripts/backfill-orchestrator-segments.js [--orchestrator <id>] [--apply]`. Sin `--apply` imprime por orquestador los tramos y la diferencia (dry-run). Con `--apply` llama a `replaceHistorical` en una transacción por orquestador. Es idempotente: re-ejecutarlo produce el mismo resultado.

- [ ] **Step 1: Write the failing tests:**
  - Un log sintético con `attach_lp`, dos `modify-range` y `kill_lp` produce 3 tramos con los cortes en los instantes correctos.
  - Σ tramos + diferencia === total del tramo histórico.
  - Aplicar dos veces da la misma salida.
  - Las filas posteriores al despliegue se ignoran.
- [ ] **Step 2: Run** `cd server && node --test test/lp-orchestrator-segment-backfill.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** el test y luego el dry-run contra la base local de Docker: `docker exec testbot-server node src/scripts/backfill-orchestrator-segments.js`. Expected: PASS, y en el dry-run una tabla por orquestador sin errores.
- [ ] **Step 5: Commit** `feat(lp-orchestrator): backfill historical segments (dry-run by default)`.

---

### Task 9: Verificación final y documentación

**Files:**
- Modify: `~/ObsidianVault/proyectos/testbotCobertura.md` (sección del 2026-10-23)

- [ ] **Step 1:** `cd server && npm run check` y `cd client && npm run lint && npx vitest run`. Expected: todo verde.
- [ ] **Step 2:** levanta Docker desde el worktree y ejecuta `npm run test:e2e -- e2e/orchestrator-segments.spec.js e2e/lp-orchestrator-responsive.spec.js e2e/orchestrator-price-at-open.spec.js`. Expected: PASS.
- [ ] **Step 3:** aplica la 048 en la base local (`docker exec testbot-server npm run migrate`) y comprueba con `GET /api/lp-orchestrators/:id/segments` que `differenceUsd = 0` en todos los orquestadores locales.
- [ ] **Step 4:** actualiza la nota del vault: qué se construyó, decisiones y cómo correr el backfill en producción (dry-run primero; lo ejecuta el usuario). Commit en `~/ObsidianVault`.
- [ ] **Step 5: Commit** del worktree si quedó algo pendiente.
