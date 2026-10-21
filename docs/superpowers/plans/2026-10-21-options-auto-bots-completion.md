# Bots de opciones por alertas: completar el módulo · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la pestaña Opciones › Trading automatizado permita ver, controlar, probar y dimensionar un bot sin salir de ella, de modo que sea seguro ponerlo en Real.

**Architecture:** Seis fases, cada una se integra y despliega por separado y en orden: A (visibilidad), B (controles manuales), B2 (venta por banda ATR, Tasks 13–15), C (detalle fiel a la configuración y extras), D (backtest de bots con el historial de alertas), E (presupuesto por fracciones y filtros de entrada). El servidor ya devuelve casi todo lo de la fase A en `GET /options/strategies/:id`; el trabajo es sobre todo de UI. Los controles manuales reutilizan la ruta de ejecución del runner (`executeShadow` / `executeLive` bajo `withLock`) en lugar de crear otra.

**Tech Stack:** Node/Express + PostgreSQL 16 (`node --test`), React 18 + Vite (`vitest`), Playwright contra Docker.

**Spec:** `docs/superpowers/specs/2026-10-15-alert-auto-trading-design.md` (bot v1) y `docs/superpowers/specs/2026-10-15-options-auto-trading-v2-decisions.md` (fase E). El análisis de huecos de 2026-10-21 (conversación) es la fuente de las fases A–D.

## Global Constraints

- Trabajar en un **git worktree** propio (`superpowers:using-git-worktrees`); otras sesiones usan el checkout principal. No cambiar de rama allí.
- Toda UI nueva es **mobile-first**: se diseña y prueba a 390 px (detalle a pantalla completa en móvil, zonas táctiles ≥ 44 px) además de escritorio.
- Textos de UI en español, con el mismo tono que el resto del módulo.
- Las E2E de Playwright corren contra **Docker en `localhost:5174`**.
- Nada envía órdenes reales en tests: `OPTIONS_LIVE_TRADING_ENABLED` sigue sin activarse; el ejecutor real se inyecta como doble.
- No tocar el experimento `OPTIONS_ETH_SYNTHETIC_TP_EXPERIMENT` ni el flujo de TP GTC residente (los TP parciales en `attention` son diseño deliberado).
- Migraciones nuevas numeradas desde `042_`.
- Comandos: servidor `npm --prefix server test` y `npm --prefix server run lint`; cliente `npm --prefix client test` y `npm --prefix client run lint`; E2E `npx playwright test <spec>`.
- `AutoTradingTab.test.jsx › nuevo bot: valida…` es inestable conocido. Si falla solo bajo carga, no es regresión de este plan; no ampliar ese test.

## Review Focus

1. **Cierre manual de un bot en Real con TP residente**: debe pedir la cancelación del TP (camino `requestProtectedExit`) y quedar como «salida pendiente», nunca mandar un SELL que compita con el TP. → test en Task 5.
2. **Doble clic / dos pestañas en «Cerrar todo»**: el segundo cierre no puede duplicar órdenes ni cerrar dos veces en sombra. → test en Task 5 (dos llamadas concurrentes, una sola orden/cierre).
3. **Señal simulada en un bot en Real**: debe operar solo el libro de sombra y quedar marcada como simulada en el registro; jamás abrir en Binance. → test en Task 6.
4. **Backtest con alertas sin disparos en el rango**, o con disparos de otro subyacente: resultado vacío explicado, no error 500 ni operaciones inventadas. → test en Task 9.
5. **Objetivo por banda ATR recalculado por error**: tras un reinicio o en cada ciclo, el precio de venta debe seguir siendo el fijado al llenarse. → test en Task 14.
6. **Spot ya más allá de la banda al llenarse**: el objetivo nunca puede quedar ≤ precio de compra. → test en Task 13.
7. **Presupuesto con órdenes pendientes**: una señal mientras hay una entrada LIMIT viva solo puede usar lo que queda tras reservar la pendiente. → test en Task 11.

---

## Fase A · Ver qué tiene el bot

### Task 1: El detalle del bot trae órdenes pendientes y operaciones cerradas con motivo

**Files:**
- Create: `server/src/db/migrations/042_options_position_close_reason.sql`
- Modify: `server/src/repositories/options-strategies.repository.js` (`mapPosition`, `closePosition`)
- Modify: `server/src/services/options/options-strategy-runner.service.js` (`book`, `settleExpired`)
- Modify: `server/src/services/options/options-strategies.service.js` (`get`)
- Test: `server/test/options-strategies.service.test.js` (añadir casos), `server/test/options-strategy-runner.test.js` o el test existente del runner

**Interfaces:**
- Produces: `GET /options/strategies/:id` para bots `alert_signal` añade
  - `pendingOrders: [{ id, purpose, action, symbol, side, price, quantity, executedQty, status, cancelRequested, createdAt, deadlineAt, error }]`: todas las órdenes reales con `status !== 'final'` (cualquier `purpose`), máx. 50. `takeProfitOrders` se mantiene igual por compatibilidad.
  - `closedPositions: [{ id, mode, symbol, side, quantity, entryPrice, exitPrice, openedAt, closedAt, pnlUsdt, feesUsdt, closeReason }]`: las 50 más recientes por `closedAt` desc.
- Produces: `repo.closePosition(id, { exitPrice, closedAt, pnlUsdt, feesUsdt, closeReason = null })`; `mapPosition` expone `closeReason`.

- [ ] **Step 1:** Migración `042`: `ALTER TABLE options_strategy_positions ADD COLUMN IF NOT EXISTS close_reason VARCHAR(40);`
- [ ] **Step 2: Tests que fallan**
  - Servicio: `get()` de un bot con una orden `queued` de entrada y otra `final` → `pendingOrders` tiene solo la `queued`, con `price === limitPrice` y `executedQty === processedQty`.
  - Servicio: dos posiciones cerradas en distintos instantes → `closedPositions[0]` es la más reciente; una estrategia que no es `alert_signal` no trae `pendingOrders`.
  - Runner: cerrar en sombra con acción `{ reason: 'stop_loss' }` → `closePosition` recibe `closeReason: 'stop_loss'`; `settleExpired` → `closeReason: 'expiry'`.
- [ ] **Step 3:** Ejecutar `npm --prefix server test` → FAIL en los casos nuevos.
- [ ] **Step 4:** Implementar. En el cierre real que hace el reconciliador de `options-live-execution.service.js`, pasar `closeReason` si la orden lo conoce; si no, se queda `null` (la UI mostrará «—»).
- [ ] **Step 5:** `npm --prefix server test` → PASS. Lint.
- [ ] **Step 6:** Commit `feat(options): bot detail exposes pending orders and closed trades with reason`.

### Task 2: Vistas puras de posiciones, órdenes, uso de límites y operaciones

**Files:**
- Create: `client/src/pages/Options/auto/botActivity.js`
- Test: `client/src/pages/Options/auto/botActivity.test.js`

**Interfaces:**
- Consumes: forma de Task 1 más `positions`, `usage`, `limits`, `params`, `equity` que ya devuelve el detalle.
- Produces:
  - `openPositionRows(detail, mode) → [{ id, symbol, sideLabel, quantity, entry, mark, pnlUsdt, pnlPct, tpPrice, stopPrice, hoursToExpiry, tone }]`. `mode` = `'live'` si el bot está en Real, si no `'shadow'`. `tpPrice`/`stopPrice` se calculan con `takeProfitPct`/`stopLossPct` sobre `entry` (en `volatility` se usa `takeProfitTarget.price` si existe; si no, `null`).
  - `pendingOrderRows(detail) → [{ id, kindLabel, symbol, sideLabel, price, filled: '0,005 / 0,01', status, statusTone, expiresIn, needsAttention }]`. `kindLabel`: `take_profit` → «TP residente», `action==='open'` → «Entrada», resto → «Salida».
  - `usageRows(bot) → [{ label, used, max, pct }]` para posiciones abiertas, operaciones de hoy, margen usado y pérdida del día (de `bot.usage` y `bot.params`/`bot.limits`).
  - `closedTradeRows(detail, mode) → [{ id, symbol, openedAt, closedAt, entry, exit, pnlUsdt, reasonLabel }]` con `REASON_LABEL = { take_profit: 'Toma de ganancia', take_profit_volatility: 'TP por volatilidad', stop_loss: 'Stop', time_exit: 'Por tiempo', opposite_signal: 'Señal contraria', expiry: 'Vencimiento', manual: 'Manual' }`; desconocido → `'—'`.

- [ ] **Step 1:** Tests: compra a 10 USDT con TP 80 % y stop 50 % → `tpPrice 18`, `stopPrice 5`; venta (`sell_against`) a 10 con recompra 50 % y stop 200 % → `tpPrice 5`, `stopPrice 30`; orden `{ purpose:'take_profit', status:'attention' }` → `needsAttention true`; `usageRows` con `maxOpenPositions 1` y una abierta → `pct 100`; motivo `'foo'` → `'—'`.
- [ ] **Step 2:** `npm --prefix client test -- botActivity` → FAIL.
- [ ] **Step 3:** Implementar con los formateadores de `strategies/common/format.js`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(options): pure view models for bot positions, orders and trades`.

### Task 3: Paneles de actividad en el detalle del bot (escritorio y móvil)

**Files:**
- Create: `client/src/pages/Options/auto/BotActivity.jsx` (+ estilos en `AutoTradingTab.module.css`)
- Modify: `client/src/pages/Options/auto/BotDetail.jsx`
- Test: `client/src/pages/Options/auto/BotActivity.test.jsx`

**Interfaces:**
- Consumes: Task 2; `PnlChart` y `LineChart` de `strategies/` (extraer `PnlChart` de `StrategyDetail.jsx` a `strategies/common/PnlChart.jsx` y reutilizarlo en los dos sitios).
- Produces: `<BotActivity bot={shown} mobile={bool} onClosePosition? onCloseAll? onCancelOrder? />`. Los callbacks se cablean en Task 5; aquí son opcionales y sin ellos no se pintan botones.

Orden en el detalle, entre los KPIs y «1 · Señales»: **Posiciones abiertas** → **Órdenes pendientes** (solo si hay) → **Uso de límites** (barras) → y al final, tras «Señales recibidas», **Curva de P&L sombra vs real** y **Operaciones cerradas**. En móvil cada posición es una tarjeta (símbolo, P&L grande, barra TP/stop) y las órdenes una lista compacta; tablas solo en escritorio.

- [ ] **Step 1:** Tests: con una posición abierta se ve su símbolo y su P&L; sin posiciones se ve «Sin posiciones abiertas»; una orden en `attention` muestra el aviso «Requiere atención»; la sección de órdenes no aparece si no hay pendientes; en modo móvil (mock de `useMediaQuery`) se renderizan tarjetas, no `<table>`.
- [ ] **Step 2:** FAIL → implementar → PASS (`npm --prefix client test -- auto/`).
- [ ] **Step 3:** Comprobar a mano en Docker (`localhost:5174`, 1440 px y 390 px) con un bot en sombra que tenga una posición.
- [ ] **Step 4:** Commit `feat(options): show positions, pending orders, limits usage, P&L curve and trades in bot detail`.

---

## Fase B · Controles manuales

### Task 4: Runner: cierre manual y señal simulada

**Files:**
- Modify: `server/src/services/options/options-strategy-runner.service.js`
- Test: test del runner existente

**Interfaces:**
- Produces:
  - `runner.closeManually(strategy, { mode, positionIds? }) → { status: 'closed' | 'pending' | 'nothing_to_close', produced }`. Bajo `withLock(strategy.id)`: lee `listOpenPositions(strategy.id, mode)`, filtra por `positionIds` si vienen, construye `{ type: 'close', reason: 'manual', detail: 'Cierre manual', legs: closeLegs(positions) }` y lo pasa por `executeShadow` o `executeLive` con el mismo `ctx` que arma `runStrategy` (spot, positions enriquecidas, params, mode). No hay lógica de cierre nueva: en Real el camino de TP residente (`requestProtectedExit`) aplica igual que a un stop.
  - `runner.runForSignal(strategy, signal, { shadowOnly = false } = {})`: con `shadowOnly` el bucle de `runStrategy` solo recorre `['shadow']` aunque el bot esté en Real.

- [ ] **Step 1:** Tests:
  - sombra con 2 posiciones, `closeManually` sin ids → las dos cerradas con `closeReason 'manual'`.
  - con `positionIds: [id1]` → solo esa.
  - Real con TP residente (doble de `liveExecutor.requestProtectedExit` que devuelve `true`) → `status 'pending'` y `submit` no se llama.
  - dos `closeManually` concurrentes en sombra → `closePosition` se llama una vez por posición (Review Focus 2).
  - `runForSignal(liveBot, signal, { shadowOnly: true })` → `liveExecutor.submit` nunca se llama.
- [ ] **Step 2:** FAIL → implementar → PASS.
- [ ] **Step 3:** Commit `feat(options): runner supports manual close and shadow-only signals`.

### Task 5: Rutas y UI de cierre manual y cancelación de órdenes

**Files:**
- Modify: `server/src/routes/options-auto-bots.routes.js`, `server/src/services/options/options-auto-trading.service.js`, `server/src/schemas/options-automation.schema.js`
- Modify: `client/src/pages/Options/autoTradingApi.js`, `AutoTradingTab.jsx`, `BotActivity.jsx`
- Test: `server/test/options-auto-bots.routes.test.js`, `server/test/options-auto-trading.service.test.js`, `BotActivity.test.jsx`

**Interfaces:**
- Produces (servidor):
  - `POST /options/auto-bots/:id/close` body `{ positionIds?: number[], confirm: true }` → `{ status, detail }`. Usa el libro del modo actual (Real → `live`, si no → `shadow`). Sin `confirm: true` → 400 `CONFIRM_REQUIRED`.
  - `POST /options/auto-bots/:id/orders/:orderId/cancel` → marca `cancel_requested` en una orden propia no final (reutilizar el método del repo de órdenes reales que ya usa el reconciliador para `cancel_requested`); orden ajena o final → 404/409.
  - El servicio comprueba que el bot pertenece al usuario (`requireStrategy`) y escribe un evento «Cierre manual» en `options_strategy_events`.
- Produces (cliente): `autoBotsApi.close(id, { positionIds })`, `autoBotsApi.cancelOrder(id, orderId)`.
- UI: botón «Cerrar» por posición y «Cerrar todo» en la cabecera del panel; ambos abren un `Sheet` de confirmación que en Real dice «Se enviará una orden LIMIT real a Binance». En órdenes pendientes, «Cancelar» (no en TP: el TP se cancela solo vía cierre). Botones deshabilitados mientras hay una petición en curso.

- [ ] **Step 1:** Tests de rutas: 400 sin `confirm`; 404 con bot de otro usuario; 200 llama a `runner.closeManually` con `mode 'shadow'` para un bot en sombra y `'live'` para uno en Real. Cancelar orden `final` → 409.
- [ ] **Step 2:** Tests de UI: «Cerrar todo» → confirmación → `autoBotsApi.close` con `{ positionIds: undefined }`; segundo clic mientras está pendiente no llama otra vez.
- [ ] **Step 3:** FAIL → implementar → PASS (servidor y cliente). Lint.
- [ ] **Step 4:** Commit `feat(options): manual close and order cancel from the bot detail`.

### Task 6: Simular una señal

**Files:**
- Modify: `options-auto-trading.service.js`, `options-auto-bots.routes.js`, schema, `autoTradingApi.js`, `BotDetail.jsx`
- Create: `server/src/db/migrations/043_options_auto_signal_simulated.sql`
- Test: `server/test/options-auto-trading.service.test.js`, test de UI

**Interfaces:**
- Produces: `POST /options/auto-bots/:id/simulate` body `{ direction: 'bullish' | 'bearish' }` → `{ decision, detail }`.
  - Llama a `runner.runForSignal(bot, signal, { shadowOnly: true })` con `eventId: null` y `alertName: 'Simulación'`.
  - Lo registra en `options_auto_signals` con `simulated = true` (migración 043: `ADD COLUMN simulated BOOLEAN NOT NULL DEFAULT false`). Al no haber evento de alerta, el dedupe no aplica; se limita a **1 simulación cada 10 s por bot** (429 `SIMULATE_RATE_LIMIT`).
  - Pausado → 409 `BOT_PAUSED` («Pasa el bot a Sombra para simular»).
- UI: menú «Probar señal ▾» (Alcista / Bajista) junto a «Vincular alerta…». En el feed, las simuladas llevan la etiqueta «Simulada». `signalStats` las excluye de los KPIs.

- [ ] **Step 1:** Tests: bot en Real + simulate → `submit` real no llamado, fila con `simulated true`; dos simulaciones en < 10 s → la segunda 429; bot pausado → 409; `signalStats` ignora simuladas.
- [ ] **Step 2:** FAIL → implementar → PASS.
- [ ] **Step 3:** E2E `e2e/options-auto-bots.spec.js` (nuevo; escritorio + 390 px, contra Docker): crear bot en sombra → «Probar señal › Alcista» → aparece la fila «Simulada» y una posición abierta → «Cerrar todo» → confirmación → la posición pasa a «Operaciones cerradas» con motivo «Manual».
- [ ] **Step 4:** Commit `feat(options): simulate a signal on a bot (shadow only)`.

**Al terminar la fase B:** integrar a main, desplegar y actualizar la nota del vault.

---

## Fase B2 · Venta por banda ATR (se ejecuta justo después de la fase B)

Decisiones del usuario (2026-10-21):
- La alerta **detona la compra** (`buy_with`). Contrato elegido como hoy: delta objetivo + vencimiento (ventana de la alerta).
- Precio de venta = `prima_fill × (1 + min(distancia% × apalancamiento, tope))`, donde:
  - **Banda ATR** = la misma fórmula del indicador «ATR Bands» de TradingView: último cierre ± `multiplicador × ATR(longitud)` (ATR de Wilder, como `technicalindicators`). Call → banda superior; put → banda inferior.
  - **Velas:** temporalidad elegida **por bot** (`5m | 15m | 1h | 4h | 1d`), longitud y multiplicador por bot (14 / 2 por defecto).
  - **distancia%** = `|banda − spot| / spot`, con el spot **en el momento del fill**.
  - **apalancamiento** = metodología de Trading manual (`optionPremiumLeverage`): **nominal** = spot / prima, aquí con la prima del fill. (Equivale a `venta = prima + |banda − spot|` antes del tope.)
  - **Tope** configurable por bot (`tpMaxGainPct`, por defecto **200 %**); si el cálculo lo supera se usa el tope.
- Se calcula **una vez al llenarse** y se coloca como **LIMIT GTC en reposo en Binance** (infra de TP residente existente). No se recalcula.
- **Sin otras salidas:** ni stop, ni salida por tiempo, ni cierre por señal contraria. Si no se vende al objetivo, se mantiene hasta la liquidación.
- Este modo **solo existe con «Comprar a favor»**. «Vender en contra» conserva sus salidas actuales.
- Decisión de Claude: si al llenarse el spot ya rebasó la banda (distancia ≤ 0), la distancia se mide desde el **último cierre** a la banda (= `multiplicador × ATR / cierre`), que siempre es positiva.
- Decisión de Claude: los bots nuevos con «Comprar a favor» nacen con este modo; los existentes no cambian.

### Task 13: Cálculo puro de la banda ATR y del precio de venta

**Files:**
- Create: `server/src/services/options/options-atr-band-tp.js`
- Modify: `server/src/services/options/binance-options.client.js` (`getSpotKlines`: aceptar `interval ∈ ['5m','15m','1h','4h','1d']` y `limit ≤ 500`), `server/src/services/options/options-market.service.js`
- Test: `server/test/options-atr-band-tp.test.js`, test del market service

**Interfaces:**
- Produces:
  - `wilderAtrBands(candles, { length = 14, multiplier = 2 }) → { close, atr, upper, lower, closeTime } | null`, a partir de la última vela **cerrada** (`closeTime < now`). ATR de Wilder: primera media = SMA de los `length` primeros TR, después `(prev × (length−1) + tr) / length`.
  - `atrBandTakeProfit({ fillPrice, spot, type, band, tickSize, minPrice, maxGainPct }) → { price, distancePct, leverage, rawGainPct, appliedGainPct, capped, bandValue } | null`. `type 'C'` usa `band.upper`, `'P'` usa `band.lower`; el precio se redondea **hacia arriba** al tick anclado en `minPrice` (como `standingPrice`); devuelve `null` si `price ≤ fillPrice`.
  - `market.getAtrBand(underlying, { interval, length, multiplier }) → wilderAtrBands(...)`, con caché de 60 s por `(underlying, interval, length, multiplier)`, pidiendo `max(200, length × 10)` velas.

- [ ] **Step 1: Tests**
  - Paridad: con un fixture de 30 velas, `wilderAtrBands` da el mismo `upper/lower` de la última vela que `computeAtrBands` del cliente (copiar los valores esperados del test del cliente a un fixture JSON compartido en `server/test/fixtures/atr-bands.json`), tolerancia 1e-9.
  - Ejemplo del usuario: `fillPrice 40, spot 3000, type 'C', band.upper 3060, tick 0.1, maxGainPct 200` → `distancePct 2`, `leverage 75`, `rawGainPct 150`, `price 100`, `capped false`.
  - Tope: `fillPrice 10, spot 3000, upper 3060` → `rawGainPct 600`, `appliedGainPct 200`, `price 30`, `capped true`.
  - Put: `type 'P'`, `lower 2940` → misma distancia del 2 %.
  - Spot más allá de la banda (`spot 3070`, `upper 3060`, `close 3000`, `atr 30`, `multiplier 2`) → distancia `60/3000 = 2 %`.
  - Redondeo: precio crudo 61.04 con tick 0.5 → 61.5.
  - La vela en curso (`closeTime ≥ now`) no se usa.
- [ ] **Step 2:** FAIL → implementar → PASS. Lint.
- [ ] **Step 3:** Commit `feat(options): ATR band take-profit calculation`.

### Task 14: Modo `atr_band` en el bot: fijar el objetivo al llenarse y colocarlo en Binance

**Files:**
- Create: `server/src/db/migrations/044_options_position_tp_target.sql` (`tp_target_price NUMERIC`, `tp_target_meta JSONB` en `options_strategy_positions`)
- Modify: `templates/alert-signal.js`, `options-strategy-runner.service.js` (`book`, `exits` vía template), `options-live-execution.service.js` (`standingPrice`, `createMissingTakeProfits`), `options-strategies.repository.js` (`mapPosition`, `setTpTarget(id, price, meta)`)
- Test: `options-alert-signal.template.test.js`, test del runner, test del ejecutor real

**Interfaces:**
- Consumes: Task 13.
- Params nuevos en `alert_signal`: `takeProfitMode` admite `'atr_band'`; `atrBandInterval` (por defecto `'1h'`), `atrBandLength` (14, entero 2–100), `atrBandMultiplier` (2, 0.25–10), `tpMaxGainPct` (200, 10–2000). `validateParams` rechaza `atr_band` con `structure 'sell_against'`; en `atr_band` fuerza `onOpposite = 'ignore'`, `stopLossPct`/`exitHoursBeforeExpiry` sin efecto.
- `ensureAtrBandTarget(position, params) → position` (helper compartido del runner y del ejecutor): si `tpTargetPrice` es null, pide `market.getAtrBand` y `getVolatilityInputs` (tick y minPrice), calcula con el spot actual (segundos después del fill) y persiste con `repo.setTpTarget`. Si ya existe, no recalcula nunca.
- Sombra: al abrir en `book`, se llama `ensureAtrBandTarget`; `exits()` en `atr_band` cierra con `reason 'take_profit_atr_band'` cuando el **bid ≥ tpTargetPrice** (emula la LIMIT en reposo) y no emite ninguna otra salida; el vencimiento lo liquida `settleExpired`.
- Real: `createMissingTakeProfits` llama a `ensureAtrBandTarget` antes de `standingPrice`; `standingPrice` en `atr_band` devuelve `position.tpTargetPrice`. Plazo de la orden: hasta el vencimiento menos 1 h (el `Math.max(1, …)` actual con `exitHoursBeforeExpiry = 0`).
- Si no hay velas o tick, el objetivo queda pendiente y se reintenta en el siguiente ciclo; el vigilante de posiciones sin protección ya avisa.

- [ ] **Step 1: Tests**
  - Template: `atr_band` + `sell_against` → ValidationError; `atr_band` con señal contraria y posición abierta → `skip('opposite_ignored')`, sin cierre; posición en pérdida del 90 % → ninguna salida; bid ≥ objetivo → cierre `take_profit_atr_band`.
  - Runner (sombra): una apertura persiste `tpTargetPrice` una vez; un segundo tick no vuelve a llamar a `getAtrBand`.
  - Ejecutor real: posición `atr_band` sin objetivo → se calcula, se persiste y la orden TP lleva ese precio; con objetivo ya guardado, `getAtrBand` no se llama; `getAtrBand` lanza → no se encola TP y no se pierde la posición.
- [ ] **Step 2:** FAIL → implementar → PASS (`npm --prefix server test`). Lint.
- [ ] **Step 3:** Commit `feat(options): atr_band take-profit mode, fixed at fill and resting on Binance`.

### Task 15: UI del modo «Banda ATR»

**Files:**
- Modify: `client/src/pages/Options/auto/botView.js` (`TAKE_PROFIT_MODES`, `COMMON_DEFAULTS`, payload y validación del formulario), `BotForm.jsx`, `BotDetail.jsx`, `Mapping.jsx`, `botActivity.js` / `BotActivity.jsx` (Task 2/3)
- Test: `botView.test.js`, `botActivity.test.js`, `BotActivity.test.jsx`

Decisiones:
- En el formulario, «Tipo de venta»: `Banda ATR` (por defecto en compra), `Porcentaje fijo`, `Volatilidad ATR + IV`. Con `Banda ATR`: selector de temporalidad (5m/15m/1h/4h/1d), longitud, multiplicador, «Tope de ganancia (%)». Se ocultan stop, salida por tiempo y señal contraria, con la nota «Sin stop ni salida por tiempo: si no se alcanza el objetivo, la opción se mantiene hasta su vencimiento y puede perderse toda la prima».
- Con `Vender en contra` el modo `Banda ATR` no aparece.
- Panel «3 · Salidas» en `atr_band`: «Venta por banda ATR 1h 14/2 · tope +200 %» y «Sin stop · se mantiene hasta vencer».
- Cada posición abierta muestra el desglose de `tp_target_meta`: `Spot 3.000 → banda 3.060 (+2,0 %) × apal. 75× = +150 % → venta a 100,0 USDT`, con «(tope)» si `capped`, o «Calculando objetivo…» si aún es null.

- [ ] **Step 1:** Tests: con `sell_against` no se ofrece `atr_band`; con `atr_band` el payload lleva los cuatro params y no lleva `stopLossPct`; el desglose de una posición con `capped true` contiene «tope»; sin objetivo → «Calculando objetivo…».
- [ ] **Step 2:** FAIL → implementar → PASS. Revisar a 390 px en Docker.
- [ ] **Step 3:** Commit `feat(options): ATR band sell mode in bot form and detail`.

**Al terminar la fase B2:** integrar, desplegar y actualizar el vault. Con `atr_band` en marcha, el backtest de la fase D (Task 9) debe soportar este modo: calcular el objetivo en la apertura simulada con velas de `atrBandInterval` del rango, y cerrar cuando el bid sintético lo alcance.

---

## Fase C · Detalle fiel a la configuración y extras

### Task 7: Mostrar toda la configuración y aclarar el estado

**Files:**
- Modify: `client/src/pages/Options/auto/botView.js` (la función que arma `desc.entry/exits/risk`), `BotDetail.jsx`, `BotList.jsx`, `Mapping.jsx`
- Test: `botView.test.js`, `AutoTradingTab.test.jsx` (sin tocar el caso inestable)

Decisiones:
- Entrada: añadir «Contratos distintos» (`contractCount`), «Capital máx. por entrada» (`capitalUsdt`, «sin límite» si null) y, en compra, «Prima máx.».
- Salidas: si `takeProfitMode === 'volatility'`, la fila de TP dice «ATR × {tpAtrMultiplier} + IV · horizonte {tpHorizonHours} h» en lugar de «% de la prima».
- Vencimiento: si alguna alerta vinculada trae `optionExpiryMinDays/MaxDays`, `Mapping` muestra «venc. 7–14 d (de la alerta)» en lugar de «~7 d». Si el endpoint de lista no trae esos campos por alerta, añadirlos en `listBots` del servicio.
- Estado: la tarjeta de la lista ya muestra el chip de modo; añadir el texto de estado del runner (`waiting_signal`, `in_position`, `no_quote`…) en lenguaje humano (`STATUS_LABEL`) en lugar del valor en crudo `paused`.

- [ ] **Step 1:** Tests: `takeProfitMode 'volatility'` → la fila de TP no contiene «%»; `capitalUsdt null` → «sin límite»; alerta con ventana 7–14 → texto «7–14 d»; estado `paused` → «Pausado», no «paused».
- [ ] **Step 2:** FAIL → implementar → PASS.
- [ ] **Step 3:** Commit `feat(options): bot detail shows contract count, capital, TP mode and alert expiry window`.

### Task 8: Clonar bot, notificaciones por bot y KPIs útiles

**Files:**
- Modify: `options-auto-trading.service.js` (+ ruta `POST /options/auto-bots/:id/clone`), template `alert-signal.js` (param `notify`), `options-strategy-runner.service.js` (`maybeNotify`), `botView.js` (`signalStats` / KPIs), `BotDetail.jsx`, `BotForm.jsx`
- Test: servicio, template, `botView.test.js`

**Interfaces:**
- `POST /options/auto-bots/:id/clone` → crea un bot nuevo en **sombra** con el mismo `params`/`limits`/`underlying` y nombre `«<nombre> (copia)»`. Nunca hereda Real.
- Param nuevo `notify: { trades: true, errors: true }` en `defaultParams` de `alert_signal`, validado como objeto de dos booleanos. `maybeNotify(strategy, message, kind)` con `kind ∈ 'trade' | 'error'` respeta el flag; las alertas de incidentes del ejecutor real (`sendIncidentAlert`) **no** se pueden silenciar.
- KPIs: «Acierto» muestra `n/a (3 ops)` cuando hay menos de 5 operaciones cerradas; se añaden «P&L medio por operación» y «Peor racha / drawdown» calculados de `closedPositions`.

- [ ] **Step 1:** Tests: clonar un bot en Real → copia en `shadow`; `notify.trades false` → `notifyTelegram` no se llama en una apertura, pero sí en un error si `errors true`; KPIs con 3 cierres → texto «n/a».
- [ ] **Step 2:** FAIL → implementar (checkbox de notificaciones en `BotForm`, botón «Clonar» junto a editar/eliminar) → PASS.
- [ ] **Step 3:** Commit `feat(options): clone bot, per-bot Telegram toggles and better KPIs`.

---

## Fase D · Backtest de bots con el historial de alertas

### Task 9: Motor: reproducir disparos de alertas en el backtest

**Files:**
- Modify: `server/src/services/options/options-backtest.service.js`
- Create: `server/src/repositories/alert-events-history.repository.js` (o una función en el repo de alertas si ya existe uno de eventos)
- Test: `server/test/options-backtest.service.test.js`

**Interfaces:**
- Produces: `listAlertSignals({ userId, alertIds, underlying, from, to }) → [{ t, direction, alertId }]` desde `alert_events` (usa la columna `direction` de la migración 032; descarta `neutral` y activos cuyo `assetToUnderlying` ≠ `underlying`; ordena por `created_at`).
- Modify: `simulate({ template, params, steps, capitalUsdt, feePct, signals = [] })`. Por cada paso, las señales con `prevT < s.t ≤ step.t` se pasan **una a una** como `ctx.signal` en evaluaciones extra del template (antes de la evaluación normal de salidas del paso), y `ctx.tradesToday` se lleva como contador por día UTC dentro de la simulación.
- `normalizeConfig`: para `isSignalDriven(template)` ya no lanza; exige `strategyId` (el bot) y carga sus `alertIds`. Si no hay disparos en el rango → `ValidationError('Las alertas de este bot no se dispararon entre <from> y <to>')`.
- El resultado añade `signals: { received, traded, ignored }` en el resumen.

- [ ] **Step 1:** Tests: con pasos sintéticos y 2 señales alcistas → 1 apertura si `maxOpenPositions 1`, y `signals.ignored === 1`; señal bajista con `onOpposite 'reverse'` cierra y abre put; sin disparos en el rango → ValidationError con ese texto (Review Focus 4); disparo de un activo de otro subyacente → ignorado.
- [ ] **Step 2:** FAIL → implementar → PASS. El `recorded` no se habilita para bots en esta tarea si carga millones de filas (deuda conocida): solo `dvol` y `realized`.
- [ ] **Step 3:** Commit `feat(options): backtest alert bots by replaying alert history`.

### Task 10: UI: «Backtestear este bot»

**Files:**
- Modify: `BotDetail.jsx`, `client/src/pages/Options/backtesting/BacktestForm.jsx`, `BacktestingTab.jsx`, `BacktestResults.jsx`
- Test: `client/src/pages/Options/backtesting/BacktestingTab.test.jsx`

- [ ] **Step 1:** Botón «Backtestear» en el detalle del bot → navega a `?tab=backtest&strategyId=<id>` con el bot preseleccionado; en el selector de Backtesting aparecen los bots (antes se filtraban por `signalDriven`); el resumen muestra «Señales: N recibidas · M operadas».
- [ ] **Step 2:** Test: con `strategyId` de un bot en la URL el formulario lo preselecciona y la fuente `recorded` aparece deshabilitada con su motivo.
- [ ] **Step 3:** FAIL → implementar → PASS. Commit `feat(options): backtest a bot from its detail`.

**Al terminar la fase D:** integrar, desplegar, actualizar el vault.

---

## Fase E · Presupuesto por fracciones y filtros de entrada (spec v2)

Solo lo **ya decidido** en el documento v2. Quedan fuera, a la espera de decisión del usuario: el objetivo de precio del subyacente, la política de repricing del LIMIT en la ventana de 10 min y la asignación ponderada.

### Task 11: Presupuesto total en N fracciones con reserva de pendientes

**Files:**
- Modify: `server/src/services/options/templates/alert-signal.js`, `options-strategy-runner.service.js` (contexto de `evaluate`), `botView.js`, `BotForm.jsx`, `BotDetail.jsx`
- Test: `server/test/options-alert-signal.template.test.js`, test del runner

**Interfaces:**
- Params nuevos: `budgetUsdt` (nullable; null = comportamiento actual con `capitalUsdt`) y `budgetFractions` (entero 1–20, por defecto **4**). Si `budgetUsdt` está definido, `capitalUsdt` se ignora.
- El runner pasa `ctx.committedUsdt`: prima (compras) o margen estimado (ventas) de las posiciones abiertas del modo, más lo **reservado** por órdenes de entrada no finales (`requested_qty − processed_qty` × `limitPrice`) en Real. En sombra solo posiciones.
- `openFor`: `perSignal = min(budgetUsdt / budgetFractions, budgetUsdt − committedUsdt)`; si `perSignal ≤ 0` → `skip('budget_exhausted', 'Presupuesto comprometido: X de Y USDT')`. Ese `perSignal` sustituye a `budget` en el reparto equitativo ya existente (redondeo hacia abajo, sin redistribuir lo no usado).
- Cambiar `budgetFractions` solo afecta a nuevas entradas (no hay que tocar posiciones).

- [ ] **Step 1:** Tests (con los números del spec): presupuesto 48, 4 fracciones, nada comprometido → 12 por señal y con 3 contratos ≤ 4 USDT cada uno; comprometido 40 → 8 por señal; comprometido 48 → `budget_exhausted`; orden de entrada pendiente de 10 USDT en Real cuenta como comprometida (Review Focus 7).
- [ ] **Step 2:** FAIL → implementar → PASS.
- [ ] **Step 3:** UI: en el formulario, «Presupuesto total» + «Fracciones» con el texto derivado «Hasta X USDT por señal»; en el detalle, barra «Comprometido X de Y USDT» en «Uso de límites» (extender `usageRows` de Task 2).
- [ ] **Step 4:** Commit `feat(options): bot budget split in fractions with pending-order reservation`.

### Task 12: Filtros de entrada por spread y apalancamiento

**Files:**
- Modify: `alert-signal.js`, `BotForm.jsx`, `botView.js`
- Test: `options-alert-signal.template.test.js`

**Interfaces:**
- Params nuevos, **apagados por defecto** (null): `maxSpreadPct` (spread relativo `(ask−bid)/mid × 100`) y `minLeverage` (apalancamiento **nominal** `spot / ask`, la metodología de Trading manual, solo en compra).
- En `openFor`, el filtro de candidatos descarta los que no cumplen, antes de ordenar por delta. Si no queda ninguno → `skip('no_legs', …)` con el detalle del filtro que los eliminó («spread > 8 %», «apalancamiento < 5×»).

- [ ] **Step 1:** Tests: candidato con bid 9 / ask 11 y `maxSpreadPct 10` → descartado (spread 20 %); con `minLeverage 20`, spot 3000 y ask 200 → apalancamiento 15× → descartado; con ambos null, la selección es idéntica a la actual (test de regresión sobre un caso existente).
- [ ] **Step 2:** FAIL → implementar → PASS.
- [ ] **Step 3:** Commit `feat(options): optional spread and leverage entry filters for bots`.

**Al terminar la fase E:** integrar, desplegar, actualizar el vault y anotar en el spec v2 qué partes quedan implementadas.
