# Take Profit LIMIT residente · Binance Opciones (PR #4)

## Configuración

En la ficha del bot se elige **Porcentaje fijo** (predeterminado para bots existentes) o **ATR + volatilidad implícita**. La interfaz muestra un estado compacto para las órdenes reales: `Preparando`, `Por confirmar`, `Activa`, `Cancelando` o `Revisar`.

El porcentaje usa la **prima del fill confirmado**, no el mark ni un mero acuse `NEW`. El modo por volatilidad proyecta el cambio de prima con ATR(14) de velas spot de una hora cerradas, IV de la opción y Black–Scholes. Parámetros: `tpAtrMultiplier` 0.25–4 y `tpHorizonHours` 1–24.

## Ciclo real de la orden

1. El reconciliador consulta `getOrder` y `getUserTrades` periódicamente (cada ~60 s). Cada fill de apertura **confirmado** genera una fila distinta de posición, con cantidad y comisiones reales.
2. En **esa misma pasada de conciliación**, cuando la exposición de Binance coincide con el libro, se crea transaccionalmente una intención de TP vinculada a `position_id` (`options_live_orders.purpose='take_profit'`, única mientras no es final).
3. El remitente reclama `queued → sending` **antes** de llamar `POST /eapi/v1/order`, con `LIMIT GTC`, `reduceOnly=true` y `clientOrderId` durable. Si el POST da timeout, consulta por identidad y nunca lo repite a ciegas. El objetivo se redondea sobre `minPrice + N*tickSize`; se exige `TRADING`, cotización USDT y `minQty/stepSize/maxQty` válidos.
4. El TP queda resting en Binance hasta que llena, se solicita cancelarlo o llega su ventana de salida temporal. El fill del TP cierra total o parcialmente **solo tras conciliación**. Los remanentes se pueden volver a proteger si no hay otro cierre solicitado. La ventana de diez minutos **solo aplica a órdenes estándar**, no al TP resting.
5. Cuando un Stop Loss, señal contraria o salida por vencimiento requiere cerrar, primero se escribe `options_live_exit_requests` duraderamente y se marca `cancel_requested` en el TP (y remanentes de entrada). El reconciliador cancela esa orden específica, verifica su estado final y sus fills, y **solo entonces** puede remitir otro cierre con la cantidad que efectivamente sigue abierta. Un cierre parcial se reintenta sin volver a proteger el remanente.
6. En la opción **Girar** (`onOpposite='reverse'`), la intención de nueva entrada y los cierres se guardan conjuntamente en `options_live_reentries`; solo se reevalúa y envía la nueva apertura cuando **todas** las posiciones contrarias están cerradas, el bot continúa en modo real, hay datos frescos y se vuelven a comprobar los límites de riesgo. Una señal de giro pendiente durante más de **30 minutos caduca** (no opera una señal anticuada).
7. Si llega el límite temporal del TP sin haber un tick disponible, se persiste una solicitud `time_exit` **antes** de cancelar la orden resting; no se inventa una liquidación por mark.

El TP se presenta como **orden aceptada, no garantía de cierre**. Un rechazo, error de datos, cuenta con órdenes ajenas, exposure mismatch, vencimiento, un movimiento del libro o un timeout dejan el caso **sin ejecutar o en atención**, con aviso Telegram deduplicado. El bot no inventa un fill ni aumenta exposición.

## Limitaciones explícitas

- La observación del fill depende del polling de conciliación (~60 s): «inmediato tras confirmación» no significa ejecución subsegundo.
- El precio objetivo de un TP resting se fija **al detectar el fill** y no se recalcula cada cinco minutos. El runner evalúa stop/señal/salida temporal aproximadamente cada cinco minutos; por lo tanto un stop no es un stop exchange-native ni garantiza precio.
- Binance Opciones ofrece órdenes LIMIT; no se presupone una OCO nativa idéntica a Spot. Las cancelaciones, salidas diferidas y restricciones de exposición corren en nuestro ledger.
- Con los dos flags de trading real apagados, las tareas no envían TP, cierres ni aperturas nuevas; las órdenes antiguas solo se concilian/cancelan según políticas previas. Una posición real abierta puede necesitar gestión manual.
- Un bot no abre entradas nuevas si hay órdenes TP resting en la cuenta: decisión de seguridad conservadora hasta validar convivencia de múltiples estrategias. El cierre de otra posición puede coexistir con TP ajenos **solo** si todos están identificados en el ledger.
- No se conoce todavía en esta conversación el resultado de ejercicios y cancelaciones **con una cuenta real del usuario**; todas las verificaciones nuevas son con mocks. No habilitar ambos flags ni hacer deploy basándose solo en CI.

## Pruebas y operación

`node --test server/test/options-standing-tp.test.js server/test/options-standing-tp-repository.test.js server/test/options-reverse-after-tp.test.js server/test/options-reverse-repository.test.js`

El runbook `docs/runbooks/binance-options-live-readiness.md` define las comprobaciones del VPS, esquema real Binance, permisos mínimos, manejo de incidentes y piloto con capital mínimo. Las tablas `options_live_orders`, `options_live_exit_requests` y `options_live_reentries` deben migrarse **antes** de ejecutar el reconciliador actualizado.

Código en PR **DRAFT**, sin despliegue ni autorización de trading.
