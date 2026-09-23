# Qué mecanismo gobierna a qué política

**Verificado contra el código el 2026-09-23.** Cada casilla se comprobó leyendo
`evaluate.js`, no de memoria.

Este documento **no describe un diseño deseado, describe el comportamiento
actual.** Existe porque esa información hoy no está escrita en ningún sitio: es
emergente de nueve condicionales repartidos por `evaluate.js`, y casi todos los
bugs de coberturas de 2026-09-22/23 salieron de una de esas ramas haciendo algo
que nadie había declarado.

---

## La tabla

| mecanismo | `range_exit_v1` | `net_profit_v1/v2` | `legacy_zones_v1` | dónde |
|---|---|---|---|---|
| **Zona muerta central** | no | **sí** | sí | `evaluate.js:853` |
| **minDwell** | no | sí | sí | `:795` |
| **Bloqueo por confianza baja** | no | sí | sí | `:798` |
| **`forceReduceNearZero`** (anula el hold) | **sí** ⚠️ | no | sí | `:851`, `:997` |
| **`urgentTrigger`** | sí (sólo log) | no | sí (sólo log) | `:852`, `:971` |
| **Medida de exposición** | `\|committed−actual\|` | `\|delta−actual\|` | `\|delta−actual\|` | `:1003` |
| **Tope de exposición** (cap) | sí | sí | sí | `:1071` |
| **Recorte parcial del cap** | sí | sí | sí | `:1077` |
| **Adopción del ancla tras ejecutar** | sí | no | no | `execution.js:252` |
| **Filtro de alerta "por diseño"** | sí | no | no | `:1018` |
| **Motivo en el log** | su compuerta | su compuerta | legacy | `:1191` |
| **Delta completo** (ratio 1) | sí | sí | no | `helpers.js:335` |
| **Límites de ejecución estrictos** (slippage 15bps / spread 10bps) | no | **sí** | no | `:450` |
| **Remapeo de target** (corrección parcial) | no | sí | no | `:467` |
| **Compuertas de riesgo de cuenta** | sí | sí | sí | `:684` |
| **Preflight** (margen, mínimo, cooldown, BBO) | sí | sí | sí | `:1076` |

---

## Las dos casillas que no sé justificar

Escribir la tabla era también la auditoría. Dos celdas aparecieron sin que
nadie las hubiera declarado:

### ⚠️ `forceReduceNearZero` aplica a `range_exit_v1`

```js
const forceReduceNearZero = !isNetProfitLive && legacyDecision.forceReduceNearZero;
...
if (forceReduceNearZero && rebalanceDecision.decision === 'hold') {
  rebalanceDecision.decision = 'rebalance_full';
}
```

Se excluye para `net_profit` y **no** para `range_exit`. Dispara cuando el
target cae a ~0 con posición viva — que por encima del borde superior es el
estado normal de `range_exit`.

**Consecuencia:** puentea la confirmación de 120 s del cruce. Una mecha que
asome por encima del borde cierra el hedge de inmediato, sin esperar a
confirmar. Si el precio vuelve, hay que reconstruirlo — que es exactamente el
whipsaw que la confirmación existe para evitar.

**Pero no es obviamente un error.** Cerrar rápido un short cuyo delta ya es 0 es
la lección de pp27 ($53,90 desnudos 72 h). Puede ser una red deliberada.

**No lo he tocado.** Es una decisión de producto, y hoy ya me equivoqué
tratando una regla del usuario como fuga legacy.

### `urgentTrigger` llega a `range_exit` pero sólo registra

Su única consumición es un `logger.info`. Sin efecto sobre la decisión. Queda
anotado para que nadie lo "arregle" creyendo que hace algo.

---

## Lo que la tabla explica

Cada bug de coberturas del 2026-09-22/23 es una casilla que estaba mal y nadie
podía ver:

| bug | casilla |
|---|---|
| El cap anulaba a `range_exit` en cada 1,2% de movimiento | medida de exposición |
| Sus ejecuciones se registraban con motivos legacy | motivo en el log |
| El `minDwell` y la confianza la frenaban | los dos frenos |
| El recorte del cap se deshacía en 92 s | adopción del ancla |
| 17 alertas de ruido en 11 h | filtro "por diseño" |

Ninguno fue un fallo de lógica dentro de una política. **Los cinco fueron
mecanismos compartidos aplicándose a quien no debían**, y ninguno era visible
sin leer nueve puntos dispersos.

---

## Para qué sirve esto

**Hoy:** responder "¿qué gobierna a esta política?" leyendo una fila en vez de
nueve condicionales.

**Al añadir una política:** la tabla dice exactamente qué decisiones hay que
tomar. Hoy hay que encontrar nueve sitios, y olvidarse de uno no falla — hace
algo silenciosamente distinto.

**Si algún día se refactoriza:** esta tabla es la especificación. El criterio
de que el refactor es correcto es que la suite pase **con cero tests
modificados**. Si hay que tocar un test, el cambio alteró comportamiento.

## Lo que NO propone

No propone cambiar ninguna casilla. Es un inventario, y su valor es que ahora
existe. Las dos casillas marcadas con ⚠️ son preguntas abiertas para el
usuario, no defectos a corregir por iniciativa propia.
