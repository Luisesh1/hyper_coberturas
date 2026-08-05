# Wizard LP unificado con creación atómica

**Fecha:** 2026-08-02
**Estado:** aprobado
**Mockup:** https://claude.ai/design/p/8ca613cc-aa8f-4444-a268-7b71972a803e?file=Wizard+LP+unificado.dc.html

## Problema

Crear un LP orquestado hoy son dos modales encadenados:

1. `CreateOrchestratorWizard` (4 pasos) crea el orquestador **solo en BD**.
2. `LpOrchestratorPage` cierra ese modal y abre `SmartCreatePoolModal` (4 pasos + firma),
   que hace lo on-chain y termina llamando a `attachLp`.

Eso produce tres defectos.

### Redundancia

Red, versión, pool, fee tier y capital se piden en ambos modales. El segundo los recibe
pre-cargados vía `smartCreateDefaults`, pero el usuario ya los tecleó una vez y la UI
vuelve a mostrarlos como campos editables.

Peor: **el ancho del rango se define dos veces sin conciliación**. `strategyConfig.rangeWidthPct`
(paso Estrategia del orquestador) gobierna los rebalanceos futuros; los presets ATR del paso
Rango definen el rango inicial real. Nada garantiza que coincidan, así que el primer
rebalanceo puede mover el LP a un ancho que el usuario nunca eligió.

También hay dos conceptos de capital: `initialTotalUsd` del orquestador ("solo una referencia
para el dimensionamiento de la protección") y `totalUsdTarget` del LP (el monto real).

### Atomicidad

Ninguno de los tres fallos posibles deja el sistema en un estado consistente:

| Fallo | Estado resultante hoy |
|---|---|
| El usuario cierra el modal de LP | Orquestador huérfano en BD, sin LP, en fase `idle` |
| `attachLp` falla | LP vivo on-chain sin vincular; mensaje que remite a "Adoptar LP existente" |
| **La cobertura falla** | **Se traga con `logger.warn` y el orquestador queda activo sin hedge** |

El tercero es el grave: `lp-orchestrator.service.js` captura el error de
`createProtectedPool` y sigue adelante con el comentario *"No abortamos: el LP quedó creado.
Solo registramos el fallo."* El orquestador queda marcado `lp_active` con
`activeProtectedPoolId = null`, es decir, **operando descubierto mientras la UI lo muestra
como protegido**.

### Recuperación

Si el navegador muere entre la firma del mint y el `attachLp`, no queda ningún registro de
la intención. El LP existe on-chain y nadie sabe a qué orquestador debía pertenecer.

## Restricción que condiciona el diseño

**Una transacción minada no se puede deshacer.** "Revertir todo" no es un rollback: es una
compensación que cuesta gas y cristaliza el impermanent loss. Por eso el diseño no promete
atomicidad sobre lo on-chain — la promete sobre el *estado del sistema*, y ordena las
operaciones para que lo irreversible ocurra lo más tarde posible y con la máxima
probabilidad de éxito.

## Diseño

### 1. Un componente, dos modos

`UnifiedLpWizard` sustituye a los dos modales:

```
mode="standalone"    ← UniswapPoolsPage
  Pool → Rango → Fondeo → Revisión → Firma

mode="orchestrated"  ← LpOrchestratorPage
  Pool → Rango → Fondeo → Cobertura → Revisión → Firma
```

El paso Cobertura solo existe en modo orquestado. Todo lo demás es idéntico, incluido el
motor de estado, el manejo de errores y las pantallas de firma/resultado.

Los componentes de paso existentes en `client/src/pages/UniswapPools/components/smart-create/`
(`StepPoolSelection`, `StepRangeConfig`, `StepFunding`, `StepSigning`) se reutilizan tal cual
o con retoques mínimos. Se añaden `StepProtection`, `StepPlanReview` y `StepOutcome`.

Ubicación: `client/src/components/LpWizard/` — neutral respecto a ambas páginas y fuera de
`client/src/shared/`, que tiene prohibido depender de features.

### 2. Redundancia eliminada

- **Identidad + Pool se fusionan** en el paso 1: red, versión, pool, fee y capital una sola vez.
- **Un solo capital.** Desaparece `initialTotalUsd` como concepto separado; el orquestador
  persiste el mismo valor que se despliega en el LP.
- **El nombre se autocompleta** desde el pool (`WETH/USDC 0.05% · Arbitrum`), editable.
- **Un solo ancho de rango.** El paso Rango es la fuente de verdad; `rangeWidthPct` se deriva
  del rango elegido. Un checkbox permite desacoplarlos explícitamente para quien quiera una
  política de rebalanceo distinta del rango inicial.

### 3. Saga con pre-flight y compensación

Orden de ejecución, anotado por reversibilidad:

| # | Paso | Reversible | Firma |
|---|---|---|---|
| 1 | Registrar la intención en el servidor | sí | no |
| 2 | Approve del token | **no** | sí |
| 3 | Swap de fondeo | **no** | sí |
| 4 | Mint de la posición | **no** | sí |
| 5 | Abrir el short en Hyperliquid | sí (cierre server-side) | no |
| 6 | Crear orquestador + vincular LP + protección | sí (transacción BD) | no |

#### Pre-flight (antes del paso 2)

`POST /api/lp-orchestrator/preflight-protection` valida en seco todo lo que puede hacer
fallar el paso 5, **antes** de gastar gas:

- La cuenta Hyperliquid resuelve y su API responde.
- El par es elegible para delta-neutral y el asset es soportado (`buildDeltaNeutralCandidate`).
- El leverage pedido no supera el máximo del asset.
- El margen libre cubre el margen requerido (`notional / leverage`).
- No hay otra protección activa sobre el mismo asset + cuenta (el conflicto que
  `createDeltaNeutralProtectedPool` rechaza).

Se ejecuta sobre un **snapshot sintético** construido con el pool, el rango planificado y el
capital — la posición real todavía no existe. Eso deja fuera lo que solo se puede validar
contra el LP minado, y es la razón por la que el fallo tardío sigue siendo posible.

El wizard bloquea el avance a Revisión si el pre-flight no pasa.

#### Intención persistida

`POST /api/lp-orchestrator/create-intent` registra la operación en
`position_action_operations` con `kind = 'orchestrated_lp_create'` y el plan completo
(pool, rango, capital, config de estrategia, config de protección) en `result_json`, **antes
de la primera firma**. Reusa `operation_key` para idempotencia y el worker de
`uniswap-operation.service.js` para la reconciliación.

**Alcance real de la recuperación automática.** El worker retoma las operaciones en estado
`committing` — es decir, aquellas en las que el cliente ya llamó a `commit-intent` y el
servidor murió a mitad. Ese caso se cierra solo, porque `commitIntent` es idempotente.

Lo que **no** se puede recuperar automáticamente es que el navegador muera entre la firma
del mint y la llamada a `commit-intent`: sin esa llamada el servidor nunca recibe los
txHashes, y no hay forma de adivinarlos. En ese caso queda la intención registrada con el
plan completo (que hoy no existe en absoluto), y el LP se recupera con «Adoptar LP
existente». Las intenciones que caducan sin firmarse se limpian a los 30 minutos.

#### Commit y compensación

`POST /api/lp-orchestrator/commit-intent` recibe el `finalizeResult` del mint y ejecuta los
pasos 5 y 6 con compensación:

```
abrir hedge
  ├─ ok  → transacción BD: crear orquestador + attach LP + vincular protección
  │         └─ falla → cerrar hedge, rollback BD, estado `compensated`
  └─ falla → rollback BD (no hay nada que cerrar), estado `compensated`
```

En ambos caminos de fallo el resultado es el mismo: **no queda orquestador, no queda
protección registrada, y el LP —minado y no revertible— se reporta al cliente como
superviviente** con su identificador y su valor.

`attachLp` deja de tragarse el fallo de protección. Pasa a aceptar
`protectionFailureMode: 'strict' | 'lenient'`; el flujo nuevo usa `strict` (propaga y
compensa), y `adoptLp` conserva `lenient` para no cambiar el comportamiento de adopción
manual de un LP que ya existe.

#### Pantalla de fallo

Cuando la compensación deja un LP vivo, la UI lo presenta con tres salidas explícitas en
lugar del error de texto actual:

- **Cerrar el LP** — 1 firma, reusa `killLp`.
- **Reintentar la cobertura** — vuelve al paso Cobertura con el pre-flight recalculado.
- **Conservarlo sin cobertura** — crea el orquestador con `protectionConfig.enabled = false`
  y adopta el LP.

## Alcance

### Backend

| Archivo | Cambio |
|---|---|
| `services/lp-orchestrator/protection-preflight.js` | nuevo — dry-run de la cobertura |
| `services/lp-orchestrator/create-saga.js` | nuevo — intención, commit, compensación |
| `services/lp-orchestrator.service.js` | `attachLp` con `protectionFailureMode` |
| `routes/lp-orchestrator.routes.js` | 3 rutas nuevas |
| `schemas/lp-orchestrator.schema.js` | schemas de las 3 rutas |
| `services/uniswap-operation.service.js` | manejar `kind = 'orchestrated_lp_create'` |

### Frontend

| Archivo | Cambio |
|---|---|
| `components/LpWizard/UnifiedLpWizard.jsx` | nuevo — shell, stepper, footer |
| `components/LpWizard/useUnifiedLpFlow.js` | nuevo — máquina de estados de los 6 pasos |
| `components/LpWizard/steps/StepProtection.jsx` | nuevo — cobertura + pre-flight |
| `components/LpWizard/steps/StepPlanReview.jsx` | nuevo — plan por reversibilidad |
| `components/LpWizard/steps/StepOutcome.jsx` | nuevo — éxito / fallo con compensación |
| `pages/LpOrchestrator/LpOrchestratorPage.jsx` | usa el wizard; se retira el encadenado |
| `pages/UniswapPools/UniswapPoolsPage.jsx` | usa el wizard en modo standalone |
| `pages/LpOrchestrator/components/CreateOrchestratorWizard.jsx` | se elimina |
| `pages/UniswapPools/components/SmartCreatePoolModal.jsx` | se elimina |
| `scripts/check-hotspot-sizes.mjs` | actualizar presupuestos de los archivos retirados |

`scripts/check-hotspot-sizes.mjs` falla si un archivo del presupuesto no existe, así que
retirar los dos modales obliga a tocarlo en el mismo commit.

## Verificación

- `npm run check` — arquitectura, hotspots, lint, tests de server y client, build.
- Tests nuevos: pre-flight (cada check que falla por separado), saga (fallo en 5, fallo en 6,
  idempotencia del commit), `attachLp` en modo `strict`.
- La app levantada en Docker (`localhost:5174`), recorriendo el wizard en ambos modos.

## Fuera de alcance

- Cambiar la lógica de rebalanceo o de la cobertura en marcha.
- Tocar `PositionActionModal`, `ApplyProtectionModal` ni el flujo de adopción manual.
- Reintentos automáticos del hedge tras la compensación.
