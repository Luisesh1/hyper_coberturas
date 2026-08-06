# Lenguaje unificado para los modales del orquestador

**Fecha:** 2026-08-05
**Estado:** aprobado
**Mockup:** https://claude.ai/design/p/beec6e3c-4e67-44fd-904e-85c66ed8c906?file=Modales+orquestador.dc.html
**Referencia visual:** `UnifiedLpWizard` ([spec del wizard](./2026-08-02-wizard-lp-unificado-design.md))

## Problema

`UnifiedLpWizard` estableció un lenguaje visual coherente y basado en `client/src/styles/tokens.css`.
El resto de modales que la página del orquestador abre no lo siguen: cada uno trae su propia
cáscara, copiada y divergida.

| Modal | z-index | radio | fondo | vocabulario |
|---|---|---|---|---|
| `UnifiedLpWizard` (referencia) | 1000 | `var(--radius-xl)` | `var(--bg-primary)` | tokens de `tokens.css` |
| `EditOrchestratorConfigModal` | 130 | 22px | gradiente hardcodeado | `--uni-*` |
| `OrchestratorIssueModal` | 1200 | 22px | gradiente hardcodeado | rgba crudo |
| `ActionLogDrawer` | 140 | — | gradiente hardcodeado | `--uni-*` |
| `PositionActionModal` | 60 | 24px | gradiente hardcodeado | rgba crudo |
| `SmartCreatePoolModal` | 1000 | 16px | `#1a1a2e` | hex crudo |

Tres vocabularios conviven (tokens núcleo, `--uni-*`, hex/rgba a pelo) y el wizard es el único
que consume `tokens.css` como corresponde.

Más allá de lo estético hay dos defectos concretos:

### La escala de z-index está rota

Los valores (60, 130, 140, 1000, 1200) no forman ninguna escala. `PositionActionModal` vive en 60
y se abre **desde** `LpOrchestratorPage`: cualquier overlay por encima lo tapa. No es hipotético —
es el modal al que el orquestador delega las acciones sobre la posición.

### La cáscara de un modal vive en el CSS de un campo

`EditOrchestratorConfigModal` importa sus estilos de `StrategyFieldInput.module.css`. Ese archivo
define `.overlay`, `.modal`, `.header`, `.footer` — la cáscara completa de un diálogo — dentro del
módulo CSS de un input de estrategia. Cualquiera que edite el campo puede romper el modal sin
saberlo, y al revés.

## Alcance

Cinco superficies, las que el usuario ve dentro del flujo del orquestador:

1. `EditOrchestratorConfigModal`
2. `OrchestratorIssueModal`
3. `ActionLogDrawer`
4. `PositionActionModal` — compartido con Uniswap Pools
5. `SmartAddLiquidityModal` — compartido con Uniswap Pools

**Efecto colateral aceptado:** (4) y (5) también cambian de aspecto en la página Uniswap Pools.

**Fuera de alcance:** `SmartCreatePoolModal`, `ApplyProtectionModal`, `ClaimFeesModal`,
`WalletConnectSetupModal`, `ConfirmDialog`, `UserFormModal`, `AccountFormModal`,
`IndicatorConfigModal`, `AssetPickerModal`. Quedan con su lenguaje actual. La deuda persiste y
debería cerrarse en una segunda pasada una vez el shell esté rodado.

## Decisiones tomadas

| Decisión | Elegido | Descartado |
|---|---|---|
| Profundidad | Cáscara + controles internos | Solo cáscara; reestructurar UX |
| Enfoque | Shell compartido en React + CSS único | Solo CSS; híbrido incremental |
| Blur y gradientes | Manda el wizard: plano, sin blur | Añadir blur a todos; gradiente sutil |
| Drawer | Mantiene forma lateral, comparte header y controles | Convertirlo en modal centrado; dejarlo fuera |

La decisión sobre blur y gradientes es la única que **resta** efecto visual respecto a lo actual:
cuatro de los cinco modales pierden su `backdrop-filter: blur()` y su
`linear-gradient(180deg, …)` de fondo. Es el precio de la fidelidad a la referencia elegida.

## Arquitectura

### `components/shared/ModalShell/`

Un componente que resuelve **una sola vez** lo que hoy está copiado cinco veces: `Escape`,
click fuera, `role="dialog"` + `aria-modal`, focus trap, bloqueo del scroll del body y
restauración del foco al cerrar.

```
ModalShell.jsx          — overlay + diálogo + comportamiento
ModalShell.module.css   — la cáscara, calcada del wizard
```

API:

| Prop | Tipo | Nota |
|---|---|---|
| `eyebrow` | node | Dominio, no acción (`LP Orchestrator`, `Uniswap Actions`) |
| `title` | node | La acción |
| `desc` | node | Una línea de contexto; opcional |
| `headerActions` | node | Slot a la izquierda del botón cerrar (p. ej. wallet del wizard) |
| `footer` | node | Acciones; el pie se omite si no se pasa |
| `size` | `'sm' \| 'md' \| 'lg'` | 560 / 780 / 920 px |
| `variant` | `'center' \| 'drawer'` | `drawer` para `ActionLogDrawer` |
| `onClose` | fn | |
| `closeDisabled` | bool | `OrchestratorIssueModal` lo necesita mientras resuelve |

`variant="drawer"` cambia la colocación (panel derecho a altura completa, `slideIn`) pero
conserva header, tipografía y controles. En `drawer` la prop `size` se ignora: el panel usa
ancho fijo `min(560px, 100%)`, el que ya tiene hoy `ActionLogDrawer`.

### `styles/modal-controls.module.css`

Controles compartidos, importados por cada modal:
`field`, `fieldLabel`, `fieldHint`, `input`, `select`, `chip` / `chipOn`, `badge`, `card`,
`notice` (+ `noticeWarn`), `errorBox`, `grid2`, `footerActions`,
`btn` + `btnPrimary` / `btnSecondary` / `btnGhost` / `btnDanger`.

**Nota de especificidad:** las reglas de control deben ganar a cualquier selector de tipo base
(`input[type='number']`, especificidad `0-1-1`). Se escriben con doble clase o clase+atributo —
el bug del prefijo `$` en `SmartCreatePoolModal` salió exactamente de este empate.

### Escala de z-index en `tokens.css`

```css
--z-modal: 1000;
--z-modal-stacked: 1100;   /* modal abierto desde otro modal */
--z-drawer: 1000;
--z-toast: 1300;
```

Sustituye a los cinco valores arbitrarios. `PositionActionModal` y `SmartAddLiquidityModal`, que
se abren desde la página del orquestador y pueden convivir con otro diálogo, usan
`--z-modal-stacked`.

## Lenguaje visual

| Elemento | Valor |
|---|---|
| Overlay | `rgba(5,7,12,.72)`, sin blur, scroll propio, `align-items: flex-start`, padding `40px 16px` |
| Diálogo | `--bg-primary` · `1px solid --border` · `--radius-xl` · `--shadow-dropdown` |
| Header | padding `24px 28px 18px`, borde inferior `--border-subtle` |
| Eyebrow | `--font-mono`, `--fs-2xs`, uppercase, `letter-spacing .18em`, `--teal` |
| Título | `1.4rem` / `600` / `--text-bright` |
| Descripción | `.8125rem` / `--text-secondary`, `max-width 520px` |
| Cerrar | 30×30, `--radius-md`, borde `--border`, fondo `--bg-card` |
| Body | padding `22px 28px`, secciones separadas por `--sp-5` |
| Footer | fondo `--bg-deep`, acciones a la derecha, primaria la última |
| Anchos | `sm 560` · `md 780` · `lg 920` |
| Acento | `--teal` primario; ámbar / rojo / verde **solo** como color semántico |

## Cambios de UX aprobados

Tres ajustes de comportamiento visual que van más allá del reskin:

1. **Pie de `OrchestratorIssueModal` con `space-between`.** "Ver bitácora" a la izquierda,
   "Cerrar" / "Reintentar" a la derecha. Hoy los tres van juntos y la navegación compite con la
   confirmación.
2. **Jerarquía fija de botones** (ghost / secundario / primario) en lugar de variar el tono del
   primario según `issue.tone`. El tono del issue sigue expresándose en el badge de la cabecera.
3. **El eyebrow nombra el dominio, el título nombra la acción.** `SmartAddLiquidityModal` hoy lo
   tiene invertido (`eyebrow` = "Agregar liquidez (smart)", `title` = el par); se corrige para
   casar con el wizard.

Ningún otro flujo, orden de pasos ni contrato de datos cambia.

## Trabajo por modal

| Modal | Trabajo |
|---|---|
| `EditOrchestratorConfigModal` | Migra a `ModalShell`; se **borran** `.overlay` / `.modal` / `.header` / `.footer` de `StrategyFieldInput.module.css`, que vuelve a ser solo el CSS del campo |
| `OrchestratorIssueModal` | `ModalShell size="sm"`; badge y `card` tokenizados; los tres cambios de UX de arriba |
| `ActionLogDrawer` | `ModalShell variant="drawer"`; entradas de bitácora con `card` / `notice` compartidos; conserva `slideIn` |
| `PositionActionModal` | `ModalShell size="lg"`; es el que más controles internos migra (`formGrid`, `infoCard`, `field`) |
| `SmartAddLiquidityModal` | `ModalShell size="md"` + controles; eyebrow/título invertidos |

## Verificación

Antes de dar por cerrado cualquier modal:

1. **Tests existentes en verde.** `UnifiedLpWizard.standalone.test.jsx` confirma que la
   referencia no se mueve; los tests de `useSmartCreateFlow` y `ProtectionFormFields` cubren los
   flujos que los modales del alcance disparan.
2. **Apertura real contra Docker en `localhost:5174`** con Playwright, uno por uno, con captura
   antes/después. Un modal que renderiza no es un modal que funciona: hay que confirmar que
   `Escape`, click fuera y el botón cerrar siguen cerrando, y que el foco vuelve al disparador.
3. **Comprobación de apilado:** abrir `PositionActionModal` desde la página del orquestador y
   verificar que queda por encima, que es el caso que hoy está roto.

## Desviaciones durante la implementación

Cinco cosas salieron distintas de lo diseñado. Todas por hallazgos en el código:

1. **`aria-label="Cerrar diálogo"`, no `"Cerrar"`.** Varios modales tienen además un botón
   "Cerrar" en el pie; dos controles con el mismo nombre accesible dentro del mismo diálogo son
   indistinguibles con lector de pantalla.
2. **`modal-controls` define sus propios botones.** Ya existía `styles/components.css` con
   `.btn`/`.btn-primary` globales, pero su primario es un degradado teal→azul y el wizard —la
   referencia aprobada— usa `--teal` plano. Unificar ambos sistemas toca toda la app y queda
   para otra pasada.
3. **En `SmartAddLiquidityModal` los botones siguen dentro de cada paso**, no en la barra de pie
   del mockup. El wizard de referencia también los tiene inline; gana el código real.
4. **`StrategyFieldInput` consume `modal-controls` directamente.** Solo lo usaba
   `EditOrchestratorConfigModal`, así que en vez de duplicar campo/label/hint se quedó con
   `tooltipIcon` y poco más: de 494 líneas a 26.
5. **El caso de `PositionActionModal` en el smoke test está omitido.** Montarlo cuelga el worker
   de vitest con cualquier acción. Comprobado contra la versión de HEAD con el mismo mock: es
   previo a esta migración, que solo tocó JSX y clases. Pendiente de investigar aparte.

## Riesgos

- **`PositionActionModal` y `SmartAddLiquidityModal` son compartidos.** Cambian también en
  Uniswap Pools. Hay que revisar esa página, no solo la del orquestador.
- **Vaciar `StrategyFieldInput.module.css` puede romper el campo** si alguna clase de la cáscara
  se estaba reutilizando dentro del input. Hay que revisar los usos antes de borrar, no después.
- **El focus trap es nuevo.** Ningún modal actual lo tiene; introducirlo puede alterar el
  comportamiento del tabulador en formularios largos como el de edición de configuración.
- **`--uni-*` sigue vivo** y es legítimo para acentos de datos (barras de rango, colores de
  token). El objetivo es sacarlo del *chrome* de los modales, no eliminarlo del proyecto.
