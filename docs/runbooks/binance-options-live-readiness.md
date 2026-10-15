# Binance Options — puesta en marcha y respuesta a incidentes

Estado: **DRAFT / trading real deshabilitado**. Alcance: PR #4 fase 2. Documentación operativa, no autorización de despliegue.

## Barreras de seguridad

- Dos variables en backend: `OPTIONS_LIVE_TRADING_ENABLED=true` **y**
  `OPTIONS_LIVE_PRODUCTION_APPROVED=true`; con cualquiera ausente el
  backend no crea nuevas órdenes reales. Nunca poner ambas en `true` en
  producción antes de cerrar la lista de validación.
- `ACCEPTED/NEW` no es ejecución: solo fills de `getUserTrades`
  transaccionales crean/cambian posiciones. Fills parciales cuentan solo
  por su cantidad realmente ejecutada.
- Cada POST tiene `clientOrderId` duradero y único, y se recupera por ese
  ID después de reiniciar. Nunca reintentar manualmente un POST ambiguo.
- La ventana de entrada LIMIT termina a los diez minutos; cancelar solo
  la orden propia identificada y confirmar su estado terminal.
- Las operaciones manuales no deben coexistir con órdenes de la app.
  Si `getOpenOrders` o exposición neta de `getPositions` no coinciden,
  bloquear entradas hasta intervención.
- No se marcan liquidados los vencimientos reales con precios spot:
  `exerciseRecord`, `bill` y ausencia de exposición deben coincidir;
  `options_live_exercises` preserva la auditoría por `recordId`.
- El flags OFF **no cierra posiciones existentes**: las posiciones abiertas
  necesitan seguimiento/gestión manual en Binance mientras se investiga.

## Comprobaciones antes de cualquier piloto real

1. PR completa revisada por al menos un segundo desarrollador; GitHub CI
   y migraciones 035, 036, 037 verdes, incluyendo pruebas de cierre parcial,
   expiración, reinicios y reconciliación.
2. Cuenta de Binance Options aislada, capital limitado, permisos mínimos,
   restricciones por IP, clave sin permisos de retiro. No probar en la
   cuenta principal. Confirmar política de comisiones y escalas por contrato.
3. Probar sin operaciones y en modo solo lectura:
   `node server/src/scripts/options-live-contract-check.js <user-id>`
   desde la raíz del repo o `node src/scripts/options-live-contract-check.js
   <user-id>` dentro de `server/`. El resultado **solo incluye estructura
   de los campos**, no saldos o credenciales. Confirmar formatos de
   `getOrder`, `getUserTrades`, `exerciseRecord`, `bill`.
4. En cuenta aislada, después de una autorización humana **separada**:
   prueba con capital mínimo permitido por exchange, revisar físicamente
   en Binance las órdenes aceptadas sin ejecución, fills parciales,
   cancelación tras 10 minutos, recuperación tras timeout y reinicio.
   Verificar idempotencia comparando la cuenta real con el ledger.
5. Esperar o reproducir **un vencimiento verdadero** en ambiente autorizado:
   corroborar sentido, cantidad, `amount`, `fee`, `EXERCISE_PNL`,
   `EXERCISE_FEE`, `quoteAsset`, eventId de ejercicio, y la fecha.
   Si el esquema de Binance difiere, abortar (fail closed) y actualizar
   pruebas documentadas; no estimar la liquidación.
6. Verificar límites API/rate 429, ventanas de historial (actualmente 3
   meses en userTrades/bill) y paginación. Medir cuánto tarda el
   conciliador con los tamaños máximos operativos.
7. Solo tras cerrar incidencias de la prueba aislada, decidir por separado
   habilitar las dos variables. El merge por sí solo nunca las activa.

## Diagnóstico sin órdenes

En backend: `node src/scripts/options-live-audit.js`. Genera JSON con
`orderStatuses`, órdenes pendientes y posiciones reales vencidas. Salida
código 2 significa alerta o necesidad de reconciliación. No toca la base.
No publicar el JSON: incluye identificadores de usuarios y símbolos.

Tablas de auditoría: `options_live_batches`, `options_live_orders`,
`options_live_fills`, `options_live_exercises`,
`options_strategy_positions`, `options_strategy_events`.
Revisar también el estado de las alertas automatizadas:
`options_auto_signals` (las señales pending no equivalen a fill).

Cada orden `attention` genera aviso a Telegram (throttle persistente:
una vez cada 15 minutos por orden) y bloquea nuevas tandas para el
usuario mientras continúe pendiente.

El monitor de cuenta consulta Binance cada cinco minutos (aunque
`OPTIONS_LIVE_TRADING_ENABLED=false`): órdenes abiertas ajenas al ledger,
exposición distinta de posiciones, credenciales caídas y cortes de red.
Los avisos se deduplican entre réplicas con
`options_live_incident_notifications` (15 minutos por incidente). Si
la cuenta no se puede verificar, no debe habilitarse el trading. El
proceso de vencimientos también alerta al operador cuando falta
evidencia; no registra PnL ni cierra la posición. Las alertas por sí
solas no solucionan el incidente.

## Respuesta a incidentes

**Orden en `attention` o venció el timeout:**
1. Deshabilitar inmediatamente **nuevas órdenes**, conservando activo el
   conciliador. No borrar ni reinsertar registros, no ejecutar el POST otra vez.
2. En Binance consultar el `clientOrderId` exacto, el `orderId`, los
   trades por `tradeId`, y las órdenes abiertas. Si queda saldo abierto,
   cancelar solo esa orden y confirmar el estado final en Binance.
3. Reconstruir la cantidad y comisión exactas, comparar
   `options_live_fills`, `options_live_orders.processed_qty` y
   `options_strategy_positions`. Si hay discrepancia, escalar y
   documentar la causa; **no fabricar fills ni corregir balances a mano**.
4. Verificar que el job vuelva a conciliar tras recuperar credenciales.
   Nunca desbloquear el sistema sin confirmar la exposición total.
5. Guardar evidencia auditada y anonimizada del incidente antes de
   reactivar el sistema.

**Vencimiento no confirmado:** consultar `exerciseRecord` y `bill`
por símbolo/fecha, comprobar que no existan posiciones ni órdenes del
contrato en Binance. Si faltan movimientos, mantener la posición marcada
como pendiente de reconciliar y no contabilizar PnL real. No usar spot.

**Credenciales, rate limit o Binance 5xx:** dejar flags OFF para nuevas
entradas; el monitoreo seguirá intentándolo. No aumentar frecuencia
de polling a ciegas ni volcar datos firmados en logs.

## Límites conocidos

- La conciliación de ejercicios funciona de manera conservadora:
  exige un único registro por símbolo/sentido, libros atribuibles por
  símbolo y matching exacto de montos. Casos de liquidaciones agregadas,
  históricos antiguos o recibos sin símbolo quedan bloqueados para
  auditoría manual.
- Los balances se validan contra la cuenta completa, pero un usuario que
  opera manualmente durante el breve intervalo entre el preflight y el POST
  puede alterar el riesgo; usar cuenta exclusiva para el bot.
- El vencimiento real requiere pruebas de contrato en el Binance del
  usuario. Pasar CI con mocks no garantiza compatibilidad de producción.

## Operación desde package.json

- `npm run audit:options-live --prefix server`: auditoría local solo
  lectura, exit code 2 cuando hay órdenes/posiciones que atender.
- `npm run check:options-binance --prefix server -- <user-id>`: prueba
  de contrato con Binance **solo lectura**; hace solicitudes firmadas,
  no POST de órdenes ni cancelaciones. No ejecutar automáticamente en
  CI con credenciales reales ni imprimir resultados privados.
