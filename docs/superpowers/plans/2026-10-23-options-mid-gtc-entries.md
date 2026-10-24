# Entradas GTC a precio medio, comisiones visibles y nueva GUI de bots — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Las aperturas de los bots por alertas pasan a `LIMIT GTC` al precio medio y se supervisan 10 minutos, en real y en sombra. Las comisiones se ven en cada operación y en el total del bot. La pestaña de trading automatizado gana ayudas visuales en escritorio y móvil.

**Architecture:**
- Una función pura calcula el medio válido.
- El ejecutor real envía las aperturas en GTC al medio. La sombra guarda las entradas pendientes en una tabla propia y una pasada periódica las llena o las hace caducar.
- Cada entrada queda enlazada a su señal para resolverla y apuntar su comisión.
- Una señal contraria cancela la entrada pendiente. En real, la señal se reevalúa cuando la cancelación ya está conciliada, reutilizando la cola de reentradas.
- En el cliente, funciones puras derivan estado, flujo y KPIs, y componentes pequeños los dibujan según la maqueta aprobada.

**Tech Stack:** Node 20 + Express + PostgreSQL 16 (`node --test`), React 18 + Vite (Vitest + Testing Library), Playwright contra Docker.

**Spec:** `docs/superpowers/specs/2026-10-23-options-mid-gtc-entries-design.md`
**Maqueta de GUI:** https://claude.ai/artifact/YY5vaFGLB2F7hxhGC1G5SW (la referencia visual de las tareas 9–11).

## Global Constraints

- Ventana de supervisión: `WINDOW_MS = 10 * 60_000`, la que ya existe en `options-live-execution.service.js`.
- Medio: `(bid + ask) / 2` sobre la rejilla `minPrice + k·tickSize`. Se redondea hacia arriba al comprar y hacia abajo al vender, sin pasar nunca de ask ni de bid. Sin bid o ask > 0, no hay entrada (motivo `no_mid_price`, texto «Sin precio medio válido»).
- Los cierres no cambian: ETH cierra con FOK y los demás con GTC. El TP residente sigue en GTC.
- Las barreras reales no cambian: los dos flags, `enforcePilotEntry` y las comprobaciones de órdenes ajenas y de exposición.
- Ninguna posición real sin fill confirmado por Binance.
- Migración nueva `046_options_mid_gtc_entries.sql`, inocua con los flags apagados.
- Textos de UI en español, en el estilo de la app. Formato numérico es-ES (`fmtNum` o `formatUsdt`).
- UI a 390 px sin scroll horizontal y objetivos táctiles ≥ 44 px.
- E2E con `--config=e2e/playwright-docker.config.js` contra `localhost:5174`.
- Trabajo en el worktree `../testbotCobertura-midgtc`, rama `feat/options-mid-gtc-entries`.

## Review Focus

1. **Entrada real que llena en parte y deja una posición < `minQty`:** el usuario espera un aviso y que el bot no abra más en ese subyacente, sin bloquear los cierres de otras posiciones. Lo cubre la tarea 4, test `partial inoperable fill blocks the underlying`.
2. **Reinicio del servidor con entradas de sombra pendientes:** deben seguir llenándose o caducando tras el arranque, no quedarse colgadas. Lo cubre la tarea 6, test `pending shadow entry survives restart and expires`.
3. **Señal contraria con una entrada real pendiente y `onOpposite=reverse`:** no puede abrirse la nueva dirección antes de que la cancelación y los cierres se concilien. Lo cubre la tarea 5, test `reevaluation waits for canceled entry to be final`.
4. **Spread de un tick:** el medio coincide con ask o bid y la orden se ejecuta como taker. No puede quedar fuera de la rejilla. Lo cubre la tarea 1, test `one-tick spread rounds to the executable side`.
5. **Señal antigua reevaluada mucho después** (cancelación que tarda): igual que los giros, caduca a los 30 minutos con aviso y sin abrir. Lo cubre la tarea 5, test `stale reevaluation expires without opening`.

---

### Task 1: Precio medio válido

**Files:**
- Create: `server/src/services/options/options-mid-price.js`
- Test: `server/test/options-mid-price.test.js`

**Interfaces:**
- Produces: `midLimitPrice({ bid, ask, side, tickSize, minPrice }) → number | null` (`side` es `'BUY'` o `'SELL'`).

- [ ] **Step 1: Write the failing tests**

```js
test('mid on the grid rounds toward the fill', () => {
  assert.equal(midLimitPrice({ bid: 700, ask: 725, side: 'BUY', tickSize: 5, minPrice: 5 }), 715);
  assert.equal(midLimitPrice({ bid: 700, ask: 725, side: 'SELL', tickSize: 5, minPrice: 5 }), 710);
  assert.equal(midLimitPrice({ bid: 700, ask: 720, side: 'BUY', tickSize: 5, minPrice: 5 }), 710);
});
test('one-tick spread rounds to the executable side', () => {
  assert.equal(midLimitPrice({ bid: 700, ask: 705, side: 'BUY', tickSize: 5, minPrice: 5 }), 705);
  assert.equal(midLimitPrice({ bid: 700, ask: 705, side: 'SELL', tickSize: 5, minPrice: 5 }), 700);
});
test('no valid mid without both sides or with a crossed book', () => {
  for (const q of [{ bid: 0, ask: 725 }, { bid: 700, ask: null }, { bid: 730, ask: 725 }]) {
    assert.equal(midLimitPrice({ ...q, side: 'BUY', tickSize: 5, minPrice: 5 }), null);
  }
});
test('works with decimal ticks without float drift', () => {
  assert.equal(midLimitPrice({ bid: 0.6, ask: 0.9, side: 'BUY', tickSize: 0.1, minPrice: 0.1 }), 0.8);
});
```

- [ ] **Step 2:** Run `cd server && node --test test/options-mid-price.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** Opera en enteros escalados por los decimales de `tickSize` y `minPrice`, igual que `priceGrid` en `client/src/pages/Options/manual/ticketMath.js`. Ajusta con `ceil` (BUY) o `floor` (SELL) y acota a `[bid, ask]`. Si falta `tickSize`, devuelve el medio sin ajustar.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(options): mid-price limit on the contract grid`.

### Task 2: Migración y repositorios

**Files:**
- Create: `server/src/db/migrations/046_options_mid_gtc_entries.sql`
- Create: `server/src/repositories/options-shadow-entries.repository.js`
- Modify: `server/src/repositories/options-strategies.repository.js` (señales y bloqueos)
- Modify: `server/src/repositories/options-live-orders.repository.js` (`beginBatch`, cola de reevaluación)
- Test: `server/test/options-shadow-entries.repository.test.js`; ampliar `server/test/options-live-orders.repository.test.js`

**Interfaces:**
- **Migración:**
  - Tabla `options_shadow_entries` con:
    - `id`, `strategy_id`, `user_id`, `auto_signal_id` (null), `alert_event_id` (null);
    - `symbol`, `side`, `option_type`, `quantity`, `limit_price`, `spot`, `deadline_at`;
    - `status` con CHECK en `('pending','filled','expired','canceled')`;
    - `created_at`, `resolved_at`;
    - índice parcial `WHERE status='pending'`.
  - `options_auto_signals`: añade `fees_usdt NUMERIC NULL` y `fees_estimated BOOLEAN NOT NULL DEFAULT FALSE`.
  - `options_live_batches`: añade `auto_signal_id BIGINT NULL`.
  - `options_live_reentries`: añade `kind VARCHAR(20) NOT NULL DEFAULT 'reentry' CHECK (kind IN ('reentry','reevaluate'))` y `wait_order_ids BIGINT[] NOT NULL DEFAULT '{}'`.
- **Shadow repo:**
  - `insertEntry({ strategyId, userId, autoSignalId, alertEventId, symbol, side, optionType, quantity, limitPrice, spot, deadlineAt, createdAt }) → entry`
  - `listPending({ strategyId? } = {}) → entry[]`
  - `resolveEntry(id, status, at) → entry | null` (solo pasa a final desde `pending`)
  - `cancelEntries(ids, at) → entry[]`
- **Strategies repo:**
  - `resolveAutoSignal(id, { decision, detail, feesUsdt, feesEstimated }) → signal | null`. A diferencia de `finishAutoSignal`, sobrescribe `pending` y también el `opened` provisional.
  - `setAutoSignalFees(id, { feesUsdt, feesEstimated })`
  - `mapAutoSignal` expone `feesUsdt` y `feesEstimated`.
  - `setUnderlyingBlock(strategyId, underlying, { reason, at })` y `clearUnderlyingBlock(strategyId, underlying)`. Se guardan en `state.blockedUnderlyings[U] = { reason, at }`.
- **Live orders repo:**
  - `beginBatch({..., autoSignalId })` guarda `auto_signal_id`.
  - `requestCancelEntries({ userId, strategyId, underlying }) → orderIds[]`: marca `cancel_requested` en las órdenes `open` no finales del subyacente.
  - `queueSignalReevaluation(strategy, signal, orderIds) → boolean`: inserta `kind='reevaluate'`, `wait_order_ids`. Usa `ON CONFLICT (strategy_id, alert_event_id) DO NOTHING`.
  - `listPendingReentries` devuelve `kind`. Para `reevaluate`, `ready` = ninguna orden de `wait_order_ids` no final.
  - `batchEntryOutcome(batchId) → { autoSignalId, requested, filled, avgPrice, feesUsdt, symbol, side } | null`, a partir de `options_live_fills`.

- [ ] **Step 1:** Tests del repo de sombra contra la BD de test, con el patrón de `options-live-orders.repository.test.js`:
  - `insertEntry → listPending` la devuelve;
  - `resolveEntry` dos veces solo resuelve la primera;
  - `cancelEntries` ignora las no pendientes.
  Tests del repo de órdenes:
  - `queueSignalReevaluation` no es `ready` mientras una orden de espera no es final y sí lo es al finalizarla;
  - `batchEntryOutcome` suma 0,10 + 0,05 a precio medio ponderado y con comisiones sumadas.
- [ ] **Step 2:** Run `cd server && node --test test/options-shadow-entries.repository.test.js test/options-live-orders.repository.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implementar migración y funciones.
- [ ] **Step 4:** Run the same command. Expected: PASS. Aplicar la migración en Docker con el migrador del servidor y comprobar con `\d options_shadow_entries`.
- [ ] **Step 5:** Commit `feat(options): storage for shadow entries, signal fees and reevaluations`.

### Task 3: Aperturas reales GTC al medio

**Files:**
- Modify: `server/src/services/options/options-live-execution.service.js:51-58` (`orderTimeInForce`) y el chequeo de FOK parcial (~495)
- Modify: `server/src/services/options/options-strategy-runner.service.js` (`executeLive`, rama `open`)
- Test: `server/test/options-live-execution.test.js`, `server/test/options-strategy-runner.test.js`

**Interfaces:**
- Consumes: `midLimitPrice` (Task 1).
- Produces:
  - `orderTimeInForce(order)` devuelve `'GTC'` para cualquier `action === 'open'`, y `'FOK'` solo para cierres ETH que no son TP.
  - El `limitPrice` de una apertura real es el medio de la cotización fresca, con `tickSize` y `minPrice` de esa cotización.

- [ ] **Step 1: Failing tests.**
  - `ETH open is GTC`: `orderTimeInForce({ symbol: 'ETH-261031-2500-C', action: 'open' }) === 'GTC'`; el cierre ETH sigue siendo `'FOK'`.
  - `live open sends the mid`: con un mercado falso bid 700 / ask 725 / tick 5, `placeOrder` recibe `price: 715` y `timeInForce: 'GTC'`.
  - `live open without bid is skipped`: no hay `placeOrder` y se registra `skip` con reason `no_mid_price`.
  - `capital revalidated at mid`: el presupuesto alcanza a 715 pero no a 725, y la orden sale.
  - `partial GTC open is not an anomaly`: un fill de 0,10 de 0,20 en apertura GTC finaliza la orden con `processedQty 0.1`, sin error.
- [ ] **Step 2:** Run `cd server && node --test test/options-live-execution.test.js test/options-strategy-runner.test.js`. Expected: los tests nuevos FAIL.
- [ ] **Step 3: Implementar.**
  - En `executeLive`, si `action.type === 'open'`, sustituir `quotes[i].price` por `midLimitPrice({ bid, ask, side, tickSize, minPrice })` de `quotes[i].quote`. Si es null, `recordOutcome(... 'skip', 'no_mid_price', 'Sin precio medio válido')` y return.
  - La revalidación de capital y prima que ya existe usa ese precio.
  - Ajustar los tests ETH existentes que esperaban FOK en aperturas (`options-eth-pilot-integrated-simulation`, `options-gtc-pilot-readiness`) a la nueva regla.
- [ ] **Step 4:** Run `cd server && npm test`. Expected: PASS completo.
- [ ] **Step 5:** Commit `feat(options): live bot entries rest as GTC at the mid price`.

### Task 4: Enlace señal → entrada real, resolución y bloqueo por resto inoperable

**Files:**
- Modify: `server/src/services/options/options-auto-trading.service.js` (`processBot` añade `signalId: claim.id` a la señal)
- Modify: `server/src/services/options/options-strategy-runner.service.js` (pasa `autoSignalId` a `liveExecutor.submit` y marca la comisión estimada)
- Modify: `server/src/services/options/options-live-execution.service.js` (`submit` → `beginBatch({ autoSignalId })`; tras `finishOrder` de una apertura con lote completado → resolver)
- Test: `server/test/options-live-execution.test.js`, `server/test/options-auto-trading.service.test.js`

**Interfaces:**
- Consumes: `batchEntryOutcome`, `resolveAutoSignal`, `setAutoSignalFees`, `setUnderlyingBlock` (Task 2), `isOrderableRemainder` y `matchesStep` (existentes).
- Produces: `OptionsLiveExecution.resolveEntrySignal(order)`, que resuelve con estos textos:
  - **Completa:** `opened`, detalle «Real: Compra 0,35 BTC-…-C a 712 · comisión 7,14 USDT».
  - **Parcial:** `opened` con « · parcial: 0,10 de 0,35».
  - **Sin fills:** `ignored` con «Real: Entrada sin ejecutar en 10 min», o «… cancelada por señal contraria» si `cancel_requested`.
  - En todos los casos se fija `fees_usdt` real y `fees_estimated=false`.

- [ ] **Step 1: Failing tests.**
  - `signal resolves to opened with real fee`.
  - `unfilled entry resolves as not executed`.
  - `pending signal shows estimated fee`: al enviar, la señal tiene `feesUsdt = tradeFee(...)` y `feesEstimated = true`.
  - `partial inoperable fill blocks the underlying`: un fill de 0,005 con `minQty` 0,01 llama a `setUnderlyingBlock(strategyId, 'ETH', { reason })`, envía un aviso de Telegram con `claimIncidentNotification` y **no** marca la orden en atención, para no bloquear otros lotes.
- [ ] **Step 2:** Run `cd server && node --test test/options-live-execution.test.js test/options-auto-trading.service.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implementar. Resolver solo cuando `finishOrder` deja el lote `completed` y `batch.auto_signal_id` no es null.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(options): resolve bot signals from live entry fills, with fees`.

### Task 5: Pendientes en el template, señal contraria y reevaluación

**Files:**
- Modify: `server/src/services/options/templates/alert-signal.js` (`evaluate`)
- Modify: `server/src/services/options/options-strategy-runner.service.js` (contexto `pendingEntries` y `blockedUnderlyings`; acción `cancel_entries`; `reevaluateSignal`)
- Modify: `server/src/services/options/options-live-execution.service.js` (`processDeferredReentries` por `kind`)
- Test: `server/test/options-alert-signal.template.test.js`, `server/test/options-strategy-runner.test.js`, `server/test/options-reverse-repository.test.js`

**Interfaces:**
- **Contexto de `evaluate`:**
  - `pendingEntries: [{ id, direction: 'bullish' | 'bearish' }]`, solo del subyacente y modo evaluados (sustituye a `pendingOpens`).
  - `blockedUnderlyings: { [U]: { reason } }`.
- **Acción nueva:** `{ type: 'cancel_entries', reason: 'opposite_signal', ids: number[], reevaluate: boolean, detail }`. `reevaluate` es true en `mode === 'live'`.
- **Runner:** `reevaluateSignal(strategyId, signal) → { status }` ejecuta `runStrategy` solo en `live`; añadir la opción `liveOnly` a `runStrategy`.
- **Orden de `evaluate` con señal:**
  1. Subyacente bloqueado → `skip('underlying_blocked', 'Resto no operable en ETH: revísalo y desbloquéalo')`.
  2. Hay pendientes contrarias:
     - en `live`, devolver solo `[cancel_entries(reevaluate: true)]`;
     - en `shadow`, `cancel_entries(reevaluate: false)` y continuar como si no hubiera pendientes, siguiendo `onOpposite` con las posiciones contrarias.
  3. Hay pendientes en el mismo sentido → `skip('underlying_busy', …)` como hoy.

- [ ] **Step 1: Failing tests.**
  - Template: `opposite pending entry in live only cancels and reevaluates`.
  - Template: `opposite pending entry in shadow cancels then reverses`, con `onOpposite: 'reverse'` y sin posiciones → `[cancel_entries, open]`.
  - Template: `blocked underlying skips`.
  - Runner: `cancel_entries live requests cancel and queues reevaluation`.
  - Repo y ejecutor: `reevaluation waits for canceled entry to be final`.
  - Ejecutor: `stale reevaluation expires without opening` (> 30 min, mismo aviso que el giro caducado).
- [ ] **Step 2:** Run `cd server && node --test test/options-alert-signal.template.test.js test/options-strategy-runner.test.js test/options-reverse-repository.test.js`. Expected: FAIL.
- [ ] **Step 3: Implementar.** La dirección de una entrada se deriva con la función inversa de `legFor` sobre `side` y el tipo de su símbolo. Reutilizar `positionDirection` si sirve.
- [ ] **Step 4:** Run the same command, then `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(options): opposite signal cancels pending bot entries`.

### Task 6: Sombra con entradas pendientes

**Files:**
- Modify: `server/src/services/options/options-strategy-runner.service.js`:
  - `executeShadow`: si la acción es una apertura de `alert_signal`, crea la entrada pendiente.
  - nuevo `processShadowEntries()`, llamado en `tick()` y en el bucle de conciliación de `start()`.
- Test: `server/test/options-strategy-runner.test.js`, `server/test/options-simulated-signals.test.js`

**Interfaces:**
- Consumes: `midLimitPrice` (Task 1), shadow repo (Task 2), `resolveAutoSignal` (Task 2).
- Produces:
  - `processShadowEntries() → { filled, expired }`.
  - El llenado reutiliza `book(strategy, 'shadow', action, filled, ctx)` con `filled[i].price = limitPrice` y `fee = tradeFee(...)`. Así entra también el objetivo ATR.
  - `decide()` de auto-trading devuelve `pending` para estas entradas con «Sombra: Orden LIMIT al medio, esperando ejecución».

- [ ] **Step 1: Failing tests.**
  - `shadow entry fills when ask reaches the limit`: compra a 715, la cotización pasa a ask 714 y queda una posición a 715. La señal se resuelve `opened` con `feesEstimated: true`.
  - `shadow entry expires after 10 min`: queda `expired` y la señal pasa a `ignored` con «Sombra: Entrada sin ejecutar en 10 min».
  - `pending shadow entry survives restart and expires`: nuevo runner con el mismo repo y `now` pasado el plazo → caduca.
  - `pending shadow entry blocks a same-direction signal` → `underlying_busy`.
  - `"Probar señal" (simulate) uses the same pending flow`.
- [ ] **Step 2:** Run `cd server && node --test test/options-strategy-runner.test.js test/options-simulated-signals.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implementar con la cotización fresca (`quoteFor(symbol, { fresh: true })`). Condiciones de llenado: `BUY` si `ask > 0 && ask <= limit`; `SELL` si `bid >= limit`.
- [ ] **Step 4:** Run `cd server && npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(options): shadow entries wait at the mid like live ones`.

### Task 6b: Desglose de comisiones (entrada, salida, ejercicio)

El usuario aprobó la maqueta con el desglose. Hoy solo existe el total `fees_usdt` por posición.

**Files:**
- Create: `server/src/db/migrations/047_options_position_fee_breakdown.sql`
- Modify: `server/src/repositories/options-strategies.repository.js` (`insertPosition`, `closePosition`, `mapPosition`)
- Modify: `server/src/repositories/options-live-orders.repository.js` (`applyTrade`: apertura, cierre total y cierre parcial con reparto proporcional)
- Modify: `server/src/services/options/options-strategy-runner.service.js` (`book` y `settleExpired`)
- Modify: `server/src/services/options/options-live-settlement.service.js` (ejercicio real)
- Modify: `server/src/services/options/options-strategies.service.js` (`kpisFor`)
- Test: `server/test/options-strategy-runner.test.js`, `server/test/options-live-orders.repository.test.js`, `server/test/options-live-settlement.test.js`, `server/test/options-strategies.usage.test.js`

**Interfaces:**
- **Migración:** `options_strategy_positions` añade `entry_fee_usdt`, `exit_fee_usdt` y `exercise_fee_usdt`, todas `NUMERIC NULL`.
  - Backfill: en las posiciones abiertas, `entry_fee_usdt = fees_usdt`.
  - Las cerradas históricas se quedan en NULL, porque no se puede repartir con fiabilidad.
- **Invariante:** en filas nuevas, `fees_usdt = entry + exit + exercise`.
- **`kpisFor`** añade `feeBreakdown: { entryUsdt, exitUsdt, exerciseUsdt, unallocatedUsdt }`.
  - `unallocatedUsdt` es la suma de `fees_usdt` de las filas sin desglose.
  - La UI lo muestra como «sin desglose (histórico)» solo si es > 0.

- [ ] **Step 1: Failing tests.**
  - `shadow open+close splits entry and exit fees`.
  - `shadow expiry books exercise fee`.
  - `live partial close allocates entry fee proportionally and keeps the breakdown summing to fees_usdt`.
  - `kpis feeBreakdown sums components and reports unallocated history`.
- [ ] **Step 2:** Run `cd server && node --test test/options-strategy-runner.test.js test/options-live-orders.repository.test.js test/options-live-settlement.test.js test/options-strategies.usage.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Run `cd server && npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(options): fee breakdown per position (entry, exit, exercise)`.

### Task 7: API para la GUI

**Files:**
- Modify: `server/src/services/options/options-strategies.service.js` (`get`)
- Modify: `server/src/services/options/options-auto-trading.service.js` (`signalDto`, `listBots`, `unblockUnderlying`)
- Modify: `server/src/routes/options-auto-bots.routes.js` (ruta `POST /:id/unblock`, body `{ underlying }`)
- Modify: `client/src/services/api.js` (`optionsApi.unblockAutoBot(id, underlying)`)
- Test: `server/test/options-auto-bots.routes.test.js`, `server/test/options-strategies.usage.test.js`

**Interfaces:**
- **`get(userId, id)`** añade:
  - `pendingEntries: [{ id, mode, symbol, side, quantity, executedQty, limitPrice, bid, ask, deadlineAt, feesEstUsdt }]`, con sombra y real;
  - `blockedUnderlyings`;
  - `kpis[mode].feesPctOfPremium` (`feesUsdt / premiumUsdt × 100` o null) y `kpis[mode].feeBreakdown` (Task 6b);
  - `equity` por modo, que ya existe.
- **`listBots`** añade por bot:
  - `pnlSeries: number[]` (P&L acumulado diario de 30 días, del modo del bot);
  - `feesUsdt`;
  - `pendingEntry: { deadlineAt } | null`;
  - `blocked: boolean`.
- **`signalDto`** añade `feesUsdt` y `feesEstimated`.

- [ ] **Step 1:** Tests de rutas:
  - `GET /:id` incluye `pendingEntries` con `deadlineAt`;
  - `POST /:id/unblock` limpia el bloqueo y da 400 con un subyacente que no es del bot;
  - `GET /:id/signals` trae `feesUsdt`.
- [ ] **Step 2:** Run `cd server && node --test test/options-auto-bots.routes.test.js test/options-strategies.usage.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(options): expose pending entries, fees and blocks for the bots UI`.

### Task 8: Modelo de vista del cliente

**Files:**
- Modify: `client/src/pages/Options/auto/botView.js`, `client/src/pages/Options/auto/botActivity.js`
- Test: `client/src/pages/Options/auto/botView.test.js`, `client/src/pages/Options/auto/botActivity.test.js`

**Interfaces:**
- **`botStatus(bot, detail, now) → { kind, title, detail, deadlineAt?, remainingMs?, progress? }`.**
  - `kind` puede ser `'blocked'`, `'pending'`, `'position'`, `'waiting'` o `'paused'`, con esa prioridad.
  - `progress` es `remainingMs / 600000`, en el rango 0–1.
- **`flowSteps(bot) → [{ key: 'signal' | 'contract' | 'entry' | 'exit', title, subtitle }]`.**
  - Textos según la maqueta. Para la banda ATR, la salida es «TP banda ATR (GTC)».
- **`feeSummary(kpis) → { total, pct, label, parts: [{ key, label, usdt }] }`**, con label «4,6 % de la prima operada» y `parts` en el orden entrada, salida, ejercicio y, solo si es > 0, «sin desglose (histórico)».
- **`ladder(entry) → { bidPct, midPct, askPct, savingPerContract }`.**
- **`normalizeSignal`** añade `feesUsdt` y `feesEstimated`, y **`signalFeeText(signal)`** devuelve «Comisión 4,08 USDT», «Comisión est. 7,14 USDT» o null.

- [ ] **Step 1:** Tests con los valores de la maqueta:
  - `botStatus` con una entrada pendiente a 6:12 → `kind 'pending'`, `progress ≈ 0.62`;
  - con un bloqueo y una posición a la vez → `'blocked'`;
  - `signalFeeText({ feesUsdt: 7.14, feesEstimated: true }) === 'Comisión est. 7,14 USDT'`;
  - `feeSummary({ feesUsdt: 31.85, premiumUsdt: 690 }).pct ≈ 4.6`.
- [ ] **Step 2:** Run `cd client && npx vitest run src/pages/Options/auto`. Expected: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(options): view model for bot status, flow and fees`.

### Task 9: Componentes visuales (escritorio)

**Files:**
- Create in `client/src/pages/Options/auto/visual/`:
  - `BotFlow.jsx`, el flujo de 4 pasos;
  - `BotNowStrip.jsx`, la franja de estado con `CountdownRing` y la escalera bid/medio/ask, refrescada cada segundo con `setInterval` y sin timer en `paused` o `waiting`;
  - `KpiCards.jsx`: P&L con curva real frente a sombra, anillo de acierto, comisiones con barra, presupuesto con barra usado/reservado;
  - `PositionRange.jsx`, la barra stop–entrada–ahora–TP reutilizando `rangePct`;
  - `SignalsTimeline.jsx`;
  - `Sparkline.jsx`;
  - `visual.module.css`.
- Modify: `BotDetail.jsx`, `BotActivity.jsx`, `SignalsFeed.jsx`, `BotList.jsx`, `AutoTradingTab.module.css`
- Test: `client/src/pages/Options/auto/visual/visual.test.jsx`; ajustar `AutoTradingTab.test.jsx`, `BotActivity.test.jsx` y `SignalsFeed.test.jsx`

**Interfaces:**
- Consumes: Task 8.
- Cada componente recibe datos ya derivados y no llama a la API.
- Los SVG llevan `aria-label` con el valor.
- `prefers-reduced-motion` desactiva el pulso del punto «Real».

- [ ] **Step 1: Tests.**
  - `BotNowStrip` muestra «Entrada pendiente» y «6:12».
  - `SignalsTimeline` muestra «Comisión est. 7,14 USDT».
  - `BotList` muestra el punto de estado con `title="Real"` y el chip «Entrada 6:12».
  - Botón «Desbloquear ETH» en el estado `blocked` → llama a `optionsApi.unblockAutoBot`.
- [ ] **Step 2:** Run `cd client && npx vitest run src/pages/Options`. Expected: FAIL.
- [ ] **Step 3:** Implementar según la maqueta, con los tokens de `styles/tokens.css` y colores semánticos verde/rojo/ámbar/índigo. Comprobar el tema claro de la app.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(options): visual bot detail — flow, live status, KPIs, position range, timeline`.

### Task 10: Móvil

**Files:**
- Modify: `BotDetail.jsx` (rama `mobile`), `AutoTradingTab.jsx` (lista móvil y banner de entrada pendiente), `AutoTradingTab.module.css`
- Test: `AutoTradingTab.test.jsx` (móvil)

**Interfaces:**
- Consumes: componentes de la Task 9 con la prop `compact`.
- **Orden en la ficha móvil:** estado → KPIs 2×2 → posición → flujo → cronología.
- **Lista móvil:** banner de entrada pendiente sobre las tarjetas; cada tarjeta con sparkline y comisiones.

- [ ] **Step 1:** Test móvil: la ficha muestra, en este orden, «Entrada pendiente», el KPI «Comisiones» y la cronología.
- [ ] **Step 2:** Run `cd client && npx vitest run src/pages/Options/auto`. Expected: FAIL.
- [ ] **Step 3:** Implementar. Objetivos ≥ 44 px y sin desbordar a 390 px.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(options): mobile bot list and detail with visual status`.

### Task 11: E2E, documentación y cierre

**Files:**
- Modify: `e2e/options-module.spec.js` (mock con `pendingEntries`, `feesUsdt` y `pnlSeries`), `e2e/options-auto-bots.spec.js`
- Modify: `docs/runbooks/binance-options-live-readiness.md`, `docs/runbooks/eth-gtc-supervised-pilot.md` (las aperturas ETH pasan a GTC al medio; los cierres siguen en FOK)
- Modify: `~/ObsidianVault/proyectos/testbotCobertura.md`

- [ ] **Step 1:** E2E en escritorio (1400 px) y móvil (390 px):
  - se ve «Entrada pendiente» con cuenta atrás;
  - el KPI de comisiones;
  - una señal con «Comisión»;
  - `horizontalOverflow === 0`;
  - capturas en `test-results/options-auto-visual-{desktop,mobile}.png`.
- [ ] **Step 2:** Run `npx playwright test --config=e2e/playwright-docker.config.js e2e/options-module.spec.js e2e/options-auto-bots.spec.js`. Expected: PASS, salvo los fallos ya conocidos (el FAB tapado por «Logs» y el filtro «Operadas»), que se anotan.
- [ ] **Step 3:** Run `cd server && npm test && cd ../client && npx vitest run && npx eslint src --ext .js,.jsx && npx vite build`. Expected: todo verde.
- [ ] **Step 4:** Actualizar los runbooks y la nota del vault.
- [ ] **Step 5:** Commit `docs(options): runbooks and e2e for mid-price GTC entries`.
