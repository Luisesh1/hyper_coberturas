# Corrección de las coberturas delta-neutral

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que una cobertura nunca se degrade en silencio. Hoy el sistema *sabe* que está descubierto, lo *detecta*, lo *loguea* — y aun así se queda 25 h sosteniendo un LP desnudo sin que nadie se entere. Ese es el defecto a corregir, no el ratio de cobertura.

## Tesis: qué mutar y qué no

La pregunta de origen fue si conviene mutar el comportamiento actual de las coberturas. La respuesta corta: **sí, pero no la política de cobertura — todavía.**

Hay dos clases de problema y se están confundiendo:

- **Clase A · Capacidad y visibilidad.** El hedge no puede ejecutar (margen agotado), y cuando falla nadie se entera (canal de alertas caído, causa real descartada). Esto son bugs. No hay trade-off que discutir: se arreglan.
- **Clase B · Política de cobertura.** Dead zone central, umbrales de rebalanceo, multiplicadores de zona. Aquí sí hay trade-offs reales entre costo de ejecución y residual.

**No se puede evaluar la Clase B mientras la Clase A esté rota.** La distribución de cobertura de pp18 esta semana (17% en banda, p05 = 0.147) es **100% fallo de ejecución**, no de política. Cualquier cambio de política desplegado hoy se mediría contra datos contaminados y se le atribuiría —bien o mal— un efecto que no es suyo.

Hay precedente directo de ese error en este mismo repo: el plan del 2026-08-10 nació persiguiendo una sub-cobertura que **no existía** (era `hedge_beta`, un estimador roto), y la Fase 2 entera se eliminó cuando la instrumentación demostró que el problema era imaginario. La lección que ese plan dejó escrita —*instrumentar ANTES de diagnosticar*— aplica igual acá.

**El patrón de fondo.** El sistema no carece de detectores. Los tiene todos, y todos funcionan:

| detector | ¿dispara? | qué pasa con la señal |
|---|---|---|
| `delta_neutral_coverage_out_of_band` | sí, 10,361 veces en 29 h | queda en un `warn` de log |
| preflight `insufficient_margin` | sí, cada ciclo | notifica a Telegram → **400, descartado** |
| retry de `updateIsolatedMargin` | sí | reintenta con el mismo nonce → **pisa la causa real** |
| `telegram_api_error` | sí, 24/24 | loguea `err.message` genérico, **tira `description`** |
| `dist_liq_pct` del dashboard | sí | lee de la db, que **sólo se escribe al rebalancear** |

Cinco detectores, cinco señales destruidas antes de llegar a un humano. **El modo de fallo del sistema no es ceguera: es afasia.** Por eso el plan ataca primero el camino de la señal (Fase 1) y la capacidad de actuar (Fase 2), y deja la política para el final (Fase 4), cuando por fin se pueda medir.

## Contexto medido (2026-09-01)

Flota viva: **#45** (pp18, $330), **#46** (pp19, $330), **#47** (pp20, $450) — v4 ETH/USDC, activos desde el 26 ago (6.4 días). Los #42/43/44 se archivaron el 26 ago.

La ventana fue **el escenario ideal para delta-neutral**: ETH lateral (2464 → 2453 de promedio, sin tendencia neta), time-in-range 96–100%, fees +$24.11. Y aun así:

| orch | pp | fees | h_real | drift | **net** | %cap | dead zone |
|---|---|---|---|---|---|---|---|
| 45 | 18 | 9.39 | −11.63 | −3.35 | **−7.13** | −2.16% | 35 |
| 46 | 19 | 5.95 | −8.87 | −2.90 | **−6.70** | −2.03% | 35 |
| 47 | 20 | 8.77 | −8.71 | −4.39 | **−3.95** | −0.88% | 0 |

**−$17.78 en 6.4 días ≈ −70% anualizado.** Señal diagnóstica: *drift y hedge negativos a la vez*. Si estuvieras cubierto, uno compensaría al otro. Los dos en rojo = la cobertura tenía el tamaño equivocado en el momento equivocado, repetidamente.

El costo de ejecución **no** es el sumidero esta vez: $3.60 en la ventana (0.32% del capital, ~18% anualizado, contra el 34% de agosto). El sumidero es el residual.

### Distribución de cobertura, 7d (`protection_decision_log`)

| pp | media | p05 | p95 | en banda ±10% | <0.8 | >1.2 |
|---|---|---|---|---|---|---|
| 18 | 1.082 | 0.147 | 2.226 | **17.3%** | 38.3% | 31.9% |
| 19 | 1.095 | 0.721 | 1.420 | 34.9% | 6.7% | 31.1% |
| 20 | 1.028 | 0.832 | 1.212 | **58.1%** | 2.6% | 5.7% |

### Los tres hallazgos accionables

**(A) pp18 lleva ~25 h sin poder cubrirse: se quedó sin margen.** Verificado contra Hyperliquid (coincide al decimal con la db):

```
cuenta 1   accountValue $20.38   withdrawable $0.004
           szi -0.051 ETH        target 0.093     → cobertura 0.55
           requiredMarginUsd $10  →  "Insufficient margin to place order"
```

`shouldRebalance: true, preflightOk: true` cada ciclo, y la orden rebota. No es el gate del temporizador ni el multiplicador de zona: es capacidad.

**El mecanismo es procíclico.** La cuenta HL bajó de $31.76 (26 ago) a $20.38 — exactamente el `hedgeRealizedPnl` de −11.63. Las pérdidas del hedge se descuentan del mismo pozo de margen que dimensiona el hedge, y **no existe ninguna vía de reposición**: no hay `usdTransfer`/`spotTransfer` ni camino LP→HL en el código, y `_maybeTopUpMargin` (`margin.js:158`) sólo mueve fondos que ya estén en cross — la cuenta 1 tiene $0.004 ahí. Un hedge que pierde reduce su propia capacidad de cubrir, sin piso.

**#46 es el siguiente**: $25.69 contra $247 de notional = 9.6x efectivo, withdrawable $0.80, distancia real a liquidación **7.9%** (bajo el umbral de 8%; el dashboard reporta 8.2%).

Trampa a recordar: `dist_liq` de pp18 marca 14.2%, el número más "sano" de la flota — **está verde justamente porque el short es demasiado chico**. La métrica de riesgo premia la cobertura rota.

**(B) La sobre-cobertura es lo que quemó el margen.** El 29–30 ago pp18 estuvo en **1.4–1.7** durante ~20 h seguidas. Sobre-cubrir no es conservador: es un short desnudo, y consume margen que después falta. El 31.9% del tiempo sobre 1.2 en pp18 y 31.1% en pp19 no es ruido de ejecución, es exposición direccional no pedida.

**(C) El dead zone bloquea rebalanceos materiales.** En pp19 (que *sí* podía ejecutar): 3,577 bloqueos en 29 h, drift mediano $30.43, máximo $135, y **1,555 de ellos (43.5%) con el drift por encima del mínimo de rebalanceo ($36)**. No está filtrando ruido.

El `centerDeadZonePct` se agregó como dial de costo y **funcionó para eso** (18% anualizado vs 34%). Pero el intercambio salió mal: pp19 ahorró $0.53 de ejecución contra pp20 y perdió $2.75 más de neto. La ironía está en el propio `config/index.js:180`, donde el comentario de `zoneHedgeMultiplierCenter` ya advierte que *"en mercados tendenciales ese 40% sin cubrir es el mayor componente de pérdida"* — el dead zone reintroduce esa misma exposición por la puerta de la **decisión** en vez de la del **sizing**.

> ⚠️ **Confounds de (C), a respetar.** pp19 vs pp20 es n=1 por brazo y difieren también en fee tier (500 vs 3000) y capital ($330 vs $450). Es una hipótesis fuerte con una comparación natural ya montada, **no** un resultado. Por eso el cambio de dead zone vive en la Fase 4 detrás de un experimento, no en la Fase 0.

## Global Constraints

- Servidor en CommonJS (`require`/`module.exports`). No ESM en `server/`.
- Tests de servidor con `node --test`; se ejecutan con `npm --prefix server run test`. Ver memoria `run-server-tests` (node 22 vía nvm + `NODE_ENV=development`).
- Inyección de dependencias existente: constructor recibe `deps = {}` y cae al módulo real con `deps.x || require('./x')`. Nunca se mockea `pg` ni se toca la red en tests.
- Logs estructurados: `this.logger.warn('snake_case_event', { campo: valor })`. Nunca `console.log` en `src/`.
- Lint obligatorio antes de commit: `npm --prefix server run lint`.
- **Ninguna tarea de este plan escribe en la base de producción.** El diagnóstico va por `scripts/hedge-followup.sh` (read-only con guard anti-escritura). Movimientos de capital y cambios de tamaño de posición los firma el usuario.
- Al terminar: rebuild de nginx+server en docker prod y push a `origin/main` (memoria `deploy-and-push-workflow`).

---

## Fase 0 · Contención (hoy, manual, sin deploy)

Sangra mientras se lee esto. Nada de esta fase requiere código.

- [ ] **0.1 · Decidir pp18: fondear o encoger.** Faltan ~$10–15 de margen para cubrir el delta actual. Dos caminos, los dos válidos, los firma el usuario:
  - fondear la cuenta HL 1 con ~$25 (deja buffer, no sólo el mínimo), o
  - reducir el LP de pp18 hasta que el delta quepa en $20 de margen (≈ $200 de LP a 10x).
  Si no se hace ninguno, pp18 sigue con ~$100 de delta desnudo.
- [ ] **0.2 · Revisar #46.** Distancia real a liquidación 7.9%, withdrawable $0.80. Mismo par de opciones que 0.1. Verificar contra Hyperliquid, no contra el dashboard.
- [ ] **0.3 · Verificar el estado real de las tres cuentas** con la API pública de HL antes y después de cualquier movimiento (memoria `hedge-periodic-analysis`, sección de verdad on-chain). La db coincide al decimal hoy, pero eso se confirma, no se asume.

## Fase 1 · Que ningún fallo sea silencioso

Esta es la fase que responde literalmente a *"evitar situaciones como la actual"*. Sin ella, todo lo demás se vuelve a romper sin aviso.

- [x] **1.1 · Arreglar el 400 de Telegram. RESUELTO (2026-09-01).**
  - **Instrumentación:** `describeTelegramError()` en `external-service-helpers.js` rescata `error_code`/`description` del cuerpo de la respuesta; `telegram_api_error` ahora loguea `description`, `errorCode`, `httpStatus`, `chatId` y `parseMode`. Antes sólo el `err.message` de axios, que siempre dice lo mismo.
  - **Causa raíz encontrada:** `execution.js:86` arma el motivo `` `Drift $${driftUsd} < minimo $${minNotionalUsd}` `` — con un **`<` literal** — y `notifyDeltaNeutralBlock` lo interpolaba **sin escapar** en un mensaje con `parse_mode: 'HTML'`. Telegram respondía `can't parse entities: Unsupported start tag "" at byte offset 127` y **descartaba el mensaje entero**. Explica los 23 de 24 fallos precedidos por `delta_neutral_drift_below_exchange_minimum`.
  - **Descartado por medición, no por intuición:** el token es válido (`getMe` → `@alertas_coverturas_bot`), el chat existe y es alcanzable (`getChat` OK, y tres envíos de prueba entregados), y el `&` sin escapar del `href` en `alerts.service.js:479` **no** rompe el parser. La sonda usó un `chat_id` inexistente para leer el error de parseo sin enviar nada — método validado antes de confiar en él: Telegram parsea las entidades ANTES de resolver el chat (un `<blink>` contra el chat falso devuelve el error de parseo, no `chat not found`).
  - **Arreglo:** `escapeHtml()` a nivel de módulo en `telegram.service.js`, aplicado a **todo texto libre** que entra en un template HTML — motivo, detalle, `cooldownReason`, `positionReadSource`, símbolos de token, activo inferido, `err.message`, `payload.message`/`stage`/`actionTaken`, `hedge.label` y alias/wallet de cuenta. No sólo el sitio que falló: la clase de bug es "texto libre llega a un mensaje parseado como HTML".
  - **Verificado end-to-end:** el mensaje exacto que llevaba 40 h rebotando se entregó al chat real.
- [x] **1.2 · Tests** (`server/test/telegram-html-escaping.test.js`, 5 casos): orden de escapado (`&` primero), el motivo real que rompía, detalle/símbolos/cooldown con `<>&`, `err.message` en el error de cobertura, y que `describeTelegramError` rescate la causa sin inventar nada cuando no hay respuesta. Uno de los tests recorre el texto final y falla si queda cualquier `<` que no abra una etiqueta permitida.
- [ ] **1.3 · Un segundo canal que no dependa de Telegram.** Un canal único de alerta es un punto único de fallo, y ya falló. Persistir las alertas críticas en una tabla (`hedge_alerts`) y exponer el estado en `/api/health`, de modo que un pool descubierto **degrade el health check**. Un healthcheck verde con una cobertura de 0.44 es el bug de diseño real.
- [ ] **1.4 · Escalar `coverage_out_of_band` de `warn` a alerta con estado.** El evento ya existe y dispara (10,361 veces en 29 h en los tres pools). Le falta ser *pegajoso*: si la cobertura queda fuera de `[0.85, 1.15]` durante más de N minutos consecutivos, emitir una alerta con severidad creciente en vez de 10 mil warns idénticos. Reusar el throttle/dedupe que ya existe en `protected-pool-delta-neutral.service.js:517-527`.
- [ ] **1.5 · Arreglar el retry que enmascara la causa en Hyperliquid.** `hyperliquid.service.js:236-243`: el guard que evita reintentar rechazos aplicativos filtra por una **lista de mensajes en español**, pero cuando HL responde `status:'err'` la línea 222 lanza el **texto crudo de HL** (`"Position does not have sufficient margin for reduction."`), que no matchea ningún patrón; y como es un throw propio, `err.response` es `undefined` y `looksTransient` da `true`. Se reintenta con **el mismo nonce** (`_sendAction:424` lo fija una sola vez) y HL siempre contesta `Invalid nonce: duplicate nonce`. El reintento **no puede funcionar nunca** y pisa el error verdadero.
  Corrección: marcar el throw de la línea 222 con una bandera (`err.hlApplicationError = true`) y decidir por ella, no por regex sobre el mensaje. Si en el futuro se quisiera reintentar de verdad una acción de exchange, hay que **refirmar con nonce nuevo**.
- [ ] **1.6 · Test: un rechazo aplicativo de HL no se reintenta.** Cubrir explícitamente el texto crudo en inglés que hoy se escapa del regex. >1,300 filas de `protection_decision_log` el 31 ago registraron "Invalid nonce" como causa cuando la causa era otra.

## Fase 2 · Capacidad: que la cobertura no pueda quedarse sin balas

- [ ] **2.1 · Invariante de piso de margen.** Antes de abrir o crecer un LP, exigir `margen_disponible >= delta_objetivo × precio / leverage × 1.3`. El 1.3 no es decoración: absorbe el drawdown del hedge que hoy consume el margen sin reposición.
- [ ] **2.2 · Camino de desapalancamiento cuando el piso no se cumple.** Hoy, si no puede cubrir, el sistema **sostiene el LP desnudo indefinidamente**. Debe hacer lo contrario: reducir el LP hasta el tamaño que sí puede cubrir. Un LP más chico y cubierto domina a uno grande y desnudo — es exactamente la situación de pp18 estas 25 h. Respetar el `MARGIN_COOLDOWN_MS` y los caps de `_maybeTopUpMargin` existentes; esto es una ruta nueva, no un bypass de las que hay.
- [ ] **2.3 · Cap de sobre-cobertura.** Clampear `targetQty` para que la cobertura no exceda ~1.15. Por encima de eso no es cobertura, es un short direccional: nadie lo pidió, y es lo que quemó el margen de pp18 el 29–30 ago (1.4–1.7 durante ~20 h). Un cap explícito con su propio log es preferible a que emerja del redondeo.
- [ ] **2.4 · Tests de los tres anteriores**, con `deps` inyectados (nunca red ni `pg`): piso que bloquea el crecimiento, desapalancamiento que se dispara, cap que clampea y loguea.
- [ ] **2.5 · `dist_liq` en vivo, no de la db.** La columna sólo se escribe **cuando ocurre un rebalanceo**, así que el `min()` de la ventana se congela justo cuando no hay actividad — y puede errar en ambos sentidos (memoria `hedge-periodic-analysis`: reportaba #37 en 13.7% cuando el real era 8.4%). Hoy volvió a fallar: dashboard 8.2% para pp19, on-chain 7.9%. La API `info` de HL es pública, gratis y sin credenciales.

## Fase 3 · Reevaluar con datos limpios

- [ ] **3.1 · Correr 7–10 días con Fases 0–2 desplegadas y sin tocar la política.** Es la línea base honesta: la primera ventana en que la distribución de cobertura mide **política** y no capacidad de ejecución.
- [ ] **3.2 · Recomputar la distribución** (`protection_decision_log`, query de la memoria `hedge-periodic-analysis`) y compararla contra la tabla de este documento. Si pp18 salta de 17% a ~55% en banda sin cambiar un solo parámetro de política, queda demostrado que el problema era Clase A y que la Fase 4 puede ser mucho más chica de lo que parece hoy.

## Fase 4 · Política de cobertura (sólo después de la Fase 3)

- [ ] **4.1 · Experimento explícito del dead zone.** Es la comparación natural que ya existe (pp18/pp19 en 35, pp20 en 0) pero hoy confundida por fee tier, capital y el fallo de margen de pp18. Con la Fase 2 puesta, rotar el valor entre pools para separar el efecto del dead zone del efecto del pool. Métrica de decisión: **neto**, no costo de ejecución — el error de agosto fue optimizar el costo en aislamiento.
- [ ] **4.2 · Decidir sobre el dead zone con ese resultado.** La hipótesis actual es que 35 es demasiado alto para un rango de ~8.5% con ETH moviéndose ±3% diarios, y que el valor correcto está más cerca de 0–15. No cambiarlo antes del experimento: es precisamente el atajo que produjo esta situación.
- [ ] **4.3 · Revisar el piso `minNotionalUsd` de la política sombra** a la luz de lo anterior. La memoria `shadow-vs-legacy-eval` ya documenta que `max(11, 3×coste)` no escala con el capital y deja la sombra inerte en pools chicos; cualquier cambio de umbral aquí hereda ese problema.

## Criterios de salida

El plan está terminado cuando, sostenido 7 días:

| criterio | hoy | objetivo |
|---|---|---|
| cobertura en banda ±10% | 17–58% | **>70% en los tres** |
| tiempo con cobertura <0.8 | 2.6–38.3% | **<5%** |
| tiempo con cobertura >1.2 | 5.7–31.9% | **<5%** |
| distancia a liquidación (on-chain) | 7.9–14.2% | **>10% en los tres** |
| alertas entregadas / disparadas | **0 / 10,361** | **100%** |
| minutos de cobertura rota sin avisar | ~1,500 | **<15** |

El neto positivo **no** es criterio de salida de este plan. Es consecuencia de la Fase 4, y la Fase 4 no puede empezar hasta que las tres primeras estén medidas. Prometer aquí un PnL positivo sería repetir el error de método que este plan corrige.

## Riesgos del plan

- **La Fase 2.2 (desapalancar) puede realizar pérdidas** que hoy están sin realizar. Es deliberado: preferimos una pérdida acotada y elegida a una exposición direccional abierta e involuntaria. Debe quedar detrás de un flag y avisar antes de actuar.
- **La Fase 1.3 (health degradado) marca el contenedor como unhealthy.** Verificado: `docker-compose.prod.yml` usa `restart: unless-stopped` y no hay autoheal, asi que Docker **no** reinicia por unhealthy — no hay riesgo de restart loop. Lo que si importa es `depends_on: condition: service_healthy`: un server unhealthy podria frenar el arranque de nginx en el proximo deploy. Usar un campo de severidad en la respuesta de `/api/health` en vez de un 503 seco, o un endpoint aparte.
- **La Fase 4 puede concluir que el dead zone estaba bien** y que el residual era todo Clase A. Sería el mejor resultado posible y hay que estar dispuesto a aceptarlo — es exactamente lo que pasó con la Fase 2 del plan del 2026-08-10.

---

## Anexo · Cobertura nueva: `range_exit_v1` (cobertura por borde de rango)

**Pedido:** cubrir el 100% del delta al abrir y no volver a tocar el hedge hasta que el precio salga del rango del LP o vuelva a entrar, corriendo un poco el trigger para cubrir comisiones.

**Estado: implementada como política SOMBRA.** No ejecuta. Corre en contrafactual sobre los mismos ticks que la viva, en `server/src/services/range-exit-policy.service.js`, registrada en el motor multi-política. Eso la hace consistente con la tesis de este plan: una política no se promueve por opinión, se promueve con datos.

### Por qué el borde es el punto correcto de rebalanceo

No es una elección arbitraria. El delta de un LP concentrado **sólo cambia dentro del rango**: por encima del borde superior el LP quedó todo en estable y el delta es 0; por debajo del inferior quedó todo en volátil y el delta es el máximo. La gamma se apaga exactamente en el borde. Rebalancear ahí es rebalancear donde el ajuste es exacto y permanente hasta el próximo cruce, en vez de perseguir un delta que se mueve.

### El intercambio, sin adornos

Dentro del rango la posición queda con **gamma negativa sin cubrir**. El LP es cóncavo en precio y un short estático es lineal, así que la suma pierde con movimiento en cualquier dirección y gana con quietud (más las fees). Esta política **no elimina ese costo: elige pagarlo como divergencia en vez de como comisiones**. Es la apuesta correcta cuando el costo de ejecución domina a la volatilidad realizada dentro del rango, y la equivocada cuando pasa lo contrario.

**No confundir con el viejo `zoneHedgeMultiplierCenter = 0.6`.** Aquél sub-cubría de forma *permanente* un 40% del delta, así que en tendencia el hueco sólo crecía. Éste abre en 1.0, la divergencia arranca en cero, es simétrica alrededor del punto de apertura, y el cruce de borde le pone un techo. Se parecen en la forma y se diferencian en lo que importa: el sesgo y el tope.

### El corrimiento del trigger, derivado del costo

El pedido fue "correr un poco el trigger para cubrir comisiones". La forma honesta de elegir ese *poco* es preguntarle al costo: cruzar implica un ajuste de `adjustQty` y volver a entrar implica deshacerlo, así que el viaje redondo cuesta ~2× la comisión de ese ajuste. Se pide que el movimiento más allá del borde le gane a ese costo con margen:

```
adjustQty × movimiento ≥ COST_COVERAGE_MULTIPLE × 2 × comisión(adjustQty)
```

Y aparece el resultado que importa: la comisión de Hyperliquid es **puramente proporcional** al notional (`size × price × rate`, sin componente fija), así que al despejar **`adjustQty` se cancela**. El offset de equilibrio no depende del tamaño:

```
offsetPct = 2 × COST_COVERAGE_MULTIPLE × takerFeeRate   →   0.10% con el taker en 0.00025
```

Se dejó escrito como función de la tasa y no de la cantidad, porque una versión que recibiera `adjustQty` para después ignorarlo aparentaría una sofisticación que no tiene. Si algún día el costo gana una parte fija (gas, piso de notional), la cancelación se rompe y ese es el lugar donde hay que volver a meter el tamaño. Un test fija ese invariante.

Además del offset hay **confirmación temporal** de 120 s (`CROSS_CONFIRM_MS`, el mismo criterio que la histéresis de `net_profit`): una mecha que pincha el borde y vuelve no es una salida del rango. El offset se aplica siempre en el sentido que hace *más difícil* el cruce — al salir hay que superar el borde más el margen, al reentrar hay que meterse dentro pasando el borde menos el margen. Esa asimetría es la que mata el ping-pong.

### Backtest sobre datos reales (26 ago – 1 sep, misma ruta de precio y mismo delta del LP)

| | pp18 | pp19 | pp20 |
|---|---|---|---|
| fills · `range_exit_v1` vs real | **9** vs 40 | **1** vs 23 | **1** vs 40 |
| comisiones · nueva vs real | **$0.11** vs $1.59 | **$0.04** vs $0.74 | **$0.05** vs $1.27 |
| PnL del hueco · nueva vs real | **+1.57** vs −3.72 | **+6.65** vs −3.91 | **+8.91** vs −0.48 |
| expuesto sin cubrir, medio | $52 vs $19 | $39 vs $28 | $48 vs $17 |
| expuesto sin cubrir, máximo | $278 vs $198 | $168 vs $161 | $203 vs $200 |

En pp18 el precio cruzó de verdad: 4 salidas + 4 reentradas, y la histéresis frenó 2,258 ticks en `trigger_offset_not_reached` más 757 en `cross_confirming` que sin ella habrían sido whipsaw.

🚩 **Cómo NO leer esta tabla.** Ganó en las tres, pero **esta ventana es exactamente la que la favorece**: ETH lateral, sin tendencia neta, y el precio nunca se fue lejos del rango. Es el régimen para el que la política está construida. En una semana tendencial el short estático pierde hasta que el cruce de borde le pone el techo, y el signo del "PnL del hueco" se da vuelta. **Una ventana no es evidencia; por eso queda en sombra.**

⚠️ **Tensión real con la Fase 2.3.** El cap de sobre-cobertura en ~1.15 que propone este plan **destruiría esta política**: cerca del borde superior el delta del LP tiende a 0, así que el ratio de cobertura se dispara a 40×, 246×, 290× — sin que pase nada raro. Para `range_exit_v1` el ratio es la métrica equivocada; la magnitud que importa es **el notional desnudo en dólares**, que está acotado por el hedge de apertura. Al implementar la Fase 2.3 hay que expresar el cap en riesgo/margen absoluto, no en ratio, o exceptuar explícitamente a esta política.

### Tareas

- [x] **A.1 · `decideRangeExitV1`** como función pura, sin IO, en `server/src/services/range-exit-policy.service.js`.
- [x] **A.2 · Registrarla en el motor de sombra** (`ALL_POLICIES` + ruteo en `decideShadow`). Corre sola en toda protección viva.
- [x] **A.3 · Tests** (`server/test/range-exit-policy.test.js`, 13 casos): apertura al 100%, quietud dentro del rango, offset del trigger, confirmación temporal, mecha abortada, salida, reentrada, re-anclaje por re-centrado, forzado, rango ausente, e invariante de la derivación del offset.
- [x] **A.4 · Tests del motor multi-política derivados del registro** en vez de fijar "las otras dos": al alta de la cuarta política el invariante correcto es "todas menos la viva", no un número.
- [ ] **A.5 · Acumular 2–3 semanas de sombra** cubriendo al menos un tramo tendencial. Sin un régimen con tendencia, la comparativa sólo mide el régimen lateral.
- [ ] **A.6 · Comparar contra las otras tres políticas** con `scripts/shadow-vs-legacy.sh`, descontando los sesgos ya documentados en la memoria `shadow-vs-legacy-eval` (funding sin escalar por qty, slippage optimista, qty continua).
- [ ] **A.7 · Sólo si gana con tendencia incluida:** exponerla en el enum `policyVersion` del schema y permitir `executionIntent: live`. Hoy no está en el enum a propósito — no se puede activar por accidente.
