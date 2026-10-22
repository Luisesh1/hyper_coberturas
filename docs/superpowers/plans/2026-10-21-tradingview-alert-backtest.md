# TradingView · Backtest de alertas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Marcar en el gráfico de `/trading-view` y en cada panel de `/trading-view/multi` (modo Multi‑TF) dónde se habrían disparado las alertas elegidas. El backtest reproduce exactamente lo que el motor de alertas habría evaluado.

**Architecture:**
- **Servidor.** Se extrae del motor en vivo una función pura de puntuación, `scoreAlert`. El motor en vivo y un nuevo servicio de backtest la comparten. El servicio recorre los cierres de la temporalidad base de la alerta y, en cada uno, reconstruye la ventana de velas que el motor en vivo habría recibido. Después simula el cooldown con la misma latencia de envío que en vivo. Expone `POST /api/alerts/:id/backtest`.
- **Cliente.** Hay dos piezas:
  - `useAlertBacktest`: datos, tramos, caché y cobertura del rango.
  - `useSeriesAlertMarkers`: dibuja los marcadores en una serie de lightweight‑charts v5 con `createSeriesMarkers`, recolocados según la temporalidad de cada gráfico.
- **Persistencia.** La selección de alertas se guarda como un ajuste de usuario, junto a los indicadores del gráfico.

**Tech Stack:**
- Servidor: Node/Express, `node:test`, zod.
- Cliente: React 18, Vite, lightweight-charts 5.1, Vitest.
- E2E: Playwright contra Docker en `localhost:5174`.

**Spec:** `docs/superpowers/specs/2026-10-21-tradingview-alert-backtest-design.md`

## Global Constraints

- **Ni una línea de lógica de evaluación duplicada.** El backtest llama a `evaluator.evaluateRule` y `calculateWeightedScore` a través de `scoreAlert`. El cliente no evalúa reglas.
- **El comportamiento en vivo no cambia.** Los tests existentes de `server/test/alerts*.test.js` siguen pasando sin tocarlos.
- **El backtest es de solo lectura.** No envía Telegram, no escribe `alert_events`, no toca `lastTriggeredAt` y no llama a `alertEvents.emit…`.
- **Ventana en el instante T.** Se usan las velas con `time ≥ T − 250·tfMs` y `closeTime ≤ T`, donde T = cierre de la vela base + `POST_CLOSE_BUFFER_MS` (3000 ms).
- **Cooldown.** Un disparo cuenta como enviado en `cierre + 3000 + SEND_DELAY_MS` (1000 ms). Una evaluación posterior en `cierre' + 3000` queda suprimida si `cooldownMs − ((cierre' + 3000) − envío) > 0`. Un suprimido no reinicia el cooldown.
- **Temporalidades.** Siempre las de la alerta. La temporalidad del gráfico nunca cambia el cálculo, solo decide dónde se dibuja la marca.
- **Activo y fuente.** Siempre el símbolo y la fuente **del gráfico**. Si `alert.datasource ≠ chart.datasource`, el chip lo avisa: «evaluada con {fuente del gráfico}; la alerta usa {fuente de la alerta}».
- **Sin actualización en vivo.** El borde derecho del rango evaluado queda fijo al cargar. Solo dispara nuevas peticiones ampliar el rango hacia atrás.
- **Tamaño de petición.** Una petición evalúa como mucho `MAX_EVALS_PER_REQUEST = 2000` velas base. El cliente pide como mucho `MAX_CHUNKS_PER_ALERT = 10` tramos por alerta y vista.
- **Selección.** Como mucho `MAX_ALERT_MARKERS = 6` alertas a la vez.
- **Móvil.** Zonas táctiles de 44 px y sin scroll horizontal. En Replay solo se muestran los disparos con `time ≤` instante actual del replay.
- **Fuera de alcance:** el modo Multi‑activo. El spec lo marcaba como opcional; se deja fuera por coste.

## Review Focus

1. **Alerta con regla en 4h evaluada a mitad de la vela 4h.** No puede ver la vela 4h en formación (*lookahead*). Lo cubre el test `windowAt excluye la vela HTF no cerrada` (Task 2).
2. **Petición que empieza en mitad de una racha de disparos.** El cooldown en el borde del tramo debe ser exacto, sin depender de dónde corta el cliente. Lo cubre el test `el resultado no depende de dónde empieza el tramo` (Task 2).
3. **Hyperliquid u otra fuente sin historia suficiente** para calentar 250 velas en alguna temporalidad. Esas evaluaciones se cuentan en `insufficient` y no se marcan. Lo cubre el test `sin historia suficiente no inventa disparos` (Task 2).
4. **Alerta borrada o editada mientras está seleccionada.**
   - Borrada: el chip muestra «alerta eliminada» y se puede quitar.
   - Editada: cambia `updatedAt`, se invalida la caché y se recalcula.
   - Lo cubren los tests `alerta eliminada` y `updatedAt invalida la caché` (Task 5).
5. **Gráfico en 1d con una alerta de 1m.** El rango no cabe en `MAX_CHUNKS_PER_ALERT`. Se marca la parte más reciente y el chip dice «evaluada desde {fecha}», sin colgarse. Lo cubre el test `rango mayor que el tope queda parcial` (Task 5).

---

## File map

**Servidor**
- `server/src/services/alerts/alerts.service.js` — se modifica: extrae `scoreAlert` y la exporta junto a `distinctTimeframes` y `candleCloseTimeMs`.
- `server/src/services/alerts/alert-backtest.service.js` — se crea: `windowAt`, `simulate`, `createAlertBacktest`.
- `server/src/routes/alerts.routes.js` — se modifica: añade `POST /:id/backtest`.
- `server/src/services/settings.service.js` y `server/src/routes/settings.routes.js` — se modifican: clave `chart_alert_markers`.
- Tests: `server/test/alerts.score.test.js`, `server/test/alert-backtest.test.js`, `server/test/settings.chart-alert-markers.test.js`.

**Cliente** (`client/src/pages/TradingView/alertMarkers/`)
- `markerModel.js` — funciones puras: paleta, selección, recolocación y marcadores.
- `useAlertSelection.js` — selección persistida.
- `useAlertBacktest.js` — datos.
- `useSeriesAlertMarkers.js` — dibujo.
- `AlertPicker.jsx` y `AlertChips.jsx` — UI.
- `AlertMarkerCard.jsx` — tarjeta de detalle (flotante en escritorio, hoja inferior en móvil).
- Se modifican:
  - `client/src/services/api.js`: añade `alertsApi.backtest`, `settingsApi.getChartAlertMarkers` y `settingsApi.saveChartAlertMarkers`.
  - `TradingViewPage.jsx`, `multi/SyncedChart.jsx` y `multi/MultiTimeframePage.jsx`.
  - `components/MobileTabBar.jsx`, o la hoja de Indicadores (ver Task 7).
- E2E: `e2e/tradingview-alert-markers.spec.js`.

---

### Task 1: Extraer `scoreAlert` del motor en vivo

**Files:**
- Modify: `server/src/services/alerts/alerts.service.js`, en la zona de `evaluateAlertOnAsset` (≈ líneas 330–370) y en los exports.
- Test: `server/test/alerts.score.test.js`

**Interfaces:**
- Produces: `scoreAlert(rules: Rule[], candlesByTf: Record<tf, Candle[]>) -> { ruleResults: Array<{ rule, matched, value, threshold, reason }>, score: number }`.
  - Atrapa las excepciones de cada regla igual que hoy: `reason: 'error: …'`, `matched: false`.
- Produces: exporta `distinctTimeframes`, `candleCloseTimeMs` y `POST_CLOSE_BUFFER_MS = 3000`. El scheduler lo importa de aquí en lugar de definir su propia constante.

- [ ] **Step 1: Escribir los tests que fallan.**
  - `scoreAlert puntúa reglas ponderadas`: dos reglas de RSI con pesos 1 y 3 sobre una serie sintética. La primera cumple y la segunda no. Se espera `score === 25` y `ruleResults[1].matched === false`.
  - `scoreAlert convierte una excepción de regla en matched=false`: regla con `indicatorType: 'nope'`. Se espera `matched === false` y que `reason` empiece por `indicador nope no soportado` o por `error:`.
- [ ] **Step 2:** `cd server && node --test test/alerts.score.test.js`. Se espera FAIL (`scoreAlert is not a function`).
- [ ] **Step 3:** implementar `scoreAlert` moviendo el bloque `ruleResults` + `calculateWeightedScore` de `evaluateAlertOnAsset`. `evaluateAlertOnAsset` pasa a llamarla. En `alerts-scheduler.service.js` hay que usar el `POST_CLOSE_BUFFER_MS` importado.
- [ ] **Step 4:** `cd server && node --test test/alerts*.test.js`. Se espera PASS en todos, también en los existentes.
- [ ] **Step 5:** commit con el mensaje `refactor(alerts): extract pure scoreAlert shared by live engine and backtest`.

### Task 2: Servicio de backtest (puro + orquestación)

**Files:**
- Create: `server/src/services/alerts/alert-backtest.service.js`
- Test: `server/test/alert-backtest.test.js`

**Interfaces:**
- Consumes: `scoreAlert`, `lowestTimeframe`, `distinctTimeframes`, `candleCloseTimeMs` y `POST_CLOSE_BUFFER_MS` (Task 1). También `marketData.TIMEFRAME_TO_MS` y `CANDLE_FETCH_LIMIT = 250`; esta última hay que exportarla también en Task 1 si no lo está.
- Produces:
  - `windowAt(candles, tf, evalTimeMs) -> Candle[]`: las velas con `time ≥ evalTimeMs − 250·tfMs` y `closeTime ≤ evalTimeMs`, ordenadas. Se buscan con búsqueda binaria sobre `candles` ordenado.
  - `simulate({ alert, candlesByTf, fromMs, toMs }) -> { baseTimeframe, events: BacktestEvent[], insufficient: number, cooldownApprox: boolean }`.
    - `BacktestEvent = { time: closeMs, score, threshold, suppressed: boolean, rules: Array<{ indicatorType, timeframe, weight, matched, reason }> }`.
    - Solo se devuelven los eventos con `fromMs < time ≤ toMs`.
  - `createAlertBacktest({ getAlert, getCandles, now = Date.now }) -> { run(userId, alertId, { asset, datasource, startTime, endTime }) -> Promise<BacktestResult> }`.
    - `BacktestResult = { alertId, alertUpdatedAt, asset, datasource, alertDatasource, baseTimeframe, from, to, events, insufficient, cooldownApprox }`.
  - `SEND_DELAY_MS = 1000`, `MAX_EVALS_PER_REQUEST = 2000` y `MAX_COOLDOWN_LOOKBACK_FACTOR = 32`.

**Algoritmo de `simulate`.** El cooldown se resuelve de forma exacta con un **punto de reinicio**:
1. Calcular `wouldTrigger` (`score ≥ threshold`) en cada cierre base del tramo `[fromMs − W, toMs]`, empezando con `W = 2·cooldownMs`.
2. Buscar el último cierre `p ≤ fromMs` tal que **ningún** cierre en `(p − cooldownMs, p]` cumpla `wouldTrigger`. En `p` no puede haber cooldown activo, sea cual sea la historia anterior.
3. Si no existe, duplicar `W` hasta `MAX_COOLDOWN_LOOKBACK_FACTOR·cooldownMs`. Si aun así no existe, simular desde el inicio y devolver `cooldownApprox: true`.
4. Simular desde `p` con la regla de cooldown de Global Constraints.
5. Si `cooldownMs === 0`, saltar la búsqueda.

Una evaluación es *insuficiente* si alguna temporalidad de la alerta tiene 0 velas en su ventana, o si la temporalidad base no tiene la vela que cierra justo en ese cierre. Las insuficientes no puntúan; solo suman en `insufficient`.

**`run`:**
1. Valida que `endTime ≤ now()` (si no, lo recorta).
2. Valida que `(endTime − startTime) / baseTfMs ≤ MAX_EVALS_PER_REQUEST`. Si se pasa, lanza `ValidationError('rango demasiado grande: máximo 2000 velas de {tf}')`.
3. Por cada temporalidad pide `getCandles(asset, tf, { datasource, startTime: startTime − W_max − 250·tfMs, endTime })`, con `W_max = MAX_COOLDOWN_LOOKBACK_FACTOR·cooldownMs`.
4. Llama a `simulate`.
5. Si la alerta no es del usuario, `getAlert` ya lanza `NotFoundError`.

- [ ] **Step 1: Escribir los tests que fallan.** Usar velas sintéticas de 15m y 4h y una alerta con `cooldownSeconds` configurable.
  - `windowAt en cripto 24/7 devuelve 249 velas en T = cierre + 3s`.
  - `windowAt excluye la vela HTF no cerrada`: a las 14:15 + 3 s, la última vela 4h devuelta cierra a las 12:00.
  - `cooldown igual al TF suprime la vela siguiente`: con `wouldTrigger` en dos cierres consecutivos de 15m y `cooldownSeconds: 900`, se espera `[suppressed=false, suppressed=true]`.
  - `cooldown deja pasar tras cd + 1 vela`: en el tercer cierre consecutivo, `suppressed === false`.
  - `el resultado no depende de dónde empieza el tramo`: los eventos de `simulate` en `[a, c]` coinciden con la unión de `[a, b]` y `[b, c]`, cortando en mitad de una racha.
  - `sin historia suficiente no inventa disparos`: la 4h empieza más tarde que la 15m. Se espera `insufficient > 0` y ningún evento antes del primer cierre 4h + 250 velas.
  - `run es de solo lectura`: los mocks de `getAlert`/`getCandles` no reciben llamadas de escritura, y el módulo no requiere `telegram.registry` ni `alert-events` (comprobar con `require.cache`).
  - `run rechaza rangos de más de 2000 velas base`.
- [ ] **Step 2:** `cd server && node --test test/alert-backtest.test.js`. Se espera FAIL (módulo inexistente).
- [ ] **Step 3:** implementar `alert-backtest.service.js`. Exportar también una instancia por defecto: `createAlertBacktest({ getAlert: alertsService.getAlert, getCandles: marketData.getCandles })`.
- [ ] **Step 4:** `cd server && node --test test/alert-backtest.test.js test/alerts*.test.js`. Se espera PASS.
- [ ] **Step 5:** commit con el mensaje `feat(alerts): exact historical backtest service`.

### Task 3: Endpoints del servidor (backtest + selección persistida)

**Files:**
- Modify: `server/src/routes/alerts.routes.js`, `server/src/services/settings.service.js` y `server/src/routes/settings.routes.js`.
- Test: `server/test/alert-backtest.route.test.js` y `server/test/settings.chart-alert-markers.test.js`. Seguir el patrón de los tests de rutas existentes; si no hay, probar el servicio.

**Interfaces:**
- `POST /api/alerts/:id/backtest` con body `{ asset: string, datasource: 'hyperliquid'|'binance'|'yahoo', startTime: ms, endTime: ms }`. Responde `{ success: true, data: BacktestResult }`. Body inválido → 400 (zod).
- `GET` y `PUT /api/settings/chart-alert-markers` con body y respuesta `{ items: Array<{ alertId: number, color: string, hidden: boolean }> }`.
  - `normalizeChartAlertMarkers` descarta los items inválidos, deduplica por `alertId` y corta en 6.
  - Valor por defecto: `{ items: [] }`.
  - Clave de ajustes: `chart_alert_markers`.

- [ ] **Step 1:** escribir los tests que fallan.
  - Normalización de la selección: deduplica, corta a 6 y descarta `alertId` no numérico.
  - Ruta de backtest: valida el body y delega en `run(userId, id, body)`.
- [ ] **Step 2:** ejecutarlos y comprobar que fallan.
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** `cd server && npm run check`. Se espera PASS (lint + tests).
- [ ] **Step 5:** commit con el mensaje `feat(alerts): backtest endpoint and chart alert-marker selection setting`.

### Task 4: Modelo puro del cliente (`markerModel.js`)

**Files:**
- Create: `client/src/pages/TradingView/alertMarkers/markerModel.js`
- Test: `client/src/pages/TradingView/alertMarkers/markerModel.test.js`
- Modify: `client/src/services/api.js`. Añadir `alertsApi.backtest(id, body)` (POST), `settingsApi.getChartAlertMarkers()` y `settingsApi.saveChartAlertMarkers({ items })`.

**Interfaces:**
- `ALERT_COLORS`: 6 colores distinguibles de los de `overlays/OverlayLegend` y de los indicadores por defecto (comprobar en `indicators/defaults.js`).
- `MAX_ALERT_MARKERS = 6`.
- `nextColor(items) -> string`: el primer color libre de la paleta.
- `addAlert(items, alertId) -> items`, `removeAlert(items, alertId) -> items`, `toggleAlertHidden(items, alertId) -> items` y `setAlertColor(items, alertId, color) -> items`. Las cuatro son puras; `addAlert` no pasa de 6.
- `chartBucketSec(eventTimeMs, chartTf, chartCandles) -> number | null`.
  - Devuelve el `time` en segundos de la vela del gráfico que contiene `eventTimeMs − 1`.
  - Busca primero en `chartCandles` (ms, ordenadas) con búsqueda binaria, que es lo correcto también para 1M y para huecos de mercado. Si cae fuera, devuelve `null`.
- `buildMarkers({ eventsByAlert, items, alertsById, chartTf, chartCandles, cutoffMs = Infinity }) -> SeriesMarker[]`.
  - Una marca por (alerta, vela del gráfico).
  - `bullish` → `{ position: 'belowBar', shape: 'arrowUp' }`. `bearish` → `{ position: 'aboveBar', shape: 'arrowDown' }`. `neutral` → `{ position: 'aboveBar', shape: 'circle' }`.
  - `color`: el del item. Si todos los eventos del bucket están suprimidos, `withAlpha(color, 0.35)` (importar `withAlpha` de `overlays/useChartOverlays.js`).
  - `text`: `'×N'` si N > 1, si no `''`.
  - `id`: `${alertId}:${bucketSec}`.
  - Omite los items `hidden` y los eventos con `time > cutoffMs`.
  - Devuelve las marcas ordenadas por `time`, como exige lightweight‑charts.
- `eventsInBucket(eventsByAlert, items, chartTf, chartCandles, bucketSec) -> Array<{ alertId, event }>`, para la tarjeta.

- [ ] **Step 1:** escribir los tests que fallan.
  - `un disparo 15m de las 14:15 cae en la vela 1h de las 14:00`.
  - `un disparo de las 15:00 cae en la vela 1h de las 14:00`.
  - `en un gráfico 1m cae en la vela de las 14:14`.
  - `tres disparos en la misma vela 4h → una marca '×3'`.
  - `bucket solo con suprimidos → color con alpha 0.35`.
  - `hidden no genera marcas`.
  - `cutoff de replay oculta los posteriores`.
  - `addAlert no pasa de 6 y asigna el primer color libre`.
- [ ] **Step 2:** `cd client && npx vitest run src/pages/TradingView/alertMarkers/markerModel.test.js`. Se espera FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** volver a ejecutarlos. Se espera PASS.
- [ ] **Step 5:** commit con el mensaje `feat(tradingview): alert marker model`.

### Task 5: Hooks de datos y dibujo

**Files:**
- Create: `alertMarkers/useAlertSelection.js`, `alertMarkers/useAlertBacktest.js` y `alertMarkers/useSeriesAlertMarkers.js`.
- Test: `alertMarkers/useAlertBacktest.test.jsx` y `alertMarkers/useAlertSelection.test.jsx`. Mockear `services/api`, siguiendo el estilo de `overlays/useChartOverlays.test.jsx`.

**Interfaces:**
- `useAlertSelection() -> { items, alerts, alertsById, loading, add(alertId), remove(alertId), toggleHidden(alertId), setColor(alertId, color) }`.
  - Al montar carga `alertsApi.list()` y `settingsApi.getChartAlertMarkers()`.
  - Cada cambio se aplica al momento y se guarda en segundo plano; si el guardado falla, se revierte el estado. Es el mismo patrón que el ojo de la leyenda (`TradingViewPage.jsx`, alrededor de `saveChartIndicators`).
  - Los items cuyo `alertId` ya no existe se conservan con estado `deleted`.
- `useAlertBacktest({ asset: { symbol, datasource }, items, alertsById, ranges: Array<{ fromMs, toMs }>, enabled }) -> { eventsByAlert: Record<alertId, BacktestEvent[]>, statusByAlert: Record<alertId, { state: 'loading'|'ready'|'error'|'deleted', partialFromMs?: number, insufficient?: number, sourceMismatch?: string, error?: string }>, retry(alertId) }`.
  - **Rango efectivo:** la unión `[min fromMs, max toMs]`.
  - **Borde derecho fijo** (sin actualización en vivo): se fija en la primera petición por (activo, alerta) y no se mueve aunque `toMs` crezca.
  - **Tramos:** de `MAX_EVALS_PER_REQUEST · baseTfMs`, desde el más reciente hacia atrás, sin pasar de `MAX_CHUNKS_PER_ALERT = 10`. `baseTimeframe` viene de la primera respuesta del servidor; hasta entonces se usa un primer tramo de 2000 velas de la temporalidad más baja calculada en el cliente con las reglas de `alertsById`.
  - **Caché** en memoria con clave `${alertId}:${updatedAt}:${datasource}:${symbol}`. Guarda los intervalos ya cubiertos y los eventos deduplicados por `time`.
  - Al ampliar `fromMs` solo se piden los huecos.
  - Si se llega al tope, `partialFromMs` toma el inicio cubierto.
  - **Errores:** el estado pasa a `error` y no se reintenta solo durante `ERROR_BACKOFF_MS` (importado de `overlays/useChartOverlays.js`).
  - `sourceMismatch = alert.datasource` cuando `alert.datasource !== asset.datasource`.
- `useSeriesAlertMarkers({ seriesRef, markers })`.
  - Crea un `createSeriesMarkers(series, [])` por serie y llama a `setMarkers(markers)` cuando cambian.
  - Si la serie se recrea, vuelve a enganchar el plugin.
  - Al desmontar llama a `detach()`.

- [ ] **Step 1:** escribir los tests que fallan.
  - `pide un tramo y expone eventos`.
  - `ampliar fromMs pide solo el hueco`.
  - `crecer toMs no pide nada` (sin actualización en vivo).
  - `updatedAt invalida la caché`.
  - `rango mayor que el tope queda parcial`: gráfico 1d con alerta 1m; se espera ≤ 10 llamadas y `partialFromMs` definido.
  - `alerta eliminada`: `alertsById` no la contiene, así que el estado es `deleted` y no hay llamada.
  - `error → estado error y retry vuelve a pedir`.
  - `useAlertSelection revierte si el guardado falla`.
- [ ] **Step 2:** `cd client && npx vitest run src/pages/TradingView/alertMarkers`. Se espera FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** volver a ejecutarlos. Se espera PASS.
- [ ] **Step 5:** commit con el mensaje `feat(tradingview): alert backtest data and marker hooks`.

### Task 6: UI — selector, chips y tarjeta de detalle

**Files:**
- Create: `alertMarkers/AlertPicker.jsx`, `alertMarkers/AlertChips.jsx` y `alertMarkers/AlertMarkerCard.jsx`, cada uno con su `.module.css` y su `.test.jsx`.

**Interfaces:**
- `AlertPicker({ open, mobile, alerts, items, onAdd, onRemove, onClose })`.
  - En escritorio es un modal; en móvil, un `components/BottomSheet`.
  - Lista las alertas con casilla, nombre, chip de dirección (reutilizar `pages/Alerts/components/Direction.jsx`), temporalidad base y número de reglas.
  - Con 6 seleccionadas, las demás casillas quedan deshabilitadas con el aviso «máximo 6».
  - Sin alertas: «No tienes alertas. Créalas en Alertas» con enlace a `/alerts`.
- `AlertChips({ mobile, items, alertsById, statusByAlert, countsByAlert, onToggleHidden, onRemove, onAdd, onRetry })`.
  - Cada chip lleva punto de color, nombre, contador de disparos (sin contar suprimidos), ojo y ✕.
  - Estados del chip:
    - Cargando: spinner.
    - Error: «Reintentar».
    - Borrada: «alerta eliminada».
    - Parcial: «desde {fecha}».
    - Fuente distinta: «evaluada con {fuente del gráfico}; la alerta usa {fuente}».
    - Insuficiente: «sin historia suficiente en parte del rango», solo si `insufficient > 0`.
  - En móvil los chips son botones de 44 px, como `OverlayChips`.
- `AlertMarkerCard({ mobile, entries: Array<{ alertId, event }>, alertsById, colorsById, index, onPrev, onNext, onClose, anchor? })`.
  - Muestra nombre, fecha y hora del cierre (hora local), temporalidad base, «Puntuación X% (umbral Y%)», la etiqueta «suprimido por cooldown» si aplica, y una línea por regla: ✅/❌, `indicatorType` y temporalidad, peso y `reason`.
  - Si una vela tiene varios eventos, los lista todos.
  - En móvil es un `BottomSheet` con «‹ anterior / siguiente ›», que recorre los eventos de esa alerta en orden temporal.
  - En escritorio se posiciona junto a `anchor` (x, y en el contenedor), sin salirse del contenedor.

- [ ] **Step 1:** escribir los tests que fallan.
  - Picker: deshabilita al llegar a 6 y muestra el estado vacío con enlace.
  - Chips: muestran el aviso de fuente distinta; el ojo llama a `onToggleHidden`; «Reintentar» llama a `onRetry`.
  - Tarjeta: muestra «Puntuación 83% (umbral 70%)» y ✅/❌ por regla; «siguiente» llama a `onNext`.
- [ ] **Step 2:** `cd client && npx vitest run src/pages/TradingView/alertMarkers`. Se espera FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** volver a ejecutarlos. Se espera PASS.
- [ ] **Step 5:** commit con el mensaje `feat(tradingview): alert picker, chips and detail card`.

### Task 7: Integración en `/trading-view` (escritorio, móvil y replay)

**Files:**
- Modify: `client/src/pages/TradingView/TradingViewPage.jsx`. Solo cableado; la lógica vive en `alertMarkers/`.
- Modify: `components/MobileTabBar.jsx`.

**Cableado:**
- `const selection = useAlertSelection()`.
- `ranges = [{ fromMs: candlesRef.current[0].time, toMs: last.time + tfMs }]`, recalculado cuando cambia `candleCount`.
- `useAlertBacktest({ asset, items: selection.items, alertsById: selection.alertsById, ranges, enabled: true })`.
- `markers = buildMarkers({ …, chartTf: timeframe, chartCandles: candlesRef.current, cutoffMs: replay.active ? replayCutoffMs : Infinity })`, con `replayCutoffMs = replay.progress.ltfTime + TF_MS[replay.subTf]`. Si `ltfTime` es null, se usa `anchor`.
- `useSeriesAlertMarkers({ seriesRef: candleSeriesRef, markers })`.
- **Escritorio:**
  - Botón «Alertas» en la barra, junto al de superponer, que abre `AlertPicker`.
  - `AlertChips` en una fila bajo `OverlayChips`, visible también en replay.
  - `chart.subscribeCrosshairMove` muestra la tarjeta al pasar por un bucket con eventos. `chart.subscribeClick` la fija; un clic fuera o Esc la cierra.
- **Móvil:**
  - Se añade una pestaña «Alertas» a `MobileTabBar` (`onAlerts`, `alertsCount`, icono nuevo en `components/icons.jsx`). Hay que verificar en 360 px que las 6 pestañas caben con su zona de 44 px. Si no caben, «Alertas» entra como segmento dentro de la hoja de Indicadores; anotar la decisión en el commit.
  - Tocar una vela con eventos abre `AlertMarkerCard` como hoja inferior.

- [ ] **Step 1:** escribir los tests que fallan en `TradingViewPage` (con el patrón de mocks existente):
  - Con una alerta seleccionada y un backtest mockeado, se llama a `createSeriesMarkers().setMarkers` con 1 marca `arrowUp`.
  - En replay con cutoff anterior al evento, `setMarkers([])`.
  - `MobileTabBar` muestra «Alertas» con contador.
- [ ] **Step 2:** ejecutarlos y comprobar que fallan.
- [ ] **Step 3:** implementar el cableado.
- [ ] **Step 4:** `cd client && npm test`. Se espera PASS, con la salvedad del `AutoTradingTab` inestable ya conocido (si falla en la suite completa, comprobarlo aislado).
- [ ] **Step 5:** commit con el mensaje `feat(tradingview): plot alert backtest markers on the main chart`.

### Task 8: Vista Multi‑TF

**Files:**
- Modify: `multi/SyncedChart.jsx` y `multi/MultiTimeframePage.jsx` (solo el modo Multi‑TF).
- Test: ampliar `multi/SyncedChart.test.jsx` y `multi/MultiTimeframePage.test.jsx`.

**Interfaces:**
- `SyncedChart` recibe dos props nuevas:
  - `alertMarkers?: { eventsByAlert, items, alertsById, cutoffMs? }`. Dentro llama a `buildMarkers` con su `timeframe` y su `candlesRef.current`, y a `useSeriesAlertMarkers({ seriesRef, markers })`.
  - `onLoadedRange?(index, { fromMs, toMs })`, que se llama tras cada carga.
  - El clic o toque en una marca abre `AlertMarkerCard`; en `compact`, como hoja inferior.
- `MultiTimeframePage` (modo Multi‑TF):
  - Usa un `useAlertSelection()` compartido, con la misma selección que `/trading-view`.
  - Usa un `useAlertBacktest({ asset, items, alertsById, ranges: rangesPorPanel, enabled: mode === 'tf' })`.
  - Pasa `alertMarkers` a cada panel.
  - Muestra `AlertChips` sobre la rejilla. El selector reutiliza `AlertPicker`.

- [ ] **Step 1:** escribir los tests que fallan.
  - Dos paneles (15m y 1h) con el mismo evento de las 14:15: la marca va en 14:00 (15m) y en 14:00 (1h).
  - Un único `alertsApi.backtest` por tramo, aunque haya 4 paneles.
- [ ] **Step 2:** ejecutarlos y comprobar que fallan.
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** `cd client && npm test`. Se espera PASS.
- [ ] **Step 5:** commit con el mensaje `feat(tradingview): alert markers in multi-timeframe view`.

### Task 9: E2E, verificación y documentación

**Files:**
- Create: `e2e/tradingview-alert-markers.spec.js`. Seguir el patrón de `e2e/tradingview-overlays.spec.js`, con `page.route` sobre `/api/`.
- Modify: `~/ObsidianVault/proyectos/testbotCobertura.md` (nota del proyecto).

- [ ] **Step 1:** escribir la E2E.
  - **Escritorio 1440×900:** abrir el selector, elegir una alerta y ver el chip con contador. Pasar sobre la marca muestra la tarjeta con «Puntuación». El ojo oculta las marcas. Al cambiar a 1h, la marca sigue ahí.
  - **Móvil 360×740:** pestaña «Alertas», selección, toque en la vela, hoja con «siguiente ›», y comprobar que no hay scroll horizontal (`document.documentElement.scrollWidth <= 360`).
  - **Multi‑TF:** los dos primeros paneles muestran la marca.
- [ ] **Step 2:** ejecutarla contra Docker en `:5174`: `npx playwright test e2e/tradingview-alert-markers.spec.js --config e2e/playwright-docker.config.js`. Se espera PASS.
  - Si el Docker del checkout principal lo está usando otra sesión, correrla contra el Vite del worktree y anotarlo, como se hizo con las superposiciones.
- [ ] **Step 3:** comprobación real.
  - Con `docker compose`, abrir `/trading-view` con una alerta real y comparar sus disparos recientes con `GET /api/alerts/:id/events`. Deben coincidir en tiempo los disparos no suprimidos, salvo los periodos en que el scheduler estuvo caído.
  - Anotar las diferencias.
- [ ] **Step 4:** `cd server && npm run check` y `cd client && npm test && npm run build`. Se espera PASS.
- [ ] **Step 5:** actualizar la nota del vault con la sección «Backtest de alertas en la gráfica (2026-10-21)»: qué hace, decisiones (fuente del gráfico, cooldown como en vivo, ventana de tiempo, punto de reinicio, tope 2000×10) y pendientes. Commit en el vault.
- [ ] **Step 6:** commit con el mensaje `test(tradingview): e2e for alert backtest markers`.
