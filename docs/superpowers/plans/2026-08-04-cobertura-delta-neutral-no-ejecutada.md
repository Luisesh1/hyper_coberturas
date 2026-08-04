# Corrección: LP orquestado corriendo sin cobertura delta-neutral

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un orquestador LP nunca quede en `lp_active` con `activeProtectedPoolId = null` habiendo pedido cobertura — y que si ocurre, el sistema lo reintente, lo alerte y la UI lo muestre.

**Architecture:** Cuatro capas de defensa sobre el mismo fallo. (1) El snapshot post-mint deja de fallar en silencio: reintenta y lanza error tipado. (2) `attachLp` deja de fabricar un stub inválido y exige un snapshot real, recargándolo él mismo si hace falta. (3) El modo de fallo pasa a `strict` por defecto, así la saga compensa en vez de dejar un LP descubierto. (4) El loop de evaluación detecta la cobertura ausente, la reintenta con backoff, alerta por Telegram y la UI la pinta como incidencia.

**Tech Stack:** Node 20 (CommonJS), `node --test` + `node:assert/strict` en servidor, Vitest en cliente, Playwright para E2E, PostgreSQL vía `pg`.

## Global Constraints

- Servidor en CommonJS (`require`/`module.exports`). No ESM en `server/`.
- Tests de servidor con el runner nativo: `node --test`, importando `node:test` y `node:assert/strict`. Se ejecutan con `npm --prefix server run test`.
- Tests de cliente con Vitest (`import { describe, expect, it } from 'vitest'`). Se ejecutan con `npm --prefix client run test`.
- Patrón de inyección de dependencias existente: constructor recibe `deps = {}` y cae al módulo real con `deps.x || require('./x')`. Los tests inyectan fakes; **nunca** se mockea `pg` ni se toca la red.
- Logs estructurados: `this.logger.warn('snake_case_event', { campo: valor })`. Nunca `console.log` en `src/`.
- Errores de dominio desde `server/src/errors/app-error.js`. `ValidationError` = 400, `ExternalServiceError` = 502.
- Los E2E de Playwright corren **contra el Docker en `http://localhost:5174`**, con `e2e/playwright-docker.config.js`. No se levanta un build estático nuevo para estos.
- Lint obligatorio antes de commit: `npm --prefix server run lint`.
- El orquestador **#26 se deja como está** (decisión del usuario). No hay tarea de remediación manual. La Tarea 5 lo cubrirá automáticamente cuando el loop reintente.

## Contexto del fallo (por qué existe este plan)

El 2026-08-03 04:48:04 el orquestador #26 (arbitrum/v4, posición 191720, ~$99,5) registró:

```
lp_orchestrator_protection_creation_failed
  error: "Solo se pueden proteger posiciones LP de Uniswap V3/V4"
```

La posición **es** v4, así que la rama que falló en `normalizePoolSnapshot` fue `pool.mode !== 'lp_position'`. La cadena causal:

1. `loadWalletPoolSnapshot` (`helpers.js:807`) devuelve `null` sin lanzar cuando el scan no encuentra la posición recién minteada. No hay log: el fallo es invisible.
2. `attachLp` (`lp-orchestrator.service.js:196-200`) arma entonces un stub `{ identifier, network, version }` **sin `mode`**.
3. El guard de `uniswap-protection.service.js:87` lo rechaza con un mensaje que culpa a la versión.
4. El modo era `lenient` (default de `attachLp:179`), así que el LP se adjuntó igual: `activeProtectedPoolId = null`.
5. Nada reintenta: todas las rutas del loop van detrás de `if (orch.activeProtectedPoolId)`.

## File Structure

| Fichero | Responsabilidad | Tarea |
|---|---|---|
| `server/src/services/uniswap/actions/helpers.js` (modificar `loadWalletPoolSnapshot`, ~L799) | Cargar el snapshot post-mint con reintentos; lanzar en vez de devolver `null` | 1 |
| `server/src/services/uniswap/actions/finalize.js` (modificar, ~L407-427) | Absorber el nuevo throw sin romper el finalize | 1 |
| `server/src/services/lp-orchestrator.service.js` (modificar `attachLp`, L179-236; nuevo método privado) | Exigir snapshot real antes de crear la protección; default `strict` | 2, 4 |
| `server/src/services/uniswap-protection.service.js` (modificar `normalizePoolSnapshot`, L87-89) | Mensajes de error que distinguen versión de snapshot inválido | 3 |
| `server/src/schemas/lp-orchestrator.schema.js` (modificar `attachLpSchema`, L72-75) | Aceptar `protectionFailureMode` explícito | 4 |
| `server/src/services/lp-orchestrator/protection-recovery.js` (**crear**) | Lógica pura: ¿toca reintentar la cobertura ausente? Backoff y límite | 5 |
| `server/src/services/lp-orchestrator/notifier.js` (modificar, tras `positionMissing`) | Alerta Telegram de cobertura ausente | 5 |
| `server/src/services/lp-orchestrator.service.js` (modificar `_evaluateOne`, ~L1269) | Enganchar el reintento al inicio del tick | 5 |
| `client/src/pages/LpOrchestrator/components/orchestratorIssueState.js` (modificar) | Incidencia `unprotected` en la tarjeta | 6 |
| `e2e/orchestrator-unprotected-lp.spec.js` (**crear**) | E2E contra Docker: un LP descubierto se ve como tal | 7 |

Tests nuevos: `server/test/uniswap/wallet-pool-snapshot.test.js`, `server/test/lp-orchestrator-protection-recovery.test.js`, y ampliaciones a `server/test/lp-orchestrator.service.test.js`, `server/test/uniswap-protection.service.test.js`, `client/src/pages/LpOrchestrator/components/orchestratorIssueState.test.js`.

---

### Task 1: El snapshot post-mint deja de fallar en silencio

**Files:**
- Modify: `server/src/services/uniswap/actions/helpers.js:799-808`
- Modify: `server/src/services/uniswap/actions/finalize.js:407-427`
- Test: `server/test/uniswap/wallet-pool-snapshot.test.js` (crear)

**Interfaces:**
- Produces: `loadWalletPoolSnapshot(userId, { network, version, walletAddress, positionIdentifier, attempts = 3, delayMs = 4000, sleep = defaultSleep, scanner = uniswapService })` → `Promise<object>`. Devuelve el snapshot con `mode: 'lp_position'`. **Lanza** `ExternalServiceError` con `code = 'SNAPSHOT_NOT_FOUND'` si tras `attempts` intentos la posición no aparece.
- Consumes (Tarea 2): el mismo símbolo, exportado desde `helpers.js`.

**Por qué reintentos:** el scan corre segundos después del mint. Una posición recién creada puede no aparecer todavía en el escaneo de la wallet. Un solo intento convierte una latencia normal en un LP descubierto permanente.

- [ ] **Step 1: Write the failing test**

Crear `server/test/uniswap/wallet-pool-snapshot.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadWalletPoolSnapshot } = require('../../src/services/uniswap/actions/helpers');

function makeScanner(responses) {
  let call = 0;
  const scanner = {
    calls: 0,
    async scanPoolsCreatedByWallet() {
      scanner.calls += 1;
      const pools = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return { pools };
    },
  };
  return scanner;
}

const noSleep = async () => {};

test('devuelve el snapshot cuando el scan encuentra la posicion', async () => {
  const snapshot = { identifier: '191720', mode: 'lp_position', version: 'v4' };
  const scanner = makeScanner([[snapshot]]);

  const result = await loadWalletPoolSnapshot(3, {
    network: 'arbitrum',
    version: 'v4',
    walletAddress: '0xabc',
    positionIdentifier: '191720',
    scanner,
    sleep: noSleep,
  });

  assert.equal(result, snapshot);
  assert.equal(scanner.calls, 1);
});

test('reintenta cuando la posicion recien minteada aun no aparece', async () => {
  const snapshot = { identifier: '191720', mode: 'lp_position', version: 'v4' };
  const scanner = makeScanner([[], [], [snapshot]]);

  const result = await loadWalletPoolSnapshot(3, {
    network: 'arbitrum',
    version: 'v4',
    walletAddress: '0xabc',
    positionIdentifier: '191720',
    attempts: 3,
    scanner,
    sleep: noSleep,
  });

  assert.equal(result, snapshot);
  assert.equal(scanner.calls, 3);
});

test('lanza SNAPSHOT_NOT_FOUND en vez de devolver null tras agotar intentos', async () => {
  const scanner = makeScanner([[]]);

  await assert.rejects(
    () => loadWalletPoolSnapshot(3, {
      network: 'arbitrum',
      version: 'v4',
      walletAddress: '0xabc',
      positionIdentifier: '191720',
      attempts: 2,
      scanner,
      sleep: noSleep,
    }),
    (err) => {
      assert.equal(err.code, 'SNAPSHOT_NOT_FOUND');
      assert.match(err.message, /191720/);
      return true;
    }
  );
  assert.equal(scanner.calls, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- --test-name-pattern="snapshot"`
Expected: FAIL. `loadWalletPoolSnapshot` ignora `scanner`/`sleep` y devuelve `null` en vez de lanzar; el tercer test falla con `AssertionError: Missing expected rejection`.

- [ ] **Step 3: Write minimal implementation**

En `server/src/services/uniswap/actions/helpers.js`, sustituir la función completa (L799-808) por:

```js
const DEFAULT_SNAPSHOT_ATTEMPTS = 3;
const DEFAULT_SNAPSHOT_DELAY_MS = 4000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Carga el snapshot de una posición concreta de la wallet.
 *
 * Reintenta porque el caller típico es el finalize de un mint: la posición
 * acaba de existir y el escaneo puede no verla todavía. Devolver `null` en
 * ese caso hacía que la creación de la cobertura recibiera un stub inválido
 * y el LP quedara descubierto sin que nada lo registrara.
 */
async function loadWalletPoolSnapshot(userId, {
  network,
  version,
  walletAddress,
  positionIdentifier,
  attempts = DEFAULT_SNAPSHOT_ATTEMPTS,
  delayMs = DEFAULT_SNAPSHOT_DELAY_MS,
  sleep = defaultSleep,
  scanner = uniswapService,
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await scanner.scanPoolsCreatedByWallet({
        userId,
        wallet: walletAddress,
        network,
        version,
      });
      const found = (result?.pools || []).find(
        (pool) => String(pool.identifier) === String(positionIdentifier)
      );
      if (found) return found;
    } catch (err) {
      lastError = err;
    }
    if (attempt < attempts) await sleep(delayMs);
  }

  // `ExternalServiceError` fija `code = 'EXTERNAL_SERVICE_ERROR'`; lo
  // sobrescribimos para que el caller pueda distinguir "la posición no
  // aparece" de cualquier otro fallo del servicio.
  const notFound = new ExternalServiceError(
    `No se encontro la posicion ${positionIdentifier} en la wallet tras ${attempts} intentos`,
    { network, version, walletAddress, positionIdentifier, lastError: lastError?.message || null }
  );
  notFound.code = 'SNAPSHOT_NOT_FOUND';
  throw notFound;
}
```

Asegurar el import al principio del fichero — si `ExternalServiceError` no está ya importado en `helpers.js`, añadir a la lista de requires:

```js
const { ExternalServiceError } = require('../../../errors/app-error');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- --test-name-pattern="snapshot"`
Expected: PASS, 3 tests.

- [ ] **Step 5: Absorber el throw en finalize**

`finalize.js` ya envuelve la llamada en `try/catch` y loguea `uniswap_position_action_snapshot_refresh_failed`. Con el cambio ese log **por fin se emite**. Solo hay que añadir el código del error al log para poder distinguir "no apareció" de "el RPC petó". En `server/src/services/uniswap/actions/finalize.js:417-426`, sustituir el bloque `catch`:

```js
    } catch (err) {
      logger.warn('uniswap_position_action_snapshot_refresh_failed', {
        action,
        userId,
        network,
        version,
        positionIdentifier: finalPositionIdentifier,
        code: err.code || null,
        error: err.message,
      });
    }
```

- [ ] **Step 6: Run full server suite and lint**

Run: `npm --prefix server run test && npm --prefix server run lint`
Expected: PASS sin regresiones. Prestar atención a `server/test/uniswap-position-actions.service.test.js`: si algún test esperaba `refreshedSnapshot === null` con un scanner vacío, sigue pasando porque `finalize` captura el throw.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/uniswap/actions/helpers.js server/src/services/uniswap/actions/finalize.js server/test/uniswap/wallet-pool-snapshot.test.js
git commit -m "fix(uniswap): el snapshot post-mint reintenta y falla explicito en vez de devolver null"
```

---

### Task 2: `attachLp` exige un snapshot real, sin stubs inválidos

**Files:**
- Modify: `server/src/services/lp-orchestrator.service.js:179-236`
- Test: `server/test/lp-orchestrator.service.test.js` (añadir bloque)

**Interfaces:**
- Consumes: `loadWalletPoolSnapshot` de Tarea 1 (inyectable como `deps.loadWalletPoolSnapshot`).
- Produces: `LpOrchestratorService#_loadProtectionSnapshot(orch, positionIdentifier)` → `Promise<object>`. Lanza si no lo consigue.
- Produces: el error de `attachLp` cuando falta el snapshot lleva `code = 'PROTECTION_SNAPSHOT_UNAVAILABLE'`.

**Por qué:** el stub `{ identifier, network, version }` de L196-200 nunca puede pasar el guard de `normalizePoolSnapshot` — le faltan `mode`, rango, valor USD, owner y tokens. Construirlo solo sirve para transformar "no tengo snapshot" en un error engañoso. Si no hay snapshot, hay que ir a buscarlo.

- [ ] **Step 1: Write the failing test**

Añadir al final de `server/test/lp-orchestrator.service.test.js` (usa `makeFakeRepo()` y `fakeDb`, ya definidos en el fichero):

```js
function makeAttachDeps(overrides = {}) {
  const repo = makeFakeRepo();
  const created = [];
  const deps = {
    lpOrchestratorRepository: repo,
    db: fakeDb,
    logger: { info() {}, warn() {}, error() {} },
    uniswapProtectionService: {
      async createProtectedPool(args) {
        created.push(args);
        return { id: 77 };
      },
      async deactivateProtectedPool() { return null; },
    },
    protectedPoolRefreshService: { async refreshProtection() { return null; } },
    ...overrides,
  };
  return { repo, created, deps };
}

async function seedOrchestrator(repo) {
  const id = await repo.create({
    userId: 3,
    name: 'test',
    network: 'arbitrum',
    version: 'v4',
    walletAddress: '0xabc',
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    phase: 'idle',
    status: 'active',
    accounting: {
      totalGasUsd: 0,
      totalSlippageUsd: 0,
      totalFeesCollectedUsd: 0,
      totalNetPnlUsd: 0,
      lpCount: 0,
    },
    strategyState: {},
  });
  return id;
}

const goodSnapshot = {
  mode: 'lp_position',
  version: 'v4',
  identifier: '191720',
  poolAddress: '0xpool',
  rangeLowerPrice: 2000,
  rangeUpperPrice: 2400,
  priceCurrent: 2200,
  currentValueUsd: 99.5,
  owner: '0xabc',
  token0: { symbol: 'WETH' },
  token1: { symbol: 'USDC' },
};

test('attachLp recarga el snapshot cuando finalize no lo trajo', async () => {
  let loaderCalls = 0;
  const { repo, created, deps } = makeAttachDeps({
    loadWalletPoolSnapshot: async () => {
      loaderCalls += 1;
      return goodSnapshot;
    },
  });
  const service = new LpOrchestratorService(deps);
  const id = await seedOrchestrator(repo);

  await service.attachLp({
    userId: 3,
    orchestratorId: id,
    finalizeResult: { positionChanges: { newPositionIdentifier: '191720' } },
    protectionConfig: { enabled: true, accountId: 8, configuredNotionalUsd: 50 },
    protectionFailureMode: 'lenient',
  });

  assert.equal(loaderCalls, 1);
  assert.equal(created.length, 1);
  assert.equal(created[0].pool.mode, 'lp_position');
  const orch = await repo.getById(3, id);
  assert.equal(orch.activeProtectedPoolId, 77);
});

test('attachLp nunca pasa un stub sin mode a createProtectedPool', async () => {
  const { repo, created, deps } = makeAttachDeps({
    loadWalletPoolSnapshot: async () => {
      const err = new Error('no aparece');
      err.code = 'SNAPSHOT_NOT_FOUND';
      throw err;
    },
  });
  const service = new LpOrchestratorService(deps);
  const id = await seedOrchestrator(repo);

  await service.attachLp({
    userId: 3,
    orchestratorId: id,
    finalizeResult: { positionChanges: { newPositionIdentifier: '191720' } },
    protectionConfig: { enabled: true, accountId: 8, configuredNotionalUsd: 50 },
    protectionFailureMode: 'lenient',
  });

  assert.equal(created.length, 0, 'no debe intentarse crear la proteccion sin snapshot');
  const orch = await repo.getById(3, id);
  assert.equal(orch.activeProtectedPoolId, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- --test-name-pattern="attachLp"`
Expected: FAIL. El primer test falla porque `attachLp` no llama a ningún loader (`loaderCalls === 0`) y pasa el stub, que revienta en `createProtectedPool`. El segundo falla porque `created.length === 1` con el stub.

- [ ] **Step 3: Write minimal implementation**

3a. En `server/src/services/lp-orchestrator.service.js`, añadir el require junto a los demás de la cabecera (tras la L19):

```js
const { loadWalletPoolSnapshot } = require('./uniswap/actions/helpers');
```

3b. En el constructor (tras `this.protectedPoolRefreshService = ...`, L61), añadir:

```js
    this.loadWalletPoolSnapshot = deps.loadWalletPoolSnapshot || loadWalletPoolSnapshot;
```

3c. Añadir el método privado justo antes de `attachLp` (antes de L179):

```js
  /**
   * Snapshot fiable de la posición para crear la cobertura. `finalizeResult`
   * lo trae casi siempre, pero cuando el escaneo post-mint llegó tarde viene
   * vacío. Antes se fabricaba un stub `{identifier, network, version}` que
   * `normalizePoolSnapshot` rechazaba con un mensaje sobre la versión — el
   * LP acababa adjunto y descubierto. Ahora se recarga o se falla claro.
   */
  async _loadProtectionSnapshot(orch, positionIdentifier) {
    return this.loadWalletPoolSnapshot(orch.userId, {
      network: orch.network,
      version: orch.version,
      walletAddress: orch.walletAddress,
      positionIdentifier: String(positionIdentifier),
    });
  }
```

3d. Sustituir el bloque de creación de protección dentro de `attachLp` (L193-236) por:

```js
    let protectedPoolId = null;
    if (protectionConfig && protectionConfig.enabled !== false) {
      try {
        const pool = refreshedSnapshot
          || await this._loadProtectionSnapshot(orch, newPositionIdentifier);
        const protectionResult = await this.uniswapProtectionService.createProtectedPool({
          userId,
          pool,
          accountId: protectionConfig.accountId,
          leverage: protectionConfig.leverage,
          configuredNotionalUsd: protectionConfig.configuredNotionalUsd,
          stopLossDifferencePct: protectionConfig.stopLossDifferencePct,
          protectionMode: 'delta_neutral',
          bandMode: protectionConfig.bandMode,
          baseRebalancePriceMovePct: protectionConfig.baseRebalancePriceMovePct,
          rebalanceIntervalSec: protectionConfig.rebalanceIntervalSec,
          targetHedgeRatio: protectionConfig.targetHedgeRatio,
          minRebalanceNotionalUsd: protectionConfig.minRebalanceNotionalUsd,
          maxSlippageBps: protectionConfig.maxSlippageBps,
          twapMinNotionalUsd: protectionConfig.twapMinNotionalUsd,
        });
        protectedPoolId = protectionResult?.id || protectionResult?.protectedPoolId || null;
      } catch (err) {
        this.logger.warn('lp_orchestrator_protection_creation_failed', {
          orchestratorId,
          protectionFailureMode,
          code: err.code || null,
          error: err.message,
        });
        if (protectionFailureMode === 'strict') {
          // La saga de creación compensa arriba: cierra el hedge si llegó a
          // abrirse y borra el orquestador. Seguir aquí dejaría un
          // orquestador en `lp_active` con `activeProtectedPoolId = null`,
          // es decir operando descubierto mientras la UI lo pinta protegido.
          const failure = new Error(`No se pudo crear la protección: ${err.message}`);
          failure.code = err.code === 'SNAPSHOT_NOT_FOUND'
            ? 'PROTECTION_SNAPSHOT_UNAVAILABLE'
            : 'PROTECTION_CREATION_FAILED';
          failure.cause = err;
          throw failure;
        }
        // `lenient`: el LP quedó creado. El loop lo reintentará (ver
        // protection-recovery) y la UI lo marcará como descubierto.
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- --test-name-pattern="attachLp"`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run full server suite and lint**

Run: `npm --prefix server run test && npm --prefix server run lint`
Expected: PASS. `server/test/lp-orchestrator-create-saga.test.js` usa `attachLp` en modo `strict`; si algún test suyo pasaba un `finalizeResult` sin `refreshedSnapshot` y esperaba éxito, inyectarle `loadWalletPoolSnapshot: async () => goodSnapshot` en sus deps.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/lp-orchestrator.service.js server/test/lp-orchestrator.service.test.js
git commit -m "fix(orchestrator): attachLp recarga el snapshot en vez de fabricar un stub invalido"
```

---

### Task 3: El guard deja de culpar a la versión

**Files:**
- Modify: `server/src/services/uniswap-protection.service.js:83-89`
- Test: `server/test/uniswap-protection.service.test.js` (añadir bloque)

**Interfaces:**
- Produces: `normalizePoolSnapshot` sigue lanzando `ValidationError`, pero con tres mensajes distinguibles: versión no soportada, `mode` incorrecto, y objeto ausente.

**Por qué:** el mensaje "Solo se pueden proteger posiciones LP de Uniswap V3/V4" apareció en producción sobre una posición v4 perfectamente válida. Costó el diagnóstico entero. Dos condiciones distintas no pueden compartir un mensaje.

- [ ] **Step 1: Write the failing test**

Añadir a `server/test/uniswap-protection.service.test.js`. El módulo no exporta `normalizePoolSnapshot`, así que se ejercita a través de `createProtectedPool`, que lo invoca primero. Comprobar el mensaje:

```js
test('distingue version no soportada de snapshot sin mode', async () => {
  const uniswapProtectionService = require('../src/services/uniswap-protection.service');

  await assert.rejects(
    () => uniswapProtectionService.createProtectedPool({
      userId: 3,
      pool: { mode: 'lp_position', version: 'v2', identifier: '1' },
    }),
    (err) => {
      assert.match(err.message, /V3\/V4/);
      return true;
    }
  );

  await assert.rejects(
    () => uniswapProtectionService.createProtectedPool({
      userId: 3,
      pool: { version: 'v4', identifier: '191720' },
    }),
    (err) => {
      assert.match(err.message, /snapshot/i);
      assert.doesNotMatch(err.message, /V3\/V4/);
      return true;
    }
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- --test-name-pattern="version no soportada"`
Expected: FAIL en la segunda aserción: el mensaje sí contiene "V3/V4" porque ambas condiciones comparten el `throw`.

- [ ] **Step 3: Write minimal implementation**

En `server/src/services/uniswap-protection.service.js`, sustituir L83-89:

```js
function normalizePoolSnapshot(pool) {
  if (!pool || typeof pool !== 'object') {
    throw new ValidationError('pool es requerido');
  }
  if (!['v3', 'v4'].includes(pool.version)) {
    throw new ValidationError('Solo se pueden proteger posiciones LP de Uniswap V3/V4');
  }
  // `mode` distinto de `lp_position` casi siempre significa que el caller
  // pasó un objeto incompleto (identificador + red + versión) porque no
  // consiguió el snapshot real, no que la posición no sea protegible.
  if (pool.mode !== 'lp_position') {
    throw new ValidationError(
      'El snapshot del pool está incompleto: falta el detalle de la posición LP'
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- --test-name-pattern="version no soportada"`
Expected: PASS.

- [ ] **Step 5: Run full server suite and lint**

Run: `npm --prefix server run test && npm --prefix server run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/uniswap-protection.service.js server/test/uniswap-protection.service.test.js
git commit -m "fix(protection): separar 'version no soportada' de 'snapshot incompleto' en el guard"
```

---

### Task 4: `strict` por defecto y explícito en la ruta

**Files:**
- Modify: `server/src/services/lp-orchestrator.service.js:179`
- Modify: `server/src/schemas/lp-orchestrator.schema.js:72-75`
- Test: `server/test/lp-orchestrator.service.test.js` (añadir), `server/test/lp-orchestrator-wizard-schema.test.js` (añadir)

**Interfaces:**
- Consumes: el bloque `catch` de la Tarea 2.
- Produces: `attachLp({ ..., protectionFailureMode = 'strict' })`. `attachLpSchema` acepta `protectionFailureMode: z.enum(['strict','lenient']).optional()`.

**Por qué:** `create-saga.js:222` ya pasa `'strict'` explícito. El default `'lenient'` solo lo usa la ruta legacy `POST /:id/attach-lp` — exactamente el camino por el que se creó el orquestador #26. Un default que deja plata descubierta es el default equivocado.

- [ ] **Step 1: Write the failing test**

Añadir a `server/test/lp-orchestrator.service.test.js` (reutiliza `makeAttachDeps`, `seedOrchestrator` y `goodSnapshot` de la Tarea 2):

```js
test('attachLp aborta por defecto si la proteccion falla', async () => {
  const { repo, deps } = makeAttachDeps({
    loadWalletPoolSnapshot: async () => goodSnapshot,
    uniswapProtectionService: {
      async createProtectedPool() { throw new Error('margen insuficiente'); },
      async deactivateProtectedPool() { return null; },
    },
  });
  const service = new LpOrchestratorService(deps);
  const id = await seedOrchestrator(repo);

  await assert.rejects(
    () => service.attachLp({
      userId: 3,
      orchestratorId: id,
      finalizeResult: { positionChanges: { newPositionIdentifier: '191720' } },
      protectionConfig: { enabled: true, accountId: 8, configuredNotionalUsd: 50 },
    }),
    (err) => {
      assert.equal(err.code, 'PROTECTION_CREATION_FAILED');
      return true;
    }
  );

  const orch = await repo.getById(3, id);
  assert.equal(orch.activePositionIdentifier, undefined, 'no debe quedar LP adjunto');
});
```

Añadir a `server/test/lp-orchestrator-wizard-schema.test.js`:

```js
test('attachLpSchema acepta protectionFailureMode explicito', () => {
  const { attachLpSchema } = require('../src/schemas/lp-orchestrator.schema');
  const parsed = attachLpSchema.parse({
    finalizeResult: { positionChanges: { newPositionIdentifier: '191720' } },
    protectionFailureMode: 'lenient',
  });
  assert.equal(parsed.protectionFailureMode, 'lenient');
  assert.throws(() => attachLpSchema.parse({
    finalizeResult: { positionChanges: { newPositionIdentifier: '191720' } },
    protectionFailureMode: 'whatever',
  }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- --test-name-pattern="aborta por defecto|protectionFailureMode"`
Expected: FAIL. El primero no lanza (default `lenient` traga el error); el segundo falla porque el schema descarta la clave desconocida.

- [ ] **Step 3: Write minimal implementation**

3a. `server/src/services/lp-orchestrator.service.js:179` — cambiar el default y documentar:

```js
  /**
   * @param {'strict'|'lenient'} [params.protectionFailureMode] Default `strict`:
   *   si la cobertura no se puede crear, el caller debe compensar y abortar.
   *   `lenient` deja el LP adjunto y descubierto — solo para adopciones
   *   manuales donde el usuario asume la exposición a sabiendas.
   */
  async attachLp({ userId, orchestratorId, finalizeResult, protectionConfig, protectionFailureMode = 'strict' }) {
```

3b. `server/src/schemas/lp-orchestrator.schema.js:72-75`:

```js
const attachLpSchema = z.object({
  finalizeResult: finalizeResultSchema,
  protectionConfig: protectionConfigSchema.optional(),
  protectionFailureMode: z.enum(['strict', 'lenient']).optional(),
});
```

La ruta `POST /:id/attach-lp` ya hace `...req.body`, así que el campo llega solo.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- --test-name-pattern="aborta por defecto|protectionFailureMode"`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run full server suite and lint**

Run: `npm --prefix server run test && npm --prefix server run lint`
Expected: PASS. Los tests de `adoptLp` que esperaban tolerancia ante fallo de protección deben pasar ahora `protectionFailureMode: 'lenient'` explícito.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/lp-orchestrator.service.js server/src/schemas/lp-orchestrator.schema.js server/test/lp-orchestrator.service.test.js server/test/lp-orchestrator-wizard-schema.test.js
git commit -m "fix(orchestrator): attachLp por defecto aborta si la cobertura falla"
```

---

### Task 5: El loop detecta y reintenta la cobertura ausente

**Files:**
- Create: `server/src/services/lp-orchestrator/protection-recovery.js`
- Modify: `server/src/services/lp-orchestrator/notifier.js` (tras `positionMissing`, ~L148)
- Modify: `server/src/services/lp-orchestrator.service.js` (`_evaluateOne`, tras la guarda de L1270-1273)
- Test: `server/test/lp-orchestrator-protection-recovery.test.js` (crear)

**Interfaces:**
- Produces: `needsProtectionRecovery(orch)` → `boolean`. True si `status === 'active'`, `activePositionIdentifier` presente, `protectionConfig?.enabled !== false` y `activeProtectedPoolId == null`.
- Produces: `shouldAttemptNow(orch, now)` → `boolean`. Respeta `orch.strategyState.protectionRetry.nextAttemptAt` y el tope `MAX_PROTECTION_RETRY_ATTEMPTS = 8`.
- Produces: `nextRetryState(previous, { ok, error, now })` → `{ attempts, nextAttemptAt, lastError, exhausted }`. Backoff exponencial 5 min → 4 h.
- Produces: `LpOrchestratorNotifier#protectionMissing(orchestrator, { attempts, lastError, exhausted })`.
- Consumes: `_loadProtectionSnapshot` de Tarea 2.

**Por qué backoff y tope:** el fallo típico (snapshot tardío) se resuelve en minutos; el fallo estructural (margen insuficiente en Hyperliquid, activo no soportado) no se resuelve nunca reintentando. Reintentar en bucle contra la API de Hyperliquid cada minuto durante días es ruido y consumo. Tras 8 intentos se alerta y se para, dejando el estado visible.

**Nota:** el orquestador #26 entra en esta ruta en el primer tick tras el deploy — es la remediación automática de lo que hoy está descubierto.

- [ ] **Step 1: Write the failing test**

Crear `server/test/lp-orchestrator-protection-recovery.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  needsProtectionRecovery,
  shouldAttemptNow,
  nextRetryState,
  MAX_PROTECTION_RETRY_ATTEMPTS,
} = require('../src/services/lp-orchestrator/protection-recovery');

function makeOrch(overrides = {}) {
  return {
    id: 26,
    userId: 3,
    status: 'active',
    phase: 'lp_active',
    activePositionIdentifier: '191720',
    activeProtectedPoolId: null,
    protectionConfig: { enabled: true, accountId: 8, configuredNotionalUsd: 50 },
    strategyState: {},
    ...overrides,
  };
}

test('detecta un LP activo que pidio cobertura y no la tiene', () => {
  assert.equal(needsProtectionRecovery(makeOrch()), true);
});

test('no toca orquestadores ya cubiertos ni los que no pidieron cobertura', () => {
  assert.equal(needsProtectionRecovery(makeOrch({ activeProtectedPoolId: 77 })), false);
  assert.equal(needsProtectionRecovery(makeOrch({ protectionConfig: { enabled: false } })), false);
  assert.equal(needsProtectionRecovery(makeOrch({ protectionConfig: null })), false);
  assert.equal(needsProtectionRecovery(makeOrch({ activePositionIdentifier: null })), false);
  assert.equal(needsProtectionRecovery(makeOrch({ status: 'archived' })), false);
});

test('el primer intento es inmediato', () => {
  assert.equal(shouldAttemptNow(makeOrch(), 1_000_000), true);
});

test('respeta el backoff persistido', () => {
  const orch = makeOrch({
    strategyState: { protectionRetry: { attempts: 1, nextAttemptAt: 2_000_000 } },
  });
  assert.equal(shouldAttemptNow(orch, 1_999_999), false);
  assert.equal(shouldAttemptNow(orch, 2_000_000), true);
});

test('deja de reintentar tras agotar los intentos', () => {
  const orch = makeOrch({
    strategyState: {
      protectionRetry: { attempts: MAX_PROTECTION_RETRY_ATTEMPTS, nextAttemptAt: 0 },
    },
  });
  assert.equal(shouldAttemptNow(orch, 9_999_999), false);
});

test('el backoff crece y se corona a 4 h', () => {
  const now = 1_000_000;
  const first = nextRetryState(null, { ok: false, error: 'boom', now });
  assert.equal(first.attempts, 1);
  assert.equal(first.nextAttemptAt, now + 5 * 60_000);
  assert.equal(first.lastError, 'boom');
  assert.equal(first.exhausted, false);

  const second = nextRetryState(first, { ok: false, error: 'boom', now });
  assert.equal(second.attempts, 2);
  assert.equal(second.nextAttemptAt, now + 10 * 60_000);

  let state = second;
  for (let i = 0; i < 10; i += 1) state = nextRetryState(state, { ok: false, error: 'boom', now });
  assert.equal(state.nextAttemptAt, now + 4 * 60 * 60_000);
  assert.equal(state.exhausted, true);
});

test('el exito limpia el estado de reintento', () => {
  const failed = nextRetryState(null, { ok: false, error: 'boom', now: 1_000_000 });
  assert.equal(nextRetryState(failed, { ok: true, now: 1_000_000 }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- server/test/lp-orchestrator-protection-recovery.test.js`
Expected: FAIL con `Cannot find module '../src/services/lp-orchestrator/protection-recovery'`.

- [ ] **Step 3: Write minimal implementation**

Crear `server/src/services/lp-orchestrator/protection-recovery.js`:

```js
/**
 * protection-recovery.js
 *
 * Lógica pura para el caso "el LP existe pero la cobertura no".
 *
 * Pasa cuando `attachLp` corrió en modo `lenient` y la creación de la
 * protección falló: el orquestador queda en `lp_active` con
 * `activeProtectedPoolId = null` y ninguna ruta del loop lo mira, porque
 * todas van detrás de `if (orch.activeProtectedPoolId)`. El resultado es un
 * LP operando descubierto de forma indefinida y silenciosa.
 *
 * El backoff existe porque los dos fallos posibles tienen escalas distintas:
 * el snapshot que llegó tarde se arregla en minutos, y el margen insuficiente
 * en Hyperliquid no se arregla reintentando nunca. Se reintenta rápido al
 * principio, se espacía, y se para avisando.
 */

const BASE_RETRY_DELAY_MS = 5 * 60_000;
const MAX_RETRY_DELAY_MS = 4 * 60 * 60_000;
const MAX_PROTECTION_RETRY_ATTEMPTS = 8;

/**
 * ¿Este orquestador pidió cobertura y se quedó sin ella?
 */
function needsProtectionRecovery(orch) {
  if (!orch) return false;
  if (orch.status !== 'active') return false;
  if (!orch.activePositionIdentifier) return false;
  if (orch.activeProtectedPoolId != null) return false;
  const protection = orch.protectionConfig;
  if (!protection) return false;
  return protection.enabled !== false;
}

function readRetryState(orch) {
  return orch?.strategyState?.protectionRetry || null;
}

/**
 * ¿Toca intentarlo en este tick? El primer intento es inmediato; los
 * siguientes esperan al `nextAttemptAt` persistido.
 */
function shouldAttemptNow(orch, now = Date.now()) {
  const state = readRetryState(orch);
  if (!state) return true;
  if (Number(state.attempts || 0) >= MAX_PROTECTION_RETRY_ATTEMPTS) return false;
  return now >= Number(state.nextAttemptAt || 0);
}

/**
 * Estado de reintento tras un intento. `null` si salió bien: el éxito
 * borra el rastro para que un fallo futuro empiece de cero.
 */
function nextRetryState(previous, { ok, error = null, now = Date.now() } = {}) {
  if (ok) return null;
  const attempts = Number(previous?.attempts || 0) + 1;
  const delay = Math.min(BASE_RETRY_DELAY_MS * (2 ** (attempts - 1)), MAX_RETRY_DELAY_MS);
  return {
    attempts,
    nextAttemptAt: now + delay,
    lastError: error,
    exhausted: attempts >= MAX_PROTECTION_RETRY_ATTEMPTS,
  };
}

module.exports = {
  needsProtectionRecovery,
  shouldAttemptNow,
  nextRetryState,
  readRetryState,
  BASE_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  MAX_PROTECTION_RETRY_ATTEMPTS,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- server/test/lp-orchestrator-protection-recovery.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the Telegram notification**

En `server/src/services/lp-orchestrator/notifier.js`, añadir tras `positionMissing` (antes del cierre de la clase, ~L148):

```js
  async protectionMissing(orchestrator, { attempts = 0, lastError = null, exhausted = false } = {}) {
    const head = this._header(orchestrator);
    const lines = [
      head,
      '',
      exhausted
        ? '🛑 <b>LP SIN COBERTURA — reintentos agotados</b>'
        : '⚠️ <b>LP sin cobertura delta-neutral</b>',
      'El LP está activo pero la protección no se pudo crear.',
      `Intentos: ${attempts}`,
      lastError ? `Motivo: ${escapeHtml(lastError)}` : null,
      exhausted
        ? 'No se reintentará más. Revisa la cuenta de Hyperliquid y vuelve a vincular la cobertura a mano.'
        : 'Se reintentará automáticamente.',
    ].filter(Boolean);
    await this._sendTelegram(orchestrator.userId, lines.join('\n'));
  }
```

- [ ] **Step 6: Write the failing integration test for the loop hook**

Añadir a `server/test/lp-orchestrator.service.test.js`:

```js
test('_evaluateOne reintenta la cobertura ausente y la vincula', async () => {
  const { repo, created, deps } = makeAttachDeps({
    loadWalletPoolSnapshot: async () => goodSnapshot,
    notifier: {
      async protectionMissing() {},
      async urgentOutOfRange() {}, async recommendRebalance() {},
      async recommendCollectFees() {}, async actionFinalized() {},
      async verificationFailed() {}, async lpKilled() {}, async positionMissing() {},
    },
  });
  const service = new LpOrchestratorService(deps);
  const id = await seedOrchestrator(repo);
  await repo.updateActiveLp(3, id, {
    activePositionIdentifier: '191720',
    activePoolAddress: '0xpool',
    activeProtectedPoolId: null,
    phase: 'lp_active',
  });
  const orch = await repo.getById(3, id);
  orch.protectionConfig = { enabled: true, accountId: 8, configuredNotionalUsd: 50 };

  const result = await service._recoverMissingProtection(orch);

  assert.equal(result.recovered, true);
  assert.equal(created.length, 1);
  const after = await repo.getById(3, id);
  assert.equal(after.activeProtectedPoolId, 77);
});

test('_recoverMissingProtection persiste el backoff cuando vuelve a fallar', async () => {
  const notified = [];
  const { repo, deps } = makeAttachDeps({
    loadWalletPoolSnapshot: async () => goodSnapshot,
    uniswapProtectionService: {
      async createProtectedPool() { throw new Error('margen insuficiente'); },
      async deactivateProtectedPool() { return null; },
    },
    notifier: {
      async protectionMissing(orch, info) { notified.push(info); },
      async urgentOutOfRange() {}, async recommendRebalance() {},
      async recommendCollectFees() {}, async actionFinalized() {},
      async verificationFailed() {}, async lpKilled() {}, async positionMissing() {},
    },
  });
  const service = new LpOrchestratorService(deps);
  const id = await seedOrchestrator(repo);
  await repo.updateActiveLp(3, id, {
    activePositionIdentifier: '191720',
    activePoolAddress: '0xpool',
    activeProtectedPoolId: null,
    phase: 'lp_active',
  });
  const orch = await repo.getById(3, id);
  orch.protectionConfig = { enabled: true, accountId: 8, configuredNotionalUsd: 50 };

  const result = await service._recoverMissingProtection(orch);

  assert.equal(result.recovered, false);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].attempts, 1);
  const after = await repo.getById(3, id);
  assert.equal(after.strategyState.protectionRetry.attempts, 1);
  assert.ok(after.strategyState.protectionRetry.nextAttemptAt > Date.now());
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm --prefix server run test -- --test-name-pattern="cobertura ausente|persiste el backoff"`
Expected: FAIL con `TypeError: service._recoverMissingProtection is not a function`.

- [ ] **Step 8: Wire it into the service**

8a. En `server/src/services/lp-orchestrator.service.js`, añadir el require junto a los otros del subdirectorio (tras L46):

```js
const protectionRecovery = require('./lp-orchestrator/protection-recovery');
```

8b. En el constructor, tras `this.verifier = ...`:

```js
    this.protectionRecovery = deps.protectionRecovery || protectionRecovery;
```

8c. Añadir el método antes de `_evaluateOne` (antes de L1269):

```js
  /**
   * Reintenta crear la cobertura de un LP que quedó descubierto. Devuelve
   * `{ recovered, skipped }`. Nunca lanza: el tick de evaluación debe
   * seguir aunque la cobertura siga sin poder crearse.
   */
  async _recoverMissingProtection(orch) {
    const now = Date.now();
    if (!this.protectionRecovery.shouldAttemptNow(orch, now)) {
      return { recovered: false, skipped: 'backoff' };
    }

    const previous = this.protectionRecovery.readRetryState(orch);
    let protectedPoolId = null;
    let error = null;

    try {
      const pool = await this._loadProtectionSnapshot(orch, orch.activePositionIdentifier);
      const protection = orch.protectionConfig || {};
      const result = await this.uniswapProtectionService.createProtectedPool({
        userId: orch.userId,
        pool,
        accountId: protection.accountId,
        leverage: protection.leverage,
        configuredNotionalUsd: protection.configuredNotionalUsd,
        stopLossDifferencePct: protection.stopLossDifferencePct,
        protectionMode: 'delta_neutral',
        bandMode: protection.bandMode,
        baseRebalancePriceMovePct: protection.baseRebalancePriceMovePct,
        rebalanceIntervalSec: protection.rebalanceIntervalSec,
        targetHedgeRatio: protection.targetHedgeRatio,
        minRebalanceNotionalUsd: protection.minRebalanceNotionalUsd,
        maxSlippageBps: protection.maxSlippageBps,
        twapMinNotionalUsd: protection.twapMinNotionalUsd,
      });
      protectedPoolId = result?.id || result?.protectedPoolId || null;
    } catch (err) {
      error = err.message;
    }

    const retryState = this.protectionRecovery.nextRetryState(previous, {
      ok: Boolean(protectedPoolId),
      error,
      now,
    });

    await this._withTransaction(async (client) => {
      if (protectedPoolId) {
        await this.repo.updateActiveLp(orch.userId, orch.id, {
          activePositionIdentifier: orch.activePositionIdentifier,
          activePoolAddress: orch.activePoolAddress,
          activeProtectedPoolId: protectedPoolId,
        }, client);
      }
      await this.repo.updateStrategyState(orch.userId, orch.id, {
        strategyState: { ...orch.strategyState, protectionRetry: retryState },
      }, client);
      await this.repo.appendActionLog({
        orchestratorId: orch.id,
        kind: 'recovery',
        reason: protectedPoolId ? 'protection_recreated' : 'protection_recreate_failed',
        positionIdentifier: orch.activePositionIdentifier,
      }, client);
    });

    if (protectedPoolId) {
      this.logger.info('lp_orchestrator_protection_recovered', {
        orchestratorId: orch.id,
        protectedPoolId,
        attempts: previous?.attempts || 0,
      });
      orch.activeProtectedPoolId = protectedPoolId;
      return { recovered: true };
    }

    this.logger.warn('lp_orchestrator_protection_recovery_failed', {
      orchestratorId: orch.id,
      attempts: retryState.attempts,
      exhausted: retryState.exhausted,
      error,
    });
    await this.notifier.protectionMissing(orch, {
      attempts: retryState.attempts,
      lastError: error,
      exhausted: retryState.exhausted,
    });
    return { recovered: false };
  }
```

8d. Enganchar al inicio de `_evaluateOne`, justo después de la guarda `no_active_lp` (tras L1273):

```js
    // Antes de evaluar el rango: si el LP pidió cobertura y no la tiene,
    // está corriendo descubierto. Recuperarla es más urgente que decidir
    // si conviene rebalancear.
    if (this.protectionRecovery.needsProtectionRecovery(orch)) {
      try {
        await this._recoverMissingProtection(orch);
      } catch (err) {
        this.logger.warn('lp_orchestrator_protection_recovery_unhandled', {
          orchestratorId: orch.id,
          error: err.message,
        });
      }
    }
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm --prefix server run test -- --test-name-pattern="cobertura ausente|persiste el backoff"`
Expected: PASS, 2 tests.

- [ ] **Step 10: Run full server suite and lint**

Run: `npm --prefix server run test && npm --prefix server run lint`
Expected: PASS. Los tests existentes de `_evaluateOne` que usan orquestadores sin `protectionConfig` no entran en la rama nueva (`needsProtectionRecovery` devuelve false con `protectionConfig` nulo). Si alguno los tiene con `enabled: true` y sin `activeProtectedPoolId`, añadirle `activeProtectedPoolId: 1` al fixture o un `notifier` fake con `protectionMissing`.

- [ ] **Step 11: Commit**

```bash
git add server/src/services/lp-orchestrator/protection-recovery.js server/src/services/lp-orchestrator/notifier.js server/src/services/lp-orchestrator.service.js server/test/lp-orchestrator-protection-recovery.test.js server/test/lp-orchestrator.service.test.js
git commit -m "feat(orchestrator): reintento con backoff y alerta cuando el LP queda sin cobertura"
```

---

### Task 6: La UI deja de pintar como sano un LP descubierto

**Files:**
- Modify: `client/src/pages/LpOrchestrator/components/orchestratorIssueState.js`
- Test: `client/src/pages/LpOrchestrator/components/orchestratorIssueState.test.js`

**Interfaces:**
- Consumes: `orchestrator.activeProtectedPoolId`, `orchestrator.protectionConfig`, `orchestrator.strategyState.protectionRetry` — todos ya expuestos por `mapRow` del repositorio y devueltos por `GET /api/lp-orchestrators`.
- Produces: `getOrchestratorIssue()` puede devolver `{ kind: 'unprotected', tone: 'urgent', chipLabel: 'Sin cobertura', ... }`.

**Prioridad:** justo después de `failed`. Un LP descubierto es más grave que un cooldown o un rebalanceo pendiente, pero menos que un orquestador ya detenido por error.

- [ ] **Step 1: Write the failing test**

Añadir a `client/src/pages/LpOrchestrator/components/orchestratorIssueState.test.js`:

```js
  it('marca como incidencia urgente un LP activo sin cobertura', () => {
    const issue = getOrchestratorIssue(makeOrchestrator({
      activePositionIdentifier: '191720',
      activeProtectedPoolId: null,
      protectionConfig: { enabled: true, accountId: 8 },
      strategyState: { protectionRetry: { attempts: 2, lastError: 'margen insuficiente' } },
    }), 1_710_000_100_000);

    expect(issue).toEqual(expect.objectContaining({
      kind: 'unprotected',
      tone: 'urgent',
      chipLabel: 'Sin cobertura',
    }));
    expect(issue.summary).toMatch(/sin cobertura/i);
  });

  it('no marca incidencia si el LP tiene cobertura vinculada', () => {
    const issue = getOrchestratorIssue(makeOrchestrator({
      activePositionIdentifier: '191720',
      activeProtectedPoolId: 77,
      protectionConfig: { enabled: true, accountId: 8 },
    }), 1_710_000_100_000);

    expect(issue).toBeNull();
  });

  it('no marca incidencia si el orquestador no pidio cobertura', () => {
    const issue = getOrchestratorIssue(makeOrchestrator({
      activePositionIdentifier: '191720',
      activeProtectedPoolId: null,
      protectionConfig: { enabled: false },
    }), 1_710_000_100_000);

    expect(issue).toBeNull();
  });

  it('el estado failed sigue teniendo prioridad sobre sin cobertura', () => {
    const issue = getOrchestratorIssue(makeOrchestrator({
      phase: 'failed',
      lastError: 'verification_failed:range_mismatch',
      activePositionIdentifier: '191720',
      activeProtectedPoolId: null,
      protectionConfig: { enabled: true },
    }), 1_710_000_100_000);

    expect(issue.kind).toBe('failed');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client run test -- orchestratorIssueState`
Expected: FAIL. `getOrchestratorIssue` devuelve `null` para el primer caso — no conoce `unprotected`.

- [ ] **Step 3: Write minimal implementation**

En `client/src/pages/LpOrchestrator/components/orchestratorIssueState.js`, insertar el bloque **inmediatamente después** del `if (orchestrator.phase === 'failed') { ... }` y antes del `if (orchestrator.nextEligibleAttemptAt ...)`:

```js
  const wantsProtection = orchestrator.protectionConfig
    && orchestrator.protectionConfig.enabled !== false;
  const isUnprotected = Boolean(orchestrator.activePositionIdentifier)
    && orchestrator.activeProtectedPoolId == null
    && wantsProtection;

  if (isUnprotected) {
    const retry = orchestrator.strategyState?.protectionRetry || null;
    const exhausted = Boolean(retry?.exhausted);
    return {
      kind: 'unprotected',
      tone: 'urgent',
      icon: '!',
      chipLabel: 'Sin cobertura',
      title: 'LP operando sin cobertura delta-neutral',
      summary: exhausted
        ? 'La proteccion no se pudo crear y ya no se reintenta. El LP esta expuesto al movimiento del precio.'
        : 'La proteccion configurada no esta vinculada. El LP esta sin cobertura mientras se reintenta.',
      details: [
        ...commonDetails,
        { label: 'Posicion', value: orchestrator.activePositionIdentifier },
        retry ? { label: 'Intentos de cobertura', value: String(retry.attempts) } : null,
        retry?.lastError ? { label: 'Detalle tecnico', value: retry.lastError } : null,
      ].filter(Boolean),
      resolveLabel: 'Reintentar cobertura ahora',
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix client run test -- orchestratorIssueState`
Expected: PASS, incluidos los 4 tests nuevos y los existentes.

- [ ] **Step 5: Verify the build**

Run: `npm --prefix client run build`
Expected: build limpio.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/LpOrchestrator/components/orchestratorIssueState.js client/src/pages/LpOrchestrator/components/orchestratorIssueState.test.js
git commit -m "feat(client): la tarjeta del orquestador marca el LP sin cobertura como incidencia urgente"
```

---

### Task 7: E2E contra Docker — un LP descubierto se ve

**Files:**
- Create: `e2e/orchestrator-unprotected-lp.spec.js`

**Interfaces:**
- Consumes: la incidencia `unprotected` de Tarea 6, renderizada por `OrchestratorCard`.
- Corre contra el stack Docker en `http://localhost:5174` con `e2e/playwright-docker.config.js`.

**Por qué E2E y no solo unit:** la regresión real no fue de lógica, fue de visibilidad — el sistema mostraba un orquestador sano mientras el dinero estaba expuesto. Ese fallo solo se ve en la página montada.

- [ ] **Step 1: Verify the Docker stack is up**

Run: `docker ps --format '{{.Names}}\t{{.Status}}' | grep testbot`
Expected: `testbot-nginx`, `testbot-server`, `testbot-frontend` y `testbot-postgres` en `Up`. Si el frontend no refleja los cambios de la Tarea 6, reconstruirlo: `docker compose up -d --build frontend`.

- [ ] **Step 2: Write the failing test**

Crear `e2e/orchestrator-unprotected-lp.spec.js`:

```js
const { test, expect } = require('@playwright/test');

const hasBackend = Boolean(process.env.E2E_API_TARGET);

async function login(page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByPlaceholder('admin').fill(process.env.E2E_USERNAME || 'admin');
  await page.getByPlaceholder('••••••••').fill(process.env.E2E_PASSWORD || 'admin123');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('button', { name: 'Backtesting' })).toBeVisible({ timeout: 10000 });
}

test.describe('Orquestador — LP sin cobertura', () => {
  test.skip(!hasBackend, 'Requiere E2E_API_TARGET');

  test('pinta el chip "Sin cobertura" cuando el LP activo no tiene proteccion vinculada', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Interceptamos la lista para forzar el estado descubierto sin depender
    // de que haya un orquestador roto de verdad en la base de datos.
    await page.route('**/api/lp-orchestrators', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const rows = Array.isArray(body?.data) ? body.data : [];
      if (rows.length > 0) {
        rows[0].activePositionIdentifier = '191720';
        rows[0].activeProtectedPoolId = null;
        rows[0].protectionConfig = { enabled: true, accountId: 8, configuredNotionalUsd: 50 };
        rows[0].strategyState = {
          ...(rows[0].strategyState || {}),
          protectionRetry: { attempts: 2, nextAttemptAt: Date.now() + 600000, lastError: 'margen insuficiente' },
        };
        rows[0].phase = 'lp_active';
        rows[0].lastError = null;
      }
      await route.fulfill({ response, json: body });
    });

    await login(page);
    await page.getByRole('button', { name: '🎛 Orquestador LP' }).click();
    await page.waitForLoadState('networkidle');

    await expect(page.getByText('Sin cobertura').first()).toBeVisible({ timeout: 10000 });

    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails against the pre-Task-6 frontend**

Si el contenedor `testbot-frontend` todavía sirve el bundle sin la Tarea 6:

Run: `E2E_API_TARGET=1 npx playwright test --config e2e/playwright-docker.config.js orchestrator-unprotected-lp`
Expected: FAIL — el chip "Sin cobertura" no aparece.

- [ ] **Step 4: Rebuild the frontend and re-run**

Run: `docker compose up -d --build frontend && E2E_API_TARGET=1 npx playwright test --config e2e/playwright-docker.config.js orchestrator-unprotected-lp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e/orchestrator-unprotected-lp.spec.js
git commit -m "test(e2e): un LP sin cobertura se muestra como incidencia en el orquestador"
```

---

### Task 8: Verificación end-to-end sobre el sistema real

**Files:** ninguno (verificación).

**Por qué es una tarea:** el objetivo del plan no es que pasen los tests, es que el orquestador #26 acabe cubierto o alertado. Eso solo se comprueba mirando el sistema en marcha.

- [ ] **Step 1: Run the full check**

Run: `npm run check`
Expected: arquitectura, hotspots, lint, tests de servidor, tests de cliente y build del cliente en verde. Si `check:hotspots` se queja de `lp-orchestrator.service.js`, anotarlo — el fichero ya rondaba el límite y este plan le suma ~70 líneas. No refactorizar dentro de este plan; abrir seguimiento aparte.

- [ ] **Step 2: Restart the server so the loop picks up the new code**

Run: `docker compose restart server`
Expected: contenedor `testbot-server` en `Up (healthy)`.

- [ ] **Step 3: Watch one evaluation cycle**

Run: `docker logs testbot-server --since 10m 2>&1 | grep -E "protection_recover|protection_recovery|lp_orchestrator_eval_completed" | tail -20`
Expected: para el orquestador #26 aparece `lp_orchestrator_protection_recovered` (cobertura creada) **o** `lp_orchestrator_protection_recovery_failed` con `attempts: 1` y un `error` concreto. Cualquiera de los dos es éxito del plan: el fallo silencioso ya no existe.

- [ ] **Step 4: Confirm the database state**

Run:
```bash
docker exec testbot-postgres psql -U testbot -d testbot -x -c \
  "SELECT id, phase, active_protected_pool_id, strategy_state_json FROM lp_orchestrators WHERE id = 26;"
```
Expected: o bien `active_protected_pool_id` con un id, o bien `strategy_state_json` conteniendo `protectionRetry` con `attempts >= 1` y `lastError`.

- [ ] **Step 5: Confirm the protection is actually hedging (only if recovered)**

Run:
```bash
docker exec testbot-postgres psql -U testbot -d testbot -c \
  "SELECT id, status, hedge_size, hedge_notional_usd, to_timestamp(updated_at/1000) FROM protected_uniswap_pools WHERE status = 'active';"
```
Expected: una fila `active` con `hedge_size > 0`. Si `hedge_size = 0` tras varios minutos, el problema está aguas abajo en `protected-pool-delta-neutral.service.js` y es un diagnóstico nuevo, fuera del alcance de este plan.

- [ ] **Step 6: Commit nothing, report findings**

Sin commit. Reportar: estado final de #26, y si la cobertura no se pudo crear, el `lastError` exacto para decidir el siguiente paso.

---

## Fuera de alcance (seguimiento aparte)

- **Tamaño de `lp-orchestrator.service.js`** — ya son ~1780 líneas y este plan le suma. Merece un split por responsabilidad (lifecycle / evaluación / reconciliación).
- **Ruido de `telegram_command_get_updates_failed`** — 20.875 warns en 48 h por un 409 (dos procesos haciendo polling del mismo bot). Ahoga los logs y dificultó este diagnóstico, pero es independiente de la cobertura.
- **`STALE_INTENT_TTL_MS is not defined`** — `uniswap_operation_worker_unhandled_error` del 2026-08-03 05:30. Bug real, sin relación con este flujo.
- **Las 19 protecciones `inactive` históricas** — no se tocan. Ninguna está viva.
