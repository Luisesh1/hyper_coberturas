# Deuda técnica de coberturas — plan verificable

**Fecha:** 2026-09-23
**Estado de la flota al escribirlo:** #55/pp28 (`range_exit_v1`) y #56/pp29
(`net_profit_v2`), ambas a 10x, `tracking`, sin compuertas. La ventana de
medición de la Fase 6 **ya está corriendo**.

> **Restricción que manda sobre todo lo demás:** hay capital real operando. Un
> despliegue actúa sobre él en el primer tick tras el reinicio. Cada tarea de
> aquí declara si puede hacerse con la flota viva o no, y esa declaración tiene
> prioridad sobre el orden de conveniencia.

---

## Tesis

Los cinco puntos no son la misma clase de problema y tratarlos igual sería un
error:

| | naturaleza | riesgo de arreglarlo |
|---|---|---|
| 1 · Estado antes de ejecución | estructural, **contenido** | alto |
| 2 · Derivación del offset inerte | código muerto que aparenta gobernar | bajo |
| 3 · Recorte por margen sin persistir | ceguera de medición **activa** | bajo |
| 4 · Documento desactualizado | documentación | nulo |
| 5 · Scripts sólo en el contenedor | operativa | nulo |

El **3** es el único con urgencia: el panel está midiendo mal durante la ventana
de Fase 6, así que cada hora que pasa son datos que no se recuperan.

El **1** es el más llamativo y el que menos conviene tocar ahora. Se argumenta
abajo.

---

## Fase A · Lo que la Fase 6 necesita ya

### A.1 · Persistir el recorte por margen `[HECHO]`

**Problema.** Desde el 2026-09-22 el preflight recorta un incremento que el
colateral no aguanta en vez de rechazarlo entero. Pero el recorte sólo se
registra en los logs del contenedor, que desaparecen en cada rebuild.
`execution_skipped_because` no sirve: describe un salto, y un recorte es lo
contrario — se ejecutó, sólo que menos.

Resultado: el panel cuenta rechazos y es **ciego a los recortes**, justo durante
la ventana que mide si las protecciones nuevas funcionan.

**Trabajo.** `server/src/db/migrations/027_decision_log_margin_clamp.sql` (ya
escrita) añade `margin_clamped_from_qty`. El dato ya está disponible en el punto
de persistencia — el preflight corre antes que `_persistDecision`— así que no
hay que reordenar nada: sólo leer `preflight.clampedFromQty` al persistir.

**Verificación.**
1. `npm --prefix server run test` en verde.
2. Test unitario: una decisión con `preflight.maxIncreaseQty > 0` persiste
   `marginClampedFromQty` no nulo; una sin recorte lo persiste nulo.
3. Tras desplegar, la columna existe:
   `\d protection_decision_log | grep margin_clamped_from_qty`
4. La consulta del panel distingue los tres estados —ejecutado entero,
   recortado, rechazado— y los tres suman el total de intentos.

**Flota viva:** sí. Es aditivo; no cambia ninguna decisión.

---

## Fase B · Lo que se puede hacer sin tocar el motor

### B.1 · Resolver la derivación inerte del offset `[HECHO — opción (b)]`

**Problema.** `resolveTriggerOffsetPct` deriva el corrimiento del trigger del
coste: `offsetPct = 4 × takerFeeRate`. Con el taker por defecto (0,00025) da
**0,10%**, por debajo del piso de **0,15%**, así que **el clamp gana siempre**.
Son ~40 líneas de comentario y tres constantes produciendo un valor que nunca
se usa.

Peor: `assetContext.takerFeeRate` **no lo puebla nadie** en todo el servidor.
Verificado con `grep -rn "takerFeeRate" server/src`. No existe tasa real que
pasar. La política sombra usa 0,0005 y la viva 0,00025 — dos valores para la
misma cosa.

**Decisión a tomar (es del usuario, no mía).**

- **(a) Dejarlo y documentarlo.** Ya está documentado en el docx. Coste: una
  derivación que aparenta gobernar y no gobierna, y que se volvería viva en
  silencio si alguien añade la tasa real algún día.
- **(b) Declarar el offset constante** y borrar la derivación. Menos código,
  menos mentira. Se pierde la justificación económica escrita.
- **(c) Poblar la tasa real** desde el `assetContext` de Hyperliquid y unificar
  los dos defaults. Es trabajo nuevo con una dependencia de red en el camino
  caliente.

**Recomendación: (b) o (c), no (a).** Lo peor es el estado actual, donde el
lector cree que el coste manda y no manda.

**Verificación (si se elige b o c).**
1. Un test que fije el offset efectivo con la tasa por defecto, y que falle si
   alguien cambia el piso sin darse cuenta.
2. Con (c): un test con tasa alta (0,0005 → 0,20%) que demuestre que **sí**
   mueve el offset, cosa que hoy no ocurre con ninguna tasa por debajo de
   0,0375%.
3. `grep -c takerFeeRate` deja de dar dos defaults distintos.

**Flota viva:** (b) sí. (c) cambia el comportamiento del trigger, así que
**no**: entra con la flota parada o al final de la ventana de Fase 6.

### B.2 · Mover los scripts operativos al repo `[HECHO]`

**Problema.** `margin-probe.js`, `margin-topup.js`, `recreate-step1.js`,
`recreate-step1b.js` y `reanclar.js` viven en `/app` dentro del contenedor. Un
despliegue se los lleva. Todos se usaron sobre capital real el 2026-09-22/23.

**Trabajo.** Llevarlos a `server/src/scripts/ops/` con sus guardas actuales
intactas (abortan si la posición no existe, si no está en isolated, o si el
saldo no alcanza) y una cabecera que diga qué mueven.

**Verificación.**
1. Los cinco existen en el repo y el contenedor los ve tras un despliegue:
   `docker exec testbot-server-prod ls src/scripts/ops/`
2. Cada uno ejecutado **sin argumentos** falla con su mensaje de uso y
   `exit != 0`, sin tocar nada.
3. `margin-probe.js` sigue siendo de sólo lectura: ejecutarlo dos veces no
   cambia `withdrawable`.

**Flota viva:** sí. Son scripts, no se invocan solos.

### B.3 · Regenerar el documento `[HECHO]`

**Problema.** `/root/report/range-exit-v1-2026-09-22.docx` es de antes del guard
de mínimo de orden, del filtro de alertas por diseño y del recorte parcial del
cap.

**Trabajo.** Regenerar con las tres secciones nuevas y la tabla de compuertas
actualizada (`commit_below_min_notional` no está).

**Verificación.** El texto extraído contiene `commit_below_min_notional`,
`NAKED_ALERT_CAP_PROXIMITY` y `resolveCapTrimTarget`; el zip valida con
`gzip -t` equivalente (`zipfile.testzip()`).

**Flota viva:** sí.

---

## Fase C · Lo estructural, y por qué NO como refactor

### C.1 · El estado se persiste antes de saber si la orden entró `[HECHO — como verificación]`

**El problema, dicho con precisión.** En `evaluate.js` el orden es:

```
~512    la política decide y su estado avanza
~1217   updateStrategyState  ← se persiste
~1345   if (!preflight.ok) return  ← la orden nunca se envía
```

Es real y costó 47 h de cobertura varada en pp24.

**Por qué no lo reordeno ahora.** Ya está **contenido**, y verificarlo cuesta
mucho menos que refactorizarlo:

- `range_exit_v1` era la única con transiciones comprometidas (zona, clave de
  rango) y un `hold` absorbente. Corregido en `b56f035` con
  `committedTargetQty`, que además cubre el llenado parcial y el rechazo del
  exchange, no sólo el preflight bloqueado.
- `net_profit_v2` y `legacy` no tienen estado absorbente: sus compuertas
  (`inside_outer`, `inner`, `min_notional`, `dwell`, `cooldown`, `fill_cap`) se
  recalculan sobre el drift **actual** en cada tick. Una orden bloqueada deja el
  drift en pie y el tick siguiente lo vuelve a ver.
- El único estado absorbente que tuvo `net_profit` fue `upper_exit_latched`,
  corregido antes (dejó $53,90 desnudos 72 h en pp27).

Reordenar el motor tocaría las tres políticas sobre capital vivo para arreglar
un peligro cuyo único caso real ya está tapado. **La relación riesgo/beneficio
no sale.**

**Lo que sí propongo: convertir la creencia en garantía.**

Tests que fijen la propiedad "una orden bloqueada no deja la política varada"
para `net_profit_v2` y `legacy`, del mismo modo que
`range-exit-commit.test.js` lo hace para `range_exit_v1`. Hoy eso lo sostiene mi
lectura del código; mañana lo sostendría la suite.

**Verificación.**
1. Para cada política: simular una decisión de rebalanceo, no ejecutarla, y
   comprobar que el tick siguiente **vuelve a decidir** sobre el mismo drift.
2. El mismo test debe **fallar** si se introduce un `hold` absorbente —
   comprobarlo revirtiendo artificialmente, como se hizo con los 6 de 9 en
   `range-exit-commit.test.js`.
3. Dejar anotado en el plan que el reordenamiento de `evaluate.js` queda
   **abierto**, con la flota parada como precondición.

**Flota viva:** sí, son sólo tests.

---

## Orden propuesto

1. **A.1** — urgente, la Fase 6 está midiendo mal ahora.
2. **B.2** y **B.3** — riesgo nulo, se pueden encadenar.
3. **C.1** (los tests) — cierra el punto estructural sin tocar el motor.
4. **B.1** — requiere una decisión tuya antes de escribir nada.

## Fuera de alcance, explícito

- **Reordenar `evaluate.js`.** Queda documentado como abierto, con precondición
  de flota parada.
- **Tocar los valores del cap** (15% / $30 / 1h) o el umbral de proximidad de
  alerta (0,75). Dependen de los datos de la Fase 6; cambiarlos ahora
  contaminaría la medición que justifica cambiarlos.
- **Cualquier movimiento de capital.** Lo firma el usuario.

## Criterio de cierre

- `npm --prefix server run test` en verde, y el conteo de tests **sube** en cada
  fase que añade garantías.
- La columna del recorte existe en producción y el panel distingue los tres
  estados de ejecución.
- Los cinco scripts sobreviven a un despliegue.
- El documento menciona las tres piezas nuevas.
- El punto C.1 queda respaldado por tests que fallan si la propiedad se rompe.


---

## Resultado (2026-09-23)

Las cinco tareas cerradas. Suite: **949 pass / 0 fail** (desde 937).

| tarea | qué se hizo | verificación |
|---|---|---|
| A.1 | migración 027 + columna `margin_clamped_from_qty` en repo y motor | 5 tests; los tres estados de ejecución se distinguen |
| B.2 | cinco scripts a `server/src/scripts/ops/` + README | los cinco fallan `exit=1` sin argumentos y sin tocar nada |
| B.3 | docx regenerado con las tres piezas nuevas | zip íntegro; 5 claves presentes en el texto |
| C.1 | 7 tests que fijan la no-absorbencia de `net_profit` y `legacy` | incluye el contraste con `range_exit` sin el arreglo |
| B.1 | opción (b): derivación documentada como inerte, sin cambiar comportamiento | 3 tests fijan el offset efectivo y el umbral de 0,0375% |

**Cuatro de los cinco scripts ya los había borrado un despliegue** antes de
llegar al repo. Se recuperaron del scratchpad de la sesión; si esa tarea se
retrasa un día más, se pierden.

### Hallazgos que la ejecución añadió al diagnóstico

**El reposo de `net_profit` se consume al DECIDIR, no al ejecutar.** Una orden
bloqueada gasta igualmente hasta 10 min de espera antes del siguiente intento.
No estrangula —el drift se vuelve a ver— pero retrasa la recuperación. Es una
versión leve del mismo problema estructural de C.1, y queda fijada por test en
vez de en un comentario suelto.

**La premisa de la derivación del offset ya estaba rota.** Supone que el coste
no tiene parte fija, y el mínimo de orden de $11 lo es: por debajo, la orden no
es cara, es imposible. Ese caso se atiende aparte, en
`commit_below_min_notional`.

### Sigue abierto

- **Reordenar `evaluate.js`** para persistir el estado después de ejecutar.
  Precondición: flota parada. Ahora respaldado por los tests de C.1, que fallan
  si alguien introduce un estado absorbente.
- **Poblar `takerFeeRate` de verdad** (opción (c) de B.1). Cambia el
  comportamiento del trigger, así que no entra con la flota viva.
- **Los valores del cap y el umbral de proximidad.** Dependen de los datos de la
  Fase 6.
