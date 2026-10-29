# Opciones · Fase 2: medir para decidir

**Spec:** este documento hace de spec y de plan (sin spec aparte). Origen: análisis de los bots de opciones en sombra del 29 oct 2026 (nota del vault `proyectos/testbotCobertura.md`, sección «análisis de los bots en sombra y fase 1»).

**Objetivo:** que el usuario pueda decidir TP, tiempo máximo y stop con datos reales de sus operaciones, ver las estadísticas de un periodo concreto, que el límite de pérdida diaria actúe antes de perder y poder comparar el backtest sintético con la sombra.

## Global Constraints

- Worktree: `/home/luis/Documentos/CODE/testbotCobertura-phase2`, rama `feat/options-phase2`. Nunca tocar `/home/luis/Documentos/CODE/testbotCobertura` (checkout compartido con otras sesiones) ni cambiar de rama allí.
- Textos de UI en español, mismo tono que la UI existente. Números con los helpers de formato existentes (`formatNumber`, `formatUsdt`).
- Toda UI nueva funciona en móvil (390 px) sin scroll horizontal, con objetivos táctiles ≥ 44 px, además de escritorio.
- Seguir el estilo del código vecino: densidad de comentarios, nombres, módulos CSS, patrón de servicios/repositorios con dependencias inyectables para tests.
- Migraciones idempotentes (`IF NOT EXISTS`), numeradas a partir de `050_`. Se ejecutan al arrancar el servidor.
- Lección previa: `options-strategies.service.get()` arma `closedPositions` con una **lista blanca de campos**. Todo campo nuevo que deba llegar al cliente se añade ahí y se cubre con un test del servicio.
- Tests: servidor `node --test` (en `server/`), cliente `npx vitest run` (en `client/`). Cada tarea añade tests y deja ambas suites en verde. Lint con `npx eslint <archivos>`.
- Tiempos en milisegundos epoch (BIGINT), como el resto de tablas de opciones.
- Comisiones con los helpers existentes (`tradeFee`, `exerciseFee` del módulo de opciones). No inventar otra fórmula.
- Commits pequeños con mensajes convencionales (`feat(options): …`), terminando con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Sin dependencias npm nuevas.

## Task 1: Guardar el recorrido de la prima

**Archivos:** `server/src/db/migrations/050_options_premium_samples.sql` (nuevo), `server/src/services/options/options-premium-sampler.service.js`, `server/src/repositories/options-strategies.repository.js` (o un repositorio nuevo `options-premium-samples.repository.js` si encaja mejor con el patrón), tests.

1. Tabla `options_premium_samples`:
   - `position_id BIGINT NOT NULL REFERENCES options_strategy_positions(id) ON DELETE CASCADE`
   - `sampled_at BIGINT NOT NULL`
   - `bid NUMERIC(24, 8) NULL`, `ask NUMERIC(24, 8) NULL`, `spot NUMERIC(24, 8) NULL`
   - `PRIMARY KEY (position_id, sampled_at)`
2. El muestreador, en cada pasada, además de `recordPremiumSample` (rango máx./mín., sin cambios), inserta una fila por posición abierta con bid, ask y spot (índice del subyacente) del mismo ticker. Usa `ON CONFLICT DO NOTHING`. Si el ticker no trae índice, el spot sale de lo que ya ofrezca el servicio de mercado sin peticiones extra por posición (una petición por subyacente como mucho por pasada); si no hay, `NULL`. Se inserta aunque el lado ejecutable falte, siempre que haya bid o ask.
3. Lectura: `listPremiumSamples(positionIds)` → `Map<positionId, Array<{ at, bid, ask, spot }>>` ordenado por `at`.
4. Retención: purga diaria de muestras con `sampled_at` de más de **120 días**, con el mismo mecanismo de mantenimiento que ya purga otras tablas (buscar el patrón existente, p. ej. el de `options_iv_snapshots` o `protection_decision_log`).
5. Tests: inserta una muestra por posición y pasada, no duplica en la misma marca de tiempo, sin bid ni ask no inserta, lectura agrupada y ordenada, purga.

## Task 2: Simulador de salidas (servidor)

**Archivos:** `server/src/services/options/options-exit-simulator.js` (nuevo, puro), servicio y ruta del endpoint, tests.

**Endpoint:** `GET /options/auto-bots/:id/exit-simulation?mode=shadow|live&since=<ms>`. `mode` por defecto `shadow`; `since` opcional (filtra por `openedAt >= since`). Solo el dueño del bot. Responde `{ success: true, data }`.

**Entrada por posición:** solo posiciones **cerradas** y **compradas** (`side = 'BUY'`) del bot y modo. Recorrido de la prima:
- Muestras por minuto de `options_premium_samples` (Task 1), mientras estuvo abierta.
- Completado con los snapshots horarios de `options_iv_snapshots` del mismo `symbol` desde `openedAt` hasta el vencimiento (antes de la primera muestra por minuto y después del cierre real). Las muestras por minuto mandan donde existan.
- Valor al vencimiento: si la posición cerró por vencimiento, su `exitPrice`. Si no, el intrínseco con el spot del último snapshot a ≤ 1 h del vencimiento (08:00 UTC del día del símbolo). Si no hay ninguno, la posición queda `incomplete` para los escenarios que necesiten llegar al vencimiento.
- Cobertura por posición: `minute` (tiene muestras por minuto), `hourly` (solo snapshots) o `none`.

**Reglas de un escenario `{ tpPct, maxHoldHours, stopPct }`** (los `null` significan «sin»), recorriendo el camino en orden desde `openedAt`:
1. TP: primer punto con `bid >= entry × (1 + tpPct/100)` → sale a `entry × (1 + tpPct/100)` (orden límite en reposo).
2. Stop: primer punto con `bid <= entry × (1 − stopPct/100)` → sale a ese bid.
3. Tiempo máximo: primer punto con `at >= openedAt + maxHoldHours h` → sale a su bid (si no hay bid, al siguiente punto con bid).
4. Si en un mismo punto se cumplen varias, el orden es TP, stop, tiempo.
5. Si ninguna se cumple: valor al vencimiento.
6. P&L = `(exit − entry) × qty − comisión de entrada − comisión de salida` (entrada: `entryFeeUsdt` guardado o `tradeFee` si falta; salida: `tradeFee` con el spot del punto, o `exerciseFee` si vence ITM; 0 si vence sin valor).

**Rejilla:** `tpPct ∈ [20, 30, 40, 60, 80, 100, 150, 200, null]`, `maxHoldHours ∈ [1, 2, 4, 6, 8, 12, 24, null]`, `stopPct ∈ [null, 30, 50]`.

**Respuesta `data`:**
```
{
  mode, since, generatedAt,
  coverage: { positions, minute, hourly, none, incomplete },
  actual: { pnlUsdt, trades, wins },            // lo que pasó de verdad (pnlUsdt de las posiciones)
  scenarios: [ { tpPct, maxHoldHours, stopPct, pnlUsdt, trades, wins, avgHoldMinutes, incomplete } ],  // toda la rejilla
  best: [ ...los 10 escenarios con más pnlUsdt (desempate: más wins, luego menor avgHoldMinutes) ],
}
```
Posiciones `none` no entran en ningún escenario y se cuentan en `coverage.none`. Un escenario con posiciones `incomplete` las excluye y lo indica en su `incomplete`.

**Tests (puros, del módulo):** TP alcanzado sale al nivel exacto, stop sale al bid, tiempo máximo, prioridad TP > stop > tiempo en el mismo punto, vencimiento OTM a 0 sin comisión de ejercicio, vencimiento ITM con `exerciseFee`, mezcla de muestras por minuto y horarias (manda el minuto), posición `none`, `best` ordenado y de 10. Más un test del endpoint o servicio con repositorios falsos.

## Task 3: Simulador de salidas (cliente)

**Archivos:** componente nuevo en `client/src/pages/Options/auto/` (p. ej. `ExitSimulator.jsx` + `exitSimulator.js` para la lógica de presentación + CSS module), cliente API en `autoTradingApi`, integración en `BotDetail.jsx`, tests.

- Sección «Simulador de salidas» en el detalle del bot, debajo de «Operaciones cerradas». Se carga al abrirla (no en cada refresco del detalle), con su propio estado de carga y error.
- Cabecera: cobertura (`N operaciones · M con datos por minuto · K solo horarios · J sin datos`) y la línea «Real: X USDT» con el P&L real para comparar.
- Aviso fijo cuando `trades < 20`: «Muestra pequeña: úsalo para descartar ideas, no para afinar números.»
- Tabla «Mejores combinaciones» con `best`: TP, tiempo máx., stop, P&L, acierto (wins/trades), tiempo medio. En móvil, tarjetas apiladas.
- Mapa TP × tiempo máximo (filas TP, columnas tiempo) para el stop elegido con un selector «Stop: sin / 30 % / 50 %». Celdas coloreadas por P&L (verde ganancia, rojo pérdida, intensidad proporcional). En móvil la tabla puede desplazarse en horizontal **dentro de su contenedor**, sin desbordar la página. Se marca la celda más cercana a la configuración actual del bot si su TP es fijo; con banda ATR, no.
- Se respeta el `mode` del bot (sombra/real) y, si existe el filtro de periodo de la Task 4, se le pasa su `since`. Si la Task 4 aún no existe, el componente acepta una prop `since` opcional.
- Tests: formato de filas, aviso de muestra pequeña, selector de stop cambia el mapa, estados de carga y error.

## Task 4: Estadísticas por periodo

**Archivos:** `server/src/services/options/options-strategies.service.js`, `server/src/routes/options-strategies.routes.js`, cliente del detalle (`BotDetail.jsx`, `botView.js` o donde se pidan los datos), tests.

- `GET /options/strategies/:id?since=<ms>` (y lo que use el detalle del bot): con `since`, los KPIs (`kpis`), la curva (`equity`) y `closedPositions` solo cuentan posiciones con `openedAt >= since`. Las posiciones abiertas, entradas pendientes, órdenes y `usage` no se filtran. Sin `since`, todo igual que hoy. `since` inválido → 400 con mensaje en español.
- Cliente: selector «Periodo» en la cabecera de los KPIs del detalle del bot: `Todo`, `7 d`, `3 d`, `Desde…` (fecha local; se envía el inicio de ese día en ms). Se recuerda por bot en `localStorage` con try/catch (si falla, `Todo`). La etiqueta «P&L NETO 30 D» pasa a reflejar el periodo elegido (p. ej. «P&L neto · 7 d», «P&L neto · desde 25 oct»).
- El simulador de la Task 3 recibe el mismo `since`.
- Tests del servicio (filtro y 400), y del cliente (selector, persistencia, etiqueta).

## Task 5: Límite de pérdida diaria que se anticipa

**Archivos:** `server/src/services/options/options-strategy-runner.service.js` (y `options-strategies.service.js` para `usage`), cliente donde se muestra «Uso de límites», tests.

- Regla nueva, en **real y en sombra** (la sombra simula el real): antes de abrir una compra, si `pérdida realizada hoy (UTC) del bot y modo + prima de la nueva entrada (precio límite × cantidad) + su comisión estimada > maxDailyLossUsdt del bot`, la entrada se salta con motivo `daily_loss_budget` y detalle «La prima de esta entrada (X USDT) no cabe en lo que queda del límite de pérdida diaria (Y de Z USDT)». La comprobación actual (pérdida realizada ≥ límite) se mantiene.
- En sombra hoy no se aplica ningún límite de pérdida: añadir la comprobación actual **y** la nueva en el camino de sombra. Localizar dónde decide la sombra abrir y reutilizar la misma función que el real para no duplicar lógica.
- `usage` añade `atRiskUsdt`: suma de la prima pagada de las posiciones compradas abiertas del modo. La UI de «Uso de límites» muestra «Pérdida del día» como hoy y debajo «En riesgo abierto: X USDT».
- La prima de una entrada se calcula igual que la prima máxima por operación (`price × quantity`).
- Tests: entrada bloqueada por presupuesto, entrada que cabe justo, comportamiento sin límite configurado, sombra aplica ambas reglas, `atRiskUsdt`.

## Task 6: Calibración del backtest sintético

**Archivos:** `server/src/scripts/options-backtest-calibration.js` (nuevo), módulo puro de comparación con tests, documentación breve en el propio script (cabecera).

- Uso: `node src/scripts/options-backtest-calibration.js --strategy <id> [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>] [--json]` dentro del contenedor (`docker exec testbot-server node src/scripts/…`). Solo lectura: nunca escribe en la base ni envía órdenes.
- Ejecuta el backtest existente (`options-backtest.service`) con los parámetros del bot y su mismo periodo de sombra (desde la primera posición de sombra o `--since`). Reutiliza las funciones del servicio; si alguna no está exportada, exportarla sin cambiar su comportamiento.
- Empareja las operaciones del backtest con las posiciones de sombra por subyacente y entrada a ±30 min. Informa por par: símbolo, entrada sintética vs real (%), salida y P&L de cada uno, motivo de cierre. Resumen: pares, solo-backtest, solo-sombra, P&L total de cada lado, error medio de la prima de entrada (%), comisión total de cada lado.
- Salida legible en texto por defecto; `--json` para máquina.
- Tests del módulo de emparejamiento y resumen (puros).
