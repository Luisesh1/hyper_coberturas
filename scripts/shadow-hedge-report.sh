#!/usr/bin/env bash
#
# shadow-hedge-report.sh — Reporte de validación del shadow mode del hedge.
#
# Agrega los logs `delta_neutral_shadow_hedge` que emite el motor delta-neutral
# cuando DELTA_NEUTRAL_SHADOW_MODE=true, y resume si conviene adoptar el fix
# (subir DELTA_NEUTRAL_ZONE_MULT_CENTER hacia 1.0).
#
# Decide GO si, sobre la ventana observada:
#   - residualReductionUsd promedio > 0 (el fix reduce exposición sin cubrir), y
#   - el % de muestras con reducción positiva es alto (el fix casi nunca empeora).
#
# Uso:
#   scripts/shadow-hedge-report.sh [VENTANA]
#   VENTANA: rango de `docker logs --since` (default 72h). Ej: 24h, 5d, 168h.
#
# El checklist completo de activación está al final de la salida.

set -euo pipefail

CONTAINER="${SHADOW_CONTAINER:-testbot-server-prod}"
WINDOW="${1:-72h}"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "ERROR: contenedor '${CONTAINER}' no está corriendo." >&2
  exit 1
fi

# Extraemos solo las líneas del evento shadow dentro de la ventana.
LOGS="$(docker logs "${CONTAINER}" --since "${WINDOW}" 2>&1 \
  | grep '"delta_neutral_shadow_hedge"' || true)"

COUNT="$(printf '%s' "${LOGS}" | grep -c . || true)"

echo "════════════════════════════════════════════════════════════════"
echo " Reporte shadow-hedge · contenedor=${CONTAINER} · ventana=${WINDOW}"
echo "════════════════════════════════════════════════════════════════"

if [ "${COUNT}" -eq 0 ]; then
  echo "Sin muestras 'delta_neutral_shadow_hedge' en la ventana."
  echo "¿Está DELTA_NEUTRAL_SHADOW_MODE=true y hay protecciones activas?"
  exit 0
fi

# Agregación por protección + global con jq (stream de objetos JSON).
printf '%s\n' "${LOGS}" | jq -rs '
  def avg(f): (map(f) | add) / length;
  def pct(f): (map(select(f)) | length) * 100 / length;
  group_by(.protectionId)[] as $g
  | {
      protectionId: $g[0].protectionId,
      asset: $g[0].asset,
      samples: ($g | length),
      avgLiveResidualUsd: ($g | avg(.liveResidualUsd) | (.*100|round)/100),
      avgShadowResidualUsd: ($g | avg(.shadowResidualUsd) | (.*100|round)/100),
      avgResidualReductionUsd: ($g | avg(.residualReductionUsd) | (.*100|round)/100),
      pctSamplesReducePositive: ($g | pct(.residualReductionUsd > 0) | (.*10|round)/10),
      zones: ($g | group_by(.zoneState) | map({ (.[0].zoneState): length }) | add)
    }
  | "  protección #\(.protectionId) (\(.asset)) · \(.samples) muestras\n" +
    "    residual actual prom:     $\(.avgLiveResidualUsd)\n" +
    "    residual con fix prom:    $\(.avgShadowResidualUsd)\n" +
    "    REDUCCIÓN prom:           $\(.avgResidualReductionUsd)\n" +
    "    % muestras con mejora:    \(.pctSamplesReducePositive)%\n" +
    "    zonas:                    \(.zones)"
'

echo "----------------------------------------------------------------"

# Veredicto global.
# El criterio correcto NO es "% de muestras que mejora" — en edge/outside el hedge
# ya está a 1.0, así que el fix es un no-op (reducción exactamente 0) y esas muestras
# nunca cuentan como positivas. Como la posición vive en edge la mayor parte del
# tiempo, exigir pctPositive alto es un falso negativo. Lo que importa es: ¿el fix
# empeora alguna muestra? (pctWorse). Si nunca empeora y reduce en promedio, es GO.
printf '%s\n' "${LOGS}" | jq -rs '
  def avg(f): (map(f) | add) / length;
  def pct(f): (map(select(f)) | length) * 100 / length;
  {
    samples: length,
    avgReduction: (avg(.residualReductionUsd) | (.*100|round)/100),
    pctPositive: (pct(.residualReductionUsd > 0) | (.*10|round)/10),
    pctWorse: (pct(.residualReductionUsd < -0.01) | (.*10|round)/10)
  }
  | "GLOBAL · \(.samples) muestras · reducción prom $\(.avgReduction) · mejora en \(.pctPositive)% · empeora en \(.pctWorse)% de muestras\n" +
    (if (.avgReduction > 0 and .pctWorse == 0)
       then "VEREDICTO: ✅ GO — adoptar el fix (subir DELTA_NEUTRAL_ZONE_MULT_CENTER hacia 1.0). Ninguna muestra empeora."
     elif (.avgReduction > 0)
       then "VEREDICTO: ⚠️  PARCIAL — reduce en promedio pero \(.pctWorse)% de muestras empeora; revisar regímenes antes de activar."
     else "VEREDICTO: ❌ NO-GO — el fix no reduce el residual en esta ventana."
     end)
'

cat <<'CHECKLIST'

────────────────────────────────────────────────────────────────
 Checklist de activación (cuando el veredicto sea GO)
────────────────────────────────────────────────────────────────
 [ ] El veredicto fue GO sobre >=3 días, incluyendo días con movimiento de precio
     (no solo mercado plano).
 [ ] Revisar funding: en /metricas, "Funding/día" no debe ser un headwind grande
     que anule la mejora del residual (un hedge mayor paga/cobra más funding).
 [ ] Activar el fix en server/.env:
        DELTA_NEUTRAL_ZONE_MULT_CENTER=1.0      # (o un intermedio: 0.85)
        # opcional, acelerar cadencia de rebalanceo:
        DELTA_NEUTRAL_BAND_INTERVAL_TIGHTEN=0.5
        DELTA_NEUTRAL_SHADOW_MODE=false          # ya no hace falta el shadow
 [ ] Recrear el server:
        docker compose -f docker-compose.prod.yml up -d server
 [ ] Verificar healthy y que targetQty ≈ deltaQty en los logs delta_neutral.
 [ ] Seguir el accounting unos días: el residual (priceDrift+hedgePnL) debe
     tender a ~0 y el netPnl por orquestador hacia positivo.
CHECKLIST
