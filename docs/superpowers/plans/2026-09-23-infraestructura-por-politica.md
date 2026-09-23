# Infraestructura propia por política — empezando por `range_exit_v1`

**Fecha:** 2026-09-23
**Origen:** `range_exit_v1` hizo 8 órdenes dentro del rango en 13 h, en la
política cuyo argumento entero es "entre dos cruces no sale ni una orden".

---

## El problema, en una frase

**`range_exit_v1` no está corriendo.** Está corriendo el motor compartido, con
la política como espectadora.

La prueba está en el log de decisiones de pp28: de 37 ejecuciones, **ninguna
lleva una compuerta de `range_exit` como motivo**.

```
risk_paused_reduce_only        20    compuerta de riesgo
restart_reconcile               4    reconciliación del motor
timer_and_drift                 3    LEGACY
naked_notional_cap_exceeded     3    el cap
naked_notional_cap              3    el cap
reanchor_manual                 2    manual
drift_exceeds_cost_aware_band   2    LEGACY
```

Ni un `range_exit`, `range_reentry`, `initial_full_hedge` ni
`commit_incomplete`. La política decide, y otro ejecuta con sus propios motivos.

## La causa raíz, medida

El cap está calibrado **3–4 veces más estrecho** que la divergencia que la
política produce por diseño dentro de su propio rango:

```
LP $519.81 · rango 2612–2858 (±4,5%)

cap                        max($30, 15% × 519.81) = $78
divergencia por diseño     $224 (borde superior) … $315 (borde inferior)
```

Desde un ancla en 2755, el cap salta a los **2722 — una caída del 1,2%**,
cuando el borde está a **5,2%**. O sea: **al 23% del camino**. La política no
llega a cruzar nunca; la anulan cuatro veces antes.

No fue un descuido de implementación. El plan de la Fase 4 advertía que un cap
por ratio *"destruiría `range_exit_v1`"*, y por eso se usó notional en dólares
**con requisito de duración**, razonando que esperar una hora protegería a la
política. **No protege:** en un mercado con tendencia la divergencia *es*
sostenida, así que el requisito se cumple solo.

El error de fondo: un límite calibrado para políticas que persiguen el delta
continuamente —donde una divergencia sostenida sí es una avería— aplicado a una
donde la divergencia sostenida **es el producto**.

---

## Tesis de la solución

El motor compartido debe proveer **ejecución**: órdenes, margen, seguridad de
cuenta, reconciliación de posición. Eso es infraestructura real y no tiene
sentido duplicarla.

Cada política debe poseer **decisión, estado, recuperación y observabilidad**.
Hoy sólo posee la decisión, y por eso colisiona.

### Inventario: qué gobierna a `range_exit` hoy

**Legítimo — se queda compartido.** Protege la cuenta, no la estrategia:

| mecanismo | por qué se queda |
|---|---|
| `risk_paused` por distancia a liquidación | es la cuenta, no la política |
| piso de margen y recarga automática | ídem |
| preflight: margen, mínimo de orden, cooldown, spread/BBO | condiciones de envío |
| `restart_reconcile`, posición no confirmada | integridad del estado real |

**Colisiona — pasa a ser propio de la política:**

| mecanismo | por qué colisiona |
|---|---|
| `naked_notional_cap` | mide "divergencia sostenida = avería". Aquí es el producto. **La raíz.** |
| `minDwellActive` | freno pensado para políticas que rebalancean seguido; ésta rebalancea en bordes |
| `confidenceBlocksIncrease` | bloquea crecer con baja confianza. Una reentrada por borde inferior ES crecer, y es justo cuando más urge |
| `reason` del log | sale de `forceReason \|\| …legacy…`: la política no puede explicarse |
| `legacyDecision` | se computa siempre aunque no gobierne, y sus strings acaban en el registro |

---

## Fase 1 · Que la política se explique

Sin esto no se puede medir nada de lo demás, y es de riesgo nulo.

**1.1 · El `reason` sale de la política que decide.** Cuando manda
`range_exit_v1`, el motivo persistido es su compuerta
(`range_exit`, `range_reentry`, `commit_incomplete`, `initial_full_hedge`,
`range_rebased`, `forced`), no un string legacy.

**Verificación.** Tras un ciclo completo, `SELECT DISTINCT reason` sobre pp28
devuelve compuertas de `range_exit` y **cero** `timer_and_drift` o
`drift_exceeds_cost_aware_band`. Test unitario sobre el mapeo.

**1.2 · Registrar quién gobernó cada tick.** Una columna o campo que diga si la
decisión efectiva vino de la política o de un mecanismo que la sobrescribió.

**Verificación.** El panel puede responder "¿qué fracción de las órdenes de
pp28 las decidió su política?". Hoy la respuesta es 0% y no hay forma de verlo.

---

## Fase 2 · Límite de divergencia propio

**2.1 · Sustituir el cap global por uno derivado del rango.** La divergencia
máxima que la política puede producir es **conocible de antemano**: delta en
cada borde contra el ancla vigente. El límite propio salta sólo por encima de
eso — o sea, ante divergencia que el rango **no explica**, que es la única que
indica avería.

Conserva las dos cosas: la política corre de verdad, y sigue habiendo red.

**Verificación.**
1. Con los números de pp28 (ancla 0,0785, rango 2612–2858) el límite propio
   queda por encima de $315 y **no** dispara en el recorrido 2755→2679 que hoy
   disparó tres veces.
2. Una divergencia que el rango no explica —short en 0 con delta en 0,1— **sí**
   dispara.
3. Test que falle si alguien vuelve a aplicarle el cap global.

**2.2 · Desactivar `minDwell` y `confidenceBlocksIncrease` para esta política**,
sustituidos por sus equivalentes propios: la confirmación de 120 s ya es su
dwell, y el cruce de borde confirmado ya es su señal de confianza.

**Verificación.** Un desarme por borde superior no se bloquea por confianza
baja del modelo. Hoy sí puede, y es justo el caso de pp27 (short desnudo 72 h).

---

## Fase 3 · Recuperación propia

**3.1 · El ancla es de la política.** Ya existe `committedTargetQty` (`b56f035`)
y ya se conectó al recorte del cap (`41290de`). Falta que **cualquier**
intervención externa la actualice, no sólo el cap.

**Verificación.** Tras una intervención de riesgo (`risk_paused_reduce`), la
política adopta el resultado como ancla en vez de intentar deshacerlo.

**3.2 · Reanclaje explícito.** Hoy hace falta un script manual (`reanclar.js`).
Debe ser una operación de la política, invocable y registrada.

---

## Lo que NO se hace

- **Duplicar el preflight, el margen o los gates de riesgo.** Son de la cuenta.
  Duplicarlos multiplica la superficie de fallo sin ganar nada.
- **Tocar `net_profit_v2` ni `legacy`** hasta que `range_exit` esté completa y
  medida. Una política a la vez.
- **Cambiar valores del cap global.** Deja de aplicarse aquí; para las otras
  sigue igual hasta que haya datos.

## Estado de la flota

pp28 sigue con el cap global gobernándola. Hasta la Fase 2, cada ~1,2% de
movimiento cuesta un ciclo de órdenes. Con `41290de` desplegado es **una orden
por ciclo en vez de dos**; la raíz sigue.

## Criterio de cierre

1. `SELECT DISTINCT reason` sobre una protección `range_exit` devuelve sólo
   compuertas suyas y motivos de riesgo de cuenta.
2. Un recorrido del precio de ±4% dentro del rango produce **cero** órdenes.
3. Un cruce de borde confirmado produce **exactamente una**.
4. Una divergencia que el rango no explica sigue disparando el límite.
5. La suite sube, y los tests nuevos fallan si se revierte cada cambio.
