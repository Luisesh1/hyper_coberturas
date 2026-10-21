# TradingView · superposición de N gráficos (activos y opciones de Deribit)

Fecha: 2026-10-21
Diseño visual (lienzo; el usuario eligió el modo de escala **A**; maquetas 1–4 de N superposiciones y prima pagada): https://claude.ai/artifact/BiYrv6H1iw7KF3izAPKBBK

## Intención

El usuario quiere **encimar uno o varios gráficos (N a la vez) sobre el
gráfico de precio**, sincronizados en el tiempo y con escala ajustable, para
compararlos uno sobre otro. La superposición **no es solo para opciones**
(insistencia del usuario): vale igual para cualquier activo del catálogo. El
usuario pidió **mucha atención a la UX y la usabilidad**. Dos usos:

1. **Activo contra activo:** cualquier otro activo del catálogo, en la misma
   temporalidad. Por ejemplo BTC, SOL y el SPX encima de ETH.
2. **Prima de una opción contra su subyacente:** ver cómo se movió la prima
   de una opción (vigente o vencida en el último año) frente al precio del
   activo, para estudiar la correlación entre los dos.

Éxito: abrir ETH en 1h, superponer `ETH-31OCT25-4000-C` y leer de un vistazo,
vela a vela, cómo respondió la prima al precio, incluidas las horas en que nadie
operó la opción.

## Fuente de datos de opciones: Deribit (decidido por el usuario)

Binance **no** sirve: `/eapi/v1/klines` responde "symbol does not exist" en
cuanto un contrato vence, y `data.binance.vision` solo tiene `BVOLIndex` y
`EOHSummary`, que se corta en octubre de 2023. Verificado el 2026-10-21.

Deribit sí sirve. Verificado el 2026-10-21 con 248 vencimientos (52 viernes y
10 diarios por subyacente):

- `GET public/get_instrument?instrument_name=…` devuelve `state: "archivized"`
  para un contrato vencido que existió, e `instrument not found` (código
  -32602) para uno que no existió. Sirve para saber si existe sin descargar
  velas.
- `GET public/get_tradingview_chart_data?instrument_name&start_timestamp&end_timestamp&resolution`
  devuelve velas OHLCV de contratos vencidos hasta un año atrás. Resoluciones
  válidas: `1,3,5,10,15,30,60,120,180,360,720,1D`. La respuesta trae
  `ticks, open, high, low, close, volume, status`.
- `GET public/get_instruments?currency=…&kind=option&expired=false` lista los
  contratos **vigentes**. Con `expired=true` solo devuelve los vencidos **hoy**,
  así que los antiguos hay que reconstruirlos.
- Nombres: `ETH-31OCT25-4000-C`, `BTC-24OCT25-108000-C`,
  `SOL_USDC-21NOV25-140-C`, `XRP_USDC-5DEC25-2d2-C`. El día va **sin cero
  delante**, el mes en mayúsculas de 3 letras y el año en 2 dígitos. En el
  strike, el punto decimal se escribe `d`.
- Paso de strike que se encontró cerca del precio: BTC 1000 (también 500),
  ETH 50 (también 25 y 100), SOL 5 (también 2 y 10), XRP 0.1 (también 0.05).
- BTC y ETH son opciones **inversas**: la prima viene en la moneda (0.0002
  ETH). Las `*_USDC` ya vienen en USD.
- Las velas son de **precio negociado**. Sin operaciones, el precio queda plano:
  en un mes solo cambia entre el 10 % y el 15 % de las horas. Las velas con
  `volume = 0` son horas sin operaciones.
- Subyacentes de Deribit: BTC, ETH (inversas) y SOL, XRP, AVAX, TRX y HYPE
  (`*_USDC`). BNB y DOGE (que Binance sí tiene) no existen en Deribit.

## Objetivos

1. Botón **"Superponer"** en la barra de `/trading-view` (escritorio) y en
   móvil. Abre un selector con dos pestañas: **Activo** (el catálogo actual,
   el mismo de `AssetPickerModal`) y **Opción** (Deribit). Se pueden añadir
   **N superposiciones a la vez**, mezclando activos y opciones. El selector
   permite añadir varias sin cerrarse; las que ya están se marcan como
   añadidas.
2. **Selector de opción por vencimiento y strike** (decidido por el usuario):
   subyacente, después vencimiento (vigentes y vencidos del último año),
   después strike y tipo CALL/PUT.
3. **Escala A · escala propia** (decidido por el usuario), extendida a N:
   - **Cada superposición tiene su propia escala**, que se ajusta sola a lo
     visible.
   - El gráfico principal mantiene la escala **derecha**.
   - **Una superposición está "enfocada"** y usa la escala **izquierda**
     visible (`priceScaleId: 'left'`), con etiquetas en su color.
   - Las demás usan escalas overlay propias e invisibles
     (`priceScaleId: 'ov-<id>'`), que se autoescalan igual. Su último valor se
     ve como etiqueta de precio en el borde, en su color.
   - Al tocar el chip de otra superposición, esa pasa a ser la enfocada: su
     eje pasa a la izquierda (`applyOptions({ priceScaleId })`). Sin
     superposiciones, el eje izquierdo se oculta.
   - La enfocada se dibuja más gruesa (2.2 px) y las demás finas (1.5 px).
     *(Mi decisión.)*
   - **Colores:** paleta fija de 6 colores, asignados por orden y distintos
     también en luminosidad, no solo en tono: ámbar `#f59e0b`, cian `#22d3ee`,
     violeta `#a78bfa`, rosa `#f472b6`, lima `#a3e635` y azul claro `#93c5fd`.
     El verde y el rojo de las velas no se usan para superposiciones.
   - **Máximo 6 superposiciones.** *(Mi decisión: más ya no se lee; el botón
     explica el límite.)*
4. **Tiempo compartido:** la serie superpuesta vive **en el mismo chart** de
   lightweight-charts que las velas, así que el zoom, el desplazamiento y el
   puntero comparten eje de tiempo sin código de sincronización.
5. **Fila de chips**, uno por superposición, sobre el gráfico. Cada chip
   muestra el color, el nombre (`BTC/USDT`, `ETH-31OCT26-2500-C`), la fuente y
   unidad en texto secundario, el valor bajo el puntero (o el último), y
   botones para ocultar y quitar. El chip enfocado se ve resaltado (borde en su
   color) e indica "eje izq.". Sin el selector de modo de escala de la
   maqueta: solo existe el modo A. Con muchas superposiciones la fila hace
   scroll horizontal y nunca tapa el gráfico más de una línea.
6. **Tooltip del puntero** con el valor del principal y el de **cada**
   superposición visible en la vela señalada, en filas con su color, más el
   cambio de cada uno frente a la vela anterior. En opciones también muestra
   "Última operación hace N h". Las ocultas no aparecen.
7. **Horas sin operaciones** (opciones): el tramo con `volume = 0` se dibuja en
   gris discontinuo (`#a8a29e`, dash 4/4). Leyenda al pie: "Prima negociada" y
   "Sin operaciones (último precio arrastrado)".
8. **Prima en USD:** en opciones inversas, `prima_usd = prima_moneda ×
   cierre del subyacente en esa misma vela`.
9. Las superposiciones **se recuerdan** en `localStorage` (una clave nueva,
   junto a las demás preferencias de TradingView), con su orden, color,
   cuál está enfocada y cuáles ocultas. Se restauran al recargar.
10. **Móvil (≤768 px, `MOBILE_QUERY`)**: diseño propio, nunca el de escritorio
    encogido (regla del usuario: todo es mobile-first).
    - El selector se abre en `BottomSheet`.
    - Los chips van en una fila compacta con scroll horizontal: punto de color
      y nombre corto (`BTC`, `C 2500 · 31 oct`).
    - Tocar un chip lo enfoca. Tocar el chip enfocado abre una hoja de
      acciones: ocultar, quitar y, **solo en activos**, "Ver en grande", que
      lo intercambia con el principal (objetivo 13).
    - El eje izquierdo se mantiene, más estrecho.
    - La lectura del puntero va en la barra inferior, como el OHLC actual:
      una línea por serie, desplegable.
    - Los toques tienen un objetivo mínimo de 44 px.
11. **Selector, más detalle** (maquetas 2 y 4):
    - Arriba, la sección **"En el gráfico"** lista lo ya superpuesto con su
      color. Tocar "Añadido" lo quita.
    - En la pestaña Opción, escritorio usa tres zonas a la vez: subyacentes en
      pastillas, vencimientos agrupados en "Vigentes" y "Vencidos · último
      año" con buscador por fecha, y una tabla de strikes con CALL y PUT por
      fila. El ATM se marca, cada fila muestra la distancia en % y hay una
      barra de progreso mientras se sondean strikes ("Buscando strikes · 43 de
      60"). Los strikes sin operaciones en ese rango salen atenuados ("Sin
      operaciones").
    - En móvil, la pestaña Opción es un flujo de tres pasos en la misma hoja:
      subyacente, después vencimiento, después strike. Hay botón atrás y el
      paso actual se ve arriba. *(Mi decisión.)*
12. **Velas del principal atenuadas** (opacidad aproximada de 0.55) mientras
    haya al menos una superposición visible, para que las líneas se lean
    encima. *(Mi decisión, como en las maquetas; si no gusta se quita.)*
13. **Cambio rápido:** desde el menú de un chip, "Intercambiar con el
    principal" convierte esa superposición en el gráfico principal y el
    principal en superposición. Solo para activos, no para opciones. *(Mi
    decisión: es una acción natural al comparar.)*

## Prima pagada por operación (pedido del usuario, 2026-10-21)

Se muestra en escritorio y en móvil. *(Interpretación mía de "ambas vistas".)*

- **Fuente:** `https://history.deribit.com/api/v2/public/get_last_trades_by_instrument_and_time?instrument_name&start_timestamp&end_timestamp&count&sorting`.
  Verificado el 2026-10-21: devuelve operaciones de contratos vencidos (la API
  normal de `www.deribit.com` responde vacío para vencidos). Cada operación
  trae `timestamp, price, contracts, amount, direction (buy|sell),
  index_price, mark_price, iv, trade_id`. Pagina con `has_more`.
- **Prima pagada por operación en USD:**
  - Inversas (BTC, ETH): `price × contracts × index_price`.
  - `*_USDC`: `price × amount`.
- **Por vela** (en la temporalidad del principal): total de prima pagada en
  USD, número de operaciones, número de compras y de ventas (según
  `direction`, la del agresor), y la lista de operaciones de la vela.
- **En el gráfico:** barras de "prima negociada" por vela al pie del panel de
  precio, como un histograma de volumen, en escala propia (overlay, unos 15 %
  de alto). Solo para la **opción enfocada**, en su color: compras en el color
  sólido y ventas en el mismo color al 45 %, apiladas. Si la enfocada es un
  activo, no hay barras.
- **Tooltip (escritorio) y lectura inferior (móvil):** bajo la fila de la
  opción, "Prima pagada en la vela: $1,240 · 6 operaciones (4 compras, 2
  ventas)" y las 3 operaciones más grandes:
  `03:12 compra 8 × 0.0002 ETH = $6.13`. En móvil esa sección se pliega y se
  despliega con un toque.
- **En el chip** de la opción, junto al valor: "Σ $48.2k en vista" (prima total
  pagada dentro del rango visible). *(Mi decisión.)*
- Las operaciones de un contrato vencido no cambian: se cachean de forma
  permanente. En los vigentes, caché de 10 s y solo el tramo nuevo.
- Endpoint propuesto:
  `GET /api/market/options/trades?instrument&timeframe&startTime&endTime` →
  `{ buckets: [{ time, premiumUsd, trades, buys, sells, top: [ {ts, side,
  contracts, price, premiumUsd} ] }] }`.

## No-objetivos

- La superposición en la vista multi-pantalla (`/trading-view/multi`). *(Mi
  decisión: el usuario no respondió; queda para después.)*
- Los modos de escala B (% desde ancla) y C (manual) de la maqueta.
- Opciones de Binance como fuente, ni del pasado ni vigentes. *(Mi decisión:
  Deribit para todo, por coherencia.)*
- Prima teórica, Black-Scholes o griegas.
- Superponer en Replay: la superposición se oculta mientras Replay está
  activo. *(Mi decisión.)*
- Persistir en el servidor.

## Anti-objetivos (fallaría aunque "funcione")

- **Correlaciones falsas:** pintar los tramos sin operaciones igual que los
  negociados. Siempre se distinguen.
- **Desalinear el tiempo:** que una vela de la superposición quede en otra
  hora que la del principal. Los `time` deben coincidir exactamente con la
  apertura de vela del gráfico principal.
- **Ruido ilegible con N series:** colores parecidos, chips que tapan media
  pantalla o un tooltip interminable. Hay paleta distinguible, tope de 6 y
  fila de chips de una línea.
- **Romper `/trading-view`:** indicadores, dibujos, Replay, la escala
  log/% de la derecha (`priceScaleMode`), la carga de historial al hacer
  scroll y el polling en vivo siguen como están.
- **Bloquear la UI** al buscar strikes de un vencimiento antiguo: muestra
  progreso y se puede cancelar.

## Reglas de comportamiento

### Temporalidad
- La superposición usa **siempre la temporalidad del gráfico principal**. Al
  cambiarla se recarga la superposición. *(Mi decisión.)*
- Deribit no tiene 4h, 1W ni 1M nativos. El servidor agrega: 4h desde 60, 1W
  y 1M desde 1D. Las velas agregadas se alinean al mismo inicio que usa el
  gráfico principal para esa temporalidad (UTC, igual que Binance).
- Correspondencia: 1m→1, 5m→5, 15m→15, 1h→60, 4h→60 agregado, 1d→1D, 1w→1D
  agregado, 1M→1D agregado.

### Rango y carga
- **Opción fuera del tramo cargado** (decidido por el usuario: "Saltar a su
  vida"):
  - Si la vida de la opción cae fuera de las velas cargadas del principal, el
    gráfico carga el historial del principal hasta esas fechas (mismo
    mecanismo que el scroll a la izquierda) y mueve la vista a la vida de la
    opción, los 7 días antes del vencimiento.
  - Aparece el botón **"Volver a ahora"**.
  - El polling en vivo se pausa mientras la vista no incluya el presente y se
    reanuda al volver.
- Al superponer se pide el mismo rango temporal que tienen las velas cargadas
  del principal. Cuando el principal carga más historial (scroll a la
  izquierda), se pide el tramo nuevo de la superposición.
- Polling en vivo: si el principal está en vivo y la superposición es un
  activo u opción vigente, se refresca con el mismo intervalo
  (`LIVE_POLL_MS`). Una opción vencida no se refresca.
- **Fuera de la vida de la opción** (antes de su primera vela o después del
  vencimiento) no se dibuja nada: ni línea ni ceros.

### Alineación de activos con otro horario (Yahoo: índices, acciones)
- Cada vela del activo superpuesto se asigna a la vela del principal que
  contiene su apertura (`main.time <= t < main.time + tf`).
- Las velas del principal sin vela del superpuesto (mercado cerrado, fin de
  semana) quedan como **hueco**: sin punto, la línea se corta. Nunca se
  arrastra el último valor. *(Mi decisión, por el anti-objetivo de
  correlaciones falsas.)*
- Si el proveedor no da ese rango en temporalidades cortas (por ejemplo Yahoo
  en 1m o 5m antiguos), el chip lo dice ("Sin datos en este rango").

### Al cambiar el activo principal
- Las superposiciones se **conservan**: hay una sola lista global en
  `localStorage`, no una por activo. *(Mi decisión.)*
- Si una superposición coincide con el nuevo principal (por ejemplo tras
  intercambiar), no se dibuja mientras lo sea y su chip lo indica ("es el
  principal").

### Nombres en la UI
- El botón del ojo que ya existe ("Ocultar overlays",
  `tv_overlays_hidden_v1`) solo oculta etiquetas informativas. Se renombra a
  **"Ocultar etiquetas"** y no afecta a las superposiciones. La función
  nueva se llama siempre **"Superposiciones"**. *(Mi decisión.)*

### Representación
- Activo superpuesto: **línea** de cierres en su color. *(Mi decisión: velas
  encima de velas no se leen.)*
- Opción: línea de la prima en USD en su color. Los segmentos que **llegan** a una
  vela sin operaciones se pintan en gris discontinuo.

### Selector de opción
- Subyacentes: BTC, ETH, SOL, XRP, AVAX, TRX y HYPE. El selector propone por
  defecto el del gráfico principal si existe en Deribit. Si el principal es
  BNB o DOGE, explica que Deribit no lo tiene.
- Vencimientos:
  - **Vigentes:** de `get_instruments(expired=false)`.
  - **Vencidos del último año:** todos los **viernes**, verificados al vuelo
    con `get_instrument` de un strike cercano. Los diarios vencidos no se
    ofrecen: duran pocos días y muchos no tienen operaciones. *(Mi decisión.)*
- Strikes de un vencimiento vencido: el servidor sondea con `get_instrument`
  una rejilla alrededor del precio del subyacente 7 días antes del
  vencimiento (±30 %, con los pasos de arriba) y devuelve los que existen.
  Un contrato vencido no cambia, así que se cachea de forma permanente.
- Cada strike muestra su distancia al precio de ese día (por ejemplo "+4.5 %
  OTM") para orientar.

## API nueva (servidor)

Propuesta de forma. Los nombres y detalles son del implementador.

- `GET /api/market/options/expiries?underlying=ETH` → `[{ code: '31OCT25',
  expiry: <ms>, live: bool }]`
- `GET /api/market/options/strikes?underlying=ETH&expiry=31OCT25` → `[{
  strike, instrumentC, instrumentP, distancePct }]`
- `GET /api/market/options/candles?instrument=ETH-31OCT25-4000-C&timeframe=1h&startTime&endTime`
  → velas normalizadas como `/market/candles`, más `traded: bool` por vela, y
  la prima ya convertida a USD (con `premiumCoin` aparte para las inversas).
- El precio del subyacente para la rejilla de strikes y la distancia % OTM
  sale del servicio de velas existente (`marketDataService`, Binance
  `<SUB>USDT`). *(Mi decisión.)*
- El precio del subyacente para convertir a USD sale de Deribit (`ETH-PERPETUAL`
  y `BTC-PERPETUAL` con `get_tradingview_chart_data`). *(Mi decisión: misma
  fuente y mismo reloj que la opción.)*
- Límites: cola con concurrencia moderada hacia Deribit (unas 6 en paralelo,
  reintento ante 429). Caché en memoria del servidor: permanente para
  contratos vencidos, 10 s para los vigentes (el mismo criterio que
  `/market/candles`).
- Para un activo superpuesto se reutiliza `GET /api/market/candles` tal cual.

## Lo que queda al implementador

- Cómo dividir `TradingViewPage.jsx` (1314 líneas) para no engordarlo: se
  sugiere un hook `useChartOverlays(chart, mainCandles, timeframe)` que
  gestione N series, y componentes `OverlayChips`, `OverlayPicker` y
  `OverlayTooltip`.
- Paginación de `get_tradingview_chart_data` en rangos largos con resolución
  baja (1m durante un año): limitar el rango pedido al visible más un margen.
- Accesibilidad: el gris discontinuo no se distingue solo por el color (ya
  difiere en trazo y luminosidad).

## Pruebas

- **Unitarias (servidor):** construir y parsear nombres de Deribit (día sin
  cero, `d` decimal, `_USDC`), agregar 60→4h y 1D→1W/1M, convertir la prima
  inversa a USD y marcar `traded`. Sondeo de strikes con un cliente falso.
- **Unitarias (cliente):** alinear `time` con las velas del principal, dividir
  la serie en tramos negociados y sin operaciones, y guardar y restaurar
  `localStorage`.
- **E2E Playwright contra Docker en `localhost:5174`** (regla del usuario):
  superponer un activo, superponer una opción vencida, quitar la
  superposición, tener tres a la vez y cambiar la enfocada (el eje izquierdo
  cambia), ocultar una, recargar y que se restauren, el tope de 6, y el flujo
  móvil con viewport de teléfono.
