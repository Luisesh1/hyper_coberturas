# Módulo de Opciones (Binance European Options) — diseño

Fecha: 2026-10-14 · Estado: aprobado para implementar en paralelo

## Objetivo

Una página nueva, **Opciones** (`/opciones`), para operar las opciones europeas de Binance (`eapi.binance.com`; BTC, ETH, BNB, SOL, XRP y DOGE, liquidadas en USDT). Tiene tres pestañas de subnavegación:

1. **Trading manual**: cadena de opciones con griegas, ticket de orden límite, posiciones, órdenes abiertas e historial.
2. **Estrategias**: estrategias automatizadas con tres modos: `paused`, `shadow` (trading en sombra: misma lógica con datos reales y llenados simulados) y `live` (órdenes reales).
3. **Backtesting**: corre una estrategia sobre el histórico con una fuente de precios elegible.

La API key de Binance se registra en **Configuración › Binance Opciones**.

**La app es responsiva y debe tener una UX móvil excelente.** En ≤768 px hay diseños específicos de teléfono, no solo columnas apiladas.

## Diseño visual (fuente de verdad)

Lienzo: https://claude.ai/artifact/4nBmfDwjexNffjiByC9Xco. Copia local de cada pantalla en `.dc.html`, en
`/tmp/claude-1000/-home-luis-Documentos-CODE-testbotCobertura/1e6c02e8-0626-4822-9c8e-f1049f02961e/scratchpad/opciones-design/project/`:

| Pantalla | Archivo |
|---|---|
| Trading manual (escritorio) | `Main.dc.html` |
| Estrategias (escritorio) | `Estrategias.dc.html` |
| Backtesting (escritorio) | `Backtesting.dc.html` |
| Configuración › Binance Opciones | `Config.dc.html` |
| Móvil · Trading manual (cadena Calls/Puts, ticket y posiciones en hojas inferiores con steppers) | `Movil-Trading.dc.html` |
| Móvil · Estrategias (lista de tarjetas + FAB «Nueva» → detalle a pantalla completa con modo segmentado) | `Movil-Estrategias.dc.html` |
| Móvil · Backtesting (resumen, hoja de configuración, CTA fijo abajo) | `Movil-Backtesting.dc.html` |

Usar los tokens de `client/src/styles/tokens.css` (los colores del diseño ya son esos), CSS modules e iconos SVG (no emoji), con objetivos táctiles de al menos 44 px. Los números van en `var(--font-mono)`. Para el corte móvil, reutilizar `useMediaQuery` como hace TradingView.

## Decisiones (valores por defecto tomados al implementar; el usuario puede cambiarlos)

- **Una cuenta de Binance por usuario**, guardada en la tabla `settings` con la clave `binance_options` y cifrada (se añade a `SENSITIVE_KEYS`). No es una tabla multicuenta.
- **Las estrategias son plantillas paramétricas**, no código JS libre: `short_strangle`, `covered_call` y `protective_put`.
- **El modo sombra no necesita API key** (solo datos públicos). El modo `live` exige credenciales, confirmación explícita (`confirm: true`) y respetar los límites globales y los de la estrategia. La sombra sigue corriendo en paralelo con el modo real.
- **Llenado simulado en sombra:** compra al ask y vende al bid del libro real del momento, más la comisión de Binance. Fórmula: mín(0,03 % del nocional del subyacente, 10 % de la prima).
- **Sin testnet:** la sombra cubre las pruebas seguras.
- **Fuentes del backtest:** `recorded` (snapshots horarios de la cadena que guarda la app), `dvol` (Black-Scholes con el DVOL histórico de Deribit, solo BTC/ETH, con sonrisa fija) y `realized` (volatilidad realizada a 30 días más una prima configurable; vale para todos). Binance no publica precios de opciones vencidas, así que la UI marca `dvol` y `realized` como estimaciones.
- Binance Opciones solo admite órdenes **LIMIT** (`postOnly` y `reduceOnly` son opcionales).

## Contratos compartidos

Respuestas con el formato del repo: `{ success: true, data }`. Errores con las clases de `server/src/errors/app-error`. Todo con `authenticate`. Nunca se devuelven ni se registran el secret ni la API key completa.

### Backend A: cliente, credenciales, mercado, trading manual

- `server/src/services/options/binance-options.client.js`: `createBinanceOptionsClient({ apiKey, apiSecret, baseUrl = 'https://eapi.binance.com', fetchImpl = fetch })`.
  - Públicos: `getExchangeInfo()`, `getMark(symbol?)`, `getTicker(symbol?)`, `getDepth(symbol, limit)`, `getIndex(underlyingPair)`.
  - Firmados (HMAC-SHA256, `X-MBX-APIKEY`, `recvWindow`): `getAccount()`, `getPositions()`, `getOpenOrders()`, `placeOrder({ symbol, side, quantity, price, postOnly, reduceOnly, clientOrderId })`, `cancelOrder({ symbol, orderId })` y `getUserTrades({ startTime })`.
  - Los errores de Binance se normalizan sin filtrar credenciales.
- `server/src/services/options/options-credentials.service.js`:
  - `get(userId)` → `{ configured, alias, apiKeyMasked }`.
  - `set(userId, { alias, apiKey, apiSecret })` (el secret vacío conserva el anterior) y `remove(userId)`.
  - `test(userId)` → `{ checks: [{ id, label, status: 'ok'|'warn'|'fail', detail }] }`: firma, cuenta de opciones, permiso de trading, restricción por IP (`warn` si no la hay) y retiros desactivados.
  - `getClientForUser(userId)` lanza un error si no hay credenciales.
  - `getLimits` / `setLimits(userId)` → `{ maxMarginUsdt, maxDailyLossUsdt, maxLiveStrategies, notifyTelegram }`, en la clave `options_limits`.
- `server/src/services/options/options-market.service.js` (solo datos públicos, caché de unos 5 s):
  - `listUnderlyings()` → `[{ underlying: 'BTC', spot, change24hPct }]`.
  - `getChain(underlying, expiry?)` → `{ underlying, spot, expiries: [{ code: 'YYMMDD', label, dte }], expiry, rows: [{ strike, call: Leg, put: Leg }] }`, donde `Leg = { symbol, bid, ask, mark, iv, delta, gamma, theta, vega, openInterest }`.
  - `getQuote(symbol)` → `Leg & { underlying, strike, type: 'C'|'P', expiry, spot }`. El motor de estrategias lo usa para los llenados en sombra.
- Rutas en `server/src/routes/options.routes.js`, montadas en `/options`:
  - `GET /options/underlyings`
  - `GET /options/chain?underlying=BTC&expiry=YYMMDD`
  - `GET /options/account` → `{ balanceUsdt, marginUsedUsdt, unrealizedPnlUsdt, greeks: { delta, gamma, theta, vega } }`
  - `GET /options/positions` → `[{ symbol, side, quantity, entryPrice, markPrice, unrealizedPnl, delta, theta, origin }]`. `origin` es `'manual'` o el nombre de la estrategia; se cruza con `options_strategy_positions`, que es de B y es opcional si la tabla no existe.
  - `GET /options/orders/open`
  - `POST /options/orders` → `{ symbol, side: 'BUY'|'SELL', quantity, price, postOnly?, reduceOnly? }`
  - `DELETE /options/orders/:symbol/:orderId`
  - `GET /options/trades?days=30`
- Rutas de configuración en `settings.routes.js`:
  - `GET`/`PUT`/`DELETE /settings/binance-options` y `POST /settings/binance-options/test`.
  - `GET`/`PUT /settings/options-limits`.
  - `GET /settings` añade `binanceOptions: { configured, alias }`.

### Backend B: estrategias, sombra/real, grabador de IV, backtesting

- Migración `server/src/db/migrations/031_options_module.sql`:
  - `options_strategies (id, user_id, name, template, underlying, params JSONB, limits JSONB, mode CHECK IN ('paused','shadow','live'), state JSONB, created_at BIGINT, updated_at BIGINT)`
  - `options_strategy_positions (id, strategy_id FK, user_id, mode CHECK IN ('shadow','live'), symbol, side, quantity, entry_price, exit_price, opened_at, closed_at, pnl_usdt, fees_usdt)`
  - `options_strategy_events (id, strategy_id FK, user_id, mode, action CHECK IN ('open','close','hold','skip','error'), detail TEXT, legs JSONB, premium_usdt, created_at)`
  - `options_iv_snapshots (id, underlying, symbol, expiry, strike, type, bid, ask, mark, iv, delta, spot, captured_at)` con un índice por `(underlying, captured_at)`
  - `options_backtests (id, user_id, strategy_id NULL, config JSONB, status CHECK IN ('queued','running','done','failed'), result JSONB, error TEXT, created_at, finished_at)`
- `server/src/services/options/options-pricing.js` (puro): `normCdf`, `blackScholes({ S, K, T, iv, type })`, `greeks(...)`, `impliedVol(...)`.
- `server/src/services/options/templates/{short-strangle,covered-call,protective-put}.js`: cada uno exporta `{ id, label, defaultParams, paramSchema, evaluate(ctx) }`, que es puro y devuelve acciones `open | close | hold | skip`. El mismo `evaluate` sirve al runner y al backtest.
- `options-strategy-runner.service.js`: evalúa cada 5 min. Recibe las dependencias de A (`getQuote`, `getChain`, `getClientForUser`) por inyección o con `require` perezoso, para que los tests no dependan del código de A. Los ejecutores sombra y real escriben posiciones y eventos. El real aplica los límites globales y los de la estrategia y avisa por Telegram si `notifyTelegram`. Se arranca y se para en `server/src/bootstrap/infra.js`.
- `options-iv-recorder.service.js`: guarda un snapshot horario de la cadena de cada subyacente.
- `options-backtest.service.js`: fuentes `recorded`, `dvol` (Deribit `public/get_volatility_index_data`) y `realized` (velas spot de Binance con el proveedor existente). Entrada: `{ strategyId | template+params, underlying, from, to, capitalUsdt, source, spreadPct, feePct, volPremiumPct }`. Resultado: `{ metrics: { returnPct, maxDrawdownPct, sharpe, wins, cycles, premiumUsdt, worstCycleUsdt }, equity: [{ t, strategy, hodl }], cycles: [{ openedAt, expiry, legs, premiumUsdt, exitReason, pnlUsdt }], sourceNote }`.
- Rutas:
  - `server/src/routes/options-strategies.routes.js`, montadas en `/options/strategies`: `GET /templates`, `GET /` (cada estrategia con `pnl30d: { shadow, live }`, `status` y `mode`), `POST /`, `GET /:id` (`kpis`, `equity: [{ t, shadow, live }]` y los últimos 100 `events`), `PUT /:id`, `PUT /:id/mode` → `{ mode, confirm }` (`live` sin `confirm` → 400) y `DELETE /:id`.
  - `server/src/routes/options-backtests.routes.js`, montadas en `/options/backtests`: `POST /` (crea la tarea y la ejecuta asíncrona), `GET /` y `GET /:id`.
  - Las dos se montan en `routes/index.js` **antes** de `/options`.

### Frontend C1: página, Trading manual, Configuración

- La ruta `/opciones` en `App.jsx` y su entrada en la navegación.
- `client/src/pages/Options/OptionsPage.jsx` con las pestañas sincronizadas con `?tab=manual|strategies|backtesting`. Importa `./strategies/StrategiesTab.jsx` y `./backtesting/BacktestingTab.jsx`; C1 deja stubs mínimos que C2 reemplaza.
- `client/src/pages/Options/manual/*`: Trading manual en escritorio y en móvil, según el diseño.
- `client/src/pages/Settings/components/BinanceOptionsSection.jsx`, su entrada en `SettingsSidebar` y los límites globales.
- Funciones nuevas en `client/src/services/api.js` **solo** para `/options/*` (las de A) y `/settings/binance-options*` y `/settings/options-limits`.

### Frontend C2: Estrategias y Backtesting

- `client/src/pages/Options/strategies/*` y `client/src/pages/Options/backtesting/*` (escritorio y móvil, según el diseño).
- Sus llamadas van en `client/src/pages/Options/optionsAutomationApi.js`, sobre el helper `request` de `client/src/services/api.js` (si no está exportado, se exporta con un cambio mínimo). No toca otras partes de `api.js`.

## Seguridad y pruebas

- Ningún test llama a Binance ni a Deribit de verdad: `fetch` siempre mockeado. Ningún agente envía órdenes reales.
- Servidor: `node --test` y `eslint`. Cliente: `vitest` y `eslint`. Hay que cubrir la firma HMAC, la confirmación de `live`, los límites de riesgo, el llenado en sombra, los templates, el pricing, el backtest (fuente `realized` con datos sintéticos) y los componentes principales, incluido el layout móvil.
- e2e con Playwright contra Docker en `localhost:5174`, a 390 px y en escritorio, con `/api/options*` mockeado.
