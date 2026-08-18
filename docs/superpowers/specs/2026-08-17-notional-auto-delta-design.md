# Notional auto por delta del rango — diseño

- **Fecha:** 2026-08-17
- **Estado:** aprobado en concepto, implementación aplazada
- **Ámbito:** wizard LP unificado, paso "Cobertura"
- **Clasificación:** bounded (cambio acotado sobre flujo existente)

## Problema

El campo **Notional USD a hedgear** de
`client/src/features/lp-wizard/ProtectionFormFields.jsx` se sugiere con la
heurística `capital / 2`, con el texto "mitad del capital LP". Esa heurística
solo es correcta cuando el precio está en el centro del rango.

El motor recalcula `deltaQty` en cada tick
(`server/src/services/delta-neutral-math.service.js:277-281`) y converge al
delta real, así que un notional mal dimensionado no rompe la cobertura. Lo que
cuesta es concreto:

1. Un rebalanceo extra en el primer tick para corregir la diferencia (fees
   evitables).
2. El pre-flight de margen dimensiona el margen requerido con ese número
   (`server/src/services/lp-orchestrator/protection-preflight.js:161`). Si va
   corto, aprueba un margen que luego no alcanza.

## Fundamento matemático

Para una posición Uniswap v3 con rango `[Pa, Pb]` y precio `P`:

```
x = L(1/√P − 1/√Pb)      (cantidad de token volátil)
y = L(√P − √Pa)          (cantidad de token estable)
V = x·P + y = L(2√P − P/√Pb − √Pa)
dV/dP = L(1/√P − 1/√Pb) = x
```

El delta en unidades de token **es exactamente la cantidad de token volátil que
la posición mantiene**. Por tanto el notional a cubrir es el valor USD de la
pata volátil, con fórmula cerrada que solo necesita `P`, `Pa`, `Pb` — sin
librería de math de Uniswap ni liquidez `L`, que se cancela:

```
fracVolátil = (√P − P/√Pb) / (2√P − P/√Pb − √Pa)
notional    = capitalUsd × fracVolátil
```

### Valores calculados

Rango simétrico, precio centrado:

| Ancho | % volátil |
|---|---|
| ±2%  | 49.5% |
| ±5%  | 48.8% |
| ±10% | 47.6% |
| ±25% | 44.1% |
| ±50% | 38.5% |

Rango ±10% fijo, precio descentrado:

| Precio en [0.90, 1.10] | % volátil |
|---|---|
| 0.92 (borde inferior) | 88.7% |
| 0.96 | 67.5% |
| 1.00 (centro) | 47.6% |
| 1.04 | 28.4% |
| 1.08 (borde superior) | 9.5% |

**Conclusión que justifica el trabajo:** con el rango centrado, `capital/2` ya
era correcto (~48%). El auto solo aporta valor en rangos descentrados, donde la
heurística infra-cubre hasta ~1.8×. Un "auto" que no use los bordes reales
sería cosmético.

## Diseño

### 1. Módulo puro nuevo

`client/src/features/lp-wizard/hedgeNotional.js`

```js
computeDeltaNotionalUsd({
  capitalUsd, currentPrice, rangeLowerPrice, rangeUpperPrice,
}) // → number | null
```

No recibe `targetHedgeRatio`: ver "Decisión resuelta" más abajo.

Casos borde:
- `P <= Pa` → 100% volátil (fuera de rango por abajo).
- `P >= Pb` → 0% volátil (fuera de rango por arriba).
- Entradas no finitas o `Pb <= Pa` → `null` (el llamador cae al fallback).

Desarrollado con TDD; los tests fijan los valores de las tablas de arriba.

### 2. UI en `ProtectionFormFields`

- Campo de state nuevo `notionalAuto`, **`true` por defecto**.
- Marcado → el input se oculta. Se muestra el valor calculado como texto de solo
  lectura, con el porqué: `"$97 — 88% del capital, el precio está pegado al
  borde inferior"`.
- Desmarcado → aparece el input actual, **pre-rellenado con el valor auto**,
  para que editar sea partir de ahí y no de cero.

### 3. Plumbing

Pasar `currentPrice`, `rangeLowerPrice` y `rangeUpperPrice` desde
`UnifiedLpWizard` → `StepProtection` → `ProtectionFormFields`. Ya existen en
`flow.suggestions.currentPrice` y `flow.activeRange`
(`client/src/pages/UniswapPools/components/smart-create/useSmartCreateFlow.js:332-347`);
hoy simplemente no se pasan hacia abajo.

### 4. Backend: sin cambios

`configuredNotionalUsd` se sigue enviando como número; el auto solo decide qué
número. **Crítico:** omitir el campo haría que el backend caiga en `capitalUsd`
(`server/src/services/lp-orchestrator/create-saga.js:78`), sobre-cubriendo ~2×.

### 5. Recálculo y fallback

- Con auto activo, cambiar rango o capital en pasos anteriores recalcula solo.
- Sin precio/bordes disponibles todavía, cae a `capital / 2` y lo indica en el
  hint.
- `notionalAuto` vive solo en el state del formulario; no entra en el payload
  (`buildProtectionPayload`).

### 6. Decisión resuelta: delta puro, sin `targetHedgeRatio`

**Resuelto el 2026-08-17.** El primer borrador de este doc proponía aplicar el
ratio (`delta × targetHedgeRatio`). Se descarta.

El motivo es que el ratio efectivo del motor no es `targetHedgeRatio` a secas
(`protected-pool-delta-neutral/pricing.js:101-107`):

```js
const baseRatio = liveNetProfit ? 1 : Number(protection.targetHedgeRatio ?? DEFAULT);
const targetHedgeRatioApplied = liveNetProfit ? 1 : baseRatio * this._zoneMultiplier(zoneState);
```

Intervienen **tres** factores, no dos. El multiplicador de zona
(`config/index.js:173-175`) vale `0.6` en centro, `0.85` en transición y `1.0`
en borde.

| | Fórmula |
|---|---|
| A — delta puro | `capital × fracVolátil` |
| B — con ratio | `capital × fracVolátil × targetHedgeRatio` |
| Lo que el motor abre | `× ratio × zoneMult` (legacy) · `× 1` (net profit real) |

Capital $110, rango ±10%, `targetHedgeRatio = 0.7`:

| Escenario | A | B | Motor abre |
|---|---|---|---|
| Legacy, precio centrado | $52.36 | $36.65 | **$21.99** |
| Legacy, precio en borde | $97.57 | $68.30 | **$68.30** |
| Net profit real, borde | $97.57 | $68.30 | **$97.57** |

Con `targetHedgeRatio = 1` ambas opciones coinciden; sólo divergen si se baja
el ratio.

Razones para elegir A:

1. **Bajo net profit real, A acierta exacto y B se queda corto**, porque
   `liveNetProfit` fuerza el ratio a 1 e ignora `targetHedgeRatio`.
2. **Bajo legacy da igual cuál se elija**: el `zoneMultiplier` descuadra las
   dos. Acertar ahí exigiría replicar la máquina de zonas en el cliente —
   complejidad que no compensa.
3. **A falla en la dirección segura.** Sobredimensiona, así que el pre-flight
   reserva margen de sobra y el motor recorta en el primer tick. B
   infradimensiona bajo net profit, que es justo el fallo que el auto viene a
   evitar.
4. **La etiqueta es honesta:** "notional a cubrir = tu exposición real" es
   cierto; "tu exposición × un ratio que a veces se ignora" no lo es.

Consecuencia: `targetHedgeRatio` sale de la firma de la función pura, que queda
más simple de testear.

## Testing

- Unitarios del módulo puro: dentro de rango, fuera por ambos lados,
  descentrado, simétrico, entradas inválidas.
- Caso en `client/src/features/lp-wizard/ProtectionFormFields.test.jsx`:
  desmarcar el check revela el input pre-rellenado con el valor auto.

## Referencias

- `client/src/features/lp-wizard/ProtectionFormFields.jsx`
- `server/src/services/delta-neutral-math.service.js:277-281`
- `server/src/services/lp-orchestrator/protection-preflight.js:161`
- `server/src/services/lp-orchestrator/create-saga.js:78`
- `server/src/services/net-profit-policy.service.js`

---

# Análisis UX del paso "Cobertura"

- **Fecha:** 2026-08-17
- **Estado:** análisis aprobado, rediseño visual pendiente
- **Ámbito:** `client/src/features/lp-wizard/ProtectionFormFields.jsx` + su CSS module

La lógica del paso está bien resuelta; los comentarios del propio código
documentan varias trampas ya sorteadas. El problema es de **jerarquía visual**:
todas las decisiones pesan lo mismo.

## 1. Jerarquía plana

`.toggleRow`, `.fieldsBlock`, `.policyCard` y `.advanced` comparten receta:
fondo `rgba(255,255,255,0.02)`, borde `1px solid var(--uni-border)`, radio
10-12px. Elegir qué motor cubre el dinero se ve igual que teclear el leverage.
El único desempate, `.policyCardNew`, sólo aparece **después** de elegir net
profit — la señal llega tarde.

**Propuesta:** tres niveles explícitos.

| Nivel | Contenido | Tratamiento |
|---|---|---|
| Decisión estructural | activar protección, política de cobertura | tarjeta con borde de acento, más padding |
| Dimensionado | cuenta, leverage, notional | campos planos, sin tarjeta |
| Tuning | preset, configuración avanzada | hundido, fondo más oscuro que el lienzo |

## 2. Dos rejillas idénticas con significados opuestos (prioridad máxima)

La clase `.presets` se reutiliza para **Sombra/Operación real** y para
**Adaptive/Balanced/Aggressive/Conservative**: dos grids de 2 columnas, botones
idénticos, separados por ~150px. Una responde "¿esto opera con dinero real?" y
la otra "¿cada cuánto rebalanceo?". Misma forma implica misma clase de decisión,
y aquí no lo son.

**Propuesta:** Sombra/Real deja de ser rejilla de tarjetas y pasa a
**segmented control** de dos posiciones con color semántico — sombra en tono
neutro/azul, real en ámbar. La forma comunica "modo", no "opción de catálogo".

## 3. La UI muestra números que el motor ignora

Con `net_profit_v1`, `decideNetProfitV1` no recibe el trigger de precio: calcula
sus propias bandas (4% en el borde, 8% en el centro). Pero los cuatro presets
siguen anunciando "1% / 3% / 5%" con toda prominencia. El hint de la avanzada
avisa de los overrides de `targetHedgeRatio` y slippage, pero **no menciona el
preset**, que está más arriba y más visible.

**Propuesta:** con net profit activo, atenuar los presets y reetiquetarlos por
lo único que sobrevive — la frecuencia de evaluación ("Adaptive — evalúa cada
6 h"). Extender el aviso de overrides para incluir el trigger.

## 4. Cifras sin consecuencia visible

Leverage 10 + notional $55 no comunica que son $5.50 de margen requerido, ni la
distancia a liquidación, ni el funding diario. El dato ya se calcula en
`server/src/services/lp-orchestrator/protection-preflight.js:167`, pero sólo
aparece tras pulsar "Comprobar", en otra tarjeta más abajo.

**Propuesta:** línea viva bajo ambos campos, recalculada al teclear:
`Margen requerido $5.50 · liquidación a −9.2% · funding est. $0.11/día`.
Es también el lugar natural para el notional auto especificado arriba.

## 5. El gate de riesgo parece un ajuste

"Confirmo activar órdenes reales con net profit" reutiliza `.toggleRow`, el
mismo estilo que "Activar protección delta-neutral". Uno enciende una función;
el otro asume que un motor sin histórico de producción mueva dinero real.

**Propuesta:** tratamiento de advertencia (fondo ámbar, icono) y texto
reorientado a la consecuencia: *"Entiendo que net profit ejecutará órdenes
reales y sustituye al motor en producción"*.

## 6. Registro lingüístico inconsistente

UI en español con "Band mode", "Rebalance price move (%)", "Target hedge ratio",
"Max slippage (bps)" y "Min drift para rebalancear" (mitad y mitad).

**Propuesta:** traducir etiquetas, dejar el término técnico como ayuda
secundaria (`Ratio de cobertura objetivo` + hint `1 = neutral puro`). Los
nombres de preset se quedan: son nombres propios.

## 7. Menores

- Labels en versalitas con `letter-spacing` para 8+ campos: cuesta escanear.
  Reservarlas para cabeceras de sección.
- `.hint` (0.75rem) y `.muted` (0.85rem) usan ambos `--uni-text-2`: no se
  distingue "ayuda" de "consecuencia".
- "Comprobar" es redundante: `useUnifiedLpFlow.js:361-364` ya corre el preflight
  al pulsar "Siguiente". Presentarlo como opcional sugiere que puede saltarse.
- `validateProtectionForm` devuelve un solo string: muestra los errores de uno
  en uno.

## Orden de ataque

1. **#2** — las rejillas gemelas. Riesgo real de activar órdenes reales creyendo
   que se toca un preset.
2. **#4** — línea de consecuencia. Máximo valor por línea de código y reutiliza
   cálculo existente.
3. **#1** — jerarquía en tres niveles. Base que hace legibles a los otros dos.
