# terminal_range_v1 — diseño de integración

Fecha: 2026-09-25. Base: `origin/main` @ `f51fbd1`. Especificación funcional de
origen: `terminal_range_v1 — especificación funcional` (backtest, perfil
40 % / 2 min, ancho 10 %, cooldown 24 h, centro spot).

## Decisiones acordadas

| Tema | Decisión |
|---|---|
| Alcance | Solo la política de **hedge**. El recentrado del LP sigue siendo manual (lo firma la wallet); el orquestador lo recomienda. Al firmar un `modify-range` la misma protección se refresca con el rango nuevo y la política abre ciclo nuevo (cambio de `rangeKey`). |
| Confirmación | **Cierres de minuto derivados** de los ticks (~2 s). Bucket UTC `floor(now/60000)`; el último precio visto en el minuto es su cierre, que se conoce en el primer tick del minuto siguiente (= "apertura siguiente"). Candidato en el primer cierre más allá del umbral; se ejecuta al acumular `confirm` minutos consecutivos. Un minuto sin ticks rompe la racha. |
| Rollout | **Live + sombra**. Seleccionable como live por protección/orquestador (con `activationConfirmed`) y añadida al motor de sombra para que toda protección la simule sin órdenes. |
| Enfoque | **Servicio puro + adaptador**. `evaluate.js` llama al adaptador una vez y consume su resultado en ramas `isTerminalLive`; las ramas de legacy, net_profit y range_exit no cambian. |

## Módulos

- `server/src/services/terminal-range-policy.service.js` — puro, sin IO. Recibe
  `valueAt(price)` / `volatileAt(price)` en lugar del snapshot. Contiene
  umbrales, cierres de minuto, confirmación, secante, coste de recentrado `K_E`,
  solver terminal (0 / q / qMax + 70 bisecciones), objetivo fuera de rango y la
  máquina de estados `decideTerminalRangeV1`.
- `server/src/services/protected-pool-delta-neutral/terminal-range.js` —
  adaptador: construye `valueAt` con `calculatePoolValueAtPrice` sobre el
  snapshot real (v3/v4, orientación, ticks, liquidez), `N` a partir de los
  acumulados del hedge contra el baseline del ciclo, y devuelve la decisión en
  el formato del evaluador.

## Estado (`strategyState.terminalRangePolicyState`)

Bloque propio; no se toca `rangeExitPolicyState` ni `netProfitPolicyState`.

- Ciclo: `rangeKey`, `cycleId`, `anchorPrice` (A), `openedAt`,
  `baselineValueUsd` (B), `hedgeNetBaselineUsd`, `liquidity`.
- Posición confirmada: `side` (−1/0/+1), `zone` (inside/below/above),
  `committedTargetQty`.
- Intención pendiente: `pendingIntent {id, side, zone, targetQty, gate, decidedAt}`.
  Solo `execution.js`, tras un fill correcto con el mismo `id`, la promueve a
  `side`/`zone`/`committedTargetQty`. Una orden bloqueada no mueve el lado
  (corrige la diferencia del prototipo, §9 de la especificación).
- Confirmación: `minute {bucket, lastPrice}`, `candidate {dir, startBucket,
  lastBucket}`.
- Observabilidad: `lastResidualUsd`, `lastInfeasible`, `infeasibleCount`,
  `lastEdge`.

## Reglas

- **Apertura de ciclo** (sin estado o `rangeKey` distinto): A = precio actual
  (si el ciclo se adopta fuera de rango, A = punto medio del rango), B = V(S),
  baseline de N = neto del hedge ahora. Objetivo: secante
  `(V(b)−V(a))/(b−a)·S/F` dentro del rango, `x(S)·S/F` fuera.
- **Cambio de liquidez** con el mismo rango (increase/decrease): B se desplaza
  por el delta de capital `V_new(S)·(1 − L_old/L_new)` para que el aporte o
  retiro no cuente como PnL. No se reinicia N.
- **Dentro del rango**: dirección por cierre de minuto contra
  `T_inf = A − h(A−a)`, `T_sup = A + h(b−A)`. Solo cuenta si difiere del lado
  confirmado. Volver al centro no restaura el balanceado.
- **Objetivo terminal**: `R = V(E) − B + N − K_E − q(F−M)`,
  `g(q') = R + q'(F−F_E) − |q'−q|·F·c − q'·F_E·c`, `F_E = E·M/S`,
  `0 ≤ q' ≤ qMax`, `qMax = V(A)·maxHedge/F` (el margen lo limita además el
  preflight existente, que recorta incrementos a lo asumible).
- **Fuera de rango**: un cierre fuera que cambia de zona decide en el tick
  siguiente, sin confirmación ni offset. Objetivo `x(S)·S/F`. La reentrada
  (cierre dentro) recalcula al borde si el precio actual está en banda terminal,
  o vuelve al balanceado con lado 0 si está en la central. La zona se reevalúa
  con el precio del tick de ejecución.
- **Orden no aterrizada**: si `|actual − committed|` supera tolerancia y el
  notional mínimo (o es cierre total), se reintenta (`commit_incomplete`).
- **Intención pendiente** sin fill: se reemite recalculada con precios frescos
  hasta que se promueve o la reemplaza otro ciclo/decisión.

## Integración con el motor compartido

- `helpers.js`: `terminal_range_v1` en `SELECTABLE_LIVE_POLICIES`; **no** en
  `FULL_DELTA_POLICIES` (no es delta completo). Nueva `policyOwnsTarget` =
  delta completo ∪ terminal, usada por `pricing.js` para no aplicar
  multiplicadores de zona legacy. Sin zona muerta central. Exposición medida
  contra `committedTargetQty`.
- `evaluate.js`: terminal no usa dead zone, min-dwell ni `forceReduceNearZero`
  (la confirmación es su dwell; ella cierra residuos). **Sí** respeta el
  bloqueo por baja confianza del modelo (datos no fiables → no aumentar
  exposición), gates de riesgo, preflight/margen y el tope de exposición
  (que adopta su recorte como `committedTargetQty`).
- `execution.js`: promueve `pendingIntent` solo si `metrics.terminalIntentId`
  coincide; adopta `committedTargetQty` comandado.
- `shadow-policies.js`: añade terminal a `ALL_POLICIES`. N de la sombra sale de
  su propio estado simulado; su estado de minuto avanza también en `hold`.
- Migración `029_terminal_range_policy.sql` (CHECK con todos los valores
  anteriores + NULL). Esquemas del orquestador y de protección aceptan la
  versión y su bloque `terminalRangeConfig` (threshold, confirmMinutes).
- Creación: dimensionado inicial (`hedgeSize`, notional) por secante; exige
  `activationConfirmed` para live.
- Orquestador: para orquestadores terminal, la recomendación de recentrado fuera
  de rango respeta 24 h desde la apertura del LP (`minRebalanceCooldownSec`,
  default 86 400 para el perfil). Los demás orquestadores no cambian.
- Cliente: opción en el wizard, etiqueta en el badge y métricas.

## Parámetros (perfil aprobado)

`threshold=0.4`, `confirmMinutes=2`, `hedgeCostRate=0.00065` (4,5 + 2 bps),
`swapCostRate=0.001` (5 + 5 bps), `gasUsd=2`, `maxHedge=1.5`. Pasados siempre
de forma explícita desde la configuración persistida.

## Diferencias conocidas frente al backtest

1. Recentrado manual, no automático; el ciclo abre cuando llega el rango nuevo.
2. B es el valor del LP al adoptar el ciclo, no el bruto antes de costes de
   apertura (esos ya se pagaron on-chain y los contabiliza el orquestador).
3. Redondeo y mínimos los aplica la capa de ejecución existente
   (`szDecimals`, `minOrderNotionalUsd`).
4. F = mid/mark de Hyperliquid (no hay precio de ejecución previo al fill).
5. `qMax` no incluye el margen: lo limita el preflight del motor, que recorta
   incrementos a lo asumible. Por eso el alta exige margen para el pico
   (`capital × maxHedge / leverage`: $5.000 con LP de $10.000 a 3x).
6. Una intención cuyo ajuste queda bajo el mínimo del exchange se confirma con
   la posición real (`intent_within_min_notional`, `committed = actual`) en vez
   de reintentarse sin fin; el cierre total sí se manda aunque sea sub-mínimo.

## Limitaciones conocidas

- `fundingAccumUsd` sale de `cumFunding.sinceOpen` de Hyperliquid: si el short
  se cierra del todo (por encima del rango) y se reabre, ese acumulado
  arranca de cero y N pierde el funding previo del ciclo. Afecta también a
  `netProtectionPnlUsd`; no se corrige aquí.
- La barra de rango del orquestador dibuja la banda de 40% centrada en el
  medio geométrico; los umbrales de terminal son aritméticos respecto al
  ancla. Con 10% de ancho la diferencia es despreciable.
- El alta directa (`POST /protected-pools`) no acepta `policyVersion` y sigue
  siendo solo legacy; terminal entra por el wizard/orquestador.

## Hallazgo fuera de alcance

La sombra de `range_exit_v1` nunca confirma un cruce: `runShadowPolicies`
descarta el `nextState` de una decisión `hold`, así que `crossPendingZone` no
sobrevive al tick y la política queda en `cross_confirming` para siempre. Su
contrafactual en Métricas está sesgado. Terminal no lo sufre (su estado avanza
en `hold`). Se deja documentado sin tocar porque el aislamiento exige no
cambiar otras políticas en esta integración.

## Pruebas

Servicio puro (umbrales, cierres, confirmación, secante, solver con/sin raíz,
fuera de rango, reentrada, liquidez), adaptador, enrutamiento live sin caída a
legacy, promoción solo tras fill, aislamiento de estados de otras políticas,
sombra, esquema/migración, creación y cliente. Regresiones: `range-exit-*`,
`delta-neutral-*`, `lp-orchestrator-*`, `multi-policy-shadow`.
