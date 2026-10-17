# Binance Options — puesta en marcha y respuesta a incidentes

Estado: **DRAFT / trading real deshabilitado**. Alcance: PR #4 fase 2. Documentación operativa, no autorización de despliegue.

## Iteración de endurecimiento del piloto (16 oct 2026)

**Estado: NO operar ni activar automáticamente.** La petición de habilitar
live no sustituye la aprobación del contrato exacto, lado, cantidad,
precio LIMIT y coste total en USD al momento de ejecución.

Límites declarados: máximo absoluto 100 USD de pérdida, buscando la mínima
posible. Solo una compra ETH; límite voluntario preliminar de 20 USDT
incluyendo reserva del 10% de la prima como fee de entrada, sin asumir que
USDT y USD son idénticos. Un contrato barato puede perder toda su prima.

### Barrera obligatoria para la única entrada piloto

El motor OptionsLiveExecution.submit comprueba ANTES del batch y del POST,
cuando ambos flags live están activados, todas estas variables:

- OPTIONS_LIVE_PILOT_AUTHORIZED=true, únicamente tras revisar y aprobar
  los términos de ESA operación.
- OPTIONS_LIVE_PILOT_USER_ID: ID interno del usuario autorizado.
- OPTIONS_LIVE_PILOT_STRATEGY_ID: ID exacto de la estrategia ETH.
- OPTIONS_LIVE_PILOT_SYMBOL: símbolo ETH exacto, listado y vigente.
- OPTIONS_LIVE_PILOT_QUANTITY: lote mínimo o cantidad exacta válida.
- OPTIONS_LIVE_PILOT_MAX_PRICE: límite máximo exacto de la opción en USDT.
- OPTIONS_LIVE_PILOT_EXPIRES_AT_MS: fecha Unix ms, con vencimiento de
  autorización no posterior a 15 minutos.

La política impide SELL-to-open, BTC, estrategias o símbolos distintos,
múltiples patas, otra cantidad, o precio más alto que el autorizado.
Los cierres y TP protectores NO quedan bloqueados por el vencimiento
del permiso. Bajo pg_advisory_xact_lock de PostgreSQL, beginBatch bloquea
otra apertura si ya existe cualquier entrada previa del usuario, incluso
una cancelada sin fills. No reintentar POST ambiguos.

### Qué falta para habilitar y operar, por orden

1. Diagnóstico GET en Binance para el contrato: tipo, strike, vencimiento,
   delta, IV, bid/ask, profundidad, minQty/tick. Si no hay candidato, no operar.
2. Verificar saldo libre, tarifa real en Binance, equivalencia USD/USDT,
   coste total y ausencia de exposición, órdenes o incidencias del ledger.
3. Elegir el bot exacto, plan de TP/stop y recuperación; otra revisión de
   permisos y firma, límites de pérdida y monitorización.
4. Obtener autorización transaccional explícita para símbolo, BUY, cantidad,
   precio límite, coste máximo y usuario; fijar permiso de 15 minutos.
5. PR de activación de producción revisada y controlada: por ahora
   docker-compose.prod.yml fija ambos flags a false y deploy rechaza true;
   no eludir estos bloqueos de forma silenciosa.
6. Un único POST LIMIT supervisado, reconciliación con getOrder,
   userTrades y fills; cancelar remanente por ID propio y confirmar TP,
   stop y reinicio. Cerrar permisos y flags de nuevas entradas al acabar.
7. Verificar liquidación real cuando venza con exerciseRecord y bill;
   sin orden/trade históricos NO afirmar ready=yes.

**No se ha enviado ninguna orden ni habilitado trading real.** Este cambio
cierra errores de límites y autorización de entrada, no certifica Binance.

## Vista previa exacta antes de la autorización del operador (16 oct 2026)

Existe una propuesta informativa basada en datos públicos del despliegue
#97: comprar 0.01 ETH-261023-2500-C con LIMIT máximo 23.60 USDT.
**No es una orden autorizada ni garantía de precio actual.**

Tras cada nuevo deploy, el paso GET de solo lectura
options-exact-buy-readonly-preview.js comprobará esta propuesta contra
exchangeInfo, ticker, book, marginAccount, API permissions, posiciones y
órdenes abiertas para el usuario interno que ya superó el diagnóstico
(user ID 1). Todos los campos de cuenta permanecen en el VPS; en CI solo
se publica si el campo USDT available está presente y cubre la
reserva máxima estimada de 0.26 USDT. **Equity/marginBalance no se acepta
como disponibilidad real.**

Si el campo de disponibilidad falta, el resultado es unverified; si no
hay suficiente, el contrato venció, la cotización ask supera el precio
límite o hay órdenes/posiciones previas, queda blocked. Incluso cuando
el resultado es pass, siempre se emite pilot_ready=no, pues siguen sin
confirmarse tarifas efectivas, USD/USDT, estrategia seleccionada,
autorización transaccional, rendimiento de cierre y protección real.

Las consultas automáticas posteriores a despliegue son puntuales, no
continuas. **Antes de autorizar una ejecución real se requiere una
revalidación fresca y aprobación expresa de precio, cantidad y riesgo**.
En todo caso, el trading está OFF y no se hizo ningún POST.

## Inspección de la estrategia de cierre, sin ejecutar (16 oct 2026)

La preparación de la compra propuesta **no equivale a autorización de
enviar una orden**. El paso de solo lectura de deploy
options-pilot-strategy-readiness.js comprueba si el usuario interno 1
ya tiene exactamente una estrategia ETH compatible, PAUSADA o en shadow,
y si ninguna otra está en live ni hay posiciones reales abiertas.

Para un resultado positivo se exige:
- Bot de alertas con estructura buy_with, una sola pata, cantidad 0.01,
  una posición y una entrada como máximo por día, sin reversión (close).
- TP fijo, stop máximo del 50 % de la prima y salida temporal al menos
  12 h antes de vencimiento. Un stop no garantiza la ejecución ni el
  precio de salida: la opción comprada puede perder toda su prima.
- Prima máxima <=0.26 USDT, capital 0.26 USDT y límites por estrategia
  explícitos maxOrdersPerDay <=3, maxDailyLossUsdt <=20,
  maxMarginUsdt <=20.
- Límites globales maxDailyLossUsdt <=20, maxMarginUsdt <=20,
  maxLiveStrategies = 1, notifyTelegram = true.
- Ninguna estrategia live adicional ni posiciones live existentes.

La inspección publica únicamente estados agregados y, si hay un
único candidato compatible, su ID interno para identificarlo después.
**Nunca** crea, pausa, activa o edita una estrategia. Si no existe una
configuración segura, reporta strategy_not_ready y no se opera.

Incluso con estrategia compatible, el bot por alertas elige
contratos dinámicamente y puede NO generar el símbolo confirmado
ETH-261023-2500-C. La última barrera del motor exige coincidencia
exacta y bloquea cualquier apertura diferente. La lógica de cierre y
la protección real siguen pendientes de validación con fills reales.

## Preparación autorizada del bot ETH — SIN TRADING (17 oct 2026)

El usuario autorizó **reducir los límites de riesgo y crear una estrategia
exclusiva PAUSADA**, sin enviar órdenes ni habilitar trading. La PR #16
implementa un ajuste transaccional de un solo uso, que se ejecuta durante
el despliegue SOLO si el commit desplegado tiene el asunto exacto
"Merge PR #16: prepare paused ETH pilot with 1 USDT risk limits (live OFF)".

El script no lee claves Binance ni hace solicitudes de trading. Exige
OPTIONS_LIVE_TRADING_ENABLED=false y OPTIONS_LIVE_PRODUCTION_APPROVED=false,
sin autorización live; no permite modificar si hay bots live, posiciones
reales abiertas ni historial de órdenes reales en el ledger. Actúa
exclusivamente en la cuenta interna 1 bajo advisory lock por usuario.

Límites globales objetivo:
- maxMarginUsdt = como máximo 1 USDT (jamás subir un límite menor).
- maxDailyLossUsdt = como máximo 1 USDT de pérdidas realizadas por día.
- maxLiveStrategies = 1; notifyTelegram = true.

Estrategia dedicada (no altera la estrategia anterior):
- Nombre: PILOTO ETH - compra unica - PAUSADO.
- Modo: paused, sin alertIds asociados. Plantilla alert_signal, ETH, buy_with.
- Cantidad: 0.01. contractCount = 1, maxOpenPositions=1,
  maxTradesPerDay=1, no reverse; onOpposite=close.
- capitalUsdt=0.26, maxPremiumUsdt=0.26.
- takeProfitPct=50, stopLossPct=50, exitHoursBeforeExpiry=24,
  takeProfitMode=fixed.
- Límites por bot: maxOrdersPerDay=3, maxDailyLossUsdt=1,
  maxMarginUsdt=1 USDT.

Las escrituras de settings y de creación de estrategia ocurren en
**una sola transacción PostgreSQL**. Repetir el mismo commit es seguro:
reutiliza el marcador exacto, valida los mismos parámetros y no crea
duplicados. Si cambió el bot marcador o existe exposición, falla con
rollback. No cambia otras estrategias ni activa nuevas órdenes.

No confundir pérdida diaria realizada o margen con un stop garantizado:
un BUY de opciones puede perder la totalidad de la prima y los stops
requieren liquidez. La propuesta BUY 0.01 ETH-261023-2500-C con
LIMIT máximo 23.60 USDT sigue SIN ejecutarse. Antes de operar se
requiere revalidación de precio y comisiones, autorización transaccional,
vinculación de la estrategia y revisión de las salidas protectoras.
Los flags live continúan OFF.

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

### Gate de despliegue sin trading real

El despliegue de esta fase en `docker-compose.prod.yml` **fuerza a
`false`** las dos variables `OPTIONS_LIVE_TRADING_ENABLED` y
`OPTIONS_LIVE_PRODUCTION_APPROVED` mediante `environment:`, que tiene
prioridad sobre `server/.env`. La habilitación futura requiere otro
cambio de código revisado y autorización independiente del piloto.

`deploy.yml` comprueba el contenedor actual de manera remota y **aborta
antes de `git checkout` / reconstruir** si cualquiera de los dos flags
está encendido o la comprobación no responde. Después de reconstruir,
comprueba SHA desplegado, ambos flags apagados y existencia de scripts
de diagnóstico; no prueba órdenes, cancela posiciones ni introduce
credenciales en Actions. Requiere el secreto SSH `SERVER_SSH_KNOWN_HOSTS`
verificado previamente o falla antes de tocar el VPS.

**Una CI exitosa o un deploy verde no certifican formatos firmados
de Binance.** El diagnóstico con ID interno debe ejecutarse
separadamente mediante el workflow manual `Options - diagnóstico VPS`
cuando el release esté desplegado.

## Comprobaciones antes de cualquier piloto real

1. PR completa revisada por al menos un segundo desarrollador; GitHub CI (incluyendo `test-migrations` con PostgreSQL 16)
   y migraciones 035–040 verdes, incluyendo pruebas de cierre parcial,
   expiración, reinicios y reconciliación.
2. Cuenta de Binance Options aislada, capital limitado, permisos mínimos,
   restricciones por IP, clave sin permisos de retiro. No probar en la
   cuenta principal. Confirmar política de comisiones y escalas por contrato.
   El chequeo de solo lectura consulta `GET /sapi/v1/account/apiRestrictions`
   y **debe confirmar** `ipRestrict=true`, `enableWithdrawals=false`,
   `enableReading=true` y `enableVanillaOptions=true`. Si la clave
   no permite consultar el endpoint, el piloto queda bloqueado; verificar
   permisos fuera del chat y repetir la comprobación. El reporte solo
   expone `apiPermissions: ok/failed` sin imprimir IP, key ni permisos.
3. Probar sin operaciones y en modo solo lectura:
   `node server/src/scripts/options-live-contract-check.js <user-id>`
   desde la raíz del repo o `node src/scripts/options-live-contract-check.js
   <user-id>` dentro de `server/`. El resultado **solo incluye estructura
   de los campos**, no saldos o credenciales. Confirmar formatos de
   `getOrder`, `getUserTrades`, `exerciseRecord`, `bill`.
   El chequeo incluye `isolatedAccount`: debe comprobar ausencia de
   órdenes abiertas y cantidad neta distinta de cero. Si cualquiera de
   estos datos no está disponible o la cuenta ya tiene exposición,
   el piloto se detiene sin publicar símbolos ni cantidades en CI.
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

## GitHub Actions: diagnóstico del VPS cada cinco horas

El workflow `.github/workflows/options-diagnostics.yml` es **solo lectura**.
Una vez fusionado a `main` ejecuta `cron: '17 */5 * * *'` (UTC), además de permitir
`workflow_dispatch`. GitHub puede retrasar ejecuciones programadas: no debe
considerarse un monitor en tiempo real ni un sustituto de Telegram en el VPS.

Utiliza los secretos existentes de `production` (`SERVER_HOST`,
`SERVER_USER`, `SERVER_SSH_KEY`, `DEPLOY_PATH`) y necesita el secreto
**`SERVER_SSH_KNOWN_HOSTS`**. Debe incluir la **clave pública SSH del host**
con prefijo que coincida exactamente con `SERVER_HOST`:

```text
<valor-de-SERVER_HOST> ssh-ed25519 <clave-publica-del-servidor>
```

Obtenerla desde el panel/consola confiable del VPS (por ejemplo,
`/etc/ssh/ssh_host_ed25519_key.pub`). Confirmar allí la huella con
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, **no** confiar sin
comparación en un `ssh-keyscan` ejecutado durante CI. Guardarla en
GitHub → Settings → Secrets and variables → Actions → Environment
`production` (o en secretos del repositorio si así está configurado
el deploy). No pegar ninguna clave privada ni credenciales en el chat.

La conexión utiliza StrictHostKeyChecking; si falta esa huella o cambia,
**la ejecución falla cerrada**. El job solo publica estados `healthy` y
cantidades agregadas (`options_unresolved_orders`,
`options_attention_orders`, `options_overdue_orders`,
`options_expired_positions`). Los datos completos se procesan dentro
del VPS, no se imprimen símbolos, usuarios ni balances. Un exit code 2
significa **incidente**, no fallo de CI del código.

Limitación: el workflow no puede ejecutarse mediante `workflow_dispatch`
desde la interfaz hasta que el archivo exista en la rama predeterminada.
El PR **no debe fusionarse solo para activar este diagnóstico** si aún
están pendientes las barreras de trading real. No colocar ambos flags
de trading en `true` por el simple hecho de completar el deploy.

### Ejecución manual del contrato de Binance por CI/CD

El workflow `.github/workflows/options-diagnostics.yml` acepta ahora la entrada
opcional `binance_user_id` en **Actions → Options - diagnóstico VPS →
Run workflow**, únicamente cuando el workflow ya está disponible en
`main`. Los cron jobs dejan esa entrada vacía y no consultan credenciales
de opciones adicionales. No habilita flags de trading.

Al introducir el **ID interno** del usuario, el job primero confirma
servicios Docker/ledger, después establece SSH con la huella previamente
verificada, exige que **ambos** flags reales estén apagados y comprueba que
el contenedor desplegado ya tiene el script. Ejecuta allí:

```bash
node src/scripts/options-live-contract-check.js <user-id>
```

Es equivalente a `npm run check:options-binance --prefix server -- <user-id>`
desde la raíz de la aplicación. Únicamente imprime estado
`binance_<comprobación>=pass|fail|unverified` y `binance_contract_ready=yes|no`.
Si el servidor sigue con una versión anterior, muestra
`binance_contract_check=not_deployed` y no actualiza código.
**No sube ni copia el script a producción ni revela el JSON completo.**

**No ejecutarlo automáticamente desde PR:** por seguridad, GitHub Actions
con secretos `production` solo corre en la rama aprobada; introducir
las claves SSH de producción en un job de `pull_request` permitiría que
código no revisado accediera al VPS. El workflow de deploy existente se
dispara en cada push a `main` después de CI, así que no integrar este
archivo aisladamente para provocar un disparo: el despliegue requiere
planificación y validación separadas.

El comprobador `node src/scripts/options-live-contract-check.js <user-id>`
verifica contratos firmados sin POST: si aún no existen órdenes históricas
en el ledger, `getOrder` y `userTrades` quedan explícitamente
`skipped`, nunca `ok` inventado. Incluso con arrays vacíos de ejercicio
o bills, su estructura no demuestra un ejercicio realmente conciliado:
esa evidencia debe obtenerse en la fase supervisada del piloto.

## Validación de TP residente y reversión (migraciones 039–040)

El bot ahora crea una orden LIMIT `reduceOnly` con `purpose='take_profit'`
**después** de registrar el fill real, dentro de la misma pasada del
conciliador (~60 s). Cada fill de apertura produce una posición separada y
un TP con `clientOrderId` duradero; `queued→sending` se reclama antes de
POST, nunca se reenvían acuses ambiguos. El precio de TP permanece fijo
hasta que llena o se cancela. No hay OCO nativa equivalente a Spot.

El cierre por stop, señal contraria o vencimiento se registra en
`options_live_exit_requests`; se cancela el TP específico y se verifica
su estado final y cualquier fill concurrente **antes de enviar otra
orden de cierre**. Se reconcilia también el remanente de la entrada.
Un giro `onOpposite=reverse` persiste el evento en
`options_live_reentries`; solo abre otra vez si todos los cierres se
confirman, el modo/permiso siguen activos y los límites y cotizaciones
frescos lo permiten. El giro caduca a los 30 min en vez de ejecutar
señales obsoletas.

**Pruebas mínimas en PostgreSQL real:** la CI debe mostrar `test-migrations`
verde (aplica todas las migraciones dos veces, comprueba 035–040).
Después hacer en cuenta aislada verificación de orden TP aceptada en
Binance, fill parcial, cancelación inmediata, cancelación simultánea con
fill, reinicio del VPS con estado `sending/attention`, stop y giro
pendientes y vencimiento real. Exigir concordancia exacta entre
`options_live_fills`, `options_strategy_positions` y Binance; no usar
precios teóricos como evidencia de ejecución.

Con el kill switch apagado ninguna nueva orden real se envía.
Las salidas pendientes son notificadas a Telegram como cierre manual
requerido. No confundir ocho/nueve trabajos CI exitosos con la aprobación
para activar operaciones: el contrato real con Binance sigue sin
certificarse desde este chat.
