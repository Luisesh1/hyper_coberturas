# Trading automatizado por alertas y dirección de las alertas — diseño

Fecha: 2026-10-15 · Estado: aprobado por el usuario para implementar en paralelo.
Base: el módulo de Opciones (`docs/superpowers/specs/2026-10-14-options-module-design.md`).

## Objetivo

1. **Las alertas tienen dirección**: `bullish` (alcista), `bearish` (bajista) o `neutral`. Así cualquier consumidor sabe hacia qué lado apunta una señal.
2. **Pestaña nueva en Opciones, «Trading automatizado»** (`?tab=auto`): bots que abren y cierran opciones de Binance cuando se disparan alertas alcistas o bajistas.

La app es responsiva y la UX móvil debe ser excelente: hay diseños específicos para teléfono.

## Diseño visual (fuente de verdad)

El lienzo es https://claude.ai/artifact/4nBmfDwjexNffjiByC9Xco, en la fila «Trading automatizado por alertas». Copias locales en `/tmp/claude-1000/-home-luis-Documentos-CODE-testbotCobertura/1e6c02e8-0626-4822-9c8e-f1049f02961e/scratchpad/opciones-design/project/`:

| Pantalla | Archivo |
|---|---|
| Pestaña Trading automatizado (escritorio) | `AutoTrading.dc.html` |
| Pestaña Trading automatizado (móvil: lista + «Última señal» + FAB → detalle a pantalla completa) | `Movil-AutoTrading.dc.html` |
| Alertas con dirección (escritorio: filtro por dirección, chip en la lista, selector en «General», vista previa de Telegram, «Usada por») | `Alertas-Direccion.dc.html` |
| Editar alerta (móvil: selector grande de dirección, CTA fijo abajo) | `Movil-Alertas.dc.html` |

La dirección no se distingue solo por color: Alcista lleva un triángulo hacia arriba y verde, Bajista un triángulo hacia abajo y rojo, Neutral una barra gris. Los iconos son SVG y los objetivos táctiles miden al menos 44 px.

## Decisiones

- **Las alertas que ya existen pasan a `neutral`**, para que ninguna empiece a operar sola. Las plantillas del cliente traen dirección: sobreventa y cruces alcistas → `bullish`; sobrecompra y cruces bajistas → `bearish`; el resto → `neutral`.
- **Un bot es una estrategia de opciones** con `template = 'alert_signal'`. Reutiliza los modos, la sombra paralela, los límites, la confirmación para pasar a Real, los KPIs, `usage`, los eventos y la liquidación del runner. `GET /options/strategies` **excluye** `alert_signal`; la pestaña Estrategias no los muestra.
- **Cada bot elige su estructura**:
  - `buy_with` (comprar a favor): alcista → compra call, bajista → compra put.
  - `sell_against` (vender en contra): alcista → vende put, bajista → vende call.
- **La entrada la dispara la alerta, en el momento**: cuando la alerta supera el umbral (respetando su cooldown), el bot se evalúa con esa señal. Las salidas (toma de ganancia, stop, salida por tiempo) se evalúan en el tick de 5 min del runner. Una prueba manual de alerta («Probar», dry-run) **no** emite señal.
- **Activo → subyacente**: se quita el sufijo `USDT`/`USDC`/`USD` y se mayusculiza (`BTCUSDT` → `BTC`). Una señal solo cuenta si ese subyacente está en `UNDERLYINGS` y coincide con el `underlying` del bot.

## Contratos

### A · Alertas con dirección (full-stack)

**Servidor:**
- Migración `server/src/db/migrations/032_alert_direction.sql`:
  - `alerts.direction VARCHAR(10) NOT NULL DEFAULT 'neutral' CHECK (direction IN ('bullish','bearish','neutral'))`.
  - `alert_events.direction VARCHAR(10)`, nullable: es la foto de la dirección en el momento del disparo.
- `alerts.service.js`:
  - `direction` en el schema zod (opcional, por defecto `'neutral'`), en el DTO y en el payload de la fila.
  - Se guarda en el evento.
  - `buildAlertMessage` antepone `🟢 ALCISTA · ` o `🔴 BAJISTA · ` al título; neutral queda como hoy.
- Emisor de eventos nuevo, `server/src/services/alerts/alert-events.js`:
  - `onAlertTriggered(listener) → unsubscribe` y `emitAlertTriggered(payload)`.
  - Los listeners se llaman de forma asíncrona y aislada: un error se loguea y no rompe la alerta ni a otros listeners.
  - `payload = { userId, alertId, alertName, direction, asset, score, thresholdPercent, eventId, candleCloseTime, triggeredAt }`.
  - Se emite **solo** cuando `evaluateAlertOnAsset` registra un disparo real. Se añade la opción `emitSignal` (por defecto `true`), y `testAlertNow`/`triggerNow` manual la pasan a `false`.
- `GET /alerts` ya devuelve `direction` en cada alerta.

**Cliente** (`client/src/pages/Alerts/`):
- Selector «Dirección de la señal» en «General».
- Chip de dirección en la lista y filtro Todas / Alcistas / Bajistas / Neutrales.
- Vista previa del encabezado de Telegram.
- Dirección por defecto en `lib/presets.js`.
- «Usada por N bots»: se calcula llamando a `GET /options/auto-bots` y contando los `alertIds`. Si falla, se oculta sin error.
- Aviso al pasar a Neutral una alerta que usan bots.
- Móvil según `Movil-Alertas.dc.html`.

### B · Motor de bots (servidor)

- Migración `server/src/db/migrations/033_options_auto_bots.sql`:
  - Recrea el CHECK de `options_strategies.template` para admitir `alert_signal`.
  - Tabla `options_auto_signals (id BIGSERIAL, strategy_id FK ON DELETE CASCADE, user_id, alert_id, alert_event_id, alert_name, direction, asset, score NUMERIC, decision VARCHAR(12) CHECK IN ('opened','closed','reversed','ignored','error'), detail TEXT, created_at BIGINT)`.
  - Índice por `(strategy_id, created_at DESC)` y único por `(strategy_id, alert_event_id)`, para no procesar dos veces el mismo disparo.
- Plantilla `server/src/services/options/templates/alert-signal.js` (`id: 'alert_signal'`).
  - Parámetros: `alertIds: number[]`, `structure: 'buy_with'|'sell_against'`, `targetDelta` (0,35 al comprar, 0,25 al vender), `expiryDays` (7), `quantity`, `onOpposite: 'reverse'|'close'|'ignore'` (por defecto `reverse`), `takeProfitPct` (80 al comprar, 50 al vender), `stopLossPct` (50 al comprar, 200 al vender), `exitHoursBeforeExpiry` (12), `maxOpenPositions` (1), `maxTradesPerDay` (4) y `maxPremiumUsdt` (solo al comprar).
  - `evaluate(ctx)` es pura.
    - Sin `ctx.signal`: solo salidas (toma de ganancia, stop, tiempo).
    - Con `ctx.signal = { direction, ... }`, aplica en este orden:
      1. Con posición contraria y `onOpposite`: `close`, o `close` + `open`.
      2. Con el máximo de posiciones abiertas o de operaciones del día alcanzado: `skip` con el motivo.
      3. Si no: `open` de una pata elegida por delta en el vencimiento más cercano a `expiryDays`.
- `options-strategy-runner.service.js`:
  - `runStrategy(strategy, tickCtx)` pasa `tickCtx.signal` a `evaluate`.
  - Expone `runForSignal(strategy, signal)`, que crea el contexto como `tick()` y devuelve las acciones y los eventos producidos, para que el servicio de bots decida qué registrar.
  - El tick de 5 min sigue evaluando las salidas de los `alert_signal`.
- `server/src/services/options/options-auto-trading.service.js`:
  - `start()` se suscribe a `onAlertTriggered` y `stop()` cancela la suscripción. Se arranca y se para en `bootstrap/infra.js`.
  - Por cada disparo busca los bots del usuario que no estén en pausa, cuyo `params.alertIds` incluya `alertId` y cuyo `underlying` corresponda al activo. Corre `runForSignal` y guarda una fila en `options_auto_signals` con la decisión.
  - Una alerta `neutral` produce `ignored` con el detalle «Alerta neutral».
  - El mismo `alert_event_id` nunca se procesa dos veces.
- Rutas `server/src/routes/options-auto-bots.routes.js`, montadas en `/options/auto-bots` antes de `/options`:
  - `GET /` → `[{ ...estrategia, alerts: [{ id, name, direction, assetList }], pnl30d: { shadow, live }, status, lastSignal }]`.
  - `GET /eligible-alerts?underlying=BTC` → las alertas del usuario no neutrales cuyo `assetList` corresponde al subyacente: `[{ id, name, direction, assetList, thresholdPercent }]`.
  - `POST /` → `{ name, underlying, alertIds, params, limits? }`. Se crea en modo `shadow`. Valida que las alertas sean del usuario, no neutrales y del mismo subyacente (si no, 400).
  - `PUT /:id` → `{ name?, alertIds?, params?, limits? }`, con la misma validación.
  - `GET /:id/signals?limit=100&filter=all|traded|ignored` → `[{ id, alertId, alertName, direction, asset, score, decision, detail, createdAt }]`.
  - Detalle, cambio de modo (con `confirm`) y borrado van por `/options/strategies/:id`, que ya existen y también funcionan para estos bots.

### C · Pestaña Trading automatizado (cliente)

- En `OptionsPage.jsx`, `OPTION_TABS` gana `{ key: 'auto', label: 'Trading automatizado', short: 'Auto' }` entre Estrategias y Backtesting, con un icono de rayo en SVG.
- `client/src/pages/Options/auto/AutoTradingTab.jsx` y sus componentes, según `AutoTrading.dc.html` y `Movil-AutoTrading.dc.html`.
- Llamadas en `client/src/pages/Options/autoTradingApi.js` (rutas `/options/auto-bots*`). Reutiliza `optionsAutomationApi.optionsStrategiesApi` para `get` (detalle con kpis/usage/events), `setMode` (con diálogo de confirmación para Real; se puede reutilizar `strategies/LiveConfirmDialog.jsx`) y `remove`.
- Formulario de bot:
  - Nombre y subyacente.
  - Alertas elegidas de `eligible-alerts`, con chip de dirección. Si no hay ninguna, un enlace a `/alertas`.
  - Estructura con vista previa de qué abre cada dirección.
  - Delta, vencimiento, cantidad, señal contraria, salidas y riesgo.
  - Valores por defecto según la estructura.
- Registro «Señales recibidas y decisiones» con filtro Todas / Operadas / Ignoradas. Se refresca cada unos 15 s mientras la pestaña está visible.

## Pruebas

- Nada llama a la red ni envía órdenes reales.
- **Servidor** (`node --test`):
  - migración y validación de dirección;
  - mensaje de Telegram;
  - el emisor (aislamiento de errores, sin emisión en dry-run);
  - la plantilla con cada estructura y cada `onOpposite`;
  - deduplicación por evento;
  - mapeo de activo a subyacente;
  - rutas y su validación;
  - que `/options/strategies` excluye los bots.
- **Cliente** (`vitest`): selector y filtro de dirección, plantillas con dirección, pestaña nueva (escritorio y móvil), formulario y confirmación de Real.
- **e2e** contra Docker en `localhost:5174`: añadir a `e2e/options-module.spec.js` la pestaña Auto (escritorio y 390 px) y en Alertas el selector de dirección, con `/api` mockeada.
