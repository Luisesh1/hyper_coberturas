# TradingView · Superposiciones (N activos y opciones de Deribit) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Superponer hasta 6 series (activos del catálogo u opciones de Deribit, vigentes o vencidas en el último año) sobre el gráfico de `/trading-view`, cada una con su propia escala. Una enfocada usa el eje izquierdo. Las opciones llevan barras y detalle de la prima pagada por operación. Escritorio y móvil.

**Architecture:**
- **Servidor:** un módulo `services/deribit/` en capas. Helpers puros de nombres, cliente HTTP con cola, transformaciones puras de velas y operaciones, y un servicio con cachés. Se expone en cuatro rutas nuevas bajo `/api/market/options/*`.
- **Cliente:** un modelo puro de superposiciones (estado, persistencia y alineación), un hook que gestiona las series de lightweight-charts dentro del chart existente, y componentes de UI (chips, tooltip, selector y piezas móviles). `TradingViewPage.jsx` solo los cablea.

**Tech Stack:**
- Node 18+ y Express, `node:test`.
- React 18, lightweight-charts 5.1, Vitest + Testing Library.
- Playwright contra Docker.

**Spec:** `docs/superpowers/specs/2026-10-21-tradingview-overlay-design.md` (lienzo: https://claude.ai/artifact/BiYrv6H1iw7KF3izAPKBBK, artboards 1 a 4 y A).

## Global Constraints

- **Paleta de superposiciones, en este orden:** `#f59e0b`, `#22d3ee`, `#a78bfa`, `#f472b6`, `#a3e635`, `#93c5fd`. Nunca el verde ni el rojo de las velas.
- **Límite:** `MAX_OVERLAYS = 6`. Pasado el tope, el botón se desactiva y explica el límite.
- **Escalas:**
  - El principal usa `right`.
  - La enfocada usa `left` (visible solo si hay alguna superposición visible).
  - El resto usa `ov-<id>`, invisible y con autoescala.
- **Grosores:** la enfocada 2.2 px y el resto 1.5 px.
- **Sin operaciones:** gris `#a8a29e`, línea discontinua 4/4.
- **Atenuación:** las velas del principal bajan a una opacidad aproximada de 0.55 si hay al menos una superposición visible.
- **Persistencia:** clave `localStorage` `tv_overlays_v1`, una lista global (no por activo).
- **Deribit:**
  - API: `https://www.deribit.com/api/v2/public`.
  - Operaciones: `https://history.deribit.com/api/v2/public/get_last_trades_by_instrument_and_time`.
  - Concurrencia 6 y reintento ante 429.
- **Nombres de contrato:**
  - Formato `ETH-31OCT25-4000-C`: día sin cero, mes en mayúsculas de 3 letras, año en 2 dígitos, decimal escrito con `d` (`XRP_USDC-5DEC25-2d2-C`).
  - Vencimiento a las 08:00 UTC.
- **Subyacentes:**
  - Inversos: BTC y ETH (prefijo igual al nombre, perpetuo `BTC-PERPETUAL` / `ETH-PERPETUAL`).
  - USDC: SOL, XRP, AVAX, TRX y HYPE (prefijo `<X>_USDC`).
  - Sin Deribit: BNB y DOGE.
- **Prima en USD:**
  - Inversas: `price × contracts × index_price` por operación, y `close × cierre del perpetuo` por vela.
  - USDC: `price × amount`, y `close` tal cual.
- **Correspondencia de temporalidades (de la app a la resolución de Deribit):** 1m→`1`, 5m→`5`, 15m→`15`, 1h→`60`, 4h→`60` agregado, 1d→`1D`, 1w→`1D` agregado, 1M→`1D` agregado.
  - 4h se alinea en múltiplos de 4 h UTC.
  - 1w empieza el lunes a las 00:00 UTC.
  - 1M empieza el día 1 a las 00:00 UTC (igual que Binance).
- **Vencidos ofrecidos:** solo los viernes del último año, verificados.
- **Strikes:** rejilla de ±30 % sobre el precio de Binance `<SUB>USDT` 7 días antes del vencimiento.
  - Pasos de strike: BTC `[1000,500]`, ETH `[50,25,100]`, SOL `[5,2,10]`, XRP `[0.1,0.05]`, AVAX `[1,0.5]`, TRX `[0.01,0.005]` y HYPE `[1,0.5]`.
- **Caché:** permanente para contratos vencidos; 10 s para los vigentes.
- **Textos de la UI (exactos):**
  - "Superponer", "Añadir", "Añadida" / "Añadido", "En el gráfico".
  - "Vigentes", "Vencidos · último año", "Buscando strikes · {n} de {total}", "Sin operaciones".
  - "Usar el eje izquierdo", "Intercambiar con {principal}", "Quitar superposición", "Volver a ahora", "eje izq.".
  - "Prima pagada: ${total} · {n} operaciones ({b} compras, {s} ventas)", "Σ ${x} en vista".
  - "BNB y DOGE no cotizan en Deribit", "Ocultar etiquetas" / "Mostrar etiquetas" (el renombre del ojo existente).
- **Móvil:**
  - `MOBILE_QUERY` de `useMediaQuery.js`: diseño propio, toques ≥44 px, selector en `BottomSheet` y opción en 3 pasos.
  - Tocar un chip lo enfoca. Tocar el enfocado abre la hoja de acciones.
- **Solo vista principal:** nada en `/trading-view/multi`. Una opción nunca pasa a ser el principal.
- **Replay activo:** las superposiciones se ocultan (las series se eliminan y se restauran al salir).
- **E2E:** contra Docker en `http://localhost:5174`, con la API simulada con `page.route` como en `e2e/tradingview-multi.spec.js`.

## Review Focus

1. **Huecos de mercado** (SPX sobre ETH en 1h, fin de semana): la línea se corta, nunca une el viernes con el lunes. Test en Task 6 (`alignToMain`) y en Task 7 (whitespace en `setData`).
2. **Opción vencida fuera del tramo cargado:** la vista salta a su vida, aparece "Volver a ahora", el polling se pausa, y "Volver a ahora" recarga el presente y reanuda el polling. Test en Task 8 y E2E en Task 11.
3. **Deribit caído o con 429 durante el sondeo de strikes:** el trabajo termina con los strikes encontrados y un `error`, y la UI no se queda en "Buscando…" para siempre. Test en Task 4 y en Task 9.
4. **Restaurar desde `localStorage` con datos corruptos**, más de 6 entradas o un id duplicado: se descarta lo inválido sin romper la página. Test en Task 6.
5. **Cambiar el principal a un activo que ya está superpuesto:** esa superposición no se dibuja y su chip dice "es el principal". Al volver, reaparece. Test en Task 6 (`isSameAsMain`) y en Task 8.

---

## File Structure

**Servidor (nuevo):**
- `server/src/services/deribit/deribit-instruments.js`: nombres, subyacentes, pasos y códigos de vencimiento (puro).
- `server/src/services/deribit/deribit.client.js`: HTTP con cola y reintentos.
- `server/src/services/deribit/option-series.js`: resolución, agregación, prima en USD, `traded` y buckets de operaciones (puro).
- `server/src/services/deribit/deribit-options.service.js`: vencimientos, trabajos de strikes, velas y operaciones, con cachés.
- **Modifica** `server/src/routes/market.routes.js`: 4 rutas.
- **Tests:** `server/test/deribit-instruments.test.js`, `deribit-client.test.js`, `option-series.test.js`, `deribit-options.service.test.js` y `market-options.routes.test.js`.

**Cliente (nuevo):**
- `client/src/pages/TradingView/overlays/overlayModel.js`: estado, persistencia, alineación y formato (puro).
- `client/src/pages/TradingView/overlays/useChartOverlays.js`: series en el chart, datos y focus.
- `client/src/pages/TradingView/overlays/OverlayChips.jsx` + `.module.css`: fila de chips y menú "⋯" (escritorio).
- `client/src/pages/TradingView/overlays/OverlayTooltip.jsx`: tooltip de escritorio y lectura móvil (`variant`).
- `client/src/pages/TradingView/overlays/OverlayPicker.jsx` + `.module.css`: modal (escritorio) y hoja (móvil), con las pestañas Activo y Opción.
- `client/src/pages/TradingView/overlays/OptionBrowser.jsx`: pestaña Opción (pastillas, vencimientos y strikes; 3 pasos en móvil).
- **Modifica** `client/src/services/api.js`: `marketApi.getOptionExpiries/getOptionStrikes/getOptionCandles/getOptionTrades`.
- **Modifica** `client/src/pages/TradingView/TradingViewPage.jsx`: cableado, botón, salto a la vida de la opción, Replay y renombre del ojo.
- **Modifica** `client/src/pages/TradingView/components/MobileTabBar.jsx`: pestaña "Superponer".
- **Tests:** un `*.test.js(x)` junto a cada archivo nuevo. E2E en `e2e/tradingview-overlays.spec.js`.

---

### Task 1: Nombres de contratos de Deribit

**Files:**
- Create: `server/src/services/deribit/deribit-instruments.js`
- Test: `server/test/deribit-instruments.test.js`

**Interfaces:**
- Produces:
  - `UNDERLYINGS: Record<'BTC'|'ETH'|'SOL'|'XRP'|'AVAX'|'TRX'|'HYPE', { prefix: string, currency: 'BTC'|'ETH'|'USDC', inverse: boolean, perpetual: string|null, binanceSymbol: string, strikeSteps: number[] }>`
  - `formatExpiryCode(expiryMs: number) => string` (`'31OCT25'`)
  - `parseExpiryCode(code: string) => number` (ms, 08:00 UTC)
  - `formatStrike(strike: number) => string` (`2.2 → '2d2'`)
  - `buildInstrumentName({ underlying, expiryMs, strike, type: 'C'|'P' }) => string`
  - `parseInstrumentName(name) => { underlying, prefix, expiryCode, expiryMs, strike, type, inverse } | null`
  - `fridaysBetween(fromMs, toMs) => number[]` (vencimientos de viernes a las 08:00 UTC)

- [ ] **Step 1: Write failing tests**
```js
assert.equal(formatExpiryCode(Date.UTC(2025, 9, 31, 8)), '31OCT25');
assert.equal(formatExpiryCode(Date.UTC(2026, 9, 9, 8)), '9OCT26');
assert.equal(parseExpiryCode('5DEC25'), Date.UTC(2025, 11, 5, 8));
assert.equal(formatStrike(2.2), '2d2'); assert.equal(formatStrike(4000), '4000'); assert.equal(formatStrike(0.105), '0d105');
assert.equal(buildInstrumentName({ underlying: 'XRP', expiryMs: Date.UTC(2025, 11, 5, 8), strike: 2.2, type: 'C' }), 'XRP_USDC-5DEC25-2d2-C');
assert.deepEqual(parseInstrumentName('ETH-31OCT25-4000-C'), { underlying: 'ETH', prefix: 'ETH', expiryCode: '31OCT25', expiryMs: Date.UTC(2025, 9, 31, 8), strike: 4000, type: 'C', inverse: true });
assert.equal(parseInstrumentName('SOL_USDC-21NOV25-140-P').inverse, false);
assert.equal(parseInstrumentName('ETH-PERPETUAL'), null);
assert.equal(UNDERLYINGS.BNB, undefined);
assert.deepEqual(fridaysBetween(Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 21)), [Date.UTC(2026, 9, 2, 8), Date.UTC(2026, 9, 9, 8), Date.UTC(2026, 9, 16, 8)]);
```
- [ ] **Step 2:** `cd server && node --test test/deribit-instruments.test.js` → FAIL (module not found)
- [ ] **Step 3:** Implement the exports above with the values from Global Constraints.
- [ ] **Step 4:** Same command → PASS
- [ ] **Step 5:** `git commit -m "feat(deribit): instrument naming helpers"`

### Task 2: Cliente HTTP de Deribit

**Files:**
- Create: `server/src/services/deribit/deribit.client.js`
- Test: `server/test/deribit-client.test.js`

**Interfaces:**
- Consumes: `httpClient` (`server/src/shared/platform/http/http-client.js`), inyectable.
- Produces: `createDeribitClient({ http = httpClient, concurrency = 6, maxRetries = 3, sleep } = {})`, que devuelve:
  - `getInstrument(name) => Promise<object|null>`: `null` cuando el error trae `data.reason === 'instrument not found'`.
  - `getInstruments({ currency, expired = false }) => Promise<object[]>`
  - `getChartData({ instrument, resolution, startMs, endMs }) => Promise<{ ticks:number[], open, high, low, close, volume }>`
  - `getTrades({ instrument, startMs, endMs }) => Promise<object[]>`: usa el host de historial, pagina con `has_more` (`count=1000`, `sorting='asc'`, avanza `start_timestamp` al último `timestamp + 1`) y corta en 50 páginas.
- Exporta también un `deribitClient` por defecto (singleton).

- [ ] **Step 1: Write failing tests** with a fake `http.get` that records calls:
  - `getInstrument` devuelve `null` ante `{ error: { data: { reason: 'instrument not found' } } }` (la respuesta 400 llega como `err.response.data`).
  - Un 429 y después un 200: reintenta y devuelve el resultado (con `sleep` falso).
  - `getTrades` encadena dos páginas (`has_more: true` y después `false`) y la segunda petición usa `start_timestamp = último.timestamp + 1`.
  - Concurrencia: con 10 llamadas simultáneas y `concurrency: 2`, el máximo en vuelo es 2.
- [ ] **Step 2:** `cd server && node --test test/deribit-client.test.js` → FAIL
- [ ] **Step 3:** Implement. Una cola simple (contador y FIFO de resolvers) y backoff `250ms × 2^intento`.
- [ ] **Step 4:** → PASS
- [ ] **Step 5:** `git commit -m "feat(deribit): rate-limited public client"`

### Task 3: Transformaciones de velas y operaciones de opciones

**Files:**
- Create: `server/src/services/deribit/option-series.js`
- Test: `server/test/option-series.test.js`

**Interfaces:**
- Produces:
  - `resolutionFor(timeframe) => { resolution: string, aggregateMs: number|null, calendar: 'week'|'month'|null }`
  - `chartDataToCandles(chartData) => Candle[]`, con `Candle = { time, open, high, low, close, volume, traded }` (`traded = volume > 0`).
  - `aggregateCandles(candles, timeframe) => Candle[]`: 4h, 1w o 1M. `traded` es verdadero si alguna vela está negociada. OHLC estándar.
  - `toUsdCandles(candles, { inverse, underlyingCloseByTime: Map<number, number> }) => Candle[]`: añade `premiumCoin` en las inversas. Una vela sin cierre del subyacente se descarta.
  - `bucketTrades(trades, timeframe, { inverse }) => Bucket[]`, con `Bucket = { time, premiumUsd, trades, buys, sells, top: Array<{ ts, side:'buy'|'sell', contracts, price, premiumUsd }> }`. `top` son las 3 de mayor `premiumUsd`, ordenadas de mayor a menor.

- [ ] **Step 1: Write failing tests**
  - `resolutionFor('4h')` → `{ resolution: '60', aggregateMs: 14_400_000, calendar: null }`.
  - `resolutionFor('1w').calendar === 'week'`.
  - **Agregación a 4h:** con cuatro velas de 1h desde `Date.UTC(2026,9,16,0)` resulta una sola vela con `time = Date.UTC(2026,9,16,0)`, `open` de la primera, `close` de la última, `high`/`low` extremos y `volume` sumado.
  - **Alineación:** una vela de 1h a las 03:00 cae en la de 00:00.
  - **Semana:** una vela 1D del miércoles 2026-10-14 se agrupa en el lunes `Date.UTC(2026,9,12)`.
  - `toUsdCandles([{ time:t, close:0.0002, … }], { inverse:true, underlyingCloseByTime:new Map([[t,3829.09]]) })[0].close ≈ 0.765818`.
  - `bucketTrades` con dos operaciones (`buy`: 8 contratos a 0.0002 con índice 3829.09; `sell`: 1 contrato a 0.0002 con índice 3822.5) en la misma hora: `premiumUsd ≈ 6.8909`, `trades = 2`, `buys = 1`, `sells = 1` y `top[0].side === 'buy'`.
  - En USDC, la prima es `price × amount`.
- [ ] **Step 2:** `cd server && node --test test/option-series.test.js` → FAIL
- [ ] **Step 3:** Implement. Funciones puras, sin I/O.
- [ ] **Step 4:** → PASS
- [ ] **Step 5:** `git commit -m "feat(deribit): option candle aggregation and premium buckets"`

### Task 4: Servicio de opciones de Deribit

**Files:**
- Create: `server/src/services/deribit/deribit-options.service.js`
- Test: `server/test/deribit-options.service.test.js`

**Interfaces:**
- Consumes: Tasks 1–3, más `marketDataService.getCandles(asset, timeframe, { datasource: 'binance', startTime, endTime, limit })` para el precio del subyacente.
- Produces: `createDeribitOptionsService({ client, marketData, now = Date.now })`, que devuelve:
  - `listExpiries(underlying) => Promise<Array<{ code, expiryMs, live }>>`
    - Vigentes: los de `getInstruments` sin duplicados, ordenados de menor a mayor.
    - Vencidos: `fridaysBetween(now - 365d, now)` que tengan algún strike real. Se verifica con `getInstrument` sobre el strike ATM de la rejilla y se cachea.
    - Orden: vigentes ascendentes y después vencidos descendentes.
  - `getStrikesJob(underlying, expiryCode) => { status: 'running'|'done'|'error', probed, total, spotRef, strikes: Array<{ strike, call: string|null, put: string|null, distancePct }>, error: string|null }`
    - Lanza el trabajo la primera vez y después devuelve su estado.
    - Si el vencimiento es vigente, se resuelve al instante con `getInstruments`.
    - Si es vencido, sondea la rejilla con `getInstrument` sobre la C y la P de cada strike.
    - `distancePct = (strike / spotRef - 1) × 100`.
    - Un error de red detiene el trabajo con `status: 'error'` y conserva lo encontrado.
  - `getCandles({ instrument, timeframe, startMs, endMs }) => Promise<Candle[]>`: en USD, agregadas y recortadas a `[startMs, endMs]`.
  - `getTradeBuckets({ instrument, timeframe, startMs, endMs }) => Promise<Bucket[]>`
- Cachés en memoria con clave por `instrument|resolution|rango redondeado al día`: permanente si `expiryMs < now`, 10 s si no.
- Exporta también un `deribitOptionsService` por defecto.

- [ ] **Step 1: Write failing tests** con un `client` y un `marketData` falsos:
  - **Strikes de un vencido:** con ETH a 2418 el 2026-10-03, los strikes 2400 y 2450 existen y el resto da `null`. El trabajo termina en `done` con esos dos, `distancePct` de 2400 ≈ −0.74, y `probed === total`.
  - **Error a mitad de sondeo** (Review Focus 3): `status === 'error'` y conserva los strikes hallados antes.
  - **Un vencimiento vigente** no llama a `getInstrument`.
  - **`getCandles` inversa:** la llamada pide `ETH-PERPETUAL` con la misma resolución y multiplica los cierres.
  - **Caché:** una segunda llamada para un vencido no vuelve a llamar al cliente, y para uno vigente sí, pasados 10 s del `now` falso.
- [ ] **Step 2:** `cd server && node --test test/deribit-options.service.test.js` → FAIL
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS
- [ ] **Step 5:** `git commit -m "feat(deribit): options service (expiries, strike probing, candles, trades)"`

### Task 5: Rutas y cliente de la API

**Files:**
- Modify: `server/src/routes/market.routes.js`, `client/src/services/api.js`
- Test: `server/test/market-options.routes.test.js` (con el patrón `withServer` de `server/test/options.routes.test.js`)

**Interfaces:**
- Consumes: el `deribitOptionsService` de la Task 4 (los tests lo sustituyen).
- Produces (todas `{ success: true, data }`):
  - `GET /api/market/options/expiries?underlying=ETH` → `listExpiries`
  - `GET /api/market/options/strikes?underlying=ETH&expiry=10OCT26` → `getStrikesJob`
  - `GET /api/market/options/candles?instrument=…&timeframe=1h&startTime&endTime` → `getCandles`
  - `GET /api/market/options/trades?instrument=…&timeframe=1h&startTime&endTime` → `{ buckets }`
  - Validación: un `underlying` fuera de `UNDERLYINGS` o un `instrument` que `parseInstrumentName` no entiende → 400 `ValidationError`.
  - Cliente: `marketApi.getOptionExpiries(underlying)`, `getOptionStrikes(underlying, expiry)`, `getOptionCandles({ instrument, timeframe, startTime, endTime })` y `getOptionTrades({ … })`, que devuelve `data.buckets`.

- [ ] **Step 1: Failing route tests:**
  - Las 4 rutas devuelven lo que dé el servicio sustituido.
  - `underlying=BNB` → 400.
  - `instrument=foo` → 400.
- [ ] **Step 2:** `cd server && node --test test/market-options.routes.test.js` → FAIL
- [ ] **Step 3:** Implement routes and the client methods.
- [ ] **Step 4:** → PASS, then `cd server && npm test` → 0 failing
- [ ] **Step 5:** `git commit -m "feat(market): Deribit option routes"`

### Task 6: Modelo de superposiciones (cliente, puro)

**Files:**
- Create: `client/src/pages/TradingView/overlays/overlayModel.js`
- Test: `client/src/pages/TradingView/overlays/overlayModel.test.js`

**Interfaces:**
- Produces:
  - `OVERLAY_PALETTE`, `MAX_OVERLAYS = 6`, `OVERLAYS_STORAGE_KEY = 'tv_overlays_v1'`
  - `Overlay = { id, kind: 'asset'|'option', color, hidden, asset?: { symbol, datasource, name }, option?: { instrument, underlying, expiryMs, strike, type } }`
  - `OverlayState = { items: Overlay[], focusedId: string|null }`
  - `overlayId(spec) => string`: `asset:<datasource>:<symbol>` u `option:<instrument>`.
  - `addOverlay(state, spec) => state`
    - No hace nada si el id ya existe o si ya hay `MAX_OVERLAYS`.
    - Asigna el primer color libre de la paleta.
    - Si no había ninguna enfocada, la nueva queda enfocada.
  - `removeOverlay(state, id)`: si era la enfocada, el foco pasa a la primera visible que quede.
  - `toggleHidden(state, id)`, `focusOverlay(state, id)`, `setColor(state, id, color)`
  - `loadOverlays(storage) => OverlayState` y `saveOverlays(storage, state)`: descarta lo inválido, los duplicados y lo que pase de 6; ante JSON corrupto devuelve el estado vacío.
  - `isSameAsMain(overlay, mainAsset) => boolean`
  - `alignToMain(mainCandles, overlayCandles, tfMs) => Array<{ time: number /*s*/, value?: number, traded?: boolean }>`
    - Una entrada por vela del principal.
    - Toma la vela del superpuesto cuya apertura cae en `[main.time, main.time + tfMs)`.
    - Si no hay ninguna, deja un hueco: `{ time }` sin `value`.
  - `splitTraded(points) => { traded: Point[], untraded: Point[] }`: los segmentos que llegan a un punto no negociado van a `untraded`, incluido el punto de partida. Cada lista lleva huecos donde la otra dibuja.
  - `shortLabel(overlay) => string` (`'ETH 31 oct · C 2500'` o `'BTC/USDT'`)
  - `formatUsdCompact(n) => string` (`84061 → '$84.1k'`)

- [ ] **Step 1: Write failing tests**, entre ellos los de Review Focus 1, 4 y 5:
  - El 7.º `addOverlay` no cambia el estado.
  - Los colores van en orden y se reutilizan tras quitar uno.
  - `loadOverlays` con `'{bad'` → `{ items: [], focusedId: null }`.
  - Con 8 entradas, carga 6. Con un id duplicado, se queda con uno.
  - `alignToMain`: un principal de 1h con 72 velas desde el viernes 20:00 UTC y un superpuesto sin velas el sábado y el domingo da puntos sin `value` en el fin de semana.
  - Una vela de Yahoo a las 13:30 cae en la del principal de 13:00.
  - `splitTraded` con `[T, T, U, U, T]` deja en `untraded` los segmentos 1→2 y 2→3; el 3→4 va a `traded` (un segmento es `untraded` si y solo si su punto final no está negociado).
  - `isSameAsMain({kind:'asset', asset:{symbol:'BTC', datasource:'binance'}}, {symbol:'BTC', datasource:'binance'}) === true`
- [ ] **Step 2:** `cd client && npx vitest run src/pages/TradingView/overlays/overlayModel.test.js` → FAIL
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS
- [ ] **Step 5:** `git commit -m "feat(tradingview): overlay model, persistence and alignment"`

### Task 7: Hook `useChartOverlays`

**Files:**
- Create: `client/src/pages/TradingView/overlays/useChartOverlays.js`
- Test: `client/src/pages/TradingView/overlays/useChartOverlays.test.jsx` (chart falso con `addSeries`, `removeSeries`, `priceScale(id).applyOptions` y series con `setData`/`applyOptions` que registran llamadas, como `multi/SyncedChart.test.jsx`)

**Interfaces:**
- Consumes: Task 6 y `marketApi` (`getCandles`, `getOptionCandles`, `getOptionTrades`).
- Produces: `useChartOverlays({ chartRef, candleSeriesRef, mainAsset, timeframe, enabled /* !replayActive */ })`, que devuelve:
  - `state: OverlayState`, `add(spec)`, `remove(id)`, `toggleHidden(id)`, `focus(id)`, `setColor(id, c)`
  - `syncMain(mainCandles)`: hay que llamarla después de `loadData`, de cargar historial y de cada tick de polling. Pide a cada superposición solo el tramo nuevo y vuelve a alinear.
  - `valuesAt(timeSec) => Array<{ id, label, color, value, changePct, traded, lastTradeAgoH, bucket: Bucket|null }>`: solo las visibles que no sean el principal.
  - `visiblePremiumSum => number|null` (la opción enfocada en el rango visible)
  - `status: Record<id, 'loading'|'ready'|'empty'|'error'|'isMain'>`
- **Series de cada superposición:**
  - Activo: un `LineSeries`.
  - Opción: dos `LineSeries`, una negociada (sólida) y otra sin operaciones (`#a8a29e`, `lineStyle: LineStyle.Dashed`).
  - Escala: `priceScaleId` = `'left'` si es la enfocada; si no, `'ov-<id>'`, con `chart.priceScale('ov-<id>').applyOptions({ visible:false, scaleMargins:{ top:0.12, bottom:0.12 } })`.
- **Barras de prima pagada:** un `HistogramSeries` en `priceScaleId 'ov-trades'` con `scaleMargins { top: 0.85, bottom: 0 }`, solo si la enfocada es una opción. Dos series apiladas: compras al 75 % de opacidad del color y ventas (total) al 32 %, dibujadas detrás.
- **Escala izquierda:** `chart.applyOptions({ leftPriceScale: { visible: hayVisibles, borderColor } })`, con las etiquetas en el color de la enfocada (`textColor`).
- **Atenuación:** `candleSeriesRef.current.applyOptions` con los colores de velas en `rgba(..., 0.55)` si hay alguna visible; si no, los de `THEME`.
- Persiste con `saveOverlays(localStorage)` en cada cambio y restaura con `loadOverlays` al montar.
- Si `enabled === false` elimina todas las series. Al volver a `true` las recrea.

- [ ] **Step 1: Failing tests:**
  - Al añadir un activo se crea un `LineSeries` con `priceScaleId 'left'`. El segundo va a `'ov-<id>'` y `focus(id2)` intercambia los dos `priceScaleId`.
  - Una opción enfocada crea un `HistogramSeries`; enfocar un activo lo elimina.
  - `isMain`: si el principal es el mismo activo, no hay serie y `status = 'isMain'`.
  - `setData` recibe los huecos de `alignToMain` (puntos sin `value`).
  - Con `enabled=false` no quedan series.
  - Sin superposiciones visibles, `leftPriceScale.visible` es `false` y las velas vuelven a sus colores.
- [ ] **Step 2:** `cd client && npx vitest run src/pages/TradingView/overlays/useChartOverlays.test.jsx` → FAIL
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS
- [ ] **Step 5:** `git commit -m "feat(tradingview): chart overlays hook (N series, focus, premium histogram)"`

### Task 8: Chips, tooltip e integración en escritorio

**Files:**
- Create: `overlays/OverlayChips.jsx` + `OverlayChips.module.css`, `overlays/OverlayTooltip.jsx`
- Modify: `client/src/pages/TradingView/TradingViewPage.jsx`
- Test: `overlays/OverlayChips.test.jsx`, `overlays/OverlayTooltip.test.jsx`, y una prueba de integración en `TradingViewPage` si ya existe una base de tests para la página (si no, la cubre la E2E de la Task 11).

**Interfaces:**
- Consumes: Task 7.
- Produces:
  - `<OverlayChips overlays focusedId status values premiumSum mainLabel onFocus onToggleHidden onRemove onSwap onColor onAdd max={6} />`
  - `<OverlayTooltip variant="desktop"|"mobile" time main={{ label, value, changePct }} rows={valuesAt(t)} />`
- **Comportamiento de los chips (artboard 1):**
  - El enfocado lleva borde y fondo en su color, y "eje izq.".
  - Un clic en el cuerpo del chip lo enfoca.
  - El menú "⋯" tiene "Usar el eje izquierdo", "Intercambiar con {principal}" (solo activos), "Color" (los colores libres de la paleta) y "Quitar superposición".
  - Un chip oculto se ve tachado y con borde discontinuo.
  - Con `status 'isMain'` dice "es el principal".
  - Con `status 'empty'` dice "Sin datos en este rango". Con `'error'` dice "Error al cargar · Reintentar".
  - Al final va el botón "Añadir".
  - La fila hace scroll horizontal.
- **Tooltip:**
  - Una fila por serie.
  - En la fila de una opción, el bloque "Prima pagada: … · N operaciones (b compras, s ventas)" con las 3 mayores (`HH:MM compra 120 × 0.0068 ETH = $1,979`).
  - "Última operación hace N h" cuando la vela no está negociada.
- **Cambios en la página:**
  - Botón "Superponer {n}/6" en `toolbarDesktop`.
  - Llamadas a `syncMain` en `loadData`, `fetchMoreHistory` y el tick de polling.
  - `enabled: !replayActive`.
  - Renombrar el `title`/`aria-label` del ojo existente a "Ocultar etiquetas" / "Mostrar etiquetas".
  - "Intercambiar": `setAsset(overlay.asset)` y añadir el principal anterior como superposición en el mismo hueco y con el mismo color.
- **Salto a la vida de la opción** (Review Focus 2):
  - Al añadir una opción con `expiryMs < candles[0].time`, la página llama a `loadData({ endTime: expiryMs + 1 día })`. `loadData` pasa a aceptar `{ endTime }` opcional, carga 500 velas que terminan ahí, guarda `historicalView = true` y encuadra `[expiryMs − 7 d, expiryMs]` con `setVisibleRange`.
  - Con `historicalView` activo:
    - Se muestra un botón flotante "Volver a ahora".
    - El polling no arranca (dependencia del efecto 4).
    - Al llegar al borde derecho se cargan velas hacia delante (`startTime = newest + 1`) hasta el presente; al alcanzarlo, `historicalView = false`.
    - "Volver a ahora" llama a `loadData()`.

- [ ] **Step 1: Failing tests:**
  - **Chips:**
    - Al hacer clic en el cuerpo de un chip no enfocado se llama a `onFocus(id)`.
    - El menú de una opción no muestra "Intercambiar".
    - Con 6 superposiciones, "Añadir" queda desactivado con el `title` "Máximo 6 superposiciones".
    - Un chip `isMain` muestra "es el principal".
  - **Tooltip:** con un bucket `{ premiumUsd: 3591, trades: 7, buys: 4, sells: 3, top:[…] }` se ve "Prima pagada: $3,591 · 7 operaciones (4 compras, 3 ventas)".
- [ ] **Step 2:** `cd client && npx vitest run src/pages/TradingView/overlays` → FAIL
- [ ] **Step 3:** Implement components and page wiring.
- [ ] **Step 4:** `cd client && npx vitest run` → 0 failing
- [ ] **Step 5:** `git commit -m "feat(tradingview): overlay chips, tooltip and desktop wiring"`

### Task 9: Selector (pestañas Activo y Opción)

**Files:**
- Create: `overlays/OverlayPicker.jsx` + `.module.css`, `overlays/OptionBrowser.jsx`
- Modify: `TradingViewPage.jsx` (abrir y cerrar)
- Test: `overlays/OverlayPicker.test.jsx`, `overlays/OptionBrowser.test.jsx`

**Interfaces:**
- Consumes: `marketApi.getCatalog`, `marketApi.getOptionExpiries/getOptionStrikes`, y el `state`/`add`/`remove` de la Task 7.
- Produces:
  - `<OverlayPicker open mobile state mainAsset onAdd onRemove onClose />`: modal en escritorio (artboard 2) y `BottomSheet` en móvil (artboard 4).
  - `<OptionBrowser mobile mainUnderlying addedIds onAdd />`
- **Pestaña Activo:**
  - Arriba, la sección "En el gráfico" (tocar "Añadido" lo quita).
  - Debajo, el catálogo con búsqueda y categorías, igual que en `AssetPickerModal`, con "+ Añadir".
  - No ofrece el activo principal.
- **Pestaña Opción:**
  - Pastillas de subyacente, con preselección de la del principal si existe. Si el principal es BNB o DOGE, la nota "BNB y DOGE no cotizan en Deribit".
  - Lista de vencimientos con buscador y los grupos "Vigentes" y "Vencidos · último año" (relativos "en 3 d" / "hace 11 d").
  - Tabla de strikes con las columnas Strike, Distancia, CALL y PUT. El ATM se marca (el de menor `|distancePct|`). Se ve "Añadida" en lo que ya está y "Sin operaciones" atenuado cuando la opción no tiene `call`/`put`.
  - Mientras `status === 'running'`, consulta `getOptionStrikes` cada 800 ms y muestra "Buscando strikes · {probed} de {total}".
  - Con `status === 'error'` muestra los strikes hallados y "No se pudieron revisar todos los strikes · Reintentar".
- **Móvil:** la pestaña Opción va en 3 pasos (subyacente, vencimiento, strike), con botón atrás y el paso visible arriba.
- Contador "{n} de 6 en uso". Se pueden añadir varias sin cerrar. Botón "Listo".

- [ ] **Step 1: Failing tests** (API simulada):
  - **Sondeo de strikes:** con un `running` y después un `done` se ve el progreso y luego la tabla.
  - **Fallo de Deribit** (Review Focus 3): con `error` aparece "Reintentar" y la tabla parcial.
  - Al añadir una CALL se llama a `onAdd` con `{ kind:'option', option:{ instrument:'ETH-10OCT26-2400-C', … } }`.
  - En móvil hay 3 pasos y "atrás" vuelve al vencimiento.
  - La pestaña Activo no lista el principal.
- [ ] **Step 2:** `cd client && npx vitest run src/pages/TradingView/overlays/OverlayPicker.test.jsx src/pages/TradingView/overlays/OptionBrowser.test.jsx` → FAIL
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS
- [ ] **Step 5:** `git commit -m "feat(tradingview): overlay picker with Deribit option browser"`

### Task 10: Móvil

**Files:**
- Modify: `TradingViewPage.jsx`, `components/MobileTabBar.jsx`, `overlays/OverlayChips.jsx` (variante `mobile`) y `overlays/OverlayTooltip.jsx` (variante `mobile`)
- Test: `components/MobileTabBar` (añadir caso) y `overlays/OverlayChips.test.jsx` (caso móvil)

**Interfaces:**
- `MobileTabBar` recibe `overlaysCount` y `onOverlays`. La nueva pestaña "Superponer" lleva una insignia con el número.
- `OverlayChips` con `mobile`:
  - Pastillas de 40 px de alto (zona táctil ≥44 px con padding): punto de color y `shortLabel`, más un "+" redondo.
  - Tocar uno no enfocado → `onFocus`.
  - Tocar el enfocado → abre una `BottomSheet` "Acciones" con "Ocultar", "Quitar superposición" y, solo en activos, "Ver en grande" (= intercambiar).
- `OverlayTooltip variant="mobile"`: se muestra en la barra de lectura inferior existente, con una línea por serie. El bloque de prima pagada es una fila plegable ("Prima pagada $3,591 · 7 ops (4 C / 3 V)") que se despliega con las 3 mayores.

- [ ] **Step 1: Failing tests:**
  - **Chips móviles:** tocar el enfocado abre la hoja con "Ver en grande" si es un activo y sin ella si es una opción.
  - **`MobileTabBar`:** la pestaña "Superponer" muestra la insignia `3`.
- [ ] **Step 2:** `cd client && npx vitest run src/pages/TradingView` → FAIL
- [ ] **Step 3:** Implement following artboards 3 and 4.
- [ ] **Step 4:** `cd client && npx vitest run` → 0 failing
- [ ] **Step 5:** `git commit -m "feat(tradingview): mobile overlays (chips, actions sheet, readout, tab)"`

### Task 11: E2E y verificación en Docker

**Files:**
- Create: `e2e/tradingview-overlays.spec.js` (mocks de `/api/*` con `page.route`, mismo patrón que `e2e/tradingview-multi.spec.js`)

- [ ] **Step 1: Write specs:**
  1. **Superponer BTC y SOL sobre ETH:** aparecen 2 chips y la primera tiene "eje izq.". Un clic en el chip de SOL mueve "eje izq." a SOL.
  2. **Ocultar BTC:** el chip queda tachado. Tras recargar la página, siguen las 2 superposiciones y BTC sigue oculta.
  3. **Superponer `ETH-31OCT25-4000-C`** (vencida; mocks de expiries, strikes `done` y candles/trades): la vista salta y aparece "Volver a ahora". En el tooltip, al pasar el puntero sobre una vela negociada, se ve "Prima pagada". "Volver a ahora" hace desaparecer el botón.
  4. **Tope:** con 6 añadidas, "Añadir" queda desactivado.
  5. **Móvil** (viewport 390×844): se abre "Superponer" desde la barra de pestañas, se añade BTC, y al tocar el chip enfocado aparece la hoja de acciones con "Ver en grande".
  6. **Replay:** al activarlo, los chips desaparecen o se desactivan y vuelven al salir.
- [ ] **Step 2:** Rebuild the frontend container and run: `docker compose up -d --build frontend && npx playwright test e2e/tradingview-overlays.spec.js` → todos PASS
- [ ] **Step 3:** `cd server && npm test` y `cd client && npx vitest run` → 0 failing
- [ ] **Step 4:** `git commit -m "test(e2e): tradingview overlays"`
