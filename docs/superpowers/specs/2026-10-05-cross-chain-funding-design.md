# Fondeo cross-chain del asistente LP — diseño

Fecha: 2026-10-05 · Estado: aprobado en conversación, pendiente de revisión escrita.
Prototipo de UX: https://claude.ai/artifact/MMRPV35hHsCyLcfWCkrA1P (pantallas Fondeo, Traer fondos, Reanudar).

## Objetivo

Que el asistente «Crear orquestador» vea los saldos de la wallet en todas las redes soportadas. Cuando la red del LP no alcance el capital objetivo, debe **planificar y ejecutar** el traslado de fondos desde otras redes. El análisis de fondeo detalla todos los costos del proceso, y el usuario elige un perfil de holgura de gas (Bajo, Medio o Alto) que aplica a todas las transacciones del plan.

### Éxito

- Con fondos repartidos entre redes, el usuario crea el LP desde el asistente sin hacer bridges a mano.
- Antes de firmar, ve por paso y por categoría el costo esperado y el máximo en USD, el % sobre el capital y lo que llega al LP.
- «Bajo» es la comisión más baja con la que la tx entra; si se atasca, hay una salida («Acelerar»).
- Si se cierra la ventana a mitad, el plan se reanuda sin reenviar nada ya enviado.
- Tras ejecutar, se muestra estimado vs real.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Alcance | Planificar y ejecutar desde el asistente |
| Destino | Solo la red del LP. El margen de Hyperliquid queda fuera |
| Proveedores | Li.Fi (agregador) y Across directo como comparador; por envío gana la ruta más barata en neto |
| Orden | Por red de origen, ERC20 primero y nativo al final. Si el destino no tiene gas, el primer envío deja allí el gas del plan |
| Orígenes | Solo tokens conocidos del catálogo (nativo, WETH, estables, tokens de `getKnownTokens`) |
| Viabilidad | Un envío queda fuera si su costo supera el umbral (3 % por defecto, configurable). Se puede forzar desde la UI |
| Selección | Automática y editable por red y token, con «Usar recomendado» |
| Perfil | Por defecto Bajo. Aplica a todas las txs (bridges, approvals, swaps, mint) |
| Persistencia | El plan se guarda en BD y se puede reanudar |
| Espera | Mientras los bridges están en vuelo, se puede configurar la protección. Las firmas del LP esperan |
| Arquitectura | Dos fases: consolidar (nuevo) y fondear (`buildFundingPlan` actual, sin cambios) |

### Hechos verificados (2026-10-05)

- Li.Fi (`li.quest/v1/chains`) soporta las 7 redes: 1, 10, 137, 8453, 42161, 4663 (Robinhood) y 84532.
- Hay ruta Arbitrum → Robinhood (vía Across). La cotización trae `feeCosts` (comisión fija de Li.Fi del 0,25 %, relayer, LP) y `gasCosts`. En $100, la comisión fija ($0,25) fue la mayor partida; por eso se compara con Across directo.
- Robinhood Chain responde a `ArbSys.arbBlockNumber()` en `0x64`: es Arbitrum Orbit. Su `eth_feeHistory` da priority fee 0 en p10, p50 y p90.

## Arquitectura

```
Paso Fondeo (cliente)
  └─ POST /cross-chain/funding-analysis
       ├─ multichain-balances  → saldos por red
       ├─ fee-oracle           → fees por red y perfil, costo por tx
       ├─ buildFundingPlan     → déficit en la red destino (sin cambios)
       └─ bridge-planner       → pasos ordenados + costos (Li.Fi | Across)
  └─ POST /cross-chain/plans                  → persistir el plan (estado draft)
  └─ POST /cross-chain/plans/:id/steps/:n/prepare → recotizar y devolver la tx a firmar
  └─ POST /cross-chain/plans/:id/steps/:n/submitted → txHash
       monitor del servidor → estado de entrega por proveedor
  └─ fase 2: buildFundingPlan sobre los saldos reales del destino (flujo actual)
```

Módulos nuevos en `server/src/services/cross-chain/`. No se añade lógica a `smart-pool-creator.service.js`, que está en el trinquete de `scripts/hotspot-baseline.json`.

### 1. `multichain-balances.js`

- Lee en paralelo las redes de mainnet de `networks.js` (excluye `base-sepolia`) reutilizando `enrichWalletAssets` por red.
- Devuelve `[{ network, assets[], gasReserve, status: 'ok' | 'error', error? }]` y `totalUsd`.
- Si una red falla, no aborta: queda marcada y el plan la excluye con su motivo.
- `gasReserve` se calcula con el perfil (vía `fee-oracle`), no con la reserva fija actual.

### 2. `fee-oracle.js`: módulo de comisiones

**Entrada:** `network`, `profile`, lista de txs (`{ kind, to?, data?, value?, from }`).
**Salida por tx:** `gasLimit`, `maxFeePerGas`, `maxPriorityFeePerGas`, `l1FeeWei`, `expectedCostUsd`, `maxCostUsd`, `source: 'simulated' | 'estimated' | 'table'`.

Precio del gas:
- `eth_feeHistory` sobre 20 bloques con percentiles `[10, 50, 90]`. Caché de 15 s por red.
- Base fee proyectado = último base fee × 1,125ᵏ, con k según el perfil.

| Perfil | Priority fee | maxFeePerGas | gasLimit |
|---|---|---|---|
| Bajo | p10 | baseNext × 1,125² (~1,27) + prio | simulado × 1,10 |
| Medio | p50 | baseNext × 2 + prio | × 1,20 |
| Alto | p90 | baseNext × 3 + prio | × 1,30 |

- Costo esperado = gasUsado esperado × (baseNext + prio) + L1. Costo máximo = gasLimit × maxFee + L1.
- La reserva de una red = Σ del costo máximo de las txs pendientes del plan en esa red. Sustituye a `resolveGasReserveRaw` en el flujo cross-chain. El fondeo de una sola red no cambia hasta que se migre en una tarea aparte.

Reglas por red:
- **Arbitrum y Robinhood** (Orbit, el secuenciador procesa por orden de llegada): prio = 0 en todos los perfiles. Componente L1 vía `NodeInterface.gasEstimateL1Component` (`0x…C8`). En Orbit, `eth_estimateGas` ya incluye las unidades de L1, así que esa parte solo se muestra desglosada y no se suma otra vez. La UI avisa que los perfiles casi no cambian el costo.
- **Base y Optimism** (OP Stack): L1 data fee = `GasPriceOracle.getL1Fee(serializedTx)` (`0x420000000000000000000000000000000000000F`), en una línea propia del desglose.
- **Polygon:** prio ≥ el mínimo de red (constante configurable, inicial 25 gwei).
- **Ethereum:** sin ajustes.

Gas units, en este orden:
1. `eth_estimateGas` de la tx real.
2. Si `estimateGas` falla porque depende de una tx previa (approve → bridge), se usa el `gasLimit` que devuelve el proveedor del bridge (Li.Fi lo trae en `transactionRequest.gasLimit`). Revisión 2026-10-05: sustituye a la simulación con Alchemy, cuyo formato de respuesta no se verificó; ese gas del proveedor cubre el caso real (approve → bridge).
3. Si no, la tabla calibrada (`gas_observations` p95 por red y tipo, con `GAS_PER_TX_TYPE` como semilla). Se marca `source: 'table'` y la UI la muestra como «estimado por tabla».

**Calibración:** tabla `gas_observations` (network, kind, profile, gas estimado y real, `effectiveGasPrice`, l1Fee, bloques de espera, fecha). Se alimenta desde `recordTxFinalized` y desde los recibos de los pasos de bridge. Si el `effectiveGasPrice` real se aparta de forma sistemática del perfil enviado (la wallet ignoró las fees, como puede pasar con SafePal por WalletConnect), la UI lo avisa.

**Acelerar:** si una tx lleva N bloques sin entrar (configurable, inicial 6) o el base fee supera su maxFee, el cliente ofrece reemplazarla con el mismo nonce y el perfil siguiente (mínimo +12,5 % en ambas fees).

### 3. `bridge-planner.js` y proveedores

Interfaz `BridgeProvider` con `quote({ fromChain, toChain, fromToken, toToken, amount, from, to })` → `{ tx, approval?, toAmount, toAmountMin, feeCostsUsd[], gasCostsUsd[], etaSec, providerRef }` y `status(ref)`. Dos adaptadores: `lifi.provider.js` (`/v1/quote`, `/v1/status`) y `across.provider.js` (API de comisiones sugeridas + `depositV3` en el SpokePool, y estado del depósito).

Algoritmo:
1. Ejecutar `buildFundingPlan` con los saldos de la red destino. Si `deployableUsd` ≥ 93 % del objetivo, no hay plan cross-chain.
2. Déficit por lado (estable y volátil) según el peso del rango, con el colchón `DEFAULT_POOL_VALUE_BUFFER`.
3. Gas en destino: si el nativo de destino < reserva del plan del LP con el perfil, el primer envío entrega el nativo que falta (o lleva «gas en destino» si la ruta lo ofrece).
4. Candidatos: por cada red de origen y token conocido, el disponible es el saldo menos la reserva de esa red para sus propios envíos. El nativo solo cuenta por encima de su reserva.
5. Cotizar en los dos proveedores la entrega **en el token del lado con déficit** (estable → USDC/USDG de destino; volátil → nativo o WETH según el pool). Ordenar por costo neto % y llenar el déficit de la más barata a la más cara, prefiriendo pocos envíos grandes.
6. Viabilidad: costo / monto > umbral → excluido con motivo, salvo que se fuerce.
7. Orden: (a) el envío que lleva gas al destino; (b) por red de origen, approvals y ERC20 antes que el nativo. Las redes distintas se pueden firmar seguidas.
8. Salida: `steps[]` con desglose (gas en origen, comisión del bridge por concepto, gas en destino), costo esperado y máximo, ruta elegida y alternativa descartada con su costo; `categories` (gas origen, bridge, gas destino, swaps, LP); `totalExpectedUsd`, `totalMaxUsd`, `% del capital`, `deliveredUsd`, `uncoveredUsd`; y `profileComparison` con los tres perfiles.

**Seguridad:** el servidor solo devuelve txs cuyo `to` esté en una allowlist por red y proveedor (LiFiDiamond, SpokePool de Across). El destinatario siempre es la wallet del usuario. Se valida `toAmountMin` contra la cotización mostrada con el slippage del formulario.

### 4. Persistencia y ejecución

Migración `030_cross_chain_plans.sql`:
- `cross_chain_plans`: id, user_id, wallet, destino (network, pool), profile, threshold_pct, status (`draft | executing | delivered | partial | discarded`), `quote_snapshot` y `cost_snapshot` (JSON), timestamps.
- `cross_chain_steps`: plan_id, order, source_network, token, amount_raw, provider, route_ref, tx_hash, nonce, status (`pending | signed | source_confirmed | delivered | failed | refunded`), est_cost_usd, real_cost_usd, received_raw, timestamps.
- `gas_observations` (sección 2).

Ejecución por paso:
1. `prepare`: recotizar gas y ruta. Si el costo se desvía más de un 20 % de lo mostrado, o la ruta caducó, se devuelve `requiresReconfirm` con los costos nuevos.
2. Cliente: `switchChain`, approval si hace falta y envío con las fees del perfil explícitas en `sendTransaction`. Se reutilizan el ping de sesión WalletConnect, el rescate por nonce y «Cancelar espera».
3. `submitted`: guarda `txHash` y `nonce`, y el estado pasa a `signed`. El monitor confirma en origen (`source_confirmed`), consulta el estado del proveedor y marca `delivered | failed | refunded`. El costo real sale del recibo y del monto recibido.

Reanudar: al abrir «Crear orquestador», si la wallet tiene un plan en `executing`, aparece el diálogo «Continuar trayendo fondos / Descartar plan». Al continuar se relee el estado en cadena y en el proveedor. Un paso con `txHash` nunca se reenvía sin resolver antes su estado. Descartar no mueve fondos.

Fallos:
- **Rechazo o revert en origen:** `failed`. Opciones: reintentar con cotización nueva o saltar el paso.
- **Reembolso:** `refunded`, con opción de recalcular el plan.
- **Más del doble del tiempo estimado:** aviso con enlace al explorador del proveedor, y las opciones «Esperar» o «Seguir con lo que llegó».
- **Tx sin entrar:** «Acelerar».
- **Red ilegible:** se excluye con su motivo.

Fase 2: con todo entregado (o si el usuario sigue con lo que llegó), se ejecuta `buildFundingPlan` sobre los saldos reales del destino. Si no alcanza, se aplica `resolveEffectiveFundingTargetUsd`.

### 5. Cliente

- Paso **Fondeo** (`client/src/features/lp-wizard/`): tabla de saldos multi-red con su papel en el plan, selector de perfil (por defecto Bajo), plan de pasos, costos por categoría, esperado y máximo, «Forzar» por origen excluido y «Usar recomendado». Sin déficit, el paso se ve como hoy más la tabla multi-red.
- Subpaso **Traer fondos**: progreso, estado por paso, «Acelerar», «Esperar» o «Seguir con lo que llegó», el aviso para configurar la protección en paralelo y la tabla de estimado vs real al terminar.
- Diálogo **Reanudar plan**.
- `useWalletConnection.sendTransaction` acepta `maxFeePerGas` y `maxPriorityFeePerGas` (y `gasPrice` en redes legacy).
- Colores siempre con tokens `--uni-*` (regla del test de literales).

## Pruebas

- **Unitarias del servidor, con RPC y APIs simuladas:**
  - `fee-oracle`: percentiles, proyección, L1 en OP y Arbitrum, piso de Polygon, respaldo a tabla.
  - `bridge-planner`: déficit, gas primero, ERC20 antes que el nativo, umbral y forzado, elección de proveedor, allowlist.
  - Estados del plan y reanudación.
- **Contrato** (job aparte, no bloquea el CI): cotizaciones reales Li.Fi y Across de montos pequeños.
- **Cliente:** tests del paso Fondeo, de Traer fondos y del diálogo de reanudar.
- **e2e Playwright** contra Docker en `localhost:5174` con el servidor simulado.

## Despliegue

Flag `CROSS_CHAIN_FUNDING_ENABLED`.
1. **Etapa 1 (lectura):** saldos multi-red, módulo de comisiones, plan y comparación de perfiles visibles, con «Traer fondos» deshabilitado.
2. **Etapa 2 (ejecución):** habilitar los bridges. La primera prueba real se hace con un monto pequeño, firmada por el usuario.

## Fuera de alcance

- Fondear el margen de Hyperliquid.
- Tokens fuera del catálogo como origen.
- Migrar el fondeo de una sola red al `fee-oracle` (tarea posterior).
- Ejecución automática sin firma.
