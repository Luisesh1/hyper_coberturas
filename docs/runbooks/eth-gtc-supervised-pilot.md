# Piloto ETH Options — Take Profit residente GTC

**Estado: preparado para comprobar, NO-GO para enviar órdenes reales.**
Esta guía registra la decisión del operador del 17 de octubre de 2026:
**TP `LIMIT GTC reduceOnly` colocado tras el fill confirmado de la entrada**.
La alternativa sintética FOK de PR #20 **no** participa del piloto.

## Flujo nominal y límites

1. Estrategia dedicada en `paused`; **ninguna** otra estrategia live,
   posiciones u órdenes abiertas en la cuenta aislada. Mantener
   `OPTIONS_LIVE_TRADING_ENABLED=false`,
   `OPTIONS_LIVE_PRODUCTION_APPROVED=false` y
   `OPTIONS_LIVE_PILOT_AUTHORIZED` diferente de `true`.
2. La única apertura candidata sería **BUY ETH 0.01 LIMIT FOK**,
   con símbolo, vencimiento, strike y precio máximo autorizados
   explícitamente por el operador para **esa** transacción. No reutilizar
   permisos caducados ni la referencia histórica
   `ETH-261023-2500-C / 23.60 USDT`. El motor bloquea reentradas.
3. El acuse `NEW` **no crea posición**. Solo `getOrder` +
   `getUserTrades` confirmados producen un registro de fill real.
4. En **la misma pasada del conciliador posterior al fill** se registra
   un único `take_profit` y se envía explícitamente
   `LIMIT SELL GTC reduceOnly` al target fijo calculado por tick;
   por defecto la conciliación es aproximadamente cada 60 segundos,
   por lo que **hay una ventana sin TP**. La orden reside en Binance
   cuando se confirma `NEW`. La base de datos conserva el
   `clientOrderId` antes de hacer POST y no duplica POST tras caída.
5. Al dispararse un stop, señal de cierre o salida de tiempo, se solicita
   cancelar únicamente el TP original; se verifica su estado terminal
   y todos sus fills antes de mandar otro cierre
   `LIMIT FOK reduceOnly` para la cantidad restante.
   Un FOK puede expirar sin ejecución; un stop local no garantiza la
   pérdida limitada. El coste de la prima comprada puede perderse entero.

## Comando de comprobación — sin dinero ni mutaciones

Con el servicio ya actualizado y el sistema **apagado**, dentro del
contenedor `server` de la cuenta aislada:

```bash
node src/scripts/options-gtc-pilot-readiness.js \
  1 'ETH-YYMMDD-STRIKE-C' '0.01' 'MAX_LIMIT_EN_USDT'
```

Sustituir los marcadores por un contrato realmente listado y una
cotización **vigente** que el operador revise. El script solo lee:
estrategia pausada en PostgreSQL, permisos y órdenes en Binance,
cuenta/posición y cotización con profundidad fresca. Devuelve estados
sanitizados `gtc_pilot_*=pass|fail`, con
`gtc_pilot_status=candidate|blocked` y **siempre**
`pilot_ready=no`. No abre la estrategia, no envía órdenes, no cancela,
no modifica flags ni crea permisos. Un candidato no equivale a GO.

Se exige presupuestar **la prima al máximo LIMIT más reserva
provisional del 10 %** dentro de los **0.26 USDT** configurados
para la estrategia pausada. **No elevar** ese límite para conseguir
una cotización. Si el ask vigente, filtros, saldo o profundidad
exceden la restricción, responder NO-GO y buscar otra propuesta
separadamente revisada. Comisiones efectivas, conversión USD/USDT y
capacidad real de cierre son comprobaciones independientes.

## Bloqueos obligatorios antes de activar piloto

- Revisar permisos Binance (IP permitida, sin retiros), saldo **available**,
  símbolos/filtros, liquidez, precios y costes exactos al momento de operar.
- Confirmar aviso Telegram efectivo y monitorización externa; un cron
  de cinco horas no sirve como protección de una posición abierta.
- **Resolver y demostrar** con Binance real que un fill parcial del TP
  GTC no deja 0.005 contratos que Binance rechazaría cerrar
  por `minQty=0.01`, o disponer de procedimiento operativo probado
  para cerrar sin abrir exposición adicional. Registrar evidencias.
  Este caso actualmente es **NO-GO para trading autónomo**.
- Validar con operaciones de prueba específicamente autorizadas
  `getOrder`, `userTrades`, cancelación con fill simultáneo,
  recuperación de `sending/attention`, salida y eventual
  `exerciseRecord`/`bill`. Las pruebas in-memory no bastan.
- Revisar y aprobar de forma separada el **símbolo exacto, BUY, cantidad,
  límite, coste total, TP, stop, vencimiento** y la autorización temporal
  de no más de 15 minutos. La petición de preparar el piloto **no**
  autoriza una orden real.
- Revisión independiente de los cambios que permitirían activar live.
  El `docker-compose.prod.yml` actual fija los dos flags OFF por
  seguridad. No saltarse las barreras del deploy.

## Incidencias

Si el TP no aparece activo dentro de dos minutos del fill,
`UNPROTECTED_TP`: detener nuevas entradas, comparar
`getOpenOrders/getOrder/userTrades` contra el ledger y revisar Binance.
Si `PARTIALLY_FILLED`, `CANCELED` o `EXPIRED` con
`0 < executedQty < quantity`, mantener `ATTENTION`, registrar
únicamente fills verificados y avisar al operador: **NO** asumir
posición cerrada ni publicar orden inferior al lote permitido.
Si falla una consulta o el bot se reinicia, recuperar por
`clientOrderId` sin duplicar POST.

**Resultado de esta iteración:** procedimientos y código de verificación
preparados; **sin órdenes reales ejecutadas, sin permisos habilitados**.

## Protección adicional: TP GTC con ejecución parcial (17 de octubre)

- Al conciliar una orden GTC con fill parcial y una salida solicitada
  (stop, señal o vencimiento del plazo), consultar la cantidad efectivamente
  ejecutada en Binance y el filtro LOT_SIZE más reciente.
- Si el resto **no constituye una nueva orden válida** bajo minQty/stepSize,
  **NO cancelar el TP residente**. Registrar únicamente trades reales,
  mantener el incidente ATTENTION y notificar intervención del operador.
  No enviar otro SELL ni redondear la posición restante.
- Si el resto **sí** es operable, se permite el flujo previo de cancelación,
  verificación terminal y cierre FOK para el remanente confirmado.
- Una orden que YA esté cancelada/expirada con resto inferior al mínimo
  **no se puede restaurar automáticamente**. Se debe conciliar con Binance,
  evaluar asistencia del exchange o liquidación al vencimiento y mantener
  entradas nuevas bloqueadas. **No garantiza el stop ni un cierre total**.
- Carrera residual: Binance puede llenar parcialmente entre el último
  getOrder y la confirmación de cancelación. Las pruebas automatizadas
  no eliminan esa ventana; NO-GO para trading autónomo hasta validar
  semántica real del exchange o disponer de procedimiento probado.
- Este cambio conserva ambos flags de trading en false y se despliega
  automáticamente por la CI sin enviar órdenes reales.
