# Binance Options ETH — plan de piloto supervisado

Estado: **PREPARACIÓN / NO AUTORIZADO PARA TRADING REAL**.

Este documento NO autoriza envíos ni cancelaciones de órdenes, cambios de los
dos flags de trading ni depósitos. La conexión firmada 2026-10-16 comprobó
10/12 contratos. Sin una orden histórica, getOrder y userTrades permanecen
`unverified`. No se deben inventar órdenes o fills para lograr una CI verde.

## 1. Inspección técnica solo lectura

Workflow manual: `.github/workflows/options-pilot-preflight.yml`, rama
`main`, entrada `binance_user_id` (ID interno de Hyper Coberturas).
La tarea ejecuta el script `src/scripts/options-pilot-preflight.js` en el
contenedor existente del VPS, sin reconstruir ni crear datos.

Controles en el momento de la lectura:
- Ambos flags OFF y host SSH fijado; credenciales con IP restringida,
  lectura habilitada, opciones habilitadas y retiros deshabilitados.
- Cuenta aislada sin posiciones netas ni órdenes abiertas.
- Contratos ETHUSDT activos con vencimiento posterior a 24 h, filtros de
  precio/tamaño exactos, bid/ask positivos, libro con profundidad visible.
- Endpoint de margen legible (no significa saldo suficiente).

El script **no selecciona una orden** ni demuestra que haya capital
suficiente. Los campos `chosenContract`, `effectiveFees`,
`riskBudget`, `operatorApproval` permanecen `unverified`.
`pilot_ready=no` es invariable.

No se imprimen balances, precio, lado, símbolo específico, ID, órdenes ni
datos firmados; solamente `pass/fail/unverified`. Un mercado inaccesible,
filtros inválidos, un permiso inseguro, exposición abierta o flags activos
bloquean el preflight. El monitor recurrente sigue siendo el diagnóstico
general de opciones, no este preflight manual.

## 2. Antes de autorizar cualquier operación con fondos

Debe acordarse y revisarse *por separado* el detalle de una única orden:
- Cuenta aislada, capital disponible verificado por el operador, pérdida
  máxima total en USDT y comisión máxima tolerada. No usar un presupuesto
  supuesto de 300 USDT sin confirmarlo.
- Contrato ETH exacto (tipo CALL/PUT, strike, vencimiento), lado BUY-to-open,
  cantidad, prima límite GTC, presupuesto de prima + comisiones, y fuente de
  la cotización. Evitar SELL-to-open / naked short en el primer piloto.
- minQty, maxQty, stepSize, minPrice, tickSize y **unit** (tamaño de contrato)
  tomados del exchangeInfo actual. Calcular una cotización actual y la
  exposición real sin redondear lotes de manera implícita.
- Spread, profundidad disponible al precio límite, desfase temporal, tasa
  real de maker/taker para esa cuenta y ese contrato, fee máxima prevista
  de entrada y salida. No inferir que una LIMIT es maker: puede cruzar.
- Liquidez suficiente hasta el vencimiento y contingencia ante fallos de red.
  Una compra de opciones puede perder el 100 % de la prima y comisiones;
  comisiones de ejercicio también pueden aplicar.
- Responsable humano disponible para supervisión en Binance y Telegram,
  con canal de parada de nuevas órdenes y cancelación segura de *la orden
  identificada* si no tiene fill, sin reintentar manualmente un POST ambiguo.
- Auditoría de ledger y aislamiento inmediatamente antes de operar.

**Fuente de comisiones y márgenes:** tabla oficial de comisiones de opciones
y FAQ de comisiones de Binance, además de la especificación por contrato.
La FAQ actualizada en abril de 2026 explica que la comisión de trading es
el mínimo entre la tasa por índice × unit y el 10 % de la prima, multiplicado
por la cantidad. La comisión de ejercicio es independiente. La tabla de
tarifas actual diferencia contratos y programas; no codificar una tasa
genérica como si fuese la tarifa efectiva de la cuenta.

Referencias:
https://www.binance.com/es-LA/fee/optionsTrading
https://www.binance.com/en-ZA/support/faq/detail/5326e5de61c34fed98abe28d2f175a23
https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/market-data

## 3. Ensayo de orden mínima (PENDIENTE DE AUTORIZACIÓN APARTE)

Únicamente después de que un segundo desarrollador revise los cambios y el
operador confirme los valores de la única orden y su coste máximo:

1. Aprobar temporalmente un canal de ejecución para esa orden específica y
   confirmar preflight, saldo y límites en el instante de ejecución.
2. Crear una sola orden de entrada LIMIT con `clientOrderId` duradero y
   único; no interpretar NEW/ACCEPTED como fill.
3. Si no se ejecuta completamente a los 10 minutos, cancelar **solo**
   el remanente identificado, consultar su estado final y reconciliar fills
   parciales antes de cualquier operación posterior.
4. Comparar en Binance y PostgreSQL el mismo orderId/tradeId, quantity,
   precio, fee, processedQty, y posiciones. No fabricar fills.
5. Verificar la orden TP reduceOnly, cierre parcial, reinicio y recuperación
   de timeout antes de autorizar un bot continuado. Puede requerir más de
   una prueba revisada y autorizada por separado.
6. Registrar vencimiento verdadero con exerciseRecord y bill de Binance;
   las arrays vacías no certifican liquidación. Si falta evidencia, bloquear.

Los flags de `docker-compose.prod.yml` siguen siendo `false` y solo
podrían modificarse en un cambio independiente, revisado y autorizado.
El piloto nunca activa por sí solo la estrategia automática.

## 4. Criterio de certificación

- Salud de Docker/ledger, cuentas y permisos seguros.
- getOrder y userTrades validados con orden/fill existente real.
- Conciliación completa de comisiones, cantidades y estados tras cancelación.
- Cierre/TP/stop/reseteo ante timeout y ejercicio real demostrados.
- Alertas y supervisión humana operativas.
- Revisión independiente del riesgo, capital y plan de reversión.

Mientras falte cualquiera, **no activar trading automático**.
