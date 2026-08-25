# Comparativa de coberturas: las 3 políticas en paralelo

## Problema

Hoy la comparación entre políticas de cobertura es 1-contra-1 y sólo existe en
una combinación concreta: si la protección se creó con `net_profit_v1` o
`net_profit_v2` en intención `shadow`, la ejecución real corre con la lógica
legacy de zonas y en paralelo se simula **esa única** política net_profit.
Nunca se simulan `v1` y `v2` a la vez, y nunca se simula legacy cuando la viva
es net_profit. El resultado es que no se puede responder "¿cuál de las tres
rinde más?" — sólo "¿esta net_profit rinde más que legacy?", y sólo en las
protecciones donde alguien eligió esa combinación.

Además la comparación se muestra en dos tarjetas por posición
(`ShadowPolicyCard`, sección violeta del `AccountingPanel`), que son fotos
acumuladas sin serie temporal: no distinguen "gana consistentemente" de "ganó
una vez de golpe".

## Objetivo

Cada pool protegido evalúa **siempre las tres** políticas —
`legacy_zones_v1`, `net_profit_v1`, `net_profit_v2` — en cada tick. La
seleccionada opera de verdad; las otras dos corren en sombra. La comparación
se muda a la página de Métricas como un desplegable sobre la gráfica que ya
existe.

## Semántica del desplegable

La vista por defecto de Métricas no cambia: muestra lo real, exactamente como
hoy. Al abrir el desplegable y elegir una política, se redibuja **la misma
gráfica** indicando a qué cobertura pertenece, sustituyendo la pata de
cobertura por la de esa política.

Sustituir la pata de cobertura propaga a todo el cálculo:

- `hlAccountUsd` pasa a ser el valor contrafactual de la cuenta de Hyperliquid
  bajo esa política.
- `totalUsd = walletUsd + lpUsd + hlAccountUsd(política)`, así que la serie
  principal y el `Δ rango` cambian.
- El PnL total se recompone con la pata de esa política: `lpFeesUsd +
  priceDriftUsd + hedgeRealizedPnlUsd(política) + hedgeUnrealizedPnlUsd(política)
  + hedgeFundingUsd(política) − gasSpentUsd − swapSlippageUsd −
  hedgeExecutionFeesUsd(política) − hedgeSlippageUsd(política)`.

Lo que **no** cambia al elegir política: `walletUsd`, `lpUsd`, `lpFeesUsd`,
`priceDriftUsd` y `gasSpentUsd`/`swapSlippageUsd` del LP. El LP es idéntico
bajo las tres políticas — es la misma posición; sólo difiere cómo se cubre.
Esta es la misma razón por la que la tarjeta de sombra actual excluye a
propósito el P&L del LP de su comparación.

Para la política que está viva, la serie mostrada es la **real**, no una
simulación: no se simula lo que ya se ejecutó.

## Arquitectura

### 1. Extraer la decisión legacy a una función pura

Es el trabajo de fondo y lo que hace viable todo lo demás.
`decideNetProfitV1` ya es pura: recibe delta, precio, rango, coste esperado,
valor del LP y su estado previo, y devuelve decisión más `nextState` sin mutar
nada. La decisión legacy no: el booleano `shouldRebalance` se arma dentro de
`_evaluateProtectionUnlocked` mezclando estado persistido, `Date.now()`,
posición real leída de Hyperliquid y señales del orquestador.

Se extrae `decideLegacyZones({...})` a `server/src/services/legacy-zones-policy.service.js`,
con la misma forma de contrato que `decideNetProfitV1`: entradas explícitas,
sin IO, devolviendo `{ decision, targetQty, gate, nextState }`. Entra por
parámetro todo lo que hoy lee del entorno: zona derivada, multiplicadores,
bandas, `centerDeadZonePct`, `lastRebalanceAt`, `forceReason`/`forceRebalance`
y el reloj.

El camino de ejecución real sigue llamando exactamente a esa función, para que
la política viva y su versión en sombra sean el mismo código. Si la extracción
cambia el comportamiento de la ruta real, es un defecto: los tests existentes
de zonas y de rebalanceo deben pasar sin modificarse.

### 2. Motor: tres evaluaciones por tick

En cada tick, con el precio, BBO, margen y posición **ya cargados** (cero
llamadas RPC o de exchange adicionales), se evalúan las tres políticas:

- La viva alimenta `TradingService` como hoy.
- Las otras dos alimentan `simulateShadowFill`, como hoy hace la sombra única.

El coste es aritmética pura sobre datos ya en memoria. No se añade latencia de
red al hot path de 2 s.

Se elimina el mecanismo viejo `config.deltaNeutral.shadowMode` (simulación de
multiplicadores de zona alternativos, hoy `false` por defecto): queda subsumido
por la comparación entre políticas y mantenerlo sería un segundo camino de
sombra con distinta semántica.

#### Qué gates replica la sombra, y cuáles no

Que la política viva y su sombra compartan la función de decisión no basta: la
ruta viva aplica además una cadena de gates **después** de decidir. Una sombra
que sólo corra la función pura no mide "esta política corriendo viva" sino
"esta política si nada la frenara" — rebalancearía de más, pagaría más
comisiones y luciría un tracking que la versión real nunca consigue.

Se replican los dos que más frenan en la práctica:

- **`min_dwell_active`** (`config.deltaNeutral.minDwellMs`, 60 s). En vivo lo
  escribe la ejecución al llenarse una orden; cada sombra lleva el suyo dentro
  de su `shadowPolicyState`.
- **`within_cost_aware_band`** (`deriveDecisionBandUsd`). Sólo aplica a la
  sombra `legacy_zones_v1`, **y eso es fiel al vivo, no un olvido**: bajo
  net_profit la `rebalanceDecision` se sintetiza de la propia decisión de la
  política, y su equivalente económico ya vive dentro de `decideNetProfitV1`
  (gate `min_notional`). Aplicársela además a las sombras net_profit las
  volvería más conservadoras que su propia versión viva.

Quedan **fuera** por decisión de producto: preflight, margen insuficiente,
spread demasiado ancho, `confidenceBlocksIncrease` y `risk_paused`. Ninguno
frena a las sombras, así que **la serie de una política en sombra es un límite
superior de lo que esa política habría conseguido**, no una estimación
insesgada. La Task 6 debe etiquetarlo en la gráfica: un punto simulado no es
directamente comparable con uno medido sin esta advertencia.

#### Funding

A cada sombra se le imputa el funding real **escalado por su propia posición**
(`shadowQty / liveActualQty`), porque el funding se devenga sobre el notional.
Imputarlo íntegro favorecía de forma determinista a la política que cubre menos
— siempre `legacy_zones_v1`, el incumbente que esta comparación existe para
poner a prueba. Con la posición viva en cero el factor es 0: no hay tasa
observada que repartir y no se inventa una.

### 3. Persistencia

`strategy_state_json.shadowSnapshot` (singular) pasa a
`strategy_state_json.shadowSnapshots`, un objeto indexado por política:

```
shadowSnapshots: {
  legacy_zones_v1: { actualQty, averageEntryPrice, realizedPnlUsd, ... },
  net_profit_v1:   { ... },
  net_profit_v2:   { ... }
}
```

Sólo contiene las políticas no vivas. Cada una guarda además su propio
`shadowPolicyState` (histéresis, cooldown, presupuesto de rotación) y su
`shadowFundingSourceUsd`. El throttle de escritura de 30 s se conserva.

En `lp_orchestrators.accounting_json`, los cinco acumuladores planos
`shadowRealizedPnlUsd`, `shadowUnrealizedPnlUsd`, `shadowFundingUsd`,
`shadowExecutionFeesUsd`, `shadowSlippageUsd` pasan a una estructura anidada
por política, con un `shadowBaseline` por política en `strategy_state_json`.
`applyShadowStateDelta` se generaliza para operar sobre una política nombrada.

Ambos blobs son JSONB y el repositorio ya mergea contra `DEFAULT_ACCOUNTING`,
así que la migración es aditiva: los registros viejos entran con la estructura
nueva vacía. **No se inventa historia**: un `shadowSnapshot` viejo (singular)
se lee como la política que fuera sombra en ese momento y se deja ahí; no se
reconstruye lo que las otras dos habrían hecho.

### 4. Snapshot horario

`orchestrator_metrics_snapshots.breakdown_json` gana un bloque `policies` con
el desglose simétrico de las tres:

```
policies: {
  legacy_zones_v1: { hedgeRealizedPnlUsd, hedgeUnrealizedPnlUsd,
                     hedgeFundingUsd, hedgeExecutionFeesUsd,
                     hedgeSlippageUsd, hlAccountUsd, isLive },
  net_profit_v1:   { ... },
  net_profit_v2:   { ... }
}
```

`isLive` marca cuál era la real en esa hora — necesario porque la política viva
puede cambiar a lo largo de la serie y el lector debe saber qué punto es
medición y cuál es simulación.

Cambio aditivo: no se toca ninguna columna existente y el `breakdown_json`
anterior sigue siendo válido. Los snapshots previos al cambio no tienen
`policies`; la gráfica los trata como "sin dato" para las políticas no vivas,
nunca como cero. Un cero dibujaría una política plana y sugeriría que no rinde,
cuando lo que pasa es que no se midió — el mismo error que ya se corrigió una
vez en la sección violeta del `AccountingPanel`.

### 5. Cliente

Se eliminan por completo:

- `client/src/pages/UniswapPools/components/ShadowPolicyCard.jsx`, su
  `.module.css` y su test, más su uso en `ProtectedPoolCard.jsx`.
- La sección de sombra de `AccountingPanel.jsx` (`hasShadowData`,
  `shadowNetUsd`, `shadowEdgeUsd`, `shadowItems` y su bloque JSX) y los casos
  de test que la cubren.

En `OrchestratorMetricChart.jsx` se añade el desplegable de política. `PNL_COMPONENTS`
deja de ser una lista fija de nueve claves planas y pasa a derivarse de la
política seleccionada: los cinco componentes de cobertura se leen del bloque
`policies[<política>]`, y los del LP (`lpFeesUsd`, `priceDriftUsd`,
`gasSpentUsd`, `swapSlippageUsd`) se leen como hoy porque no dependen de la
política. Con la política viva seleccionada — el estado por defecto — el
componente debe producir exactamente los mismos números que produce hoy.

## Criterios de aceptación

- Un pool protegido con cualquiera de las tres políticas acumula estado de
  sombra para las otras dos, verificable en `strategy_state_json`.
- La ruta de ejecución real es idéntica antes y después de extraer
  `decideLegacyZones`: los tests de zonas y rebalanceo pasan sin modificarse.
- El tick no hace ninguna llamada de red adicional por evaluar tres políticas.
- Métricas con la política viva seleccionada da los mismos valores que hoy.
- Elegir otra política cambia `hlAccountUsd`, `totalUsd`, `Δ rango` y el PnL
  total, y deja intactos `walletUsd`, `lpUsd` y los componentes del LP.
- Los snapshots anteriores al cambio se dibujan como hueco, no como cero.
- No queda ninguna referencia a `ShadowPolicyCard` ni a la sección violeta de
  sombra en el cliente.
- `npm run check` en verde.

## Fuera de alcance

- Promover una protección a `live` desde el panel (sigue sin endpoint).
- Backfill del histórico anterior al cambio.
- Elegir automáticamente la política ganadora: esto mide, no decide.
