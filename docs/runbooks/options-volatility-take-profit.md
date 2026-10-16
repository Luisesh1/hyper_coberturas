# Take Profit ATR + IV — bots de alertas Binance Options

## Configuración y compatibilidad

En el editor del bot de alertas, **Tipo de Take Profit** permite elegir:
- `fixed` (predeterminado, compatible con bots existentes): toma de ganancia como porcentaje de la prima de entrada.
- `volatility` (opt-in): objetivo proyectado a partir de ATR(14) de velas spot de 1 hora, volatilidad implícita `markIV` de la opción y Black–Scholes. `tpAtrMultiplier` (0.25–4, predeterminado 1) y `tpHorizonHours` (1–24, predeterminado 4) controlan la proyección.

Ninguna de las dos opciones modifica el hecho de que las nuevas operaciones reales requieren los dos flags de aprobación; nunca habilitar por defecto. Las operaciones de sombra siguen disponibles.

## Condiciones para cerrar

1. La **prima de entrada** es la del fill realmente confirmado en el ledger de Binance, no el acuse de la orden ni el precio mark.
2. Para una posición **comprada**, el TP se activa cuando el **bid** de mercado es mayor o igual al precio objetivo; se emite una orden `SELL LIMIT`. Para una posición **vendida**, requiere **ask** menor o igual al objetivo; se emite `BUY LIMIT` con `reduceOnly`.
3. Antes del POST de la orden de salida, el ejecutor consulta un libro **fresco** y vuelve a verificar el objetivo. Si el precio cambió en contra, **no envía**.
4. Una orden LIMIT enviada no equivale a un cierre: la posición y el P&L reales sólo cambian con `getUserTrades`, incluidas ejecuciones parciales. El remanente se cancela tras diez minutos; estados ambiguos requieren conciliación.
5. Cuando faltan ATR (al menos 15 velas cerradas), IV, precio spot, vencimiento suficiente o el `tickSize` oficial de `PRICE_FILTER`, **no se inventa un TP**. El stop y la salida por tiempo continúan evaluándose.

## Alcances y límites del MVP

- El cálculo del objetivo se **actualiza en cada evaluación** con IV/spot/ATR nuevos y se ancla a la prima confirmada; no es un objetivo fijo persistente ni una orden take-profit estacionada en el exchange.
- El runner normal evalúa estrategias cada **5 minutos**. Puede perder movimientos transitorios entre ticks; la salida se hace mediante LIMIT GTC con conciliación, nunca con MARKET.
- La proyección Black–Scholes y el movimiento implícito **no garantizan rentabilidad, liquidez ni ejecución**. No descuenta comisiones del umbral teórico (el P&L se registra con fees reales).
- No habilitar envíos reales sin pruebas con cuenta Binance Options controlada, verificación de filtros reales, forma de respuesta de `klines` y `exchangeInfo`, cancelaciones, ejercicio/vencimiento, alerta operativa y parada de emergencia. Consultar `docs/runbooks/binance-options-live-readiness.md`.

## Pruebas

`node --test server/test/options-take-profit.test.js server/test/options-alert-volatility-tp.test.js`

Verificar adicionalmente en CI `test-server`, `test-client`, `lint`, `lint-client`, `build-client` y revisiones de contratos del proveedor. Un resultado verde con mocks **no sustituye** el piloto manual con Binance.
