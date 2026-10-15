# Evolución del trading automatizado de opciones — decisiones de diseño (borrador)

Fecha: 2026-10-15
Estado: **planeación; no implementado**. Complementa `2026-10-15-alert-auto-trading-design.md`. No reemplaza el funcionamiento actual.

## Objetivo

Evolucionar el bot de señales hacia trading automático de **opciones compradas** (calls ante señales alcistas, puts ante señales bajistas), con posibilidad de abrir varias opciones por señal y varias señales en paralelo, manteniendo un límite de capital comprometido. El propósito inicial es didáctico, con importes pequeños.

## Decisiones acordadas hasta ahora

### Selección y ejecución
- Cada alerta tendrá un **rango mínimo y máximo de tiempo restante al vencimiento**. Solo se consideran opciones dentro de ese intervalo; no equivale a un tiempo máximo de permanencia.
- Una señal puede seleccionar **varios contratos**, con diferentes strikes y vencimientos. También pueden coexistir operaciones en distintos subyacentes.
- En la entrada se evalúan **apalancamiento efectivo**, prima comprometida, rentabilidad potencial para el objetivo de precio y liquidez. La elección final y los umbrales aún requieren especificación.
- La entrada usa órdenes **LIMIT** con una ventana máxima aproximada de **10 minutos**. Si no se ejecuta por completo, se cancela el remanente; las ejecuciones parciales se registran por la cantidad realmente llenada. La siguiente señal puede generar un nuevo intento, respetando lo ya abierto.
- Debe haber seguimiento explícito de estados de orden y reconciliación con Binance: **orden aceptada no significa orden ejecutada**.
- La gestión de salida anticipada se limita a **take profit** sobre la cantidad ejecutada. Si no se ejecuta la salida, se conserva la opción hasta su vencimiento y liquidación. No se propone stop loss ni cierre por tiempo para esta versión.

### Capital y reparto — decisión vigente
- El usuario define un **presupuesto total** para esta estrategia y un **número configurable de fracciones**: **4 fracciones al inicio**, ajustables posteriormente.
- Una señal puede comprometer como máximo **una fracción**; si compra varias opciones, todas comparten ese presupuesto.
- **En esta primera versión, el dinero asignado a la señal se divide en partes iguales entre las opciones seleccionadas.** Ejemplo: presupuesto de señal 12 USDT y 3 opciones elegibles → hasta 4 USDT por opción, incluyendo una reserva para costos estimados.
- El presupuesto es **un máximo, no una obligación de gasto**. No se fuerza una orden cuando el mínimo del contrato, el tamaño de lote, la liquidez o los costos no caben en su parte.
- Las órdenes pendientes también reservan capital. Las cantidades realmente ejecutadas permanecen comprometidas hasta el cierre o liquidación; el remanente cancelado libera reserva.
- Cambiar el número de fracciones afectará las **nuevas asignaciones**, sin modificar las posiciones existentes. Ninguna nueva asignación puede exceder el presupuesto disponible.

## Mejora futura explícitamente pospuesta

**Asignación ponderada por rendimiento y liquidez**, en lugar del reparto equitativo.

En una fase posterior se estudiará si conviene asignar mayor proporción a opciones con mejores métricas, por ejemplo:
- Rendimiento proyectado **neto** hasta el objetivo del subyacente.
- Spread bid/ask relativo y profundidad disponible.
- Probabilidad o calidad de ejecución dentro de la ventana de entrada.
- Concentración por subyacente y vencimiento, y exposición agregada de la señal.

Esta mejora queda **documentada como análisis futuro, no como comportamiento requerido ni implementado ahora**. Antes de activarla, contrastar con simulaciones y backtests, incorporando fricciones de ejecución y escenarios de pérdida total de las primas.

## Aspectos abiertos para una decisión posterior

- Cómo se elige el objetivo del precio del subyacente (por ejemplo, media móvil), y el horizonte de tiempo usado al proyectar la prima.
- Umbrales mínimos de apalancamiento y rentabilidad y filtros máximos de spread y liquidez.
- Política precisa de actualización del precio LIMIT durante los 10 minutos (fijo frente a repricing con límite).
- Redondeos, tamaños mínimos y redistribución —o no— del presupuesto no utilizado cuando algunas opciones no son ejecutables.
- Tratamiento operativo de órdenes TAKE PROFIT que no se ejecuten antes del vencimiento.

## Nota de implementación

El runner actual de opciones registra órdenes reales como posiciones demasiado pronto. Antes de activar este flujo hay que separar **solicitud de orden, confirmación de fills y registro de posiciones**, incluyendo parciales, cancelaciones, reintentos idempotentes y reinicios del proceso. Ningún cambio de trading real forma parte de esta nota.
