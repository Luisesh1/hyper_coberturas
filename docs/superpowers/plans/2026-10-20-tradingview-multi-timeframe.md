# TradingView multi-temporalidad · plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Página `/trading-view/multi` con N gráficos del mismo activo en distintas temporalidades y puntero sincronizado (verde = mismo inicio exacto, amarillo oscuro = dentro de otra vela).

**Architecture:** Lógica pura en `crosshairSync.js`; un componente `SyncedChart` por gráfico (lightweight-charts) controlado por un estado `sync` que vive en `MultiTimeframePage`. Ruta propia, sin tocar la lógica de `TradingViewPage.jsx` salvo un botón de entrada.

**Tech Stack:** React 18, Vite, lightweight-charts 5.1.0, vitest + Testing Library, Playwright (Docker en `localhost:5174`).

**Spec:** `docs/superpowers/specs/2026-10-20-tradingview-multi-timeframe-design.md` (léelo entero antes de empezar).

## Global Constraints

- Colores: exact `#3ddc84`, near `#b8860b`, out `#8690a0`.
- Exacto = la vela destino abre en el mismo segundo que la vela origen (`t === c.time/1000`); no se compara duración.
- `CrosshairMode.Normal` en todos los gráficos de esta vista.
- Horas en UTC, meses cortos en español (`ene feb mar abr may jun jul ago sep oct nov dic`), formato `19 oct 20:45`.
- Velas de `marketApi.getCandles` traen `time` en **ms**; lightweight-charts recibe `Math.floor(ms/1000)`.
- Solo se propagan eventos de puntero con `param.sourceEvent`.
- Móvil = `MOBILE_QUERY` (`(max-width: 768px)`) de `pages/TradingView/useMediaQuery.js`; botones táctiles ≥44 px; sin scroll horizontal a 390 px.
- `localStorage` siempre dentro de `try/catch`.
- Textos de UI en español. Iconos SVG (de `pages/TradingView/components/icons.jsx` si existe uno adecuado), nunca emoji.
- No modificar `SyncedChart.jsx` fuera de la Tarea 2 ni `crosshairSync.js` fuera de la Tarea 1.

## Review Focus

1. **Polling con puntero activo**: una actualización de datos dispara eventos sin `sourceEvent`; no deben borrar ni mover el puntero sincronizado. → test en Tarea 2.
2. **Temporalidad cambiada con el puntero puesto**: al cambiar un `<select>` el panel recarga velas; mientras no hay velas, `resolveSyncedTime` con `[]` debe devolver `out` sin lanzar. → test en Tarea 1.
3. **Origen fuera del layout** (pasar de 2×2 a 1×2 con el puntero en el panel 3): el `sync` debe limpiarse. → test en Tarea 3.
4. **Dos paneles con la misma temporalidad**: ambos deben mostrar `exact` (mismo inicio). → test en Tarea 1.
5. **Fin de toque en móvil**: `touchend` limpia el puntero en todos. → test en Tarea 2.

## Ejecución multiagente

- Ola 1 (yo, antes de lanzar agentes): Tarea 0.
- Ola 2 (en paralelo, worktrees): Tarea 1, Tarea 2, Tarea 3. Cada una solo toca sus archivos. Tarea 2 y 3 importan `crosshairSync.js` según el contrato; mientras Tarea 1 no esté unida, usan el stub de la Tarea 0.
- Ola 3 (yo): integración + Tarea 4.

---

### Task 0: Stubs de contrato (lead)

**Files:**
- Create: `client/src/pages/TradingView/multi/crosshairSync.js` (stub con las firmas y constantes del spec, cuerpos mínimos: `resolveSyncedTime` → `{status:'out',candleTimeSec:null,offsetSec:0,side:null}`, formatters devuelven `''`, `loadMultiPrefs` devuelve defaults, `saveMultiPrefs` no-op, `statusLabel` → `''`).
- Create: `client/src/pages/TradingView/multi/SyncedChart.jsx` (stub: `export default function SyncedChart({ index }) { return <div data-testid={`synced-chart-${index}`} />; }`).

- [ ] Crear ambos, `npm run lint` en `client/` sin errores, commit `chore(tradingview): contract stubs for the multi-timeframe view`.

### Task 1: Lógica de sincronización (`crosshairSync.js`)

**Files:**
- Modify (reemplaza el stub): `client/src/pages/TradingView/multi/crosshairSync.js`
- Test: `client/src/pages/TradingView/multi/crosshairSync.test.js`

**Interfaces — Produces:** exactamente lo listado en el spec §A: `SYNC_COLORS`, `TF_SECONDS`, `MULTI_TIMEFRAMES`, `LAYOUTS`, `DEFAULT_DESKTOP`, `DEFAULT_MOBILE_TIMEFRAMES`, `resolveSyncedTime(tSec, candles, tfSec, visibleRange) → {status, candleTimeSec, offsetSec, side}`, `formatOffset(sec)`, `formatSyncTime(sec)`, `statusLabel(resolution, { isSource })`, `loadMultiPrefs()`, `saveMultiPrefs(prefs)`. Además `DEFAULT_SYNC = true` y la clave `MULTI_PREFS_KEY = 'tv_multi_prefs_v1'`.

- [ ] **Step 1: tests que fallan.** Velas helper: 15m desde `T0 = Date.UTC(2026,9,19,0,0)/1000`, `time` en ms. Casos:
  - `resolveSyncedTime(T0+3600, c1h, 3600, null)` → `{status:'exact', candleTimeSec:T0+3600, offsetSec:0, side:null}`.
  - `resolveSyncedTime(T0+3600+2700, c1h, 3600, null)` → `near`, `candleTimeSec: T0+3600`, `offsetSec: 2700`.
  - Mismo tf en origen y destino → `exact` (Review Focus 4).
  - `t` anterior a la primera vela → `{status:'out', side:'left'}`; `t >= última apertura + tfSec` → `out`, `side:'right'`.
  - `visibleRange = {from: T0+7200, to: T0+14400}` y `t = T0` (vela existe) → `out`, `side:'left'`; `t` mayor que `to + tfSec` con vela existente → `out`, `right`.
  - `candles = []` → `out` sin lanzar (Review Focus 2).
  - 2.000 velas: resultado correcto (binaria).
  - `formatOffset(2700)==='45m'`, `formatOffset(6300)==='1h 45m'`, `formatOffset(90000)==='1d 1h'`.
  - `formatSyncTime(Date.UTC(2026,9,19,20,45)/1000)==='19 oct 20:45'`.
  - `statusLabel({status:'exact'},{isSource:true})==='Origen'`; `exact` → `'Coincide exacto'`; `near` con `candleTimeSec=Date.UTC(2026,9,19,20,0)/1000, offsetSec=2700` → `'Dentro de la vela 19 oct 20:00 (+45m)'`; `out` → `'Fuera de vista'`.
  - `loadMultiPrefs()` con `localStorage` vacío → `{layout:'2x2', timeframes:['5m','15m','1h','4h'], mobileTimeframes:['5m','1h','4h'], sync:true}`; con JSON corrupto o `timeframes:['7m',...]` → defaults en los campos inválidos; `saveMultiPrefs` + `loadMultiPrefs` hace ida y vuelta; `localStorage.getItem` que lanza → defaults.
- [ ] **Step 2:** `cd client && npx vitest run src/pages/TradingView/multi/crosshairSync.test.js` → FAIL.
- [ ] **Step 3:** implementar. La vela es visible si `candleTimeSec + tfSec > from && candleTimeSec <= to` (lado `left` si queda antes de `from`, si no `right`).
- [ ] **Step 4:** mismo comando → PASS.
- [ ] **Step 5:** commit `feat(tradingview): crosshair sync resolution and prefs for the multi-timeframe view`.

### Task 2: Componente `SyncedChart`

**Files:**
- Create: `client/src/pages/TradingView/multi/chartTheme.js` (copia de `THEME`, `LIVE_POLL_MS`, `getPricePrecisionFromCandles`, `getPriceFormatOptions`, `formatPrice` de `TradingViewPage.jsx`, exportados; no tocar `TradingViewPage.jsx`).
- Modify (reemplaza el stub): `client/src/pages/TradingView/multi/SyncedChart.jsx`
- Create: `client/src/pages/TradingView/multi/SyncedChart.module.css`
- Test: `client/src/pages/TradingView/multi/SyncedChart.test.jsx`

**Interfaces — Consumes:** `crosshairSync.js` (Tarea 1), `marketApi.getCandles({ asset, datasource, timeframe, limit, … })` de `services/api.js`. **Produces:** las props del spec §B; `data-testid="synced-chart-<index>"`, chip `data-testid="sync-chip-<index>"` con `data-status` ∈ `exact|near|out|source`; aviso de borde `data-testid="sync-out-<index>"`.

- [ ] **Step 1: tests que fallan** con `vi.mock('lightweight-charts')` (fábrica que devuelve un chart falso que guarda el handler de `subscribeCrosshairMove` y espía `setCrosshairPosition`, `clearCrosshairPosition`, `applyOptions`, `timeScale().getVisibleRange()` → `null`) y `vi.mock('../../../services/api')` con velas de 1h. Casos:
  - `sync={{sourceIndex:1, timeSec:<apertura de una vela 1h>, price:2500}}` en `index=0` → `setCrosshairPosition(2500, thatTime, series)` y `applyOptions` con `crosshair.vertLine.color === '#3ddc84'`, `style === LineStyle.Dashed`; chip `data-status="exact"`, texto `Coincide exacto`.
  - mismo con `timeSec` +45 min → color `#b8860b`, chip `near`, texto `Dentro de la vela … (+45m)`.
  - `timeSec` anterior a todas las velas → `clearCrosshairPosition` llamado, aviso `sync-out-0` visible con `◀`.
  - `sourceIndex === index` → color verde, `LineStyle.Solid`, chip `source` con texto `Origen`, y NO llama `setCrosshairPosition`.
  - handler invocado con `{ time, point, sourceEvent: {} }` → `onPointer(0, { timeSec: time, price })`; invocado sin `sourceEvent` → `onPointer` no se llama (Review Focus 1).
  - `fireEvent.touchEnd` y `mouseLeave` en el contenedor → `onPointer(0, null)` (Review Focus 5).
  - `syncEnabled={false}` → no hay chip y no se llama `setCrosshairPosition`.
  - el `<select>` tiene etiqueta accesible `Temporalidad` y `onTimeframeChange('4h')` al cambiarlo.
- [ ] **Step 2:** `npx vitest run src/pages/TradingView/multi/SyncedChart.test.jsx` → FAIL.
- [ ] **Step 3:** implementar según spec §B. Notas: crear el chart una vez (`autoSize: true`, `crosshair.mode: CrosshairMode.Normal`); recargar velas al cambiar `asset`/`timeframe` (limpia y vuelve a aplicar el `sync` vigente al terminar); polling con `limit: 2` fusionando por `time`; aplicar `sync` en un `useEffect([sync, syncEnabled, candles])`. `compact` = cabecera con selector, cierre y chip. Estados de carga/error dentro del panel.
- [ ] **Step 4:** mismo comando → PASS; `npm run lint` sin errores.
- [ ] **Step 5:** commit `feat(tradingview): synced chart panel with exact/near crosshair colors`.

### Task 3: Página, ruta y entradas

**Files:**
- Create: `client/src/pages/TradingView/multi/MultiTimeframePage.jsx`, `MultiTimeframePage.module.css`
- Test: `client/src/pages/TradingView/multi/MultiTimeframePage.test.jsx`
- Modify: `client/src/App.jsx` (lazy import, `<Route path="/trading-view/multi" …/>`, añadir `'/trading-view/multi'` a `FULLSCREEN_ROUTES` en la línea 58)
- Modify: `client/src/pages/TradingView/TradingViewPage.jsx` (solo: botón "Multi‑TF" en `toolbarDesktop` y en la cabecera móvil, que navega a `/trading-view/multi?symbol=${asset.symbol}&datasource=${asset.datasource}`)

**Interfaces — Consumes:** `SyncedChart` (props del spec §B) y `crosshairSync.js`. **Produces:** página por defecto exportada.

- [ ] **Step 1: tests que fallan** con `vi.mock('./SyncedChart', …)` que renderiza un `<div data-testid="synced-chart-N" data-tf={timeframe} data-sync={JSON.stringify(sync)}>` y expone `onPointer` mediante un botón de prueba; `useTradingContext` mockeado; `matchMedia` controlado. Casos:
  - Escritorio sin prefs → 4 paneles `5m,15m,1h,4h`; botón `2×2` con `aria-pressed="true"`.
  - Pulsar `1×3` → 3 paneles; prefs guardadas en `tv_multi_prefs_v1`.
  - `onPointer(1, {timeSec, price})` → todos los paneles reciben `sync.sourceIndex === 1`; la barra muestra `Puntero: 19 oct 20:45 · 15m`.
  - Con `sync.sourceIndex === 3`, cambiar a `1×2` → `sync` pasa a `null` (Review Focus 3).
  - Conmutador "Puntero sincronizado" → paneles reciben `syncEnabled=false`.
  - Móvil (`matchMedia` true) → 3 paneles `5m,1h,4h` con `compact`, enlace volver a `/trading-view`, texto `Mantén pulsado y arrastra sobre un gráfico`.
  - `?symbol=BTC&datasource=binance` → los paneles reciben `asset.symbol === 'BTC'`.
- [ ] **Step 2:** `npx vitest run src/pages/TradingView/multi/MultiTimeframePage.test.jsx` → FAIL.
- [ ] **Step 3:** implementar según spec §C. Agrupar `setSync` con `requestAnimationFrame`. En móvil, `document.body.classList.add('tv-mobile-chrome')` en efecto con limpieza. Selector de par con `AssetPickerModal` existente.
- [ ] **Step 4:** test → PASS; `npm test` completo de `client/` sin regresiones; `npm run lint`.
- [ ] **Step 5:** commit `feat(tradingview): multi-timeframe page, route and entry buttons`.

### Task 4: Integración y e2e (lead)

**Files:**
- Create: `e2e/tradingview-multi.spec.js` (patrón de `e2e/tradingview-mobile.spec.js`: login en `localStorage`, `/api/market/candles` mockeado generando velas alineadas por `timeframe` con `time` en ms).

- [ ] Unir las ramas de las Tareas 1–3; `npm test`, `npm run lint`, `npm run build` en `client/`.
- [ ] e2e escritorio 1400×900: 4 `synced-chart-*`; mover el ratón al centro del panel 15m → `sync-chip-0` (5m) con `data-status` `exact` y `sync-chip-2` (1h) `exact` o `near` según la vela; la prueba elige el punto calculando una vela 15m no alineada a la hora vía `page.mouse.move` y comprueba `near` en el 1h. Cambiar a `1×3` → 3 paneles.
- [ ] e2e 390×844: 3 paneles, `document.documentElement.scrollWidth <= 390`.
- [ ] Ejecutar contra Docker en `localhost:5174` (`npx playwright test -c e2e/playwright-docker.config.js e2e/tradingview-multi.spec.js`) → PASS.
- [ ] Commit `test(tradingview): e2e for the multi-timeframe view`.
