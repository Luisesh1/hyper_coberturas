# TradingView · Backtest de alertas en la gráfica

Fecha: 2026-10-21
Maquetas (servidor de brainstorming local; el usuario eligió la opción **A**):
`.superpowers/brainstorm/2559839-1792638921/content/markers.html`

## Intención

El usuario quiere ver **en la gráfica de un activo dónde se habría disparado
una alerta** con los datos históricos, para juzgar si la alerta "dispara donde
debe" antes de fiarse de ella (o de un bot que la use). Elige qué alertas
evaluar entre las que ya tiene; el sistema hace un **backtest preciso de la
información que le habría llegado al módulo de alertas** y pinta los
resultados sobre la gráfica. Tiene que funcionar también en la vista
**Multi‑TF**.

Lo que se quiere ver es **dónde dispara y por qué**. No se busca medir
rentabilidad.

Éxito: abrir BTCUSDT en 15m, activar "RSI sobreventa" y "MACD cruce bajista",
ver sus disparos marcados con sus colores, incluidos en tenue los que el
cooldown habría tapado. Al tocar una marca se lee la puntuación, el umbral y
qué reglas cumplieron, con sus valores. Las marcas tienen que coincidir con lo
que el motor en vivo habría calculado en esos mismos cierres de vela.

## Objetivos

1. **Seleccionar varias alertas existentes** en `/trading-view`. Cada una lleva
   su color, su chip en la leyenda y su ojo para ocultarla, igual que los
   indicadores (ver el ojo de la leyenda, commit `c0d7a57`).
2. **Evaluación fiel al motor** (`server/src/services/alerts/`):
   - Se evalúa en cada cierre de vela de la **temporalidad más baja** de la
     alerta (`lowestTimeframe`), como hace `alerts-scheduler.service.js`.
   - En cada evaluación, cada temporalidad recibe **exactamente lo que
     recibiría en vivo**. En vivo, `getCandles` con `limit: 250` se convierte
     en una **ventana de tiempo** `[T − 250×tf, T]`, y después
     `filterClosedCandles` quita la vela en curso. En cripto 24/7 quedan unas
     249 velas; en activos con horario de mercado (Yahoo) quedan bastantes
     menos.
   - El backtest replica **esa ventana de tiempo**, no "250 velas cerradas".
     `T` es el instante de evaluación en vivo: cierre de la vela base más
     `POST_CLOSE_BUFFER_MS` (3 s). Los indicadores con memoria (EMA, MACD,
     sqzmom…) calientan igual que en producción y dan el mismo valor.
     *Decisión de Claude, para que el resultado sea exacto.*
   - Misma puntuación ponderada (`calculateWeightedScore`), mismo umbral
     (`thresholdPercent`) y mismo `evaluator.evaluateRule`. **No se
     reimplementa** el evaluador: el backtest llama al mismo código que
     producción.
   - **Cooldown simulado como en vivo** (decisión del usuario). En vivo,
     `lastTriggeredAt` se fija con el instante de **envío** (`alertSentAt`), que
     cae después del cierre (3 s de buffer más lo que tarde en traer velas). En
     la siguiente evaluación, el resto de cooldown es
     `cd − (Date.now() − lastTriggeredAt)`.
   - El backtest fija el envío en `cierre + 3 s + δ`, con δ > 0 (por ejemplo,
     1 s), y evalúa en `cierre + 3 s`. Así, cuando el cooldown es igual a la
     temporalidad base (900 s en 15m), el disparo de la vela siguiente sale
     **suprimido**, como suele pasar en la práctica. El builder decide el
     valor exacto de δ, pero tiene que ser estrictamente mayor que 0.
3. **Mostrar dos clases de marca:**
   - **Disparo**: habría llegado al motor (puntuación ≥ umbral y sin cooldown).
     Marca rellena.
   - **Suprimido por cooldown**: superó el umbral, pero el cooldown lo bloqueó.
     Marca hueca o tenue. Un suprimido **no** reinicia el cooldown, igual que
     en vivo, donde `suppressedBy: 'cooldown'` no actualiza `lastTriggeredAt`.
4. **Estilo de marca (opción A, elegida por el usuario):**
   - La forma indica la dirección de la alerta: ▲ bajo la vela si es
     `bullish`, ▼ encima si es `bearish`, ● si es `neutral`.
   - El color indica la alerta.
   - Al pasar el ratón o hacer clic aparece una **tarjeta flotante** con el
     detalle: nombre, fecha y hora del cierre evaluado, temporalidad base,
     puntuación frente al umbral, si fue suprimido, y por cada regla ✅/❌, su
     peso y el `reason` del evaluador con los valores.
   - En **móvil**, la tarjeta es una **hoja inferior** con "‹ anterior /
     siguiente ›" para recorrer los disparos de esa alerta. Los chips de la
     leyenda muestran cuántos disparos tiene cada alerta (ver maqueta).
5. **Activo:** la alerta se evalúa sobre el **activo del gráfico**, esté o no
   en su `assetList` (decisión del usuario).
6. **Fuente de datos** (decisión del usuario):
   - Si la fuente de la alerta (`datasource`) **coincide** con la del gráfico,
     se usa esa.
   - Si **no coincide**, se evalúa con **la fuente del gráfico** y el símbolo
     del gráfico. El chip de la alerta lo indica, por ejemplo con un aviso
     "evaluada con Hyperliquid; la alerta usa Binance".
   - No hay traducción de símbolos entre fuentes (BTC ↔ BTCUSDT ↔ BTC-USD),
     porque no existe en el código y queda fuera de alcance. Por eso tampoco
     hay interruptor de fuente: esto sustituye a la idea inicial de un
     interruptor elegible.
7. **Rango:** se evalúa lo que está **cargado** en el gráfico, y se amplía al
   hacer scroll hacia atrás, cuando el gráfico pide más historia.
8. **Se respetan las temporalidades de la alerta** (requisito del usuario). La
   evaluación usa **siempre** las temporalidades que la alerta tiene
   configuradas en cada condición, y la temporalidad del gráfico **nunca**
   cambia el cálculo. **Al cambiar la temporalidad del gráfico**, las marcas
   solo se recolocan sin recalcular el backtest, porque los disparos dependen
   de la alerta y no del gráfico.
   - Un disparo en el instante T (cierre de la vela base) se dibuja en la vela
     del gráfico que contiene `T − 1 ms`, es decir, en la última vela que
     cerró en T o antes.
   - Si en una misma vela del gráfico caen varios disparos de una alerta (TF
     del gráfico mayor que el de la alerta), se dibuja **una sola marca** con
     un contador, y la tarjeta los lista. *Decisión de Claude.*
9. **Vista Multi‑TF** (`/trading-view/multi`, modo Multi‑TF): cada panel
   muestra las marcas de las alertas seleccionadas, recolocadas a su
   temporalidad con la regla anterior.
   - Las alertas y los disparos son los mismos en todos los paneles, porque el
     activo es el mismo.
   - En el modo Multi‑activo, cada panel evalúa su propio activo. *Decisión
     de Claude; el usuario no lo pidió y puede quedar fuera si complica.*
10. **Replay:** las marcas aparecen a medida que avanza el replay. Nunca se
    muestran disparos posteriores a la vela actual del replay.
11. **Persistencia:** la selección de alertas y sus colores u ocultación se
    guardan como los indicadores del gráfico, por usuario y en el servidor
    (`settings/chart-indicators` o un ajuste hermano). La vista Multi‑TF usa la
    misma selección. *Cómo se guarda exactamente lo decide el builder.*

## No objetivos

- **No** actualizar en vivo. Al cerrar una vela nueva en el modo en vivo no se
  añade la marca; se ve al recargar o al volver a pedir el rango (decisión del
  usuario).
- **No** editar la alerta desde el gráfico ni hacer pruebas "what‑if" de
  umbral o cooldown. Se evalúa tal cual está guardada; para cambiarla se usa
  la página de Alertas (decisión del usuario).
- **No** mostrar los disparos reales de `alert_events` (decisión del usuario).
- **No** calcular rendimiento posterior (% a N velas, tasa de acierto).
- **No** enviar Telegram, escribir `alert_events`, tocar `lastTriggeredAt` ni
  emitir en `alert-events`. El backtest es de **solo lectura**.

## Anti‑objetivos (fallaría aunque funcione)

- Que el backtest use velas aún no cerradas de una temporalidad mayor
  (*lookahead*). Por ejemplo, evaluar a las 14:15 con la vela 4h que cierra a
  las 16:00. Daría disparos que en vivo nunca habrían existido.
- Que haya una **segunda implementación** del evaluador en el cliente que se
  aparte de la del servidor.
- Que la gráfica se quede bloqueada o tarde segundos en cada scroll. El cálculo
  tiene que ir en segundo plano y las marcas aparecer cuando estén.
- Que en móvil las marcas sean imposibles de tocar o la tarjeta tape el
  gráfico sin forma de cerrarla.

## Restricciones y contexto

- **Motor actual:**
  - `alerts.service.js` (`evaluateAlertOnAsset`, `filterClosedCandles`,
    `calculateWeightedScore`, `lowestTimeframe`, `distinctTimeframes`).
  - `indicator-evaluator.js` (`evaluateRule`). Evalúa siempre en el **último
    índice** del array de velas que recibe, así que el backtest tiene que pasar
    en cada instante T el **corte** de 250 velas cerradas en T. Para los
    operandos `series` en otra temporalidad, el propio evaluador realinea con
    `alignSeries`.
- Hay que **extraer** de `evaluateAlertOnAsset` una función pura que, dado
  `(alertDto, candlesByTf ya cortadas)`, devuelva la puntuación y los
  resultados por regla. Esa función la usarán tanto el motor en vivo como el
  backtest, y **el comportamiento en vivo no debe cambiar**.
- **Coste:** hay una evaluación por cada vela de la temporalidad base del
  rango. En cada una se recalculan los indicadores sobre 250 velas por cada
  temporalidad. En 1m y con rangos largos son muchas operaciones.
  - El backtest corre en el **servidor**, por petición y por tramos
    (`startTime`/`endTime`).
  - Necesita traer 250 velas **extra hacia atrás** por temporalidad para
    calentar la ventana.
  - El builder decide si hay que poner un tope de velas por petición o una
    caché. *Sugerencia: cachear por (alerta, `updatedAt`, activo, fuente,
    tramo).*
- **Hyperliquid** solo sirve unas 5000 velas por temporalidad. Si falta
  historia para calentar una temporalidad, esas evaluaciones se marcan como
  "sin datos suficientes" y no se dibujan, en vez de inventar.
- Respetar la **UX móvil**: zonas táctiles de 44 px, sin scroll horizontal y
  con diseño explícito para el teléfono (preferencia permanente del usuario).
- `TradingViewPage.jsx` ronda las 1500 líneas. La lógica nueva va en módulos o
  hooks propios (`alertBacktest/`), no dentro de la página.
- Las E2E se corren contra Docker en `localhost:5174`.

## Qué se deja al builder

- La forma de la API. *Sugerencia:* `POST /api/alerts/:id/backtest`, con
  `{ asset, datasource, startTime, endTime }`, que devuelva
  `[{ time, lowestTf, score, threshold, suppressed, rules:[{matched, weight, reason, label}] }]`.
- Dónde va el selector de alertas: una pestaña "Alertas" en el panel del
  catálogo de indicadores o un botón propio en la barra, y su equivalente en
  la barra de pestañas móvil.
- La paleta de colores por alerta, que debe distinguirse de los colores de los
  indicadores y de las superposiciones.
- Cómo se dibujan las marcas: con `setMarkers` de lightweight‑charts o con un
  primitive propio. La marca hueca de "suprimido" y el contador pueden
  necesitar el primitive.
- Los estados vacío, cargando y error por alerta, que se muestran en su chip.
