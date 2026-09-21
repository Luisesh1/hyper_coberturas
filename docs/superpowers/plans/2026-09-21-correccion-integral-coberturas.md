# Corrección integral de las coberturas delta-neutral

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que una cobertura nunca quede posicionada direccionalmente sin que alguien lo haya decidido. Hoy las tres protecciones vivas necesitan intervención, y la exposición que las puso ahí no la creó ningún bug: la creó una política haciendo exactamente lo que se le pidió, en un régimen para el que no tiene representación.

Este plan **reemplaza** a `2026-09-01-correccion-coberturas.md`. Lo que quedó pendiente de aquél se arrastra aquí, corregido donde el diagnóstico cambió (ver *Herencia*).

---

## Tesis: la exposición es de diseño, la ceguera es de bugs

El hallazgo que ordena todo lo demás: **hay un test que asegura el comportamiento que rompió las coberturas.**

```js
// server/test/net-profit-policy.test.js:131
test('net_profit_v1 no cierra normalmente cuando el target es cero', () => {
  const decision = decideNetProfitV1({
    deltaQty: 0,        // el LP no tiene delta
    actualQty: 1,       // hay un short entero abierto
    currentPrice: 2_000,
  });
  assert.equal(decision.decision, 'hold');   // ← se espera que NO lo cierre
});
```

Eso es, línea por línea, el estado de pp27 hoy (target `0.00308`, actual `0.02260`), asertado como correcto y pasando en verde.

El segundo test relevante (`:145`, el del latch) usa `deltaQty: 1, actualQty: 0.5` a precio `111.5` con techo `110` — delta **máximo** por encima del borde superior, que es imposible en un LP concentrado. Se probó la máquina de estados (`confirming → latched → rearm`) sobre un fixture que contradice la física del instrumento, y nunca la consecuencia de exposición.

Las dos mitades del fallo tienen test cada una. **La combinación que rompió —latcheado *y* delta→0 *y* short grande— no tiene ninguno.**

De ahí el reparto que estructura las fases:

| | Qué son | Qué hicieron | Cómo se arreglan |
|---|---|---|---|
| **Diseño** | latch sin contraparte inferior · `normal_zero_target` sin caducidad · cero tope de notional desnudo en las 3 políticas · margen que rechaza entero en vez de recortar · `nearBoundary` sin contemplar que `outside` es permanente | **Crearon la exposición** | Requieren una decisión de producto (Fase 1) y cambiar los tests que la bendicen |
| **Bugs** | `execution_skipped_because = NULL` en la rama del temporizador · `_normalizeBlockReason` sin match · `policy_version` NULL en pp26 | **La ocultaron y retrasaron la recuperación** | Se arreglan sin discutir nada |

**Ningún bug puso los $53.90 de short desnudo en los libros.** Los bugs son la razón de que te enteres tres días después y no tres minutos después.

### El error de diseño, con precisión

No es que el latch esté mal. La intención es defendible: no tirar el hedge entero porque una lectura de delta dio 0 un tick. Los dos errores son más finos:

1. **Confunde "el delta leyó cero y desconfío" con "el delta es cero de verdad", y no tiene dimensión temporal.** El latch tiene confirmación de 120 s para *entrar*; el hold por target cero no tiene ni confirmación ni caducidad. A los tres días con el precio 6% arriba del rango sigue tratándolo como lectura sospechosa.
2. **Sostiene el *tamaño*, no la *posición*.** Lo correcto era desarmar hasta el delta nuevo y *después* no tocar nada. Sostener el tamaño convierte una protección contra whipsaw en un short direccional.

### La direccionalidad emergente

No hay ningún término de tendencia en el sizing (grepeado `momentum|trend|skew|drift_bias|directional` en las tres políticas, el motor y `delta-neutral-math`: cero resultados). La direccionalidad **emerge** de que dos rechazos sin relación entre sí se sientan en lados opuestos:

| Salida del rango | El LP queda | Delta | El hedge debe | Quién lo impide | Resultado |
|---|---|---|---|---|---|
| **Abajo** (< 2388) | todo ETH | máximo | **crecer** | compuerta de margen (todo-o-nada) | **net largo** en mercado que cae |
| **Arriba** (> 2612) | todo USDC | → 0 | **encogerse** | `upper_exit_latched` | **net corto** en mercado que sube |

El precio hizo las dos en esta ventana. **El sistema queda posicionado contra el breakout en ambas direcciones.**

---

## Estado medido (2026-09-21)

Flota viva: **#51** (pp24, `range_exit_v1`), **#53** (pp26, legacy), **#54** (pp27, `net_profit_v2`) — v4 ETH/USDC. Las tres comparten par, rango (`2388–2612`) y camino de precio, en cuentas HL separadas. Es un control natural:

| pp | orch | política | cobertura | notional desnudo | dist_liq (on-chain) |
|---|---|---|---|---|---|
| 24 | 51 | `range_exit_v1` | **1.01** | $0.05 | 19.4% |
| 26 | 53 | `legacy_zones_v1` (`policy_version` NULL) | **1.08** | $0.79 | 8.5% |
| 27 | 54 | `net_profit_v2` | **7.35** | **$53.90** | 14.7% |

Sólo rompió la que tiene el latch asimétrico. `range_exit_v1` trata `above` y `below` en espejo exacto (`range-exit-policy.service.js:222-239`) y al confirmar el cruce **rebalancea**, no sostiene; legacy no tiene latch y su temporizador de 30 min lo hizo seguir al delta hacia abajo.

> ⚠️ **Simetría de política no es inmunidad.** `range_exit_v1` no tiene asimetría direccional propia, pero **sí quedó expuesta a la del margen**: en la ruptura hacia abajo del 15–16 sep (precio 2371–2420, bajo el piso de 2388) pp24 cayó a cobertura **0.455 / 0.706**. Salir por arriba exige desarmar —que el margen nunca bloquea— y salir por abajo exige crecer —que sí—. La Fase 4 es la que la protege; la Fase 1 no le aplica.

**Esto cierra la tarea A.5 del plan anterior** («acumular sombra cubriendo al menos un tramo tendencial»): el tramo tendencial llegó, y `range_exit_v1` lo atravesó en banda.

Cuenta de pp27 (verificado contra la API pública de HL, coincide con la db al decimal):

```
accountValue 10.95   marginUsed 10.72   withdrawable 0.23
ETH szi -0.0226   entry 2564.27   liqPx 3172.48   uPnl -4.46
```

Preflight en vivo, el mismo tick:

```
driftUsd 53.90  >  minRebalanceNotionalUsd 42.39     ✓
timerDue true   preflightOk true   executionSkippedBecause null
shouldRebalance false                                ← sólo la política
```

Coste operativo del lazo: `protection_decision_log` tiene **6 492 134 filas / 1.79 GB** contra **592 rebalanceos reales** (≈11 000 filas por rebalanceo), sin retención. Ritmo actual **1 760 filas/hora/pool** (lazo de 2 s) contra **120/hora** cuando el precio está dentro del rango.

---

## Herencia del plan del 2026-09-01

| Tarea anterior | Estado real verificado en código | Destino |
|---|---|---|
| 1.1 / 1.2 · Telegram 400 + tests | Hecho (`f018eb8`) | Cerrado |
| 1.5 / 1.6 · Retry que enmascara la causa | **Hecho** (`350af1e`): usa la bandera `err.hlApplicationError`, ya no el regex en español | Cerrado |
| 2.5 · `dist_liq` en vivo | **Hecho** (`c44056f`): el dashboard muestra `dist_liq_vivo` | Cerrado |
| A.1–A.4 · `range_exit_v1` + tests | Hecho | Cerrado |
| 1.3 · `hedge_alerts` + health degradado | No existe en el código | → **Fase 2.5** |
| 1.4 · `coverage_out_of_band` pegajoso | Sigue siendo un `warn` suelto (`evaluate.js:548`) | → **Fase 2.4** |
| 2.1 · Piso de margen | No existe | → **Fase 4.3** |
| 2.2 · Desapalancamiento | No existe | → **Fase 4.4** |
| **2.3 · Cap de sobre-cobertura por ratio** | No existe — **y así debe seguir** | **Corregida** → Fase 3 |
| 3.1 / 3.2 · Reevaluar con datos limpios | Pendiente | → **Fase 6** |
| 4.1–4.3 · Dead zone, `minNotionalUsd` sombra | Pendiente | → **Fase 6** |
| A.5 · Tramo tendencial | **Cumplida por los hechos** (ver *Estado medido*) | Cerrado |
| A.6 / A.7 · Comparar y promover | Pendiente, ahora con datos tendenciales | → **Fase 6** |

> ⚠️ **Corrección al plan anterior.** Su tarea 2.3 proponía *«clampear `targetQty` para que la cobertura no exceda ~1.15»*. **Eso destruiría `range_exit_v1`**: cerca del borde superior su delta tiende a 0 y el ratio se dispara a 40×–290× sin que pase nada anómalo — es su comportamiento correcto. El ratio deja de tener sentido cuando el denominador tiende a cero. La magnitud que sí es finita, comparable entre políticas y económicamente real es el **notional desnudo en USD**. Fase 3 la implementa en lugar del cap por ratio.

---

## Global Constraints

- Servidor en CommonJS (`require`/`module.exports`). No ESM en `server/`.
- Tests de servidor con `node --test`; se ejecutan con `npm --prefix server run test`. Ver memoria `run-server-tests` (node 22 vía nvm + `NODE_ENV=development`).
- Inyección de dependencias existente: constructor recibe `deps = {}` y cae al módulo real con `deps.x || require('./x')`. Nunca se mockea `pg` ni se toca la red en tests.
- Logs estructurados: `this.logger.warn('snake_case_event', { campo: valor })`. Nunca `console.log` en `src/`.
- Lint obligatorio antes de commit: `npm --prefix server run lint`. Respetar `scripts/check-architecture-boundaries.mjs` y `scripts/check-hotspot-sizes.mjs`.
- **Ninguna tarea de este plan escribe en la base de producción.** El diagnóstico va por `scripts/hedge-followup.sh` (read-only con guard anti-escritura). Movimientos de capital y cambios de tamaño de posición los firma el usuario.
- **Contrastar siempre contra la API pública de Hyperliquid antes de alarmar.** Es gratis, de sólo lectura y no necesita credenciales (memoria `hedge-periodic-analysis`).
- Al terminar: rebuild de nginx+server en docker prod y push a `origin/main` (memoria `deploy-and-push-workflow`).

---

## Fase 0 · Contención (hoy, manual, sin deploy)

El precio está 6% arriba del techo del rango. Las tres protecciones no cobran fees y pp27 sostiene un short direccional.

- [ ] **0.1 · Verificar el estado on-chain de las tres cuentas** antes de tocar nada. La db coincide al decimal hoy, pero eso se confirma, no se asume.
- [ ] **0.2 · Cerrar el hedge de pp27.** ✅ **DECIDIDO (2026-09-21): cerrar.** Realiza los −$4.46 no realizados y elimina la exposición direccional. Es lo que el sistema debería haber hecho solo el 18 sep. Preparar los pasos y verificar on-chain antes y después; **la orden la firma el usuario**.
- [ ] **0.3 · Revisar pp26.** `dist_liq` on-chain 8.5%, el más apretado de la flota. No urge, pero es el siguiente si el precio sigue subiendo.
- [x] **0.4 · Los tres LPs fuera de rango se quedan como están.** ✅ **DECIDIDO (2026-09-21): no mover capital.** No se re-centra ni se cierra ningún LP; la corrección va por código. Consecuencia aceptada: siguen sin cobrar fees y el lazo sigue a 2 s hasta que se despliegue la Fase 5.

> Fase 0 **no** es prerequisito de las siguientes. Las fases 1–5 se pueden construir con la flota en el estado que sea.

---

## Fase 1 · La decisión de producto

Todo lo estructural depende de una sola pregunta, y no la puede contestar el código:

> **¿Qué debe hacer un hedge cuando lo que cubría dejó de existir?**

- [x] **1.1 · Política de delta-cero: desarmar al confirmar la salida.** ✅ **DECIDIDO (2026-09-21).**

  El `hold` se conserva **sólo durante el tramo de confirmación** — los mismos 120 s (`UPPER_HYSTERESIS_CONFIRM_MS`) que el latch ya usa para *entrar*. Confirmada la salida, el hedge **se redimensiona al delta nuevo**; no se sostiene el tamaño viejo.

  Esto resuelve los dos errores de diseño de la *Tesis* a la vez: le da al `hold` la dimensión temporal que no tenía (deja de tratar un delta cero de tres días como una lectura sospechosa) y hace que sostenga la *posición correcta* en vez del *tamaño viejo*.

  Alcance: aplica a `net_profit_v1`/`v2` (`upper_exit_latched` y `normal_zero_target`). **No aplica a `range_exit_v1`**, que ya redimensiona al confirmar el cruce, ni a legacy, que no tiene latch.
- [ ] **1.2 · Cambiar los dos tests que bendicen el comportamiento actual.** No es refactor: es el acto que registra la decisión de 1.1.
  - `net-profit-policy.test.js:131` — `normal_zero_target` con `deltaQty: 0, actualQty: 1` asertando `hold`. Debe asertar lo que decida 1.1.
  - `net-profit-policy.test.js:145` — el fixture del latch usa `deltaQty: 1` por encima del techo. Corregirlo a un delta físicamente posible (≈0) y **añadir una aserción sobre la exposición resultante**, no sólo sobre el gate.
- [ ] **1.3 · Añadir el caso que nunca existió:** latcheado **y** delta→0 **y** `actualQty` grande. Es la combinación que rompió y no la cubre ningún test hoy.

---

## Fase 2 · Que el log deje de mentir

Sin esto no se puede verificar ninguna de las fases siguientes: hoy el log dice que todo se ejecutó.

- [ ] **2.1 · Separar diagnóstico de acción en el log de decisiones.** `resolveRebalanceDecision` (`protected-pool-delta-neutral.helpers.js:504`) devuelve `rebalance_full` mirando sólo drift-vs-banda; no sabe nada del temporizador. Lo que gatea la ejecución es `effectiveShouldRebalance` (`evaluate.js:996`, `:1200`), otra variable. Registrar ambas: qué se diagnosticó y qué se ejecutó.
- [x] **2.2 · Que el gate del temporizador escriba su motivo.** ✅ **HECHO (`9a32bc3`).** Cubre las mismas ramas que el gate reusando `legacyDecision.gate`; `riskPausedCanReduce` queda fuera a proposito porque esa rama sí ejecuta. Sin cambio de comportamiento del gate. En `evaluate.js:~1125`, `executionSkippedBecause` se llena con `preflight.ok ? null : …`, así que cuando frena el temporizador queda en `NULL`. Cubrir **todas** las ramas de `:1200` (`forcedStatus`, `!effectiveShouldRebalance`, `decision === 'hold'`, `!preflight.ok`), cada una con su motivo.
  - Evidencia de por qué importa: pp26 registró **2 870 `rebalance_full` con `skip=NULL` el 09-12 y ejecutó 0**. Igual el 09-13 (2 860 → 0).
- [x] **2.3 · Arreglar `_normalizeBlockReason`** ✅ **HECHO (`9a32bc3`).** Se matchea `"sufficient margin"`, substring de la forma negativa, que cubre las tres variantes sin enumerar frases. (`protected-pool-delta-neutral.service.js:361`). Busca `'insufficient margin'`; HL responde `"Account does not have sufficient margin available for increasing position"` — contiene `"sufficient margin"` pero **no** `"insufficient margin"`, así que no matchea y la frase entera se guarda cruda como categoría propia. El 09-18 eso partió el mismo evento en 41 filas normalizadas y **355 crudas**. Normalizar por la bandera/el código, no por substring, o cubrir ambas formas con un test que use el texto literal de HL.
- [x] **2.4 · `coverage_out_of_band` pegajoso y con severidad.** ✅ **HECHO (`4e1e9d5`).** Mide **notional en USD**, no ratio (un umbral por ratio marcaría rota a `range_exit_v1` de forma permanente; hay test que lo fija). Materialidad = $15 **y** 5% del pool. Escalones 15 min / 1 h / 6 h, se avisa sólo al cruzar uno. Verificado contra la flota: pp24 y pp26 en silencio, pp27 → `critical`. Esto adelanta también la **Fase 3.1**: el notional desnudo ya es una magnitud de primera clase (`nextState.nakedNotionalUsd`). Hereda la 1.4 del plan anterior. El evento ya dispara —**5 265 veces en 3 horas**— y sigue siendo un `warn` suelto (`evaluate.js:548`). Si la cobertura queda fuera de `[0.85, 1.15]` más de N minutos consecutivos, emitir **una** alerta con severidad creciente en vez de miles de warns idénticos. Reusar el throttle/dedupe existente.
- [ ] **2.5 · Segundo canal que no dependa de Telegram.** Hereda la 1.3. Persistir alertas críticas en tabla y exponer el estado en `/api/health`, de modo que una protección con notional desnudo **degrade el health check**. Usar un campo de severidad en la respuesta, no un 503 seco (ver *Riesgos*).
- [x] **2.6 · Que el estado reportado refleje la exposición.** ✅ **HECHO (`4e1e9d5`).** Nuevo estado `naked_exposure`, colocado detrás de `rebalance_pending` a propósito. El cliente degrada a texto crudo (`HEDGE_STATUS_LABELS[...] || status`), así que no rompe UI. Hoy las tres se reportan `strategy_status: tracking`, `fallos: 0`, `ult_error` vacío, mientras pp27 carga $53.90 desnudos. Un `hold` que sostiene exposición direccional no es `tracking`.
- [x] **2.7 · Tests de 2.2–2.3** ✅ **HECHO (`9a32bc3`, `delta-neutral-decision-log-truth.test.js`, 5 casos).** Incluye los dos casos simétricos: una ejecución real no se marca bloqueada, y un `hold` genuino conserva `skip = null`. ⚠️ El target se le **pregunta al motor**, nunca se fija a mano: depende del multiplicador de zona, que sale del `.env` que el cwd decida cargar (raíz → default 0.6; `server/` → 1.0). Con el valor hardcodeado el test pasaba aislado y fallaba en la suite. Tests originales de 2.1–2.3 con `deps` inyectados: el gate del temporizador escribe motivo; el texto literal de HL se normaliza; diagnóstico y acción no se pisan.

---

## Fase 3 · Invariante de notional desnudo

Reemplaza a la tarea 2.3 del plan anterior. **El ratio no sirve como límite; el notional en USD sí.**

- [ ] **3.1 · Definir `nakedNotionalUsd` como métrica de primera clase.** `|actualQty − deltaQty| × precio`. Es finita, comparable entre las tres políticas y económicamente real incluso cuando el delta es 0 y el ratio explota. Emitirla en `delta_neutral_delta_diagnostic` y persistirla en el log de decisiones.
- [ ] **3.2 · Tope duro de notional desnudo, transversal a la política.** Debe vivir **por encima** de las políticas, no dentro: es un límite de riesgo, no una decisión de cobertura. Ninguna de las tres lo tiene hoy. Cuando se supere, la corrección se ejecuta aunque la política diga `hold` — con su propio evento y su propia alerta.
  - Valor inicial sugerido: un porcentaje del valor del LP, no un absoluto, para que escale con el capital. La memoria `shadow-vs-legacy-eval` ya documenta que los pisos absolutos (`max(11, 3×coste)`) no escalan y dejan la política inerte en pools chicos.
- [ ] **3.3 · Hacer alcanzable el escape de riesgo de `net_profit`.** `riskToInner` (`net-profit-policy.service.js:167`) hoy sólo sobrescribe el gate de `daily_rotation_budget`, y el latch retorna en `:130`, **antes** de que se calcule. Un escape de riesgo que no puede dispararse en el estado de riesgo no es un escape.
- [ ] **3.4 · Tests:** el tope dispara con la política en `hold`; el ratio alto de `range_exit_v1` cerca del borde **no** lo dispara (es la regresión que mataría esa política); `riskToInner` alcanzable estando latcheado.

---

## Fase 4 · El rectificador de margen

La compuerta de margen sólo existe en la dirección de crecer, y cuando bloquea **rechaza la orden entera en vez de recortarla**. Medido sobre 25 días: **56 722 bloqueos con el hedge corto contra 664 con el hedge largo — 98.8% en una sola dirección.**

- [ ] **4.1 · Recortar la orden a lo que el margen permite, en vez de rechazarla.** `protected-pool-delta-neutral.service.js:930`:
  ```js
  if (targetIncreaseQty > 0 && incrementMarginUsd > availableForIncrementUsd) {
    return { ok: false, reason: 'insufficient_margin' };   // todo o nada
  }
  ```
  Con recorte, pp24 habría entrado al ~60% en vez de al 0% y completado en el tick siguiente. En su lugar se quedó **siete días** en `actual_qty = 0.00010` contra un target de `0.068` (descubierto medio $170, pico $270).
  - Respetar el mínimo del exchange: si lo recortado cae bajo `minOrderNotionalUsd`, no enviar — pero **registrar la diferencia entre "no cabe nada" y "no cabe todo"**, que hoy son el mismo `insufficient_margin`.
- [ ] **4.2 · Distinguir bloqueo total de bloqueo parcial** en el log y en la alerta. Son dos situaciones con acciones distintas.
- [ ] **4.3 · Invariante de piso de margen.** Hereda la 2.1. Antes de abrir o crecer un LP, exigir margen suficiente para el delta objetivo con holgura que absorba el drawdown del hedge — que hoy consume margen sin vía de reposición.
- [ ] **4.4 · Camino de desapalancamiento cuando el piso no se cumple.** Hereda la 2.2. Hoy, si no puede cubrir, el sistema sostiene el LP desnudo indefinidamente. Debe reducir el LP hasta el tamaño que sí puede cubrir. Detrás de un flag y avisando antes de actuar (ver *Riesgos*).
- [ ] **4.5 · Tests de 4.1–4.4** con `deps` inyectados: recorte que entra parcial; recorte que queda bajo el mínimo y no se envía; piso que bloquea el crecimiento; desapalancamiento que se dispara.

---

## Fase 5 · El amplificador del lazo

- [ ] **5.1 · Que `outside` no saltee el throttle indefinidamente.** `protected-pool-delta-neutral.service.js:1160`:
  ```js
  if (!evalDue && !crossedBoundary && !nearBoundary) return;
  ```
  `nearBoundary` incluye `zoneState === 'outside'`, que fuera de rango es permanentemente cierto → evaluación completa cada 2 s y no vuelve. El diseño está invertido: el camino urgente, pensado para un cruce transitorio, se vuelve permanente cuando el precio se estaciona afuera — que es cuando el LP no cobra fees y debería trabajar *menos*, no 15× más.
  - Distinguir **cruce** (transitorio, merece urgencia) de **estar afuera** (estacionario, merece la cadencia larga).
- [ ] **5.2 · Retención en `protection_decision_log`.** 6.49 M filas / 1.79 GB contra 592 rebalanceos. Definir política de retención o agregación. Sin 5.1 esto sólo tapa el síntoma, así que va después.
- [ ] **5.3 · Test:** una protección fuera de rango de forma sostenida vuelve a la cadencia larga; un cruce sigue disparando evaluación inmediata.

---

## Fase 6 · Reevaluar con datos limpios

No empieza hasta que 2–5 estén desplegadas. Es la lección que este repo ya aprendió dos veces: **instrumentar antes de diagnosticar.**

- [ ] **6.1 · Correr 7–10 días sin tocar política.** Primera ventana en que la distribución de cobertura mide *política* y no capacidad de ejecución ni ceguera.
- [ ] **6.2 · Recomputar la distribución** y compararla contra la tabla de *Estado medido*.
- [ ] **6.3 · Comparar las cuatro políticas con el tramo tendencial ya incluido.** `scripts/shadow-vs-legacy.sh`, descontando los sesgos documentados en `shadow-vs-legacy-eval` (funding sin escalar por qty, slippage optimista, qty continua, baseline sin coste de apertura). Hereda A.6.
- [ ] **6.4 · Migrar pp26.** Tiene `policy_version` NULL, residuo del bug de persistencia corregido en `fa2b73a`. Las protecciones creadas en esa ventana no se migraron: hay que **recrearlas**, editar la config del orquestador no las cambia. Comprobar con `activeHedge.livePolicy`, nunca con `protectionConfig`.
- [ ] **6.5 · Decidir sobre el dead zone y el `minNotionalUsd` de la sombra** con ese resultado. Hereda 4.1–4.3.

---

## Criterios de salida

El plan está terminado cuando, sostenido 7 días:

| criterio | hoy | objetivo |
|---|---|---|
| notional desnudo máximo sostenido | **$53.90 (72 h)** | **< tope de 3.2, y nunca >15 min por encima** |
| cobertura en banda ±10% (dentro de rango) | 1.01 / 1.08 / **7.35** | **las tres en banda** |
| decisiones `rebalance_full` con `skip=NULL` que no ejecutan | **2 870/día** | **0** |
| filas de decisión por hora fuera de rango | **1 760** | **≤120** |
| eventos `coverage_out_of_band` entregados | **0 / 5 265 (3 h)** | **1 alerta por episodio** |
| `insufficient_margin` que rechaza entero pudiendo entrar parcial | 98.8% de los bloqueos | **0** |
| minutos con exposición direccional sin avisar | ~4 300 | **<15** |

El neto positivo **no** es criterio de salida. Es consecuencia de la Fase 6, y la Fase 6 no puede empezar hasta que las anteriores estén medidas. Prometer aquí un PnL positivo sería repetir el error de método que este plan corrige.

---

## Riesgos del plan

- **La Fase 1 es una decisión, no una tarea.** Si se salta y se implementa la Fase 3 sola, el tope de notional queda haciendo de política de facto: el sistema desarmará por límite de riesgo en vez de por intención. Funciona, pero deja la intención sin escribir en ninguna parte — que es exactamente cómo llegamos acá.
- **La Fase 0(a) y la 4.4 realizan pérdidas** que hoy están sin realizar. Es deliberado: una pérdida acotada y elegida domina a una exposición direccional abierta e involuntaria. Ambas detrás de confirmación explícita.
- **La Fase 2.5 (health degradado) marca el contenedor como unhealthy.** Verificado: `docker-compose.prod.yml` usa `restart: unless-stopped` y no hay autoheal, así que Docker **no** reinicia por unhealthy. Lo que sí importa es `depends_on: condition: service_healthy`: un server unhealthy podría frenar el arranque de nginx en el próximo deploy. Usar severidad en la respuesta, no un 503 seco.
- **La Fase 3 puede romper `range_exit_v1` si se implementa como cap de ratio.** Es el error que este plan corrige del anterior. El test de 3.4 existe precisamente para que esa regresión no pase en silencio.
- **La Fase 6 puede concluir que `net_profit_v2` no debe promoverse.** Sería un resultado válido: en el único tramo tendencial medido quedó 7.35 mientras las otras dos quedaron en banda. Hay que estar dispuesto a aceptarlo.
- **Arreglar el log (Fase 2) va a hacer aparecer fallos que hoy no se ven.** No son nuevos: estaban ocurriendo y no se registraban. Esperar un salto en el conteo de bloqueos y no leerlo como regresión.

---

## Anexo · Lo que se descartó, para no volver a investigarlo

Medido en esta ronda y **no** es causa de nada:

- **El target nunca excede el delta por diseño.** `DEFAULT_TARGET_HEDGE_RATIO = 1`; los multiplicadores de zona topan en `1` (`edge`), y center/transition están en `1.0` en producción vía `.env` desde julio (el default del código sigue en `0.6` — esa brecha es conocida y está documentada).
- **La ejecución no tiene sesgo.** Distribución post-rebalanceo sobre 240 rebalanceos: media `0.9997`, 121 quedaron sobre y 119 sub. Único matiz: `boundary_cross` termina consistentemente algo por encima (media `1.0223`, 8/3, mínimo `1.000`, n=11) — coherente con que el delta caiga más rápido que el fill. No es la historia.
- **El redondeo de lote sesga hacia abajo.** `formatSize` (`utils/format.js:20`) **trunca**, no redondea.
- **No hay término de tendencia en el sizing.** Grep de `momentum|trend|skew|drift_bias|directional` en las tres políticas, el motor y `delta-neutral-math`: cero resultados.
- **La reconstrucción de liquidez y el delta v4 están sanos.** `modelValueRatio` en 1.00–1.05.
- **La db coincide con Hyperliquid al decimal.** Los fallos son de decisión y de capacidad de ejecución, no de reconciliación.
