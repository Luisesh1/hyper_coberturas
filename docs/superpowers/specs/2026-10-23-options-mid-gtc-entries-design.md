# Bots de opciones: entradas GTC a precio medio y comisiones visibles

Fecha: 2026-10-23 · Estado: propuesto · Ámbito: bots por alertas (`alert_signal`)

## Por qué

Hoy las aperturas pagan el lado caro del libro: compran al ask o venden al bid.
En ETH se envían además como FOK, que se ejecuta entera al momento o se
cancela. El usuario quiere entrar a un precio mejor, en el punto medio del
spread, dando tiempo al mercado para llenar la orden. Acepta el riesgo de
llenados parciales que el FOK evitaba.

También quiere ver con claridad cuánto se va en comisiones: en cada operación
y como total del bot.

## Objetivos

1. **Toda apertura** de un bot por alertas se envía como `LIMIT GTC` al
   **precio medio válido** entre bid y ask, en todos los subyacentes (ETH y
   BTC por igual).
2. La entrada se **supervisa 10 minutos**. Lo que no se haya ejecutado se
   cancela. No se reintenta; el bot espera a la siguiente señal.
3. **La sombra se comporta igual**: la entrada simulada espera hasta 10
   minutos al precio medio y solo se llena si el mercado llega a ese precio.
4. Las comisiones se muestran **en cada operación** y **como total del bot**.

## No objetivos

- Los cierres no cambian. ETH sigue cerrando con FOK y el resto con GTC al
  bid o ask. El TP residente sigue siendo GTC.
- No se persigue el precio: el límite se fija al enviar y no se re-cotiza
  durante los 10 minutos.
- No se relajan las barreras de trading real: la doble llave de flags, el
  permiso del piloto y las comprobaciones de exposición y de órdenes ajenas
  siguen igual.
- El ticket manual de Opciones no cambia.

## Anti-objetivos (sería un fracaso aunque funcione)

- Pagar el ask a ciegas cuando no hay un medio fiable.
- Una sombra optimista que siempre entra cuando la real no lo haría.
- Un llenado parcial que deja un resto imposible de operar y del que nadie se
  entera, o tras el cual el bot sigue abriendo como si nada.
- Que la comisión mostrada no coincida con la que se usa en el P&L.

## Comportamiento acordado

### Precio medio válido (decidido por el usuario)

- `medio = (bid + ask) / 2`, ajustado a la rejilla del contrato
  (`minPrice + k·tickSize`).
- Si cae entre dos ticks se redondea **hacia el llenado**: hacia arriba al
  comprar y hacia abajo al vender. Nunca pasa del ask al comprar ni baja del
  bid al vender. Con un spread de un tick, el medio coincide con el ask o el
  bid.
- **Sin medio fiable no se entra.** Si falta el bid o el ask, o alguno es
  ≤ 0, la señal se registra como «Sin precio medio válido» y el bot espera a
  la siguiente. Nunca recurre al ask/bid. El filtro de spread que ya existe
  (`maxSpreadPct`, opcional) sigue siendo lo que descarta spreads anchos
  *(decisión de Claude: no se añade otro umbral)*.
- La cotización usada es la **fresca** que el ejecutor real ya consulta antes
  de enviar. El presupuesto, la prima máxima y los límites de riesgo se
  revalidan con el precio medio, que es el que se envía de verdad.
- El tamaño (contratos) lo sigue calculando el template con el precio
  ejecutable (ask o bid), que es más caro que el medio. Así la cantidad
  nunca supera el presupuesto aunque la orden salga al medio
  *(decisión de Claude: conservador y sin tocar el dimensionado)*.

### Supervisión de 10 minutos (real)

- La apertura queda como `LIMIT GTC`. Esto reemplaza el FOK de las aperturas
  en ETH; `orderTimeInForce` deja de devolver FOK para `action === 'open'`.
- La ventana es el `WINDOW_MS` (10 min) que ya existe. Al vencer, el
  conciliador cancela el resto y registra solo los fills confirmados por
  Binance. No hay reintento.
- **Llenado parcial (decidido por el usuario: se acepta).**
  - Lo ejecutado queda como posición y recibe su TP con normalidad.
  - Si lo ejecutado es menor que `minQty` o no cae en la rejilla de
    `stepSize`, la posición no se puede cerrar con una orden. En ese caso se
    marca **atención**, se avisa por Telegram y el bot **no abre más en ese
    subyacente** hasta que el usuario lo revise.
  - Hoy un llenado parcial de una apertura FOK en ETH se trata como anomalía.
    Con GTC deja de serlo; solo el resto inoperable se marca.
- **Señal contraria durante la espera (decidido por el usuario).**
  - Se pide cancelar la entrada pendiente con el `requestCancel` /
    `cancel_requested` que ya existe.
  - Lo que ya se haya llenado se trata como posición contraria según
    `onOpposite`: `close`, `reverse` o `ignore`.
  - En `reverse`, la nueva entrada solo se abre cuando la cancelación y los
    cierres se han conciliado, igual que el giro actual.
- Una señal **en el mismo sentido** durante la espera se descarta como hoy
  («Hay una orden de entrada pendiente»).

### Sombra igual que real (decidido por el usuario)

- Una apertura en sombra crea una **entrada simulada pendiente**: precio
  medio, cantidad y plazo de 10 minutos.
- Se considera llenada cuando, dentro del plazo, el lado ejecutable llega al
  precio: ask ≤ límite al comprar, bid ≥ límite al vender. En ese momento se
  registra la posición al **precio límite**, con la comisión estimada.
- Se comprueba en cada pasada del conciliador (cada 60 s) y en las pasadas
  del runner. Por eso el «llenado» simulado tiene una granularidad de unos
  60 s *(decisión de Claude)*.
- Si vence sin llenarse, se cancela y queda registrada como «Entrada sin
  ejecutar».
- La sombra llena la entrada simulada **completa o nada**. El libro de la
  cadena no da profundidad por nivel *(decisión de Claude)*.
- Una entrada simulada pendiente bloquea el subyacente igual que una real
  (`pendingOpens`), y una señal contraria la cancela igual que en real.

### La señal se actualiza al resolverse la entrada *(decisión de Claude)*

Hoy una señal que deja una entrada pendiente se queda en `pending` para
siempre: `finishAutoSignal` solo se llama al procesar el disparo. Con
entradas que esperan hasta 10 minutos, eso dejaría el historial sin
desenlace y sin comisión. Al resolverse la entrada, real o sombra, la fila de
la señal se actualiza a:

- `opened`, con precio, contratos y comisión;
- `opened` con la nota «parcial: X de Y contratos»;
- o `ignored` con «Entrada sin ejecutar en 10 min» (o «cancelada por señal
  contraria»).

### Comisiones (decidido por el usuario: todas, en tres sitios)

- **Qué cuenta:** comisión de entrada, de salida y de ejercicio o liquidación
  al vencimiento.
  - En real se usa la que cobra Binance: el `fee` de `userTrades` y la factura
    `EXERCISE_FEE`.
  - En sombra se usa la estimada con la fórmula de Binance (`tradeFee`,
    `exerciseFee`).
  - Hoy esto ya se acumula en `options_strategy_positions.fees_usdt`.
- **Historial de señales:** cada señal que abre o cierra indica su comisión,
  por ejemplo «Comisión 0,21 USDT». En una apertura real que aún espera fill
  se muestra «Comisión est. …» hasta que Binance la confirma.
- **Posiciones del bot** (abiertas y cerradas): comisiones pagadas hasta el
  momento y P&L neto de comisiones.
- **KPIs del bot:** total acumulado de comisiones y su porcentaje sobre la
  prima operada, separado en sombra y real.
  - `kpisFor` ya calcula `feesUsdt` y `premiumUsdt`; falta mostrarlo.
  - El total cubre toda la vida del bot. El % es `fees / prima operada`.
- El P&L registrado ya es neto: al cerrar, en sombra y en real, se resta
  `fees_usdt` del P&L bruto. La UI debe decirlo («P&L neto de comisiones»)
  para que la cifra y la comisión se lean juntas sin sumarlas dos veces.

## Restricciones

- Trading real con dinero. Ante la duda, no se envía. Cada camino nuevo tiene
  tests con Binance simulado, incluidos llenado completo, parcial operable,
  parcial inoperable, vencido sin fills, cancelación por señal contraria y
  caída del proceso a mitad.
- No se registran posiciones reales sin fill confirmado por Binance.
- Las migraciones siguen la numeración (la última es la 045) y deben poder
  aplicarse con los flags de trading apagados sin efectos.
- UI con buena experiencia en móvil: la ficha del bot y el historial ya
  tienen vista móvil, y las comisiones deben verse bien a 390 px.
- Los e2e se ejecutan contra Docker en `localhost:5174`.

## A criterio de quien lo construya

- Dónde se persiste la entrada simulada pendiente de la sombra: una tabla
  nueva o `options_live_orders` con una columna de modo. Debe sobrevivir a un
  reinicio y no confundirse nunca con órdenes reales en las comprobaciones de
  exposición, órdenes ajenas y alertas.
- Cómo se asocia la comisión a cada señal en el historial: por evento, por
  señal o por `clientOrderId`.
- El texto exacto de los mensajes y la disposición de las comisiones en cada
  vista, siguiendo el estilo existente.
- Actualizar los runbooks de trading real
  (`binance-options-live-readiness.md` y `eth-gtc-supervised-pilot.md`), que
  hoy dan por hecho la entrada FOK en ETH, y la nota del proyecto en el vault.
