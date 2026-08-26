# Despliegue de hooks V4 desde el panel — diseño

Fecha: 2026-08-25
Estado: aprobado, pendiente de plan de implementación

## 1. Problema

El módulo de contratos está incompleto: registra código y evidencia, pero **no
puede desplegar**. Hoy el ciclo de vida de un hook V4 se corta por la mitad.

- `contracts/` sólo tiene `compile` y `test`. No existe ningún script de deploy
  en el repositorio.
- `SmartContractsPage` pide teclear a mano la dirección y el `txHash` de un
  despliegue hecho fuera de la aplicación.
- Su tira de pasos («Código → Firma y despliegue → Verificación on-chain → Uso
  en orquestador») y el subtítulo «La firma ocurre desde la wallet» insinúan
  que la aplicación orquesta la firma. No lo hace. La redacción induce a error.

Consecuencia práctica: no hay forma soportada de poner `VolatilityShieldV1` en
ninguna red, ni siquiera en Base Sepolia, que era el objetivo del plan
`2026-08-25-volatility-shield-twap-testnet.md`.

## 2. Decisiones

| Decisión | Elegido |
|---|---|
| Alcance de red | Las 6 redes soportadas desde el principio, testnet y mainnets |
| Qué se despliega | Sólo el catálogo compilado del repositorio |
| Reutilización | Catálogo con direcciones conocidas: si el hook ya está en cadena, se adopta sin gas |
| Arquitectura | El servidor arma el txPlan; la wallet del usuario firma |

El textarea de código pegado **se conserva** para registrar hooks de terceros ya
desplegados, pero esos no se pueden desplegar desde la aplicación.

## 3. Hallazgos verificados

Cuatro comprobaciones hechas contra el código y la cadena, no supuestos:

1. **El proxy CREATE2 determinista está en las 6 redes.** `getCode` sobre
   `0x4e59b44847b379578588920cA78FbF26c0B4956C` devuelve 69 bytes en ethereum,
   arbitrum, base, base-sepolia, optimism y polygon. No hace falta desplegar
   una factory propia.
2. **Minar la salt es viable pero no puede hacerse en caliente.** Para
   base-sepolia bastaron 9.154 intentos (2,9 s); la media son ~16.384 (~5 s).
   Cinco segundos de keccak bloquean el event loop de Node y con él el
   WebSocket de Hyperliquid, el monitor de coberturas y el scheduler de
   alertas. **Por eso la salt se precomputa en build.**
3. **`poolManager` es `immutable`** (`ImmutableState.sol` de v4-periphery, vía
   `BaseHook`). El runtime que devuelve el RPC nunca coincidirá con el que
   emite solc. La verificación actual sólo pasa porque el usuario teclea el
   hash que ya sacó de la cadena: es circular y no prueba nada.
4. **El contenedor del servidor no ve `contracts/`.** Su build context es
   `./server` y el volumen monta `./server:/app`. El catálogo debe llegar por
   un paso explícito de sincronización.

## 4. Arquitectura

### 4.1 Catálogo precompilado

`contracts/scripts/compile.js` pasa a emitir, por contrato:

```
VolatilityShieldV1.json
  ├─ abi, compiler, creationBytecode, runtimeBytecode
  ├─ immutableReferences                    (nuevo: solc outputSelection)
  └─ networks:
       <red>: { poolManager, salt, initcodeHash, predictedAddress }
```

El `initcode` es `creationBytecode ‖ abi.encode(address poolManager)`. Como
ambos se conocen al compilar, la salt que hace cumplir los flags de permiso se
mina **una vez, en build, y se commitea**.

Propiedades que esto da:

- El servidor no mina: lee la salt y, como mucho, hace un keccak para confirmar
  que la dirección predicha sigue cuadrando. Cero riesgo para el event loop.
- La dirección del hook se conoce **antes** de desplegar, lo que habilita la
  adopción sin gas.
- Es determinista: cualquiera puede recompilar y obtener la misma salt y la
  misma dirección.

### 4.2 Sincronización al servidor

Un script `sync:artifacts` copia el catálogo a `server/src/contracts/catalog/`.
`npm run check` falla si el catálogo sincronizado difiere del artefacto, con la
misma forma que las guardias `check:architecture` y `check:hotspots` ya
existentes.

### 4.3 Rutas nuevas

Bajo `/api/smart-contracts`:

- **`GET /catalog?network=…`** — por cada contrato del catálogo, su estado en
  esa red leído de la cadena en el momento: *ya desplegado* (el código en
  `predictedAddress` coincide con el runtime esperado), *dirección ocupada por
  otro código*, o *desplegable*.
- **`POST /catalog/:nombre/adopt`** `{network}` — camino **sin gas**. Si el
  código en cadena cuadra, registra contrato + versión + despliegue a nombre
  del usuario y lo deja verificado.
- **`POST /catalog/:nombre/deployment-plan`** `{network}` — devuelve el txPlan
  con la forma que ya usa el proyecto (`to` = proxy CREATE2, `data` =
  `salt‖initcode`) más la dirección predicha, para verla antes de firmar.

**Preflight obligatorio antes de devolver cualquier txPlan:** la red tiene
`poolManager`; el proxy CREATE2 existe; la dirección predicha está vacía (si no,
se redirige a *adopt* en lugar de permitir quemar gas); y los 14 bits bajos de
esa dirección coinciden con los permisos que declara el contrato. Si algo falla,
no hay txPlan.

### 4.4 Conciliación

`uniswap-operation.service.js` ya discrimina por `kind` (`position_action`,
`claim_fees`, `orchestrated_lp_create`) y concilia en segundo plano. El
despliegue entra como `kind: 'hook_deployment'`: espera el recibo, confirma que
hay código en la dirección predicha, registra el despliegue y **encadena la
verificación existente**. El usuario no vuelve a teclear direcciones ni hashes.

### 4.5 Verificación reproducible

Con `immutableReferences` en el catálogo, el servidor reconstruye el **runtime
esperado por red**: toma el `runtimeBytecode` y escribe la dirección del
`PoolManager` de esa red en cada hueco de immutable. Compara su keccak contra el
código del RPC.

Esa comparación sí demuestra que el contrato desplegado es, byte a byte, el de
`contracts/src/`. `artifactBytecodeHash` deja de teclearse a mano para los
contratos del catálogo: lo calcula el servidor. `canVerifyContractVersion` no
cambia; por fin recibe un hash que no es circular.

La ruta manual sobrevive para hooks de terceros, con la UI dejando explícitos
los dos niveles de garantía: *código del proyecto, reproducible* frente a
*dirección aportada por el usuario*.

### 4.6 UI

En `SmartContractsPage`, una sección nueva arriba, **Contratos del proyecto**:
selector de red y una tarjeta por contrato con estado, dirección predicha y un
único botón contextual — «Registrar el ya desplegado (sin gas)» o «Desplegar y
firmar». Se reescribe la tira de pasos para que deje de insinuar que la
aplicación orquesta una firma que no orquesta.

**Guardarraíl de mainnet:** el `deployment-plan` marca cuándo la red es de
dinero real y la UI exige una confirmación aparte. Un despliegue es
irreversible y quema la dirección para esa salt.

## 5. Flujo de datos

**Camino sin gas** (el habitual a partir del primer despliegue por red):

```
UI: elige contrato + red
  → GET /catalog            → estado "ya desplegado"
  → POST /catalog/:n/adopt  → registra + verifica
  → el hook aparece en el desplegable del wizard de LP
```

**Camino con firma** (primer despliegue en una red):

```
UI: elige contrato + red
  → GET /catalog                      → estado "desplegable"
  → POST /catalog/:n/deployment-plan  → preflight + txPlan + dirección predicha
  → UI muestra dirección y red; confirmación extra si es mainnet
  → wallet firma (useWalletExecution)
  → operación kind=hook_deployment concilia: recibo → código → registro → verificación
  → el hook aparece en el desplegable del wizard de LP
```

## 6. Errores contemplados

| Situación | Respuesta |
|---|---|
| Proxy CREATE2 ausente en la red | Sin txPlan; se explica que esa red no admite el despliegue determinista |
| Dirección predicha ocupada por código distinto | Bloqueo duro. Nunca se sobrescribe; se avisa |
| Red sin `poolManager` configurado | El contrato no aparece como desplegable en esa red |
| Wallet conectada a otra red | Se impide firmar; se pide cambiar de red |
| Transacción revertida | La operación queda `failed` con su motivo; no se registra despliegue |
| Catálogo desincronizado del artefacto | `npm run check` falla antes de producción |

## 7. Pruebas

Regla heredada del plan de testnet: **ninguna prueba firma, despliega ni envía
transacciones**.

- **`contracts/`** — que la salt de cada red produzca una dirección con los
  flags correctos y que el `initcodeHash` cuadre. Cálculo puro, sin red.
- **`server/`** — construcción del initcode y del runtime esperado con
  immutables sobre un fixture; preflight (dirección ocupada obliga a *adopt*);
  conciliación del `kind` nuevo con provider simulado.
- **`client/`** — que la página refleje el estado correcto por red y **no
  ofrezca firmar** cuando el contrato ya está desplegado.
- **E2E (Playwright contra Docker en `localhost:5174`)** — camino sin gas:
  catálogo → *adopt* → el hook aparece en el desplegable del wizard de LP.

## 8. Fuera de alcance

- Compilar en el servidor código pegado por el usuario (`solc` en el backend,
  resolución de imports, reproducibilidad). Descartado explícitamente.
- Desplegar una factory CREATE2 propia: innecesario, el proxy estándar está en
  las 6 redes.
- Hacer globales los despliegues del registro (hoy son por usuario). La
  adopción sin gas resuelve el problema práctico sin tocar el esquema.
- Verificación en exploradores de bloques (Etherscan/Basescan).

## 9. Riesgos

- **Un despliegue es irreversible.** El guardarraíl de mainnet y la
  visualización de la dirección antes de firmar son la mitigación.
- **La salt commiteada depende del `creationBytecode`.** Cualquier cambio en el
  contrato o en la versión de solc la invalida: el catálogo debe regenerarse y
  la guardia de `npm run check` es lo que impide que se use una salt obsoleta.
- **El catálogo fija la dirección del `PoolManager` por red.** Si Uniswap
  desplegara un `PoolManager` nuevo en alguna red, el catálogo quedaría
  desfasado y habría que regenerarlo.
