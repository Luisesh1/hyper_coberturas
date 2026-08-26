# Despliegue de hooks V4 desde el panel — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el panel pueda desplegar los hooks V4 del repositorio en las 6 redes soportadas, o adoptar sin gas el que ya esté en cadena, dejándolos verificados y disponibles en el wizard de LP.

**Architecture:** El artefacto compilado gana una salt CREATE2 precomputada por red, de modo que la dirección del hook se conoce antes de desplegar. El servidor sirve ese catálogo, lee la cadena para decir si el hook ya existe, y arma el txPlan; la wallet del usuario firma. La verificación reconstruye el runtime esperado rellenando los `immutable`, de forma que comparar hashes demuestre de verdad la identidad del código.

**Tech Stack:** Node 20 + Express + PostgreSQL, ethers v6, solc 0.8.26, React 18 + Vite + CSS Modules, node:test (server y contracts), Vitest (client), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-08-25-despliegue-hooks-design.md`

## Global Constraints

- Ninguna prueba firma, despliega ni envía transacciones a una red real.
- El contenedor del servidor no ve `contracts/`: el catálogo debe copiarse a `server/src/contracts/catalog/` y commitearse.
- Redes soportadas: `ethereum`, `arbitrum`, `base`, `base-sepolia`, `optimism`, `polygon`.
- Proxy CREATE2 determinista: `0x4e59b44847b379578588920cA78FbF26c0B4956C` (verificado presente en las 6).
- Flags de permiso de hook = 14 bits bajos de la dirección. `VolatilityShieldV1` declara sólo `beforeSwap` → flags objetivo `0x0080`.
- Mensajes de interfaz y comentarios en español, como el resto del proyecto.
- La interfaz debe explicarse sola: cada estado dice qué significa, si cuesta gas y cuál será la dirección.

## Desviación respecto del spec

El spec (§4.4) proponía un `kind: 'hook_deployment'` en `uniswap-operation.service.js` para conciliar el despliegue en segundo plano. **Se sustituye por reintentar `adopt`.** Razón: la dirección del hook es determinista y la cadena es la fuente de verdad, así que si el usuario cierra el navegador a medias no se pierde nada — vuelve a entrar y el catálogo ya dice «ya desplegado», con un botón que lo adopta sin gas. Elimina la maquinaria de *claim*/*heartbeat* y una posible migración de base de datos sin perder ninguna garantía.

---

### Task 1: Utilidades de dirección de hook (puras)

**Files:**
- Create: `contracts/scripts/hook-address.js`
- Test: `contracts/test/hook-address.test.js`

**Interfaces:**
- Produces:
  - `CREATE2_PROXY: string`
  - `HOOK_PERMISSION_BITS: Record<string, number>` — nombres tal cual aparecen en `Hooks.Permissions` de Solidity
  - `parseHookPermissions(source: string): string[]` — nombres con valor `true`
  - `flagsForPermissions(names: string[]): bigint`
  - `buildInitcode(creationBytecode: string, poolManager: string): string`
  - `predictAddress(initcodeHash: string, salt: string): string`
  - `addressFlags(address: string): bigint`
  - `mineSalt(initcodeHash: string, targetFlags: bigint, opts?: {maxAttempts?: number}): {salt: string, address: string, attempts: number}`

- [ ] **Step 1: Escribir la prueba que falla**

```js
// contracts/test/hook-address.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { keccak256 } = require('ethers');
const {
  parseHookPermissions, flagsForPermissions, buildInitcode,
  predictAddress, addressFlags, mineSalt, CREATE2_PROXY,
} = require('../scripts/hook-address');

test('parseHookPermissions devuelve sólo los permisos en true', () => {
  const source = `
    return Hooks.Permissions({
      beforeInitialize: false,
      beforeSwap: true,
      afterSwap: false,
      beforeSwapReturnDelta: false
    });`;
  assert.deepEqual(parseHookPermissions(source), ['beforeSwap']);
});

test('flagsForPermissions codifica beforeSwap en el bit 7', () => {
  assert.equal(flagsForPermissions(['beforeSwap']), 0x80n);
});

test('flagsForPermissions rechaza permisos desconocidos', () => {
  assert.throws(() => flagsForPermissions(['beforeTeleport']), /beforeTeleport/);
});

test('buildInitcode concatena el constructor codificado', () => {
  const initcode = buildInitcode('0xdead', '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408');
  assert.equal(initcode.slice(0, 6), '0xdead');
  assert.equal(initcode.length, 6 + 64);
  assert.ok(initcode.toLowerCase().endsWith('05e73354cfdd6745c338b50bcfdfa3aa6fa03408'));
});

test('mineSalt encuentra una dirección con los flags pedidos', () => {
  const initcodeHash = keccak256('0x60006000fd');
  const { salt, address, attempts } = mineSalt(initcodeHash, 0x80n);
  assert.equal(addressFlags(address), 0x80n);
  assert.equal(predictAddress(initcodeHash, salt), address);
  assert.ok(attempts >= 0);
});

test('mineSalt se rinde si agota los intentos', () => {
  assert.throws(
    () => mineSalt(keccak256('0x00'), 0x80n, { maxAttempts: 5 }),
    /No se encontró salt/
  );
});

test('CREATE2_PROXY es el proxy determinista estándar', () => {
  assert.equal(CREATE2_PROXY, '0x4e59b44847b379578588920cA78FbF26c0B4956C');
});
```

- [ ] **Step 2: Ejecutar la prueba y comprobar que falla**

Run: `npm --prefix contracts exec -- node --test test/hook-address.test.js`
Expected: FAIL — `Cannot find module '../scripts/hook-address'`

- [ ] **Step 3: Implementar**

```js
// contracts/scripts/hook-address.js
/**
 * Utilidades puras para calcular la dirección de un hook de Uniswap v4.
 *
 * En v4 los permisos del hook van codificados en los 14 bits BAJOS de su
 * dirección, así que un hook no se puede desplegar con CREATE normal: hay que
 * usar CREATE2 y buscar una salt cuya dirección resultante lleve exactamente
 * los bits de los callbacks que el contrato implementa.
 */
const { keccak256, getCreate2Address, AbiCoder, zeroPadValue, toBeHex } = require('ethers');

// Proxy de despliegue determinista (Arachnid), presente en las 6 redes que
// soporta el panel. Su calldata es `salt (32 bytes) ‖ initcode`.
const CREATE2_PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

// Nombres tal cual aparecen en `Hooks.Permissions` de v4-core. Ojo: Solidity
// usa `ReturnDelta` y el clasificador del servidor `RETURNS_DELTA`.
const HOOK_PERMISSION_BITS = Object.freeze({
  beforeInitialize: 1 << 13,
  afterInitialize: 1 << 12,
  beforeAddLiquidity: 1 << 11,
  afterAddLiquidity: 1 << 10,
  beforeRemoveLiquidity: 1 << 9,
  afterRemoveLiquidity: 1 << 8,
  beforeSwap: 1 << 7,
  afterSwap: 1 << 6,
  beforeDonate: 1 << 5,
  afterDonate: 1 << 4,
  beforeSwapReturnDelta: 1 << 3,
  afterSwapReturnDelta: 1 << 2,
  afterAddLiquidityReturnDelta: 1 << 1,
  afterRemoveLiquidityReturnDelta: 1 << 0,
});

const HOOK_FLAG_MASK = (1n << 14n) - 1n;

/**
 * Lee del código fuente los permisos declarados en `getHookPermissions()`.
 * Se parsea la fuente en vez de duplicar la lista para que no puedan
 * divergir: si alguien añade un callback al contrato y olvida el catálogo,
 * la salt deja de cuadrar y la guardia de `npm run check` lo caza.
 */
function parseHookPermissions(source) {
  const names = [];
  const pattern = /(\w+)\s*:\s*(true|false)/g;
  let match = pattern.exec(source);
  while (match) {
    if (match[2] === 'true' && match[1] in HOOK_PERMISSION_BITS) names.push(match[1]);
    match = pattern.exec(source);
  }
  return names;
}

function flagsForPermissions(names) {
  let flags = 0n;
  for (const name of names) {
    const bit = HOOK_PERMISSION_BITS[name];
    if (bit === undefined) throw new Error(`Permiso de hook desconocido: ${name}`);
    flags |= BigInt(bit);
  }
  return flags;
}

function buildInitcode(creationBytecode, poolManager) {
  const encoded = AbiCoder.defaultAbiCoder().encode(['address'], [poolManager]);
  return creationBytecode + encoded.slice(2);
}

function predictAddress(initcodeHash, salt) {
  return getCreate2Address(CREATE2_PROXY, salt, initcodeHash);
}

function addressFlags(address) {
  return BigInt(address) & HOOK_FLAG_MASK;
}

/**
 * Busca la primera salt cuya dirección CREATE2 tenga exactamente `targetFlags`.
 * Se ejecuta en build, nunca en caliente: son ~16.384 intentos de media y
 * bloquearía el event loop del servidor durante segundos.
 */
function mineSalt(initcodeHash, targetFlags, { maxAttempts = 2_000_000 } = {}) {
  for (let attempts = 0; attempts < maxAttempts; attempts += 1) {
    const salt = zeroPadValue(toBeHex(attempts), 32);
    const address = predictAddress(initcodeHash, salt);
    if (addressFlags(address) === targetFlags) return { salt, address, attempts };
  }
  throw new Error(`No se encontró salt en ${maxAttempts} intentos para los flags 0x${targetFlags.toString(16)}`);
}

module.exports = {
  CREATE2_PROXY,
  HOOK_PERMISSION_BITS,
  HOOK_FLAG_MASK,
  keccak256,
  parseHookPermissions,
  flagsForPermissions,
  buildInitcode,
  predictAddress,
  addressFlags,
  mineSalt,
};
```

- [ ] **Step 4: Ejecutar la prueba y comprobar que pasa**

Run: `npm --prefix contracts exec -- node --test test/hook-address.test.js`
Expected: PASS (6 pruebas)

- [ ] **Step 5: Commit**

```bash
git add contracts/scripts/hook-address.js contracts/test/hook-address.test.js
git commit -m "feat(contracts): calcular direcciones CREATE2 con los flags del hook"
```

---

### Task 2: El compilador emite el catálogo con salt por red

**Files:**
- Create: `contracts/scripts/pool-managers.js`
- Modify: `contracts/scripts/compile.js`
- Modify: `contracts/artifacts/VolatilityShieldV1.json` (regenerado)
- Test: `contracts/test/catalog.test.js`

**Interfaces:**
- Consumes: todo lo que produce Task 1.
- Produces: `POOL_MANAGERS: Record<string, string>` y el artefacto con esta forma:

```
{
  contractName, version, compiler, abi,
  sourceCode, sourceHash,
  creationBytecode, runtimeBytecode, runtimeBytecodeHash,
  immutableReferences: { "<astId>": [{ start, length }] },
  permissions: string[],
  hookFlags: "0x80",
  networks: {
    "<red>": { poolManager, salt, initcodeHash, predictedAddress }
  }
}
```

- [ ] **Step 1: Escribir la prueba que falla**

```js
// contracts/test/catalog.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const artifact = require('../artifacts/VolatilityShieldV1.json');
const { POOL_MANAGERS } = require('../scripts/pool-managers');
const {
  buildInitcode, predictAddress, addressFlags, flagsForPermissions, keccak256,
} = require('../scripts/hook-address');

test('el artefacto declara los permisos que implementa el contrato', () => {
  assert.deepEqual(artifact.permissions, ['beforeSwap']);
  assert.equal(artifact.hookFlags, '0x80');
});

test('el artefacto trae fuente, immutables y una entrada por red', () => {
  assert.ok(artifact.sourceCode.includes('contract VolatilityShieldV1'));
  assert.equal(artifact.sourceHash, keccak256(Buffer.from(artifact.sourceCode, 'utf8')));
  assert.ok(Object.keys(artifact.immutableReferences).length > 0);
  assert.deepEqual(Object.keys(artifact.networks).sort(), Object.keys(POOL_MANAGERS).sort());
});

test('cada red predice una dirección con los flags correctos', () => {
  const target = flagsForPermissions(artifact.permissions);
  for (const [network, entry] of Object.entries(artifact.networks)) {
    const initcode = buildInitcode(artifact.creationBytecode, entry.poolManager);
    assert.equal(entry.initcodeHash, keccak256(initcode), `initcodeHash de ${network}`);
    assert.equal(entry.predictedAddress, predictAddress(entry.initcodeHash, entry.salt), `dirección de ${network}`);
    assert.equal(addressFlags(entry.predictedAddress), target, `flags de ${network}`);
    assert.equal(entry.poolManager, POOL_MANAGERS[network], `poolManager de ${network}`);
  }
});
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

Run: `npm --prefix contracts exec -- node --test test/catalog.test.js`
Expected: FAIL — el artefacto no tiene `permissions` ni `networks`

- [ ] **Step 3: Crear el mapa de PoolManagers**

```js
// contracts/scripts/pool-managers.js
/**
 * Dirección del PoolManager de Uniswap v4 por red.
 *
 * Se declara aquí porque `contracts/` no puede importar el módulo del
 * servidor. `scripts/check-hook-catalog.mjs` comprueba que ambos mapas
 * coincidan, de modo que no puedan divergir en silencio.
 */
const POOL_MANAGERS = Object.freeze({
  ethereum: '0x000000000004444c5dc75cB358380D2e3dE08A90',
  arbitrum: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
  base: '0x498581ff718922c3f8e6a244956af099b2652b2b',
  'base-sepolia': '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408',
  optimism: '0x9a13f98cb987694c9f086b1f5eb990eea8264ec3',
  polygon: '0x67366782805870060151383f4bbff9dab53e5cd6',
});

module.exports = { POOL_MANAGERS };
```

- [ ] **Step 4: Ampliar el compilador**

En `contracts/scripts/compile.js`, añadir `evm.deployedBytecode.immutableReferences` al `outputSelection`, y sustituir la construcción del artefacto por la versión con catálogo:

```js
// outputSelection pasa a ser:
outputSelection: {
  '*': {
    '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'],
  },
},
```

```js
// tras `const compiled = ...`, sustituir el bloque `const artifact = {...}`:
const { POOL_MANAGERS } = require('./pool-managers');
const {
  parseHookPermissions, flagsForPermissions, buildInitcode, mineSalt,
} = require('./hook-address');

const CONTRACT_VERSION = '1.0.0'; // Súbela a mano si cambia el código: las versiones del registro son inmutables.

const source = fs.readFileSync(sourcePath, 'utf8');
const creationBytecode = `0x${compiled.evm.bytecode.object}`;
const runtimeBytecode = `0x${compiled.evm.deployedBytecode.object}`;
const permissions = parseHookPermissions(source);
const hookFlags = flagsForPermissions(permissions);

const networks = {};
for (const [network, poolManager] of Object.entries(POOL_MANAGERS)) {
  const initcodeHash = keccak256(buildInitcode(creationBytecode, poolManager));
  const { salt, address, attempts } = mineSalt(initcodeHash, hookFlags);
  networks[network] = { poolManager, salt, initcodeHash, predictedAddress: address };
  console.log(`  ${network}: ${address} (salt minada en ${attempts} intentos)`);
}

const artifact = {
  contractName: 'VolatilityShieldV1',
  version: CONTRACT_VERSION,
  compiler: `solc ${solc.version()}`,
  abi: compiled.abi,
  sourceCode: source,
  sourceHash: keccak256(Buffer.from(source, 'utf8')),
  creationBytecode,
  runtimeBytecode,
  runtimeBytecodeHash: keccak256(runtimeBytecode),
  immutableReferences: compiled.evm.deployedBytecode.immutableReferences || {},
  permissions,
  hookFlags: `0x${hookFlags.toString(16)}`,
  networks,
};
```

- [ ] **Step 5: Regenerar el artefacto y ejecutar las pruebas**

Run: `npm --prefix contracts run compile && npm --prefix contracts exec -- node --test test/catalog.test.js`
Expected: el compilador imprime una dirección por red y las 3 pruebas pasan

- [ ] **Step 6: Comprobar que no se rompió nada de contratos**

Run: `npm --prefix contracts test`
Expected: PASS (las pruebas existentes siguen verdes)

- [ ] **Step 7: Commit**

```bash
git add contracts/scripts/ contracts/artifacts/ contracts/test/catalog.test.js
git commit -m "feat(contracts): emitir catálogo con salt CREATE2 por red"
```

---

### Task 3: Sincronización del catálogo al servidor y guardia en CI

**Files:**
- Create: `scripts/sync-hook-catalog.mjs`
- Create: `scripts/check-hook-catalog.mjs`
- Create: `server/src/contracts/catalog/VolatilityShieldV1.json` (copia generada)
- Create: `server/src/contracts/catalog/index.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: el artefacto de Task 2.
- Produces: `listCatalog(): Array<Artifact>` y `getCatalogEntry(name: string): Artifact | null` desde `server/src/contracts/catalog/index.js`.

- [ ] **Step 1: Escribir el sincronizador**

```js
// scripts/sync-hook-catalog.mjs
/**
 * Copia los artefactos compilados de `contracts/` al servidor.
 *
 * Hace falta porque el contenedor del servidor sólo monta `./server:/app`:
 * desde ahí no existe ninguna ruta relativa que llegue a `contracts/`.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'contracts', 'artifacts');
const to = join(root, 'server', 'src', 'contracts', 'catalog');

mkdirSync(to, { recursive: true });
const files = readdirSync(from).filter((name) => name.endsWith('.json'));
for (const name of files) {
  writeFileSync(join(to, name), readFileSync(join(from, name)));
  console.log(`sincronizado ${name}`);
}
if (files.length === 0) throw new Error('No hay artefactos que sincronizar: ejecuta antes `npm --prefix contracts run compile`.');
```

```js
// scripts/check-hook-catalog.mjs
/**
 * Guardia de coherencia del catálogo de hooks. Falla si:
 *  1. el catálogo del servidor difiere del artefacto de `contracts/`;
 *  2. las direcciones de PoolManager difieren de las de `networks.js`.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'contracts', 'artifacts');
const to = join(root, 'server', 'src', 'contracts', 'catalog');

const problems = [];
const files = readdirSync(from).filter((name) => name.endsWith('.json'));

for (const name of files) {
  const target = join(to, name);
  if (!existsSync(target)) {
    problems.push(`${name}: falta en server/src/contracts/catalog — ejecuta \`npm run sync:artifacts\``);
    continue;
  }
  if (readFileSync(join(from, name), 'utf8') !== readFileSync(target, 'utf8')) {
    problems.push(`${name}: el catálogo del servidor está desincronizado — ejecuta \`npm run sync:artifacts\``);
  }
}

const { POOL_MANAGERS } = require(join(root, 'contracts', 'scripts', 'pool-managers.js'));
const { getNetworkConfig } = require(join(root, 'server', 'src', 'services', 'uniswap', 'networks.js'));
for (const [network, address] of Object.entries(POOL_MANAGERS)) {
  const configured = getNetworkConfig(network)?.deployments?.v4?.eventSource;
  if (String(configured).toLowerCase() !== String(address).toLowerCase()) {
    problems.push(`${network}: pool-managers.js dice ${address} y networks.js dice ${configured}`);
  }
}

if (problems.length > 0) {
  console.error(`Catálogo de hooks incoherente:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`Catálogo de hooks coherente (${files.length} artefacto/s).`);
```

- [ ] **Step 2: Escribir el cargador del catálogo en el servidor**

```js
// server/src/contracts/catalog/index.js
/**
 * Catálogo de contratos desplegables desde el panel.
 *
 * Los `.json` de esta carpeta son copias generadas de `contracts/artifacts/`
 * (ver `npm run sync:artifacts`). No se editan a mano: `npm run check` falla
 * si dejan de coincidir con el artefacto original.
 */
const fs = require('node:fs');
const path = require('node:path');

function loadCatalog() {
  return fs.readdirSync(__dirname)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8')));
}

const CATALOG = loadCatalog();

function listCatalog() {
  return CATALOG;
}

function getCatalogEntry(name) {
  return CATALOG.find((entry) => entry.contractName === name) || null;
}

module.exports = { listCatalog, getCatalogEntry };
```

- [ ] **Step 3: Cablear los scripts en `package.json`**

En `scripts`, añadir:

```json
"sync:artifacts": "node scripts/sync-hook-catalog.mjs",
"check:catalog": "node scripts/check-hook-catalog.mjs",
```

y añadir `npm run check:catalog` a la cadena de `check`, justo después de `check:hotspots`.

- [ ] **Step 4: Sincronizar y verificar la guardia**

Run: `npm run sync:artifacts && npm run check:catalog`
Expected: «sincronizado VolatilityShieldV1.json» y «Catálogo de hooks coherente (1 artefacto/s).»

- [ ] **Step 5: Comprobar que la guardia detecta la desincronización**

Run: `printf '{}' >> server/src/contracts/catalog/VolatilityShieldV1.json; npm run check:catalog; echo "salida=$?"; npm run sync:artifacts`
Expected: falla con «el catálogo del servidor está desincronizado» y salida distinta de 0; luego se resincroniza

- [ ] **Step 6: Commit**

```bash
git add scripts/ server/src/contracts/ package.json
git commit -m "feat(contracts): sincronizar el catálogo de hooks al servidor"
```

---

### Task 4: Lógica pura del catálogo en el servidor

**Files:**
- Create: `server/src/services/hook-catalog.service.js`
- Test: `server/test/hook-catalog.test.js`

**Interfaces:**
- Consumes: `getCatalogEntry`, `listCatalog` (Task 3); `CREATE2_PROXY` se redeclara aquí para no cruzar la frontera `contracts/` → `server/`.
- Produces:
  - `expectedRuntimeBytecode(entry, network): string`
  - `expectedRuntimeHash(entry, network): string`
  - `buildDeploymentCalldata(entry, network): string`
  - `classifyOnchainCode(entry, network, code): 'deployed' | 'address_taken' | 'deployable'`
  - `CREATE2_PROXY: string`

- [ ] **Step 1: Escribir la prueba que falla**

```js
// server/test/hook-catalog.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { keccak256 } = require('ethers');
const {
  expectedRuntimeBytecode, expectedRuntimeHash, buildDeploymentCalldata,
  classifyOnchainCode, CREATE2_PROXY,
} = require('../src/services/hook-catalog.service');

// Runtime de juguete: 4 bytes de relleno + un hueco de 32 bytes a ceros.
const ENTRY = {
  contractName: 'Toy',
  creationBytecode: '0xaabb',
  runtimeBytecode: `0x${'11'.repeat(4)}${'00'.repeat(32)}`,
  immutableReferences: { '7': [{ start: 4, length: 32 }] },
  networks: {
    'base-sepolia': {
      poolManager: '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408',
      salt: `0x${'00'.repeat(31)}2a`,
      initcodeHash: keccak256('0x00'),
      predictedAddress: '0x0bbA77640ac3570bf1c3D221c81b0f067C39c080',
    },
  },
};

test('expectedRuntimeBytecode rellena el hueco del immutable con el PoolManager', () => {
  const runtime = expectedRuntimeBytecode(ENTRY, 'base-sepolia');
  assert.equal(runtime.slice(0, 10), '0x11111111');
  assert.ok(runtime.toLowerCase().endsWith('05e73354cfdd6745c338b50bcfdfa3aa6fa03408'));
  assert.equal(runtime.length, ENTRY.runtimeBytecode.length);
  assert.equal(expectedRuntimeHash(ENTRY, 'base-sepolia'), keccak256(runtime));
});

test('expectedRuntimeBytecode falla en una red que el catálogo no cubre', () => {
  assert.throws(() => expectedRuntimeBytecode(ENTRY, 'solana'), /solana/);
});

test('expectedRuntimeBytecode rechaza immutables que no sean de 32 bytes', () => {
  const roto = { ...ENTRY, immutableReferences: { '7': [{ start: 4, length: 20 }] } };
  assert.throws(() => expectedRuntimeBytecode(roto, 'base-sepolia'), /32 bytes/);
});

test('buildDeploymentCalldata concatena salt e initcode', () => {
  const data = buildDeploymentCalldata(ENTRY, 'base-sepolia');
  assert.ok(data.startsWith(ENTRY.networks['base-sepolia'].salt));
  assert.ok(data.toLowerCase().includes('05e73354cfdd6745c338b50bcfdfa3aa6fa03408'));
  assert.ok(data.toLowerCase().includes('aabb'));
});

test('classifyOnchainCode distingue los tres estados', () => {
  const bueno = expectedRuntimeBytecode(ENTRY, 'base-sepolia');
  assert.equal(classifyOnchainCode(ENTRY, 'base-sepolia', bueno), 'deployed');
  assert.equal(classifyOnchainCode(ENTRY, 'base-sepolia', '0x'), 'deployable');
  assert.equal(classifyOnchainCode(ENTRY, 'base-sepolia', null), 'deployable');
  assert.equal(classifyOnchainCode(ENTRY, 'base-sepolia', '0xdeadbeef'), 'address_taken');
});

test('CREATE2_PROXY es el proxy determinista estándar', () => {
  assert.equal(CREATE2_PROXY, '0x4e59b44847b379578588920cA78FbF26c0B4956C');
});
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

Run: `npm --prefix server exec -- node --test test/hook-catalog.test.js`
Expected: FAIL — no existe `hook-catalog.service`

- [ ] **Step 3: Implementar**

```js
// server/src/services/hook-catalog.service.js
/**
 * Reglas puras sobre el catálogo de hooks desplegables.
 *
 * Dos cosas que sólo se pueden hacer con el catálogo delante:
 *
 * 1. Reconstruir el bytecode runtime ESPERADO. `poolManager` es `immutable`
 *    en `BaseHook`, y Solidity graba los immutables dentro del runtime al
 *    desplegar, así que el runtime que emite solc (con ceros en esos huecos)
 *    nunca coincide con el que devuelve el RPC. Sin este relleno, comparar
 *    hashes no demuestra nada.
 * 2. Armar la calldata del proxy CREATE2: `salt ‖ initcode`.
 */
const { ethers } = require('ethers');
const { getCatalogEntry, listCatalog } = require('../contracts/catalog');

const CREATE2_PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

function networkEntry(entry, network) {
  const found = entry?.networks?.[network];
  if (!found) throw new Error(`El catálogo no cubre la red ${network} para ${entry?.contractName}`);
  return found;
}

function expectedRuntimeBytecode(entry, network) {
  const { poolManager } = networkEntry(entry, network);
  const bytes = Buffer.from(entry.runtimeBytecode.slice(2), 'hex');
  const word = Buffer.from(ethers.zeroPadValue(poolManager, 32).slice(2), 'hex');
  const groups = Object.values(entry.immutableReferences || {});
  if (groups.length !== 1) {
    throw new Error(`Se esperaba exactamente un immutable (poolManager) y hay ${groups.length}`);
  }
  for (const { start, length } of groups[0]) {
    if (length !== 32) throw new Error(`Los immutables deben ocupar 32 bytes y este ocupa ${length}`);
    word.copy(bytes, start);
  }
  return `0x${bytes.toString('hex')}`;
}

function expectedRuntimeHash(entry, network) {
  return ethers.keccak256(expectedRuntimeBytecode(entry, network));
}

function buildDeploymentCalldata(entry, network) {
  const { poolManager, salt } = networkEntry(entry, network);
  const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(['address'], [poolManager]);
  return `${salt}${entry.creationBytecode.slice(2)}${constructorArgs.slice(2)}`;
}

function classifyOnchainCode(entry, network, code) {
  if (!code || code === '0x') return 'deployable';
  return ethers.keccak256(code) === expectedRuntimeHash(entry, network) ? 'deployed' : 'address_taken';
}

module.exports = {
  CREATE2_PROXY,
  getCatalogEntry,
  listCatalog,
  networkEntry,
  expectedRuntimeBytecode,
  expectedRuntimeHash,
  buildDeploymentCalldata,
  classifyOnchainCode,
};
```

- [ ] **Step 4: Ejecutar y comprobar que pasa**

Run: `npm --prefix server exec -- node --test test/hook-catalog.test.js`
Expected: PASS (6 pruebas)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/hook-catalog.service.js server/test/hook-catalog.test.js
git commit -m "feat(server): reconstruir el runtime esperado del hook con sus immutables"
```

---

### Task 5: Flujo de despliegue y adopción en el servidor

**Files:**
- Create: `server/src/services/hook-deployment.workflow.service.js`
- Test: `server/test/hook-deployment-workflow.test.js`

**Interfaces:**
- Consumes: Task 4; `repository` de `smart-contract-registry.repository`; `SmartContractRegistryService.verifyVersion` y `hookSafetyFor` de `smart-contract-registry.workflow.service`; `getNetworkConfig` de `services/uniswap/networks`.
- Produces la clase `HookDeploymentService` con:
  - `describeCatalog({ network }): Promise<Array<{contractName, version, network, status, predictedAddress, permissions, isMainnet, reason?}>>`
  - `buildDeploymentPlan({ name, network }): Promise<{tx, predictedAddress, chainId, isMainnet, contractName, version}>`
  - `adopt({ userId, name, network, txHash }): Promise<{versionId, address, status}>`

- [ ] **Step 1: Escribir la prueba que falla**

```js
// server/test/hook-deployment-workflow.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { HookDeploymentService } = require('../src/services/hook-deployment.workflow.service');
const { expectedRuntimeBytecode, getCatalogEntry } = require('../src/services/hook-catalog.service');

const ENTRY = getCatalogEntry('VolatilityShieldV1');
const NETWORK = 'base-sepolia';

function serviceWith({ code = '0x', repository = {}, verifyVersion = async () => ({}) } = {}) {
  return new HookDeploymentService({
    providerForNetwork: async () => ({ getCode: async () => code }),
    repository: {
      createContract: async () => 1,
      createVersion: async () => 2,
      recordDeployment: async () => 3,
      listContracts: async () => [],
      ...repository,
    },
    registryService: { verifyVersion },
  });
}

test('describeCatalog marca desplegable cuando la dirección está vacía', async () => {
  const data = await serviceWith({ code: '0x' }).describeCatalog({ network: NETWORK });
  assert.equal(data.length, 1);
  assert.equal(data[0].contractName, 'VolatilityShieldV1');
  assert.equal(data[0].status, 'deployable');
  assert.equal(data[0].predictedAddress, ENTRY.networks[NETWORK].predictedAddress);
  assert.equal(data[0].isMainnet, false);
});

test('describeCatalog marca desplegado cuando el código coincide', async () => {
  const code = expectedRuntimeBytecode(ENTRY, NETWORK);
  const data = await serviceWith({ code }).describeCatalog({ network: NETWORK });
  assert.equal(data[0].status, 'deployed');
});

test('describeCatalog marca dirección ocupada cuando el código no coincide', async () => {
  const data = await serviceWith({ code: '0xdeadbeef' }).describeCatalog({ network: NETWORK });
  assert.equal(data[0].status, 'address_taken');
});

test('describeCatalog señala las redes de dinero real', async () => {
  const data = await serviceWith({ code: '0x' }).describeCatalog({ network: 'base' });
  assert.equal(data[0].isMainnet, true);
});

test('buildDeploymentPlan devuelve una tx hacia el proxy CREATE2', async () => {
  const plan = await serviceWith({ code: '0x' }).buildDeploymentPlan({ name: 'VolatilityShieldV1', network: NETWORK });
  assert.equal(plan.tx.to, '0x4e59b44847b379578588920cA78FbF26c0B4956C');
  assert.equal(plan.tx.value, '0x0');
  assert.equal(plan.tx.kind, 'hook_deployment');
  assert.ok(plan.tx.data.startsWith(ENTRY.networks[NETWORK].salt));
  assert.equal(plan.predictedAddress, ENTRY.networks[NETWORK].predictedAddress);
  assert.equal(plan.isMainnet, false);
});

test('buildDeploymentPlan se niega si la dirección ya tiene el hook', async () => {
  const code = expectedRuntimeBytecode(ENTRY, NETWORK);
  await assert.rejects(
    () => serviceWith({ code }).buildDeploymentPlan({ name: 'VolatilityShieldV1', network: NETWORK }),
    /ya está desplegado/
  );
});

test('buildDeploymentPlan se niega si la dirección está ocupada por otro código', async () => {
  await assert.rejects(
    () => serviceWith({ code: '0xdeadbeef' }).buildDeploymentPlan({ name: 'VolatilityShieldV1', network: NETWORK }),
    /ocupada/
  );
});

test('buildDeploymentPlan rechaza un contrato que no está en el catálogo', async () => {
  await assert.rejects(
    () => serviceWith().buildDeploymentPlan({ name: 'Inventado', network: NETWORK }),
    /no está en el catálogo/
  );
});

test('adopt registra y verifica cuando el código en cadena es el esperado', async () => {
  const calls = [];
  const code = expectedRuntimeBytecode(ENTRY, NETWORK);
  const service = serviceWith({
    code,
    repository: {
      createContract: async (args) => { calls.push(['contract', args.name]); return 11; },
      createVersion: async (args) => { calls.push(['version', args.artifactBytecodeHash]); return 22; },
      recordDeployment: async (args) => { calls.push(['deployment', args.address]); return 33; },
    },
    verifyVersion: async (args) => { calls.push(['verify', args.versionId]); return { status: 'verified' }; },
  });

  const result = await service.adopt({ userId: 5, name: 'VolatilityShieldV1', network: NETWORK, txHash: null });

  assert.equal(result.versionId, 22);
  assert.equal(result.address, ENTRY.networks[NETWORK].predictedAddress);
  assert.deepEqual(calls[0], ['contract', 'VolatilityShieldV1']);
  assert.equal(calls[1][0], 'version');
  assert.equal(calls[1][1], ethers.keccak256(code)); // hash calculado por el servidor, no tecleado
  assert.deepEqual(calls[2], ['deployment', ENTRY.networks[NETWORK].predictedAddress]);
  assert.deepEqual(calls[3], ['verify', 22]);
});

test('adopt se niega si en la dirección no hay nada', async () => {
  await assert.rejects(
    () => serviceWith({ code: '0x' }).adopt({ userId: 5, name: 'VolatilityShieldV1', network: NETWORK }),
    /no hay ningún contrato/
  );
});

test('adopt es idempotente: si ya está registrado no duplica', async () => {
  const code = expectedRuntimeBytecode(ENTRY, NETWORK);
  let created = 0;
  const service = serviceWith({
    code,
    repository: {
      createContract: async () => { created += 1; return 1; },
      listContracts: async () => ([{
        id: 99, name: 'VolatilityShieldV1', version: ENTRY.version, status: 'verified',
        deployment: { network: NETWORK, address: ENTRY.networks[NETWORK].predictedAddress },
      }]),
    },
  });

  const result = await service.adopt({ userId: 5, name: 'VolatilityShieldV1', network: NETWORK });
  assert.equal(result.versionId, 99);
  assert.equal(result.status, 'already_registered');
  assert.equal(created, 0);
});
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

Run: `npm --prefix server exec -- node --test test/hook-deployment-workflow.test.js`
Expected: FAIL — no existe `hook-deployment.workflow.service`

- [ ] **Step 3: Implementar**

```js
// server/src/services/hook-deployment.workflow.service.js
/**
 * Despliegue y adopción de los hooks del catálogo del proyecto.
 *
 * Dos caminos, y el barato es el habitual:
 *
 *  - ADOPTAR (sin gas): un hook V4 no tiene dueño y su estado va por `poolId`,
 *    así que un único despliegue por red sirve para todos los usuarios y todos
 *    los LPs. Si en la dirección predicha ya está el bytecode esperado, basta
 *    con registrarlo y verificarlo.
 *  - DESPLEGAR (con gas): sólo la primera vez en cada red. El servidor arma la
 *    calldata del proxy CREATE2 y la wallet del usuario firma.
 *
 * No hay conciliación en segundo plano a propósito: la dirección es
 * determinista y la cadena es la fuente de verdad, así que si el usuario cierra
 * el navegador a mitad de camino sólo tiene que volver y pulsar «adoptar».
 */
const { ethers } = require('ethers');
const { ValidationError, NotFoundError } = require('../errors/app-error');
const { getNetworkConfig } = require('./uniswap/networks');
const onChainManager = require('./onchain-manager.service');
const repositoryDefault = require('../repositories/smart-contract-registry.repository');
const {
  SmartContractRegistryService, hookSafetyFor,
} = require('./smart-contract-registry.workflow.service');
const { DYNAMIC_FEE_HOOK } = require('./smart-contract-registry.service');
const {
  CREATE2_PROXY, listCatalog, getCatalogEntry, networkEntry,
  expectedRuntimeHash, buildDeploymentCalldata, classifyOnchainCode,
} = require('./hook-catalog.service');

const TESTNETS = new Set(['base-sepolia']);

function defaultProviderForNetwork(network) {
  return onChainManager.getProvider(getNetworkConfig(network), { scope: 'hook-deployment' });
}

class HookDeploymentService {
  constructor({
    repository = repositoryDefault,
    providerForNetwork = defaultProviderForNetwork,
    registryService = new SmartContractRegistryService(),
  } = {}) {
    this.repository = repository;
    this.providerForNetwork = providerForNetwork;
    this.registryService = registryService;
  }

  async _statusOf(entry, network) {
    const provider = await this.providerForNetwork(network);
    const { predictedAddress } = networkEntry(entry, network);
    const code = await provider.getCode(predictedAddress);
    return { status: classifyOnchainCode(entry, network, code), code, predictedAddress };
  }

  async describeCatalog({ network }) {
    const isMainnet = !TESTNETS.has(network);
    const entries = listCatalog().filter((entry) => Boolean(entry.networks?.[network]));
    return Promise.all(entries.map(async (entry) => {
      const base = {
        contractName: entry.contractName,
        version: entry.version,
        permissions: entry.permissions,
        network,
        isMainnet,
        predictedAddress: entry.networks[network].predictedAddress,
      };
      try {
        const { status } = await this._statusOf(entry, network);
        return { ...base, status };
      } catch (error) {
        return { ...base, status: 'unknown', reason: error.message };
      }
    }));
  }

  _entryOrThrow(name, network) {
    const entry = getCatalogEntry(name);
    if (!entry) throw new NotFoundError(`El contrato ${name} no está en el catálogo del proyecto`);
    if (!entry.networks?.[network]) throw new ValidationError(`El catálogo no cubre la red ${network}`);
    return entry;
  }

  async buildDeploymentPlan({ name, network }) {
    const entry = this._entryOrThrow(name, network);
    const config = getNetworkConfig(network);
    if (!config?.deployments?.v4) throw new ValidationError(`La red ${network} no tiene PoolManager de Uniswap v4`);

    const provider = await this.providerForNetwork(network);
    const proxyCode = await provider.getCode(CREATE2_PROXY);
    if (!proxyCode || proxyCode === '0x') {
      throw new ValidationError(`La red ${network} no tiene el proxy CREATE2 determinista, así que no se puede fijar la dirección del hook`);
    }

    const { status, predictedAddress } = await this._statusOf(entry, network);
    if (status === 'deployed') {
      throw new ValidationError(`${name} ya está desplegado en ${network} (${predictedAddress}): regístralo sin gas en lugar de desplegarlo`);
    }
    if (status === 'address_taken') {
      throw new ValidationError(`La dirección ${predictedAddress} está ocupada por otro código en ${network}. No se sobrescribe nada`);
    }

    return {
      contractName: entry.contractName,
      version: entry.version,
      network,
      chainId: config.chainId,
      isMainnet: !TESTNETS.has(network),
      predictedAddress,
      tx: {
        to: CREATE2_PROXY,
        data: buildDeploymentCalldata(entry, network),
        value: '0x0',
        chainId: config.chainId,
        kind: 'hook_deployment',
        label: `Desplegar ${entry.contractName} ${entry.version}`,
      },
    };
  }

  async _findRegistered({ userId, entry, network }) {
    const contracts = await this.repository.listContracts(userId);
    return (contracts || []).find((item) => (
      item.name === entry.contractName
      && item.version === entry.version
      && item.deployment?.network === network
      && String(item.deployment?.address || '').toLowerCase() === String(entry.networks[network].predictedAddress).toLowerCase()
    )) || null;
  }

  async adopt({ userId, name, network, txHash = null }) {
    const entry = this._entryOrThrow(name, network);
    const { status, code, predictedAddress } = await this._statusOf(entry, network);

    if (status === 'deployable') {
      throw new ValidationError(`En ${predictedAddress} no hay ningún contrato desplegado todavía`);
    }
    if (status === 'address_taken') {
      throw new ValidationError(`El código en ${predictedAddress} no es el de ${name}: no se registra`);
    }

    const existing = await this._findRegistered({ userId, entry, network });
    if (existing) {
      return { versionId: existing.id, address: predictedAddress, status: 'already_registered' };
    }

    const artifactBytecodeHash = expectedRuntimeHash(entry, network);
    const contractId = await this.repository.createContract({
      userId,
      name: entry.contractName,
      contractType: DYNAMIC_FEE_HOOK,
      description: `Hook V4 de tarifa dinámica del proyecto, compilado con ${entry.compiler}`,
    });
    const versionId = await this.repository.createVersion({
      userId,
      contractId,
      version: entry.version,
      sourceCode: entry.sourceCode,
      sourceHash: entry.sourceHash,
      compilerVersion: entry.compiler,
      abiJson: entry.abi,
      artifactBytecodeHash,
    });
    await this.repository.recordDeployment({
      userId,
      contractVersionId: versionId,
      network,
      address: predictedAddress,
      txHash: txHash || null,
      artifactBytecodeHash,
      onchainBytecodeHash: ethers.keccak256(code),
      hookSafety: hookSafetyFor(predictedAddress),
    });
    await this.registryService.verifyVersion({ userId, versionId, network });

    return { versionId, address: predictedAddress, status: 'registered' };
  }
}

module.exports = { HookDeploymentService, TESTNETS };
```

- [ ] **Step 4: Ejecutar y comprobar que pasa**

Run: `npm --prefix server exec -- node --test test/hook-deployment-workflow.test.js`
Expected: PASS (11 pruebas)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/hook-deployment.workflow.service.js server/test/hook-deployment-workflow.test.js
git commit -m "feat(server): desplegar y adoptar hooks del catálogo"
```

---

### Task 6: Rutas HTTP del catálogo

**Files:**
- Modify: `server/src/routes/smart-contracts.routes.js`
- Modify: `server/src/schemas/smart-contract-registry.schema.js`
- Test: `server/test/hook-catalog-routes.test.js`

**Interfaces:**
- Consumes: `HookDeploymentService` (Task 5).
- Produces: `GET /api/smart-contracts/catalog?network=…`, `POST /api/smart-contracts/catalog/:name/plan`, `POST /api/smart-contracts/catalog/:name/adopt`.

- [ ] **Step 1: Escribir la prueba que falla**

```js
// server/test/hook-catalog-routes.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogNetworkSchema, adoptSchema } = require('../src/schemas/smart-contract-registry.schema');

test('catalogNetworkSchema exige una red soportada', () => {
  assert.equal(catalogNetworkSchema.safeParse({ network: 'base-sepolia' }).success, true);
  assert.equal(catalogNetworkSchema.safeParse({ network: 'solana' }).success, false);
  assert.equal(catalogNetworkSchema.safeParse({}).success, false);
});

test('adoptSchema acepta txHash opcional y valida su forma', () => {
  assert.equal(adoptSchema.safeParse({ network: 'base' }).success, true);
  assert.equal(adoptSchema.safeParse({ network: 'base', txHash: `0x${'a'.repeat(64)}` }).success, true);
  assert.equal(adoptSchema.safeParse({ network: 'base', txHash: 'no-es-un-hash' }).success, false);
});
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

Run: `npm --prefix server exec -- node --test test/hook-catalog-routes.test.js`
Expected: FAIL — `catalogNetworkSchema` no está exportado

- [ ] **Step 3: Añadir los esquemas**

Al final de `server/src/schemas/smart-contract-registry.schema.js`, antes de `module.exports`:

```js
const SUPPORTED_CATALOG_NETWORKS = ['ethereum', 'arbitrum', 'base', 'base-sepolia', 'optimism', 'polygon'];

const catalogNetworkSchema = z.object({
  network: z.enum(SUPPORTED_CATALOG_NETWORKS),
});

const adoptSchema = z.object({
  network: z.enum(SUPPORTED_CATALOG_NETWORKS),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'txHash inválido').optional(),
});
```

y añadirlos a `module.exports` junto a `SUPPORTED_CATALOG_NETWORKS`.

- [ ] **Step 4: Añadir las rutas**

En `server/src/routes/smart-contracts.routes.js`, importar el servicio y los esquemas, y añadir las rutas **antes** de `router.get('/', …)` para que `/catalog` no se coma la ruta genérica:

```js
const { HookDeploymentService } = require('../services/hook-deployment.workflow.service');
// y en el destructuring de esquemas: catalogNetworkSchema, adoptSchema

router.get('/catalog', asyncHandler(async (req, res) => {
  const parsed = catalogNetworkSchema.safeParse({ network: String(req.query.network || '').trim() });
  if (!parsed.success) return res.status(400).json({ success: false, error: 'network no soportada' });
  const data = await new HookDeploymentService().describeCatalog({ network: parsed.data.network });
  res.json({ success: true, data });
}));

router.post('/catalog/:name/plan', validate(catalogNetworkSchema), asyncHandler(async (req, res) => {
  const data = await new HookDeploymentService().buildDeploymentPlan({
    name: req.params.name,
    network: req.body.network,
  });
  res.json({ success: true, data });
}));

router.post('/catalog/:name/adopt', validate(adoptSchema), asyncHandler(async (req, res) => {
  const data = await new HookDeploymentService().adopt({
    userId: req.user.userId,
    name: req.params.name,
    network: req.body.network,
    txHash: req.body.txHash || null,
  });
  res.json({ success: true, data });
}));
```

- [ ] **Step 5: Ejecutar las pruebas del servidor**

Run: `npm --prefix server exec -- node --test test/hook-catalog-routes.test.js && npm --prefix server run test`
Expected: PASS, sin regresiones

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/smart-contracts.routes.js server/src/schemas/smart-contract-registry.schema.js server/test/hook-catalog-routes.test.js
git commit -m "feat(server): exponer el catálogo de hooks por HTTP"
```

---

### Task 7: Cliente API

**Files:**
- Modify: `client/src/services/api.js:339-350`

**Interfaces:**
- Produces, en `smartContractRegistryApi`:
  - `listCatalog(network)`
  - `planDeployment(name, network)`
  - `adoptDeployment(name, network, txHash)`

- [ ] **Step 1: Añadir los métodos**

```js
  listCatalog: (network) => request(
    'GET',
    `/smart-contracts/catalog?network=${encodeURIComponent(network)}`
  ),
  planDeployment: (name, network) => request('POST', `/smart-contracts/catalog/${encodeURIComponent(name)}/plan`, { network }),
  adoptDeployment: (name, network, txHash) => request(
    'POST',
    `/smart-contracts/catalog/${encodeURIComponent(name)}/adopt`,
    txHash ? { network, txHash } : { network }
  ),
```

- [ ] **Step 2: Commit**

```bash
git add client/src/services/api.js
git commit -m "feat(client): consumir el catálogo de hooks"
```

---

### Task 8: Panel «Contratos del proyecto» que se explica solo

**Files:**
- Create: `client/src/pages/SmartContracts/components/ProjectContractsPanel.jsx`
- Create: `client/src/pages/SmartContracts/components/ProjectContractsPanel.module.css`
- Test: `client/src/pages/SmartContracts/components/ProjectContractsPanel.test.jsx`

**Interfaces:**
- Consumes: `smartContractRegistryApi` (Task 7); `useWalletConnection()` que expone `{ isConnected, chainId, switchChain, sendTransaction, waitForTransactionReceipt }`.
- Produces: `<ProjectContractsPanel onAdopted={() => {}} />`

**Requisito de interfaz:** cada estado debe decir por sí solo qué significa, si cuesta gas y qué dirección tendrá el contrato. Nada de jerga sin explicar: la primera vez que aparece «hook» o «dirección predicha», el panel lo explica en una línea.

- [ ] **Step 1: Escribir la prueba que falla**

```jsx
// client/src/pages/SmartContracts/components/ProjectContractsPanel.test.jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ProjectContractsPanel from './ProjectContractsPanel';

const listCatalog = vi.fn();
const adoptDeployment = vi.fn();
const planDeployment = vi.fn();

vi.mock('../../../services/api', () => ({
  smartContractRegistryApi: {
    listCatalog: (...args) => listCatalog(...args),
    adoptDeployment: (...args) => adoptDeployment(...args),
    planDeployment: (...args) => planDeployment(...args),
  },
}));

const wallet = {
  isConnected: true,
  chainId: 84532,
  switchChain: vi.fn(),
  sendTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
};
vi.mock('../../../hooks/useWalletConnection', () => ({
  useWalletConnection: () => wallet,
}));

const ENTRY = {
  contractName: 'VolatilityShieldV1',
  version: '1.0.0',
  network: 'base-sepolia',
  permissions: ['beforeSwap'],
  isMainnet: false,
  predictedAddress: '0x0bbA77640ac3570bf1c3D221c81b0f067C39c080',
};

beforeEach(() => {
  vi.clearAllMocks();
  listCatalog.mockResolvedValue([{ ...ENTRY, status: 'deployable' }]);
  adoptDeployment.mockResolvedValue({ versionId: 1, address: ENTRY.predictedAddress, status: 'registered' });
});

describe('ProjectContractsPanel', () => {
  it('explica el estado desplegable y ofrece firmar', async () => {
    render(<ProjectContractsPanel />);
    expect(await screen.findByText(/Aún no está en esta red/i)).toBeInTheDocument();
    expect(screen.getByText(/cuesta gas/i)).toBeInTheDocument();
    expect(screen.getByText(ENTRY.predictedAddress)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Desplegar y firmar/i })).toBeInTheDocument();
  });

  it('cuando ya está en cadena ofrece registrarlo sin gas y no ofrece firmar', async () => {
    listCatalog.mockResolvedValue([{ ...ENTRY, status: 'deployed' }]);
    render(<ProjectContractsPanel />);
    expect(await screen.findByText(/Ya está en esta red/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sin gastar gas/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Desplegar y firmar/i })).not.toBeInTheDocument();
  });

  it('adopta sin gas y avisa al padre', async () => {
    listCatalog.mockResolvedValue([{ ...ENTRY, status: 'deployed' }]);
    const onAdopted = vi.fn();
    render(<ProjectContractsPanel onAdopted={onAdopted} />);
    fireEvent.click(await screen.findByRole('button', { name: /sin gastar gas/i }));
    await waitFor(() => expect(adoptDeployment).toHaveBeenCalledWith('VolatilityShieldV1', 'base-sepolia', undefined));
    await waitFor(() => expect(onAdopted).toHaveBeenCalled());
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('bloquea la dirección ocupada y no ofrece ninguna acción', async () => {
    listCatalog.mockResolvedValue([{ ...ENTRY, status: 'address_taken' }]);
    render(<ProjectContractsPanel />);
    expect(await screen.findByText(/ocupada por otro código/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Desplegar y firmar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sin gastar gas/i })).not.toBeInTheDocument();
  });

  it('exige confirmación aparte en redes de dinero real', async () => {
    listCatalog.mockResolvedValue([{ ...ENTRY, network: 'base', isMainnet: true, status: 'deployable' }]);
    render(<ProjectContractsPanel />);
    fireEvent.change(await screen.findByLabelText(/Red/i), { target: { value: 'base' } });
    const boton = await screen.findByRole('button', { name: /Desplegar y firmar/i });
    expect(boton).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Entiendo que es dinero real/i));
    expect(boton).toBeEnabled();
  });

  it('firma, espera el recibo y adopta con el txHash', async () => {
    planDeployment.mockResolvedValue({
      predictedAddress: ENTRY.predictedAddress,
      chainId: 84532,
      tx: { to: '0x4e59b44847b379578588920cA78FbF26c0B4956C', data: '0xabc', value: '0x0', chainId: 84532 },
    });
    wallet.sendTransaction.mockResolvedValue('0xhash');
    wallet.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });

    render(<ProjectContractsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Desplegar y firmar/i }));

    await waitFor(() => expect(wallet.sendTransaction).toHaveBeenCalled());
    await waitFor(() => expect(adoptDeployment).toHaveBeenCalledWith('VolatilityShieldV1', 'base-sepolia', '0xhash'));
  });
});
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

Run: `npm --prefix client exec -- vitest run src/pages/SmartContracts/components/ProjectContractsPanel.test.jsx`
Expected: FAIL — no existe el componente

- [ ] **Step 3: Implementar el componente**

El componente debe cumplir, literalmente, estos textos (las pruebas los fijan) y esta estructura:

- Cabecera: título «Contratos del proyecto» y una frase que explique qué es un hook y por qué su dirección viene dada: *«Un hook es un contrato que la pool de Uniswap v4 consulta en cada swap. Su dirección no se elige: va calculada para que codifique los permisos que el contrato declara, así que aquí ya sabes cuál será antes de firmar.»*
- Selector `<label>Red<select>…</select></label>` con las 6 redes.
- Una tarjeta por contrato con: nombre y versión; permisos declarados; dirección predicha en `<code>`; y un bloque de estado:
  - `deployed` → «**Ya está en esta red.**  Alguien lo desplegó antes; registrarlo **no cuesta gas**.» + botón «Registrarlo sin gastar gas»
  - `deployable` → «**Aún no está en esta red.**  Desplegarlo **cuesta gas** y sólo hace falta hacerlo una vez: a partir de ahí sirve para todos tus LPs.» + botón «Desplegar y firmar»
  - `address_taken` → «**Dirección ocupada por otro código.**  No se sobrescribe nada. Recompila el catálogo si has cambiado el contrato.» + sin botones
  - `unknown` → «**No se ha podido consultar la cadena.**» + el motivo + sin botones
- Si `isMainnet`, una casilla `<label><input type="checkbox"/>Entiendo que es dinero real y el despliegue es irreversible</label>` que habilita el botón de firmar.
- Acción de adoptar: `adoptDeployment(name, network, txHash)` y luego `onAdopted?.()` y recargar el catálogo.
- Acción de desplegar: `planDeployment` → `switchChain(chainId)` si `chainId` difiere → `sendTransaction(tx)` → `waitForTransactionReceipt(hash, { chainId })` → `adoptDeployment(name, network, hash)` → `onAdopted?.()` → recargar.
- Los errores se muestran en un `<p role="alert">` con el mensaje del servidor tal cual: son mensajes redactados para leerse.

- [ ] **Step 4: Ejecutar y comprobar que pasa**

Run: `npm --prefix client exec -- vitest run src/pages/SmartContracts/components/ProjectContractsPanel.test.jsx`
Expected: PASS (6 pruebas)

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/SmartContracts/components/
git commit -m "feat(client): panel de contratos del proyecto con estados explicados"
```

---

### Task 9: Integrar el panel y corregir el texto engañoso

**Files:**
- Modify: `client/src/pages/SmartContracts/SmartContractsPage.jsx`
- Modify: `client/src/pages/SmartContracts/SmartContractsPage.test.jsx`

**Interfaces:**
- Consumes: `<ProjectContractsPanel onAdopted={load} />` (Task 8).

- [ ] **Step 1: Actualizar la prueba de la página**

Añadir a `SmartContractsPage.test.jsx` un mock de `./components/ProjectContractsPanel` que renderice `<div data-testid="panel-catalogo" />`, y una prueba nueva:

```jsx
it('muestra el catálogo del proyecto y separa el registro de terceros', async () => {
  render(<SmartContractsPage />);
  expect(await screen.findByTestId('panel-catalogo')).toBeInTheDocument();
  expect(screen.getByText(/hooks de terceros/i)).toBeInTheDocument();
  expect(screen.queryByText(/Código → Firma y despliegue/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Ejecutar y comprobar que falla**

Run: `npm --prefix client exec -- vitest run src/pages/SmartContracts/SmartContractsPage.test.jsx`
Expected: FAIL — no existe el panel en la página

- [ ] **Step 3: Modificar la página**

- Importar y montar `<ProjectContractsPanel onAdopted={load} />` justo debajo de la cabecera.
- Sustituir la tira de pasos `styles.flow` por una que describa el flujo real y distinga los dos caminos: `Catálogo del proyecto → (ya en cadena) registrar sin gas · (aún no) desplegar y firmar → Verificación on-chain → Uso en el orquestador`.
- Retitular la sección de registro manual a «Hooks de terceros» y dejar explícito el nivel de garantía: *«Para hooks que no son del proyecto y ya están desplegados. Aquí la dirección la aportas tú; el servidor sólo comprueba el bytecode que encuentre en ella.»*
- Ajustar el vacío (`styles.empty`) para que apunte al catálogo: *«Empieza por el catálogo del proyecto, arriba.»*

- [ ] **Step 4: Ejecutar las pruebas del cliente**

Run: `npm --prefix client run test`
Expected: PASS, sin regresiones

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/SmartContracts/
git commit -m "feat(client): integrar el catálogo y aclarar el flujo de contratos"
```

---

### Task 10: E2E del camino sin gas

**Files:**
- Create: `e2e/hook-catalog.spec.js`

**Interfaces:**
- Consumes: la interfaz de Task 9 a través de mocks de `**/api/**`, como el resto de specs.

- [ ] **Step 1: Escribir la prueba**

Siguiendo el patrón de `e2e/automation.spec.js` (interceptar `**/api/**` con `page.route`), una spec que:
1. autentica con el mock existente;
2. sirve `GET /api/smart-contracts/catalog` con un contrato en estado `deployed`;
3. navega a la página de contratos;
4. comprueba que aparece «Ya está en esta red» y el botón «Registrarlo sin gastar gas»;
5. lo pulsa y comprueba que se llama a `POST /api/smart-contracts/catalog/VolatilityShieldV1/adopt`.

- [ ] **Step 2: Ejecutar contra Docker**

Run: `docker compose up -d && npx playwright test --config e2e/playwright-docker.config.js hook-catalog.spec.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add e2e/hook-catalog.spec.js
git commit -m "test(e2e): camino sin gas del catálogo de hooks"
```

---

### Task 11: Verificación completa e integración

- [ ] **Step 1: Pasar la batería completa**

Run: `npm run check`
Expected: PASS — arquitectura, hotspots, catálogo, lint, server, client, contracts y build del cliente

- [ ] **Step 2: Levantar la aplicación y comprobar el módulo a mano**

Run: `docker compose up -d --build && curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5174/`
Expected: 200, y la página de contratos muestra el catálogo con su estado por red

- [ ] **Step 3: Integrar en main y publicar**

```bash
git push origin main
```

- [ ] **Step 4: Actualizar la nota del vault**

Añadir a `~/ObsidianVault/proyectos/testbotCobertura.md` una sección con: el despliegue de hooks ya operativo, la salt precomputada en build y por qué (el event loop), y el arreglo de la verificación circular por los immutables. Commitear en el vault.
