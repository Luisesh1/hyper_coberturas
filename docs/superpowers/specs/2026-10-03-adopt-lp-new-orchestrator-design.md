# Adoptar un LP existente con un orquestador nuevo

Fecha: 2026-10-03 · Estado: aprobado (diseño visual en el artifact «Adoptar LP existente»)

## Problema

Solo se puede adoptar un LP desde un orquestador que ya existe y que se configuró
a mano con el mismo par, red y fee (`POST /:id/adopt-lp`). No hay forma de partir
de una posición que ya está en la wallet y obtener un orquestador configurado.

## Solución

«Crear orquestador» ofrece dos caminos: crear un LP nuevo (asistente actual) o
adoptar un LP de la wallet. El segundo no pide firmas y precarga la configuración
con lo que la posición cuenta de sí misma.

### Pasos del asistente

1. **Posición**: red + wallet; se escanean v3 y v4. Cada posición muestra valor,
   rango, hook y estado. Las no adoptables aparecen deshabilitadas con el motivo.
2. **Datos**: identidad bloqueada (red, versión, par, fee, tickSpacing, hook,
   poolId), capital, ancho de rango, margen de borde, slippage y nombre editables.
3. **Cobertura**: nueva (formulario actual precargado y con políticas
   restringidas por el hook), conservar la existente, o ninguna.
4. **Revisión**: resumen y confirmación.

### Precarga

| Campo | Regla |
|---|---|
| network, version, walletAddress, tokens, fee | De la posición. |
| v4TickSpacing, v4Hooks | PoolKey de la posición (siempre en v4). |
| v4DynamicFeeHookVersionId | Si el hook está en el registro de hooks verificados. |
| inferredAsset | `protectionCandidate.inferredAsset`. |
| initialTotalUsd | `currentValueUsd` (sin fees sin cobrar). Editable. |
| rangeWidthPct | (sup − inf) / 2 / √(inf·sup) × 100, 2 decimales. |
| min/maxRangeWidthPct | 1 / 30, ampliados para contener el ancho del LP. |
| edgeMarginPct | 40 (default del asistente). |
| name | `{t0}/{t1} {fee o «dinámica»} #{id}`. |

### Elegibilidad

- Sin liquidez → no aparece.
- Ya vinculada a un orquestador activo → deshabilitada.
- Hook con retorno de delta en liquidez → deshabilitada.
- Sin valoración USD → deshabilitada.
- Hook con retorno de delta en swaps → solo políticas `SWAP_DELTA_HOOK_POLICIES`.
- Cobertura activa delta-neutral → modo `reuse` (único). Otra cobertura activa →
  solo `none`, con aviso. Activo no cubrible en Hyperliquid → solo `none`.

### Decisiones

1. Cobertura existente delta-neutral: se vincula sin tocar el short.
2. Contabilidad: el PnL empieza en la adopción. Se siembra
   `lastEvaluation.poolSnapshot` con el snapshot de adopción, así la primera
   evaluación no cuenta como ganancia las fees sin cobrar previas ni la deriva.
3. Fallo de cobertura: estricto. Se borra el orquestador, se desactiva la
   protección si llegó a crearse en esta llamada, y el LP queda intacto.

### API

- `GET /lp-orchestrators/adoption-candidates?network&walletAddress` →
  `{ candidates: [{ position, eligible, blockedReason, prefill, protection }], warnings }`.
- `POST /lp-orchestrators/adopt` → `{ orchestrator }`. Relee la posición en cadena
  e ignora la identidad que manda el cliente; solo acepta los campos editables.
  Tras crear, evalúa en segundo plano.

### Fuera de alcance

- Sustituir los `prompt()`/`confirm()` del adoptar huérfano actual.
- Acción «Orquestar» desde la página de Pools.
