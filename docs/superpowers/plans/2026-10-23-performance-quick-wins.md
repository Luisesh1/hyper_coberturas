# Mejoras de performance de mayor valor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cuatro mejoras independientes de alto valor y bajo riesgo:
1. Sacar el paquete de la wallet de la carga inicial del cliente.
2. Hacer que una protección delta-neutral lenta no retrase a las demás.
3. Podar automáticamente `protection_decision_log`.
4. Pausar los sondeos del cliente mientras la pestaña está oculta.

**Architecture:** cada mejora es un cambio acotado que se puede desplegar por separado.
- **Cliente:** `WalletProvider` pasa de `main.jsx` a una ruta-layout perezosa que envuelve solo las páginas que firman transacciones. Los sondeos usan un hook compartido que respeta `document.visibilityState`.
- **Servidor:** el bucle delta-neutral mantiene la comprobación ligera en serie y lanza las evaluaciones completas a través de un limitador con tope global, en serie por `cuenta:activo`. Un servicio nuevo ejecuta a diario la poda que hoy solo existe como script manual.

**Tech Stack:** React 18 + Vite 7 + React Router 7, Vitest + Testing Library, Node 22 (`node:test`), PostgreSQL 16, Playwright contra Docker (localhost:5174).

**Spec:** no hay documento aparte. Este plan implementa el análisis de performance y arquitectura del 2026-10-23 (conversación con el usuario). Los datos que lo justifican están en «Contexto».

## Contexto (hallazgos medidos)

- **Wallet en la carga inicial.** `npm run build` genera `vendor-wallet-*.js` con 1,7 MB (486 KB gzip), y `dist/index.html` lo precarga en todas las rutas, incluido el login. La causa es que `client/src/main.jsx` envuelve la app con `WalletProvider`. Solo lo consumen `/uniswap-pools`, `/lp-orchestrator`, `/contratos` y `/hidenActions`.
- **Bucle delta-neutral.** `ProtectedPoolDeltaNeutralService.evaluateAll()` (`server/src/services/protected-pool-delta-neutral.service.js:1099`) corre cada 2 s y espera a cada `_tickProtection`. Cuando a una protección le toca evaluación completa (RPC + Hyperliquid), las demás no se comprueban hasta que termine.
  - Cada evaluación retiene una conexión del pool (`max: 10`, `server/src/db/index.js`) para el advisory lock mientras dura.
  - Dos protecciones con la misma cuenta y el mismo activo comparten la posición en Hyperliquid.
- **Log de decisiones.** `protection_decision_log` llegó a 6,49 M de filas / 1,79 GB (comentario en `protected-pool-delta-neutral.service.js:1276`). `pruneDecisionLog` existe (`protected-pool-maintenance.service.js:99`), pero solo lo llama `server/src/scripts/prune-decision-log.js`, a mano.
- **Sondeos del cliente.** Opciones y TradingView se pausan con la pestaña oculta; el resto no. Hay dos hooks que se solapan (`pages/Options/strategies/common/useVisibleInterval.js` y `pages/Options/manual/hooks/usePolling.js`).

## Global Constraints

- **Retención:** solo `protection_decision_log`, 30 días (`DEFAULT_DECISION_LOG_RETENTION_DAYS`). Decisión del usuario del 2026-10-23: **no** podar `lp_orchestrator_action_log`, `alert_events` ni ninguna otra tabla.
- **Concurrencia del bucle delta-neutral:** 3 evaluaciones completas simultáneas por defecto (`DELTA_NEUTRAL_MAX_CONCURRENT_EVALS`), nunca más de una a la vez por clave `cuenta:activo`.
- **Comportamiento intacto:** no cambian la lógica de decisión de `_tickProtection` (umbrales, `fullEvalMs`, `NEAR_BOUNDARY_URGENCY_MS`) ni `evaluateProtection`. La lista de protecciones se sigue leyendo en cada vuelta, sin caché: la comprobación lee `strategyState`, que las evaluaciones actualizan.
- **Sin dependencias nuevas.**
- **Formato:** textos de UI y logs en español, como el resto del repo. Eventos de log en `snake_case`.
- **Pruebas:** Playwright siempre contra Docker en `http://localhost:5174` (`e2e/playwright-docker.config.js`).
- **Trabajo aislado:** en un git worktree (`../testbotCobertura-perf`, rama `perf/quick-wins`), porque hay otras sesiones en el checkout principal. Nunca cambiar de rama allí.
- **Interfaz responsive:** cualquier cambio visible debe verse bien a 390 px.

## Review Focus

1. **Protección en el borde con evaluación de más de 2 s:** la comprobación la marca en cada vuelta. No debe encolar evaluaciones duplicadas: como mucho una en cola o en curso por protección (test en Task 3).
2. **Una evaluación lanzada que falla:** se registra con `protected_pool_delta_neutral_tick_failed`, no produce un rechazo sin manejar y se vuelve a lanzar en una vuelta posterior (test en Task 3).
3. **Navegar entre `/uniswap-pools` y `/lp-orchestrator`:** la wallet sigue conectada y el provider no se vuelve a montar. Entrar por enlace directo a una página de wallet funciona (e2e en Task 1).
4. **Primera poda en producción con millones de filas:** cada ejecución tiene un tope de filas y pausa entre lotes. La primera pasada se reparte en varios días y no bloquea la base (test en Task 4).
5. **Volver a la pestaña tras un rato oculta:** se refresca al momento, sin esperar al siguiente intervalo (test en Task 5).

---

### Task 1: Wallet fuera de la carga inicial

**Files:**
- Create: `client/src/wallet/WalletLayout.jsx`
- Create: `client/scripts/check-initial-bundle.mjs`
- Modify: `client/src/main.jsx` (quitar `WalletProvider`)
- Modify: `client/src/App.jsx:186-199` (rutas)
- Modify: `client/package.json` (script `check:bundle`)
- Modify: `.github/workflows/ci.yml:146` (ejecutar el check después del build)
- Test: `client/src/wallet/WalletLayout.test.jsx`, `e2e/wallet-lazy-routes.spec.js`

**Interfaces:**
- Produces: `export default function WalletLayout()`, que renderiza `<WalletProvider><Outlet /></WalletProvider>`.

- [ ] **Step 1: Write the failing test** en `client/src/wallet/WalletLayout.test.jsx`.

```jsx
// Mockea ../hooks/useWalletConnection: WalletProvider renderiza
// <div data-testid="wallet-provider">{children}</div>.
it('envuelve la ruta hija con WalletProvider', () => {
  render(
    <MemoryRouter initialEntries={['/x']}>
      <Routes><Route element={<WalletLayout />}><Route path="/x" element={<p>hija</p>} /></Route></Routes>
    </MemoryRouter>
  );
  expect(within(screen.getByTestId('wallet-provider')).getByText('hija')).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client run test -- src/wallet/WalletLayout.test.jsx`
Expected: FAIL (no se puede resolver `./WalletLayout`).

- [ ] **Step 3: Implement**
  - Crear `WalletLayout.jsx`.
  - En `App.jsx`, declarar `const WalletLayout = lazy(() => import('./wallet/WalletLayout'));` y agrupar `/uniswap-pools`, `/lp-orchestrator`, `/contratos` y `/hidenActions` bajo `<Route element={<WalletLayout />}>…</Route>`. Las demás rutas no cambian.
  - Quitar `WalletProvider` y su import de `main.jsx`.

- [ ] **Step 4: Run tests**

Run: `npm --prefix client run test && npm --prefix client run lint`
Expected: PASS. Los tests que ya usan `useWalletConnection` montan su propio provider o mock, así que no deberían romperse.

- [ ] **Step 5: Bundle check**
  - Escribir `client/scripts/check-initial-bundle.mjs`: lee `dist/index.html` y termina con código 1 y el mensaje `vendor-wallet en la carga inicial` si contiene `vendor-wallet`.
  - Añadir `"check:bundle": "node scripts/check-initial-bundle.mjs"` a `package.json`.
  - En el job de build de `ci.yml`, añadir `- run: npm run check:bundle --prefix client` justo después de `npm run build --prefix client`.

Run: `npm --prefix client run build && npm --prefix client run check:bundle`
Expected: termina con código 0, y `grep -c vendor-wallet client/dist/index.html` imprime `0`.
Si falla, rastrear qué módulo del arranque importa `viem`, `wagmi` o `@walletconnect` (por ejemplo `features/cross-chain-funding/format.js`) y cambiar ese import por uno perezoso.

- [ ] **Step 6: e2e contra Docker** en `e2e/wallet-lazy-routes.spec.js`. Mockear la API como en `e2e/metrics-wallet-orchestrators.spec.js`.
  - Test `'/trade renderiza sin WalletProvider'`: cargar `/trade` y comprobar que el panel renderiza sin errores en consola. Que no se descargue `vendor-wallet` lo cubre el Step 5, porque en dev Vite no genera chunks.
  - Test `'navegar entre páginas de wallet no vuelve a montar el provider'`: ir a `/lp-orchestrator`, guardar en `window.__mark = 1`, navegar con la UI a `/uniswap-pools` y comprobar que `window.__mark === 1` (sin recarga completa) y que la página renderiza.
  - Test `'entrar por enlace directo a /contratos funciona'`.
  - Ejecutar a 1400 px y a 390 px.

Run: `npx playwright test -c e2e/playwright-docker.config.js e2e/wallet-lazy-routes.spec.js`. Requiere que el worktree esté integrado en el checkout que sirve Docker, o levantar Vite del worktree en otro puerto apuntando a la API de Docker.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/wallet client/src/main.jsx client/src/App.jsx client/scripts client/package.json .github/workflows/ci.yml e2e/wallet-lazy-routes.spec.js
git commit -m "perf(client): load the wallet stack only on routes that sign transactions"
```

---

### Task 2: Limitador por clave

**Files:**
- Create: `server/src/utils/keyed-limiter.js`
- Test: `server/test/keyed-limiter.test.js`

**Interfaces:**
- Produces: `class KeyedLimiter` (`module.exports = KeyedLimiter`, mismo estilo que `utils/keyed-mutex.js`).
  - `constructor({ maxConcurrent: number })`
  - `run(key: string, fn: () => Promise<T>): Promise<T>`: resuelve o rechaza con el resultado de `fn`.
  - `get size(): number`: tareas en cola más en curso.
  - `idle(): Promise<void>`: se resuelve cuando `size === 0`.
  - Semántica: como mucho `maxConcurrent` tareas en curso en total, como mucho una por clave, y orden FIFO. Una tarea que espera por su clave no ocupa un hueco global.

- [ ] **Step 1: Write the failing tests** con `node:test`, usando promesas diferidas (`deferred()` con `resolve` y `reject` expuestos).
  - `'respeta maxConcurrent'`: `maxConcurrent: 2`, tres claves distintas. Tras lanzarlas, solo 2 `fn` han empezado. Al resolver una, empieza la tercera.
  - `'serializa la misma clave'`: dos `run('a', …)`. La segunda empieza solo cuando la primera termina, aunque haya huecos libres.
  - `'una clave ocupada no bloquea a otras'`: `maxConcurrent: 2`, `run('a')`, `run('a')` y `run('b')`. `b` empieza enseguida.
  - `'propaga el rechazo y libera el hueco'`: `fn` rechaza, `run` rechaza con ese error, y la siguiente tarea en cola empieza.
  - `'idle espera a que se vacíe'`: `idle()` no se resuelve hasta que terminan todas, y con el limitador vacío se resuelve enseguida. `size` vale 0 al final.

- [ ] **Step 2: Run to verify fail**

Run: `npm --prefix server test -- test/keyed-limiter.test.js`
Expected: FAIL (`Cannot find module '../src/utils/keyed-limiter'`).

- [ ] **Step 3: Implement `KeyedLimiter`** con una cola FIFO de `{ key, fn, resolve, reject }`, un `Set` de claves en curso y un contador. En cada paso, `_pump()` arranca la primera tarea de la cola cuya clave esté libre mientras haya hueco.

- [ ] **Step 4: Run to verify pass**

Run: `npm --prefix server test -- test/keyed-limiter.test.js && npm --prefix server run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/utils/keyed-limiter.js server/test/keyed-limiter.test.js
git commit -m "feat(server): KeyedLimiter, global concurrency cap with per-key serialization"
```

---

### Task 3: El bucle delta-neutral deja de esperar a cada evaluación

**Files:**
- Modify: `server/src/services/protected-pool-delta-neutral.service.js`: constructor (~líneas 84-128), `evaluateAll` (1099), `_tickProtection` (1256-1299) y exports (1620+).
- Modify: `server/src/config/index.js:164` (bloque `deltaNeutral`)
- Modify: `server/src/bootstrap/infra.js:103` (shutdown)
- Test: `server/test/delta-neutral-eval-dispatch.test.js`

**Interfaces:**
- Consumes: `KeyedLimiter` (Task 2).
- Produces:
  - `config.deltaNeutral.maxConcurrentEvals`: `parseInt(process.env.DELTA_NEUTRAL_MAX_CONCURRENT_EVALS, 10) || 3`.
  - `deltaNeutralEvalKey(protection) -> string`: devuelve `` `${protection.accountId}:${String(protection.inferredAsset || 'unknown').toUpperCase()}` ``. Se exporta.
  - `_tickProtection(protection) -> Promise<null | { marketContext, forceReason }>`: misma lógica que hoy, pero **devuelve** la decisión en lugar de llamar a `evaluateProtection`. Sigue fijando `lastEvalAt` y `_recordHybridStat('marketTicks')` cuando decide evaluar.
  - `_dispatchEvaluation(protection, decision) -> boolean`: devuelve `false` si esa protección ya está en `this.queuedEvals`. Si no, la añade y llama a `this.evalLimiter.run(deltaNeutralEvalKey(protection), () => this.evaluateProtection(protection, decision))`. Captura el error con `logger.warn('protected_pool_delta_neutral_tick_failed', { protectionId, userId, error })`, la quita del `Set` en `finally` y devuelve `true`.
  - `drain(timeoutMs = 30_000) -> Promise<void>`: `Promise.race` entre `evalLimiter.idle()` y un temporizador con `unref`.
  - Constructor: `this.maxConcurrentEvals = deps.maxConcurrentEvals || config.deltaNeutral.maxConcurrentEvals || 3`, `this.evalLimiter = new KeyedLimiter({ maxConcurrent: this.maxConcurrentEvals })` y `this.queuedEvals = new Set()`.

- [ ] **Step 1: Write the failing tests.** Montar `new ProtectedPoolDeltaNeutralService({ protectedPoolRepository: { listActiveDeltaNeutral: async () => list }, logger: stubLogger, maxConcurrentEvals: 2 })` y sobrescribir en la instancia `_tickProtection` (devuelve `{ marketContext: null, forceReason: null }`) y `evaluateProtection` (devuelve un diferido por llamada y registra `protection.id`).
  - `'evaluateAll vuelve sin esperar a las evaluaciones'`: con 3 protecciones de claves distintas, `await service.evaluateAll()` se resuelve con todos los diferidos aún pendientes. `evaluateProtection` se llamó 2 veces (el tope).
  - `'misma cuenta y activo se evalúan en serie'`: protecciones `{id:1, accountId:7, inferredAsset:'ETH'}` y `{id:2, accountId:7, inferredAsset:'eth'}`. Solo empieza la 1, y la 2 empieza al resolver la 1.
  - `'no encola duplicados mientras una evaluación sigue en curso'`: tres `evaluateAll()` seguidos con la misma protección y el diferido pendiente. `evaluateProtection` se llamó 1 vez.
  - `'un fallo se registra y la siguiente vuelta reintenta'`: el diferido rechaza. Tras `await service.drain()`, `stubLogger.warn` recibió `'protected_pool_delta_neutral_tick_failed'` con `protectionId`. No hay `unhandledRejection` (registrar un listener que haga fallar el test). Otro `evaluateAll()` vuelve a llamar a `evaluateProtection`.
  - `'deltaNeutralEvalKey normaliza el activo'`: `deltaNeutralEvalKey({accountId:7, inferredAsset:'eth'}) === '7:ETH'` y `deltaNeutralEvalKey({accountId:7}) === '7:UNKNOWN'`.

- [ ] **Step 2: Run to verify fail**

Run: `npm --prefix server test -- test/delta-neutral-eval-dispatch.test.js`
Expected: FAIL (`deltaNeutralEvalKey` no existe y `evaluateAll` espera a las evaluaciones).

- [ ] **Step 3: Implement**
  - Añadir la config, los campos del constructor, `deltaNeutralEvalKey`, `_dispatchEvaluation` y `drain`.
  - Cambiar `_tickProtection` para que devuelva la decisión.
  - `evaluateAll` mantiene el guard `running` y el bucle en serie, pero por cada protección hace `const decision = await this._tickProtection(p)` (con su `catch` actual) y, si no es `null`, `this._dispatchEvaluation(p, decision)` sin `await`.
  - En `infra.js` (shutdown), justo después de `protectedPoolDeltaNeutralService.stop()`, añadir `await protectedPoolDeltaNeutralService.drain().catch(() => {})`.

- [ ] **Step 4: Run the whole server suite**

Run: `npm --prefix server test && npm --prefix server run lint`
Expected: PASS, incluidos los `delta-neutral-*.test.js` existentes sin cambios.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/protected-pool-delta-neutral.service.js server/src/config/index.js server/src/bootstrap/infra.js server/test/delta-neutral-eval-dispatch.test.js
git commit -m "perf(delta-neutral): dispatch full evaluations so one slow protection no longer stalls the loop"
```

---

### Task 4: Poda diaria automática del log de decisiones

**Files:**
- Modify: `server/src/services/protected-pool-maintenance.service.js:99-130` (`pruneDecisionLog` acepta `maxBatches` y `pauseMs`)
- Create: `server/src/services/decision-log-retention.service.js`
- Modify: `server/src/config/index.js` (bloque nuevo `decisionLogRetention`)
- Modify: `server/src/bootstrap/infra.js` (start y stop)
- Test: `server/test/decision-log-retention.test.js` (y ampliar `server/test/delta-neutral-boundary-throttle.test.js` si ya prueba `pruneDecisionLog`)

**Interfaces:**
- Produces:
  - `pruneDecisionLog({ retentionDays, batchSize, dryRun, maxBatches = Infinity, pauseMs = 0 }, executor)`. Mismo resultado que hoy más `capped: boolean` (`true` si paró por `maxBatches` con filas pendientes). El script manual no cambia de comportamiento.
  - `config.decisionLogRetention`: `{ enabled: process.env.DECISION_LOG_RETENTION_ENABLED !== 'false', retentionDays: parseInt(process.env.DECISION_LOG_RETENTION_DAYS, 10) || 30, intervalMs: 24 * 3_600_000, initialDelayMs: 10 * 60_000, batchSize: 5_000, maxBatches: 200, pauseMs: 200 }`.
  - `createDecisionLogRetentionService({ prune = pruneDecisionLog, config, logger, setTimer = setTimeout, clearTimer = clearTimeout })` devuelve `{ start(), stop(), runOnce(): Promise<summary|null> }`. `module.exports` exporta la instancia por defecto y la fábrica.
  - `runOnce`: no hace nada si ya hay una ejecución en curso. Llama a `prune({ dryRun: false, retentionDays, batchSize, maxBatches, pauseMs })` y registra `decision_log_pruned` con `{ deleted, candidates, capped }`. Si falla, registra `decision_log_prune_failed` sin lanzar.
  - `start()`: si `enabled`, programa `runOnce` tras `initialDelayMs` y luego cada `intervalMs`, con temporizadores `unref`.

- [ ] **Step 1: Write the failing tests**
  - `'pruneDecisionLog se detiene en maxBatches y marca capped'`: con un executor falso cuyo `DELETE` devuelve siempre `rowCount === batchSize` y `maxBatches: 3`, se ejecutan exactamente 3 `DELETE`, `deleted === 3 * batchSize` y `capped === true`.
  - `'sin tope vacía hasta el último lote'`: con `rowCount` igual a `[5, 5, 2]` y `batchSize: 5`, hay 3 `DELETE` y `capped === false`.
  - `'runOnce poda con la configuración y registra el resumen'`: `prune` falso que devuelve `{ deleted: 10, candidates: 10, capped: false }`. Se llamó con `dryRun: false, retentionDays: 30, maxBatches: 200` y `logger.info` recibió `'decision_log_pruned'`.
  - `'runOnce no solapa ejecuciones'`: dos `runOnce()` con `prune` pendiente provocan una sola llamada.
  - `'un fallo se registra y no lanza'`: `prune` rechaza, `runOnce()` se resuelve en `null` y `logger.warn` recibió `'decision_log_prune_failed'`.
  - `'deshabilitado no programa nada'`: con `enabled: false`, `start()` no llama a `setTimer`.

- [ ] **Step 2: Run to verify fail**

Run: `npm --prefix server test -- test/decision-log-retention.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement.** En `pruneDecisionLog`, contar los lotes, cortar al llegar a `maxBatches` y esperar `pauseMs` entre lotes. Crear el servicio y engancharlo en `infra.js`: `start()` junto a los demás y `stop()` en el shutdown.

- [ ] **Step 4: Run**

Run: `npm --prefix server test && npm --prefix server run lint`
Expected: PASS.

- [ ] **Step 5: Comprobación en local (solo lectura)**

Run: `docker exec testbot-postgres sh -c 'psql -U ${POSTGRES_USER:-postgres} -d ${POSTGRES_DB:-postgres} -c "SELECT count(*) FILTER (WHERE created_at < (extract(epoch from now())*1000 - 30*86400000)) AS podables, count(*) FROM protection_decision_log"'`
Expected: muestra cuántas filas se podarían. **No ejecutar `runOnce` contra la base local sin confirmación del usuario** (regla del proyecto: nada destructivo sin backup ni confirmación).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/protected-pool-maintenance.service.js server/src/services/decision-log-retention.service.js server/src/config/index.js server/src/bootstrap/infra.js server/test/decision-log-retention.test.js
git commit -m "feat(maintenance): prune protection_decision_log daily (30 days, capped batches)"
```

---

### Task 5: Sondeos pausados con la pestaña oculta

**Files:**
- Move: `client/src/pages/Options/strategies/common/useVisibleInterval.js` → `client/src/hooks/useVisibleInterval.js`, actualizando sus imports en `pages/Options/strategies/StrategiesTab.jsx`, `pages/Options/OptionsPage.jsx`, `pages/Options/auto/AutoTradingTab.jsx` y `pages/Options/manual/ExpiryPills.jsx` (comprobar la lista con `grep -rln useVisibleInterval client/src`).
- Modify:
  - `client/src/pages/LpOrchestrator/LpOrchestratorPage.jsx:96-99`
  - `client/src/pages/Metricas/MetricasPage.jsx:40-45`
  - `client/src/pages/Metricas/hooks/useWalletSeries.js:31`
  - `client/src/components/TradingPanel/TradingPanel.jsx:83-92` (solo el `setInterval`; la carga inicial forzada sigue igual)
  - `client/src/pages/UniswapPools/UniswapPoolsPage.jsx:142-174` (los dos intervalos)
- Test: `client/src/hooks/useVisibleInterval.test.js`

**Interfaces:**
- Produces: `useVisibleInterval(callback: () => void, ms: number, enabled = true): void`, con la misma firma y comportamiento que el hook actual. Solo cambia de ubicación.
- Fuera de alcance, a propósito: `features/cross-chain-funding/useBringFunds.js` (vigila un fondeo en curso), `context/MarketContext.jsx` (es un chequeo local, sin red), `RelativeTime`, `useWebSocket` y TradingView (ya se pausan).

- [ ] **Step 1: Write the failing test** en `client/src/hooks/useVisibleInterval.test.js`, con temporizadores falsos y `document.visibilityState` redefinido mediante `Object.defineProperty`.
  - `'no llama mientras la pestaña está oculta'`: con la pestaña oculta y `ms = 1000`, tras avanzar 5000 ms el callback se llamó 0 veces.
  - `'al volver a ser visible llama enseguida'`: con la pestaña oculta, pasar a visible y disparar `visibilitychange` provoca 1 llamada sin avanzar el reloj.
  - `'visible llama cada ms'`: con la pestaña visible, 3000 ms producen 3 llamadas.
  - `'enabled=false no programa'`.

- [ ] **Step 2: Run to verify fail**

Run: `npm --prefix client run test -- src/hooks/useVisibleInterval.test.js`
Expected: FAIL (el módulo no existe en `hooks/`).

- [ ] **Step 3: Implement.** Mover el archivo con `git mv` y actualizar sus imports. En cada archivo de la lista, sustituir el `useEffect` + `setInterval` + `clearInterval` por `useVisibleInterval(cb, ms)`. La carga inicial que hoy hace cada `useEffect` al montar se mantiene en su propio `useEffect`. En `UniswapPoolsPage`, el intervalo de cuentas sigue leyendo `accountsRef`.

- [ ] **Step 4: Run**

Run: `npm --prefix client run test && npm --prefix client run lint`
Expected: PASS, incluidos los tests de Opciones, Métricas y orquestador.

- [ ] **Step 5: Commit**

```bash
git add -A client/src
git commit -m "perf(client): pause page polling while the tab is hidden"
```

---

### Task 6: Verificación integrada y documentación

- [ ] **Step 1: Suites completas**

Run: `npm --prefix server test && npm --prefix server run lint && npm --prefix client run test && npm --prefix client run lint && npm --prefix client run build && npm --prefix client run check:bundle`
Expected: todo en verde.

- [ ] **Step 2: Integrar en el checkout que sirve Docker** (merge `--no-ff` de `perf/quick-wins` en `main`, con `main` limpio). Comprobar en `docker logs --since 2m testbot-server` que nodemon reinició sin errores y que aparece la línea de arranque del servicio de retención.

- [ ] **Step 3: e2e contra Docker**

Run: `npx playwright test -c e2e/playwright-docker.config.js e2e/wallet-lazy-routes.spec.js e2e/metrics-wallet-orchestrators.spec.js e2e/lp-orchestrator-responsive.spec.js`
Expected: PASS.

- [ ] **Step 4: Nota del vault.** Añadir una sección «Performance: quick wins (2026-10-23)» en `~/ObsidianVault/proyectos/testbotCobertura.md`:
  - Las cuatro mejoras.
  - Las variables `DELTA_NEUTRAL_MAX_CONCURRENT_EVALS`, `DECISION_LOG_RETENTION_ENABLED` y `DECISION_LOG_RETENTION_DAYS`.
  - La decisión de no podar otras tablas.
  - Lo pendiente del análisis: migración a dominios parada, separar los roles API y worker, más eventos por WebSocket, `pg_stat_statements` en producción.
  - Actualizar `actualizado` y hacer commit en `~/ObsidianVault`.

- [ ] **Step 5: Borrar el worktree y la rama ya integrada.** No hacer push ni desplegar sin pedirlo al usuario.
