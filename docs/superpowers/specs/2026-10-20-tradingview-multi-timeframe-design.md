# TradingView · vista multi-temporalidad con puntero sincronizado

Fecha: 2026-10-20 · Rama: `feat/tradingview-multi-timeframe`
Diseño visual aprobado (lienzo): https://claude.ai/artifact/5Cm4T5Mh3R2ePfd34b1PAb

## Intención

El usuario quiere ver **el mismo activo en varias temporalidades a la vez**
(p. ej. 5m, 15m, 1h y 4h) y, al mover el puntero en un gráfico, ver en los
demás **el mismo instante**. El color de las líneas del puntero dice si ese
instante cae **exactamente** al inicio de una vela del otro gráfico o
**dentro** de una vela más larga:

- **Verde** (`#3ddc84`): el timestamp señalado es exactamente la apertura de
  una vela de ese gráfico.
- **Amarillo oscuro** (`#b8860b`): el timestamp cae dentro de una vela (no es
  su apertura); el puntero se coloca en esa vela contenedora.

Éxito: análisis multi-temporalidad sin cambiar de gráfico, con lectura
inmediata de "esto es la misma vela" vs "esto es una parte de una vela mayor".

## Objetivos

1. Página nueva `/trading-view/multi` (pantalla completa, como `/trading-view`).
2. Un activo (el mismo selector/almacenamiento que TradingView), N gráficos
   con temporalidad propia cada uno.
3. Distribuciones de escritorio: `1×2`, `1×3`, `2×2` (por defecto `2×2` con
   `5m, 15m, 1h, 4h`).
4. Móvil (≤768 px, `MOBILE_QUERY` de `useMediaQuery.js`): 3 gráficos apilados
   (`5m, 1h, 4h` por defecto), cabecera compacta y barra inferior con la
   lectura del puntero y la leyenda. Diseño móvil explícito, no el de
   escritorio encogido.
5. Puntero sincronizado (conmutable "Puntero sincronizado / independiente").
6. Velas en vivo (mismo polling por temporalidad que TradingView).
7. **Indicadores configurados (pedido del usuario, 2026-10-20):** cada gráfico
   muestra los mismos indicadores que el usuario tiene guardados en
   TradingView (`settingsApi.getChartIndicators()`, con
   `getDefaultChartIndicators()` como respaldo), calculados sobre las velas de
   su propia temporalidad. Se respetan los ocultos (`visible === false`). Se
   dibujan con el mismo `createIndicatorsController(chart)` de
   `indicators/renderAdapter.js` (overlays en el panel de precio y osciladores
   en sub-paneles), que se vuelve a llamar con `render(indicators, candles)` al
   cargar, en cada polling y al cambiar la lista. La página carga la lista una
   vez y la pasa como prop `indicators` a cada `SyncedChart`.
   - Si el puntero está sobre un sub-panel (`param.paneIndex !== 0`), el precio
     propagado es el cierre de la vela señalada (la coordenada `y` no es de la
     escala de precio). La línea vertical sigue funcionando igual.

## No-objetivos

- Dibujos y Replay en esta vista (siguen en `/trading-view`).
- Editar indicadores desde esta vista (se configuran en `/trading-view`).
- Sincronizar zoom/desplazamiento entre gráficos.
- Persistir la configuración en el servidor (basta `localStorage`).

## Anti-objetivos (fallaría aunque "funcione")

- Que el verde/amarillo dependa solo del color: cada gráfico muestra además un
  chip de texto ("Origen", "Coincide exacto", "Dentro de la vela 19 oct 20:00
  (+45m)", "Fuera de vista").
- Bucles de eco o punteros fantasma: solo se propagan movimientos reales del
  usuario. En lightweight-charts 5.1 `setCrosshairPosition` y
  `clearCrosshairPosition` NO disparan `subscribeCrosshairMove`, pero sí hay
  eventos sin `param.sourceEvent` al actualizar datos (polling) y al salir el
  ratón; esos se ignoran.
- Romper `/trading-view` existente.

## Reglas de comportamiento (decididas)

- **Origen**: el gráfico donde está el puntero. Su línea es **continua** y
  siempre verde (es exacto por definición). Los demás usan línea
  **discontinua** (`LineStyle.Dashed`).
- **Instante señalado** = apertura (en segundos) de la vela bajo el puntero en
  el gráfico origen (`param.time`). Si `param.time` es nulo (zona vacía), se
  limpia el puntero en todos.
- **Resolución en otro gráfico** con velas `candles` (ordenadas, `time` en ms)
  y temporalidad `tfSec`: se busca la vela `c` con
  `c.time/1000 <= t < c.time/1000 + tfSec`.
  - `t === c.time/1000` → `exact` (verde). **Confirmado por el usuario:** es
    verde cuando ambas velas tienen el mismo inicio exacto, aunque su
    duración sea distinta (p. ej. vela 4h de las 08:00 → vela 5m de las 08:00
    es verde). No se compara la duración.
  - si no → `near` (amarillo oscuro), offset = `t − apertura`.
  - sin vela contenedora (más viejo que lo cargado o posterior a la última
    vela) → `out`.
  - Si la vela contenedora existe pero está fuera del rango visible del
    gráfico (`timeScale().getVisibleRange()`), también `out`, con lado
    `left|right`. **Decisión de Claude (el usuario no la ha confirmado):**
    no se auto-desplaza; se muestra un aviso "◀ 13 oct 08:15
    fuera de vista" en el borde correspondiente.
- **Precio**: la línea horizontal usa el mismo precio en todos (mismo activo).
  Si cae fuera del rango de precios visible, lightweight-charts simplemente no
  la pinta; aceptable.
- **Color de líneas**: ambas líneas (vertical y horizontal) y sus etiquetas
  (`labelBackgroundColor`) toman el color del estado. `out` → gris `#8690a0`
  (no se pinta crosshair en ese gráfico, solo el aviso).
- **Sincronización apagada**: cada gráfico tiene su puntero nativo normal
  (color por defecto), sin chips.
- **Etiqueta de tiempo** en `near`: el eje muestra la apertura de la vela
  contenedora (nativo); el chip textual muestra el offset `+45m`.
- Al salir el ratón de todos los gráficos se limpia el puntero en todos.
- En táctil se usa el comportamiento nativo de lightweight-charts (mantener
  pulsado y arrastrar muestra el puntero) y la barra inferior lo indica. Al
  soltar (`touchend`/`pointerup` táctil en el contenedor) se limpia el puntero
  en todos, porque el evento de limpieza de la librería no trae `sourceEvent`.
- **Modo del crosshair: `CrosshairMode.Normal`** en todos los gráficos de esta
  vista (decisión de Claude). Con `Magnet` la librería pega el precio de
  `setCrosshairPosition` al cierre de la vela destino y la línea horizontal
  dejaría de ser el mismo precio en todos.
- **Zona horaria: UTC** en chips, barra "Puntero" y etiquetas (decisión de
  Claude): el eje de tiempo de lightweight-charts en esta app ya muestra UTC
  (no hay `timeFormatter`), así chip y eje dicen la misma hora.

## Arquitectura y contratos (para trabajar en paralelo)

Carpeta nueva: `client/src/pages/TradingView/multi/`.

### A · Lógica pura — `multi/crosshairSync.js` (+ `crosshairSync.test.js`)

```js
export const SYNC_COLORS = { exact: '#3ddc84', near: '#b8860b', out: '#8690a0' };
export const TF_SECONDS = { '1m':60,'5m':300,'15m':900,'1h':3600,'4h':14400,'1d':86400,'1w':604800 };
export const MULTI_TIMEFRAMES = ['1m','5m','15m','1h','4h','1d','1w'];
export const LAYOUTS = [
  { id: '1x2', label: '1×2', count: 2, cols: 2, rows: 1 },
  { id: '1x3', label: '1×3', count: 3, cols: 3, rows: 1 },
  { id: '2x2', label: '2×2', count: 4, cols: 2, rows: 2 },
];
export const DEFAULT_DESKTOP = { layout: '2x2', timeframes: ['5m','15m','1h','4h'] };
export const DEFAULT_MOBILE_TIMEFRAMES = ['5m','1h','4h'];

// candles: [{ time(ms), open, high, low, close }] ascendentes.
// visibleRange: { from, to } en segundos (o null = todo visible).
// → { status: 'exact'|'near'|'out', candleTimeSec|null, offsetSec, side: 'left'|'right'|null }
export function resolveSyncedTime(tSec, candles, tfSec, visibleRange);

export function formatOffset(sec);            // 2700 → '45m', 6300 → '1h 45m', 90000 → '1d 1h'
export function formatSyncTime(sec);          // '19 oct 20:45' (UTC, mes corto en español)
export function statusLabel(resolution, { isSource }); // textos del chip (ver Reglas)
export function loadMultiPrefs(); export function saveMultiPrefs(prefs);
// localStorage 'tv_multi_prefs_v1' = { layout, timeframes:[4], mobileTimeframes:[3], sync }
// con try/catch y validación (valores inválidos → defaults).
```

Búsqueda binaria sobre `candles` (pueden ser 500+). Tests: exacto, dentro,
antes de lo cargado, después de la última vela (`t >= last + tfSec`), fuera
del rango visible por ambos lados, velas vacías, offsets y prefs corruptas.

### B · Componente de gráfico — `multi/SyncedChart.jsx` (+ `.module.css`, test)

Un panel = cabecera + un gráfico de lightweight-charts (velas, mismo `THEME`
que `TradingViewPage.jsx`; extraer `THEME` y los helpers de precio a
`multi/chartTheme.js` copiándolos, sin tocar `TradingViewPage.jsx`).

Props:

```js
<SyncedChart
  asset={{ symbol, datasource }}
  timeframe="15m"
  timeframes={MULTI_TIMEFRAMES}
  onTimeframeChange={(tf) => …}
  index={0}
  syncEnabled={true}
  sync={null | { sourceIndex, timeSec, price }}   // estado global del puntero
  onPointer={(index, { timeSec, price } | null) => …} // solo eventos reales (sourceEvent)
  compact={false}                                    // móvil: cabecera reducida
/>
```

Responsabilidades:
- Carga `marketApi.getCandles({ asset, datasource, timeframe, limit: 500 })`
  y hace polling en vivo (intervalos por temporalidad como `LIVE_POLL_MS` de
  TradingView; en el polling pide `limit: 2` y fusiona la última vela).
  Estados de carga y error dentro del panel.
- `subscribeCrosshairMove`: si `param.sourceEvent` existe → `onPointer(index,
  { timeSec: param.time, price: series.coordinateToPrice(param.point.y) })`;
  si existe y `param.time == null` → `onPointer(index, null)`. Ignora los
  eventos sin `sourceEvent` (son los sintéticos).
- `mouseleave` del contenedor y fin de toque (`touchend`, `touchcancel`) →
  `onPointer(index, null)`.
- `crosshair.mode = CrosshairMode.Normal`.
- Cuando cambia `sync` (y `syncEnabled`) y `sync.sourceIndex !== index`:
  `resolveSyncedTime(...)`; `exact|near` → `chart.applyOptions({ crosshair:
  { vertLine/horzLine: { color, style: Dashed, labelBackgroundColor } } })` y
  `chart.setCrosshairPosition(price, candleTimeSec, series)`; `out` →
  `clearCrosshairPosition()` + aviso de borde. Si `sourceIndex === index`:
  colores verdes, línea continua (`LineStyle.Solid`). `sync === null` →
  `clearCrosshairPosition()` y colores por defecto.
- Cabecera: `<select>` de temporalidad con `<label>` (accesible), OHLC de la
  vela resuelta (o la última), chip de estado (`statusLabel`), visible solo con
  sync activo y puntero presente. En `compact` solo temporalidad, cierre y chip.
- `data-testid="synced-chart-<index>"`, chip `data-testid="sync-chip-<index>"`
  con `data-status="exact|near|out|source"`.

Test (vitest + Testing Library) con `lightweight-charts` mockeado
(`vi.mock`), comprobando: aplica verde/amarillo/gris según el `sync`, no llama
`onPointer` para eventos sin `sourceEvent`, y el chip.

### C · Página — `multi/MultiTimeframePage.jsx` (+ `.module.css`, test)

- Estado: `prefs` (de `loadMultiPrefs`), `asset` (misma clave
  `tv_selected_asset_v1` y `?symbol=&datasource=` que TradingView; mismo
  `AssetPickerModal`), `sync` (`{ sourceIndex, timeSec, price } | null`).
- `onPointer(index, p)` → `setSync(p ? { sourceIndex: index, ...p } : null)`
  (con `requestAnimationFrame` para no re-renderizar por cada píxel).
- Escritorio: barra superior (par + precio del primer panel, botones de
  distribución `aria-pressed`, conmutador de sincronización, "Puntero: 19 oct
  20:45 · 15m", leyenda verde continua / amarillo discontinua) y una rejilla
  CSS `cols×rows` con `SyncedChart` por temporalidad.
- Móvil: cabecera (volver a `/trading-view`, par, botón Sync ≥44 px), 3
  `SyncedChart compact` apilados con `flex: 1`, barra inferior con lectura del
  puntero, leyenda y "Mantén pulsado y arrastra sobre un gráfico".
- Enlaces de entrada: botón "Multi‑TF" en la barra de escritorio de
  `TradingViewPage.jsx` y en su cabecera móvil, navegando a
  `/trading-view/multi?symbol=…&datasource=…`. Y "← Gráfico único" de vuelta.
- Ruta en `client/src/App.jsx` (lazy) y añadir `/trading-view/multi` a
  `FULLSCREEN_ROUTES`. Clase `tv-mobile-chrome` en `<body>` en móvil (como
  TradingView) para subir el botón de logs de dev.

## Verificación

- Unit: `npm test` en `client/` (los tres módulos nuevos con tests).
- e2e: `e2e/tradingview-multi.spec.js` contra Docker en `localhost:5174`
  (memoria del usuario), con `/api/market/candles` mockeado por temporalidad:
  escritorio 1400 px (4 paneles, cambiar a 1×3, mover el ratón sobre el 15m
  en una vela no alineada a la hora → chip del 5m `exact`, del 1h `near`) y
  390 px (3 paneles apilados, sin scroll horizontal).
- `npm run lint` y `npm run build` limpios.

## Decisiones tomadas por Claude (revisables)

- Ruta propia en lugar de un modo dentro de `TradingViewPage.jsx` (1.335
  líneas): menos riesgo de romper la página existente.
- Sin auto-desplazamiento cuando el instante está fuera de vista.
- Colores exactos: verde `#3ddc84` (distinto del verde de velas `#26a69a`),
  amarillo oscuro `#b8860b`.
- Ambas líneas del puntero toman el color.
- `CrosshairMode.Normal` en esta vista y horas en UTC.
