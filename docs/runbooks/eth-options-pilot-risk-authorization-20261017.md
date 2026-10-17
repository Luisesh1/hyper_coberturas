# Decisión del operador y límites del piloto ETH Options — 17 octubre 2026

**Estado: autorización general de presupuesto y aceptación de riesgo, NO una orden concreta aprobada; trading real sigue OFF.**

## Decisión comunicada
- El operador acepta el riesgo residual de **ejecución parcial del take profit LIMIT GTC** que podría dejar una cantidad inferior a `minQty` y exigir intervención humana o esperar hasta el vencimiento. Esta aceptación **no significa** que Binance haya demostrado la inexistencia de esos fills.
- Autoriza preparar y, una vez cumplidas las barreras operativas y transaccionales, efectuar **pruebas supervisadas** con **un máximo de 20 USD de costo total por apertura**, incluidas comisiones de entrada. Esto es un **techo**, no un mínimo ni una instrucción de utilizarlo íntegramente.
- Establece **100 USD como pérdida acumulada máxima neta de capital de todas las pruebas**, incluyendo posiciones abiertas marcadas a mercado, operaciones cerradas y comisiones. Para prevenir exceder el límite antes de que un stop local actúe, se exige capacidad de suspender nuevas entradas con margen prudente. No computar ganancias anteriores como permiso automático para aumentar tamaño o rehacer presupuesto.
- **Pérdidas menores son preferibles**: el piloto existente continúa limitado a 0.26 USDT por estrategia y 1 USDT en límites locales hasta que un cambio separado y verificado justifique cualquier incremento.
- USD y USDT no son equivalentes garantizados. No se puede afirmar cumplimiento de un tope expresado en USD sin conversión actual fiable y reconocimiento de comisiones y exposición.

## Riesgo aceptado y contención que no se elimina
1. Los filtros `LOT_SIZE` determinan nuevas órdenes. El diagnóstico del 17/10/2026 confirmó que `0.01` es válido y una nueva `0.005` no lo es; la muestra de 100 trades públicos tuvo 0 cantidades fuera del lote. Esto **no prueba** la granularidad de cada fill futuro.
2. Ante un TP parcialmente ejecutado, conciliar `getOrder` y `getUserTrades`, persistir fills reales antes de cualquier decisión. Si cancelar el TP dejaría un resto imposible de operar, **conservar la orden residente**, marcar **ATTENTION** y avisar al operador; no redondear el resto ni duplicar un cierre.
3. Si el TP se cancela/expira con residuo inferior a `minQty`, **bloquear nuevas entradas** y solicitar resolución manual con evidencia de Binance o esperar liquidación al vencimiento, si aplica. El stop no garantiza el precio ni la ejecución. No hay garantía de limitar pérdidas al importe del stop.
4. No se autorizan **opciones cortas descubiertas**, múltiples aperturas simultáneas ni trading autónomo con esta decisión. Comenzar con **una BUY-to-open ETH** a lote mínimo si existe candidata viable.

## Registro forense requerido por cada cierre parcial o incidencia
El ledger del proyecto dispone de registros de órdenes y fills (`options_live_orders`, `options_live_fills`), estado `attention` y avisos. Para reconstrucción posterior conservar, sin publicar secretos:
- **Cuándo:** `created_at`, `updated_at`, `traded_at` (UTC), hora de detección, consulta y cancelación.
- **Dónde:** entorno de VPS/deploy y commit del release, `symbol`, ID local de estrategia/posición, `clientOrderId`, `orderId`, `tradeId` de Binance.
- **Cómo:** orden original, lado, `timeInForce`, `reduceOnly`, precio límite, cantidad solicitada, ejecutada y restante, `minQty/stepSize` vigentes, fills parciales, precios, fees, estados `PARTIALLY_FILLED/CANCELED/EXPIRED/ATTENTION`, mensaje de error y decisiones de protección.
- **Resultado:** comparación de posición real Binance versus ledger, P&L neto y comisiones, alerta entregada/no entregada, bloqueo de nuevas entradas, acción manual y conciliación final.
- Prohibido imprimir claves API, secretos, saldos privados o identificadores de cuenta en logs públicos de GitHub Actions. El almacenamiento privado duradero y la consulta humana de incidentes deberán comprobarse en el entorno real antes del piloto.

## Estado operativo al registrar esta decisión
- El deploy #117 pasó y mantuvo `OPTIONS_LIVE_TRADING_ENABLED=false` y `OPTIONS_LIVE_PRODUCTION_APPROVED=false`.
- La vista previa de solo lectura del despliegue #117 encontró viable **en ese momento** `ETH-261023-2500-C`, BUY `0.01`, con límite de referencia `23.60 USDT` por unidad y reserva total máxima de `0.26 USDT`. **Los precios caducan: no utilizar esa cotización para ordenar sin renovarla.**
- La estrategia piloto #2 aparece como candidata y pausada; `alertIds=[]` no permite generar entrada. Aún faltan señal efectiva, notificaciones Telegram comprobadas, tarifas exactas, vigilancia y revisión independiente.
- La autorización genérica de presupuesto **no equivale a autorización transaccional**. El mecanismo de seguridad exige una propuesta con símbolo, cantidad, precio límite y costo total recién verificados, TP, stop, vencimiento y permiso de esa única orden con duración máxima de 15 minutos.
- No enviar órdenes ni activar flags de producción desde esta documentación. Cualquier cambio de ejecución requiere revisión, CI y controles de pérdida reales; no basta la promesa de un tope si no existe monitorización fiable del drawdown.

## Próximo paso operativo breve
1. Confirmar señal vinculada y canal Telegram, mantener cuenta aislada.
2. Actualizar cotización exacta, comisiones y saldo; comparar con el límite **menor** entre los guardarraíles configurados y los techos de USD autorizados.
3. Preparar la propuesta de **una** orden supervisada y permiso temporal exacto, revisar la barrera de pérdida agregada antes de habilitar código o flags.
4. Tras ejecución autorizada, inspeccionar `getOrder/getUserTrades`, TP, fills, ledger y salida; cortar nuevas entradas ante cualquier incidencia.
