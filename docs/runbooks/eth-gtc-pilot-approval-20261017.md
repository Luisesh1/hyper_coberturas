# Propuesta de primera operación piloto ETH Options — pendiente de aprobación

**Fecha de preparación:** 17 de octubre de 2026.  
**Estado:** BORRADOR / NO-GO / SOLO LECTURA. **No es autorización de compra ni instrucción de activar trading.**

Este documento reúne los parámetros del piloto GTC existente para revisión del operador. La referencia histórica de precio del 17 de octubre **no debe reutilizarse como cotización actual**: todas las cifras que dependen del mercado deben rehacerse inmediatamente antes de aprobar la operación.

## 1. Términos de referencia (no aprobados)

| Campo | Propuesta de referencia |
|---|---|
| Exchange | Binance Options, cuenta aislada del piloto |
| Operación | **BUY-to-open**, una call ETH |
| Contrato de referencia | `ETH-261023-2500-C` (**revalidar listado y filtros**) |
| Vencimiento codificado en el símbolo | 23 de octubre de 2026; verificar **hora exacta** en Binance |
| Cantidad | **0.01** (revalidar `minQty`/`stepSize`) |
| Entrada | `LIMIT FOK`; un llenado anómalo parcial se trata como incidente |
| Límite de entrada histórico **solo para ilustración** | 23.60 USDT por unidad de opción |
| Prima al límite histórico | 0.01 × 23.60 = **0.2360 USDT** |
| Reserva de verificación, no comisión real | 10% de la prima = **0.0236 USDT** |
| Tope conjunto de referencia | **0.2596 USDT**, dentro del presupuesto de estrategia de 0.26 USDT |
| Take Profit | **SELL LIMIT GTC reduceOnly**, registrado **después** del fill confirmado, objetivo fijo **+50% sobre precio medio real**, redondeado al tick aplicable |
| TP teórico si el fill fuese 23.60 | **35.40 USDT por unidad**; ingreso bruto 0.354 USDT por 0.01, antes de fees |
| Stop | Señal del bot de **−50% de prima** sobre precio de ejecución; cancelar y conciliar el GTC antes de intentar salida `LIMIT FOK reduceOnly`; no garantiza ejecución |
| Umbral teórico de stop si el fill fuese 23.60 | **11.80 USDT por unidad**; resultado real sujeto a spread, liquidez y fallos |
| Salida temporal | Al menos **24 horas antes** del vencimiento; revalidar horario del contrato |
| Máximo | Una entrada, una posición, sin reentrada; ninguna otra posición u orden abierta |

**Precisiones de riesgo:** el presupuesto preparado para esta estrategia es 0.26 USDT y los límites globales reducidos de la cuenta piloto son más estrictos que el techo general de 100 USD acordado. Esto NO garantiza pérdidas máximas; la prima de una opción comprada puede perderse por completo y las comisiones efectivas deben calcularse con los datos de Binance. El 10% es una **reserva provisional**, no una tarifa verificada.

## 2. Comprobaciones que deben pasar antes de pedir aprobación vinculante

- [ ] Obtener **nuevo** símbolo, vencimiento/hora, strike, bid, ask, profundidad, timestamp, filtros y tickSize desde Binance. Rechazar cotización ausente, vencida o ask superior a un máximo aprobado nuevo.
- [ ] Verificar comisiones reales, USDT disponible, equivalencia USD/USDT, ausencia de órdenes/posiciones ajenas, permisos API e IP; sin retiros.
- [ ] Vincular y validar una **señal de entrada real** a la estrategia; actualmente su `alertIds=[]` deja el bot **pausado, sin señal**.
- [ ] Evidenciar que las alertas Telegram y la vigilancia independiente funcionan; definir respuesta dentro de la ventana sin TP posterior al fill.
- [ ] **Resolver o demostrar de forma verificable** el tratamiento de fills parciales del TP GTC (p. ej., 0.005 de 0.01), que pueden dejar residuo inferior a `minQty=0.01`. Sin vía operativa probada para ese residuo **NO-GO**.
- [ ] Validar recuperación y conciliación con Binance de orden ambiguamente enviada, `PARTIALLY_FILLED`, cancelación con fill simultáneo, reinicio, órdenes expiradas y cierre.
- [ ] Revisar independientemente cualquier PR que habilite ejecución y verificar que la apertura quede limitada a **una única operación supervisada**.

## 3. Orden y autorización que debe aprobar expresamente el operador

Preparar un resumen fresco, con fecha y hora, antes de solicitar un «sí»:

```text
Binance Options / piloto real supervisado
Símbolo exacto: [PENDIENTE DE VERIFICAR EN BINANCE]
Lado: BUY-to-open
Cantidad: 0.01
Tipo: LIMIT FOK
Precio máximo USDT por unidad: [NUEVO LÍMITE]
Prima máxima USDT: [CANTIDAD x NUEVO LÍMITE]
Comisión estimada USDT: [TARIFA REAL]
Costo máximo total USDT: [COSTO + FEES], debe respetar 0.26 USDT
TP: SELL LIMIT GTC reduceOnly a +50% del precio de fill, ajustado a tick
Stop: señal del bot a -50% de prima, no garantizada, cierre FOK supervisado
Expiración del contrato UTC: [HORA VERIFICADA]
Salida anticipada: 24 horas antes
Vigencia de la autorización: <=15 min
Riesgo GTC parcial: [RESUELTO CON EVIDENCIA / NO-GO]
Riesgo de ventana sin protección: [MITIGACIÓN VALIDADA / NO-GO]
Autorización del operador: [PENDIENTE]
```

La petición genérica de «avanzar» o «ver la operación para aprobarla» **no sustituye** esta autorización transaccional ni implica aceptación del riesgo residual. Si cambia el ask, el strike, el vencimiento, el costo, el tamaño o el riesgo, volver a solicitar aprobación específica.

## 4. Criterios de cierre del piloto real

- Una sola apertura con `getOrder` y `getUserTrades` conciliados con la base de datos.
- Comprobación de TP GTC aceptado y visible en Binance; ausencia de exposición sin protección no reconocida.
- Salida completa o resolución probada, explícitamente supervisada, de cualquier residuo.
- Ledger, Binance, comisiones, balances, P&L y eventuales registros de liquidación conciliados sin incidentes críticos.
- Nuevas entradas bloqueadas tras la prueba y documentación final del resultado.

**Operación real ejecutada: NO. Controles live activados: NO. Aprobación solicitada: NO.**  
Referencia de flujo: [runbook GTC](./eth-gtc-supervised-pilot.md).
