# TradingView pantalla dividida multi-activo · plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Modo "Multi‑activo" en `/trading-view/multi`: hasta 4 activos independientes, cada uno con su temporalidad, puntero compartido opcional solo en tiempo.

**Architecture:** Se amplía `SyncedChart` con dos props aditivas (`syncPrice`, `onAssetClick`); la página gana un modo y un estado de paneles por activo. Lógica de prefs en `crosshairSync.js`.

**Tech Stack:** React 18, lightweight-charts 5.1.0, vitest, Playwright (Docker `localhost:5174`).

**Spec:** `docs/superpowers/specs/2026-10-20-tradingview-multi-timeframe-design.md`, sección "Ampliación: pantalla dividida multi-activo" (y el resto como contexto).

## Global Constraints

- Lo existente de Multi‑TF no cambia de comportamiento (sus tests y e2e siguen verdes).
- Colores `#3ddc84` / `#b8860b` / `#8690a0`; horas UTC; textos en español; SVG sin emoji; `localStorage` en try/catch.
- Móvil = `MOBILE_QUERY`; táctil ≥44 px; sin scroll horizontal a 390 px.
- Claves: `tv_split_prefs_v1`, `tv_multi_mode_v1`.

## Review Focus

1. Cambiar el activo de un panel con sincronización encendida y el puntero puesto en él: el `sync` se limpia y no queda puntero fantasma. → test Tarea 2.
2. Dos paneles con el mismo activo y temporalidad: ambos `exact`. → cubierto por `resolveSyncedTime` (Tarea 1 previa).
3. Volver de Multi‑activo a Multi‑TF conserva las prefs de cada modo por separado. → test Tarea 2.
4. `syncPrice=false` → al apagar la sincronización la línea horizontal vuelve a verse en todos. → test Tarea 1.
5. Prefs corruptas o con activos sin `symbol` → defaults por panel. → test Tarea 2.

## Ejecución

Tareas 1 y 2 en paralelo en worktrees basados en la rama `feat/tradingview-multi-timeframe` (HEAD actual). 1 solo toca `SyncedChart.*`; 2 toca `crosshairSync.*`, `MultiTimeframePage.*` y `e2e/tradingview-multi.spec.js` (2 mockea `SyncedChart` en sus tests unitarios). Luego integración + e2e (lead).

### Task 1: `SyncedChart` — `syncPrice` y `onAssetClick`

**Files:** Modify `client/src/pages/TradingView/multi/SyncedChart.jsx`, `SyncedChart.module.css`; Test `SyncedChart.test.jsx`.

**Produces:** props `syncPrice` (default `true`) y `onAssetClick(index)` según la sección "Contrato nuevo de SyncedChart" del spec; `data-testid="asset-btn-<index>"`.

- [ ] Tests que fallan:
  - `syncPrice={false}` y `sync` destino exacto sobre una vela con `close = 2510` → `setCrosshairPosition(2510, candleTimeSec, series)` y `applyOptions` con `crosshair.horzLine.visible === false` y `labelVisible === false`; color vertical `#3ddc84`.
  - luego `sync={null}` → `applyOptions` con `horzLine.visible === true`.
  - `syncPrice={false}` en el origen (`sourceIndex === index`) → horzLine visible (el origen conserva su puntero).
  - con `onAssetClick` → botón `asset-btn-0` con texto `BTC` y `aria-label` `Cambiar activo (actual: BTC)`; click → `onAssetClick(0)`. Sin la prop → no hay botón.
- [ ] Implementar (la clave de `applyLines` debe incluir `syncPrice` para no cachear opciones viejas).
- [ ] `npx vitest run src/pages/TradingView/multi/` verde, `npx eslint src/pages/TradingView/multi/` limpio, commit `feat(tradingview): synced chart supports time-only sync and a per-panel asset button`.

### Task 2: modo Multi‑activo en la página

**Files:** Modify `crosshairSync.js` (+ test), `MultiTimeframePage.jsx`, `MultiTimeframePage.module.css` (+ test), `e2e/tradingview-multi.spec.js`. Si `MultiTimeframePage.jsx` supera ~450 líneas, extraer el modo a `multi/SplitAssetsView.jsx` (misma carpeta) y dejar la página como contenedor.

**Consumes:** `SyncedChart` con `syncPrice` y `onAssetClick` (Tarea 1; en tests unitarios se mockea).

**Produces (crosshairSync.js):** `SPLIT_PREFS_KEY = 'tv_split_prefs_v1'`, `MULTI_MODE_KEY = 'tv_multi_mode_v1'`, `DEFAULT_SPLIT = { layout: '2x2', panels: [BTC,ETH,SOL,HYPE en hyperliquid 15m], mobilePanels: [BTC, ETH en hyperliquid 15m], sync: false }`, `loadSplitPrefs()`, `saveSplitPrefs(prefs)`, `loadMultiMode()` → `'tf'|'assets'` (default `'tf'`), `saveMultiMode(mode)`.

- [ ] Tests que fallan (crosshairSync): defaults; panel inválido (sin symbol, tf desconocido) → default de esa posición; JSON corrupto → defaults; ida y vuelta; `loadMultiMode` con valor raro → `'tf'`.
- [ ] Tests que fallan (página, `SyncedChart` mockeado como en sus tests actuales, exponiendo `onAssetClick`, `syncPrice`, `asset`):
  - selector de modo con dos botones `Multi‑TF` / `Multi‑activo` (`aria-pressed`); `?mode=assets` abre Multi‑activo.
  - Multi‑activo escritorio sin prefs → 4 paneles con `asset.symbol` `BTC, ETH, SOL, HYPE`, `timeframe` `15m`, `syncEnabled=false`, `syncPrice=false`.
  - `onAssetClick(2)` abre `AssetPickerModal`; elegir `DOGE` → solo el panel 2 cambia; prefs guardadas en `tv_split_prefs_v1`.
  - con sync encendido y `sync.sourceIndex === 2`, cambiar el activo del panel 2 → `sync` pasa a `null` (Review Focus 1).
  - cambiar a Multi‑TF y volver → cada modo conserva su layout/paneles (Review Focus 3); `tv_multi_mode_v1` guardado.
  - barra "Puntero: … · BTC 15m" en Multi‑activo con sync.
  - móvil → 2 paneles `compact` con `BTC`, `ETH`; sin precio global en la cabecera en este modo; selector de modo visible con botones ≥44 px.
  - Multi‑TF: tests existentes siguen verdes.
- [ ] Implementar. Escritorio: el selector de modo va al inicio de la barra; en Multi‑activo no hay botón de activo global. Móvil: el selector de modo va en la cabecera o en una fila bajo ella; diseño explícito para 390 px.
- [ ] e2e (no lo ejecutes; Docker sirve la copia principal): añadir a `e2e/tradingview-multi.spec.js` un test escritorio `Multi‑activo: 4 activos independientes y sincronización opcional` (navega a `?mode=assets`, 4 `asset-btn-*` con BTC/ETH/SOL/HYPE, activar el interruptor, mover el ratón sobre el panel 0 al 35 % de alto y 60 % de ancho → `sync-chip-1` existe con `data-status` `exact`/`near`/`out`) y uno móvil 390 px (2 paneles, sin scroll horizontal). El mock de velas ya responde por `asset`/`timeframe`.
- [ ] `npx vitest run src/pages/TradingView/`, `npm test` completo, `npm run lint`, `npm run build`; commit `feat(tradingview): split-screen multi-asset mode with optional time sync`.
