#!/usr/bin/env bash
#
# hedge-followup.sh — Dashboard de seguimiento (SOLO LECTURA) de los
# orquestadores LP tras activar la cobertura plena del hedge (center 0.6→1.0).
#
# Diseñado para consultarse en sesiones posteriores sin re-autorización: NO
# ejecuta ninguna escritura — solo SELECT contra la db `hyperbot`. Cualquier
# cambio (DELETE/UPDATE/config/deploy) queda fuera y sigue requiriendo OK manual.
#
# Uso:
#   scripts/hedge-followup.sh [VENTANA_DIAS]
#   VENTANA_DIAS: ventana de análisis en días (default 7).
#
# Qué vigila (en orden de importancia post-cambio):
#   1. Riesgo de liquidación del short  ← el riesgo que introdujo subir el hedge
#   2. Cobertura efectiva (target/delta) ← debe pasar de ~0.60 a ~1.0 en center
#   3. Convergencia del residual         ← corr(total,lp)→0, netPnl→positivo
#   4. Time-in-range y funding
#   5. Calidad de datos (anomalías hl=0)  ← debe quedarse en 0 tras el fix

set -euo pipefail

CONTAINER="${FOLLOWUP_DB_CONTAINER:-testbot-postgres-prod}"
DB="${FOLLOWUP_DB:-hyperbot}"
DBUSER="${FOLLOWUP_DB_USER:-hyperBot}"
WIN_DAYS="${1:-7}"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "ERROR: contenedor '${CONTAINER}' no está corriendo." >&2
  exit 1
fi

# Helper: corre una query read-only. Rechaza cualquier verbo de escritura como
# doble red de seguridad (el script no debe mutar prod nunca).
q() {
  local sql="$1"
  if printf '%s' "$sql" | grep -iqE '\b(insert|update|delete|drop|alter|truncate|create|grant)\b'; then
    echo "ABORT: query no-read detectada, bloqueada." >&2; exit 2
  fi
  docker exec "$CONTAINER" psql -U "$DBUSER" -d "$DB" -P pager=off -c "$sql"
}

WIN_MS="${WIN_DAYS}::bigint*86400000"

echo "════════════════════════════════════════════════════════════════"
echo " Seguimiento hedge · db=${DB} · ventana=${WIN_DAYS}d · $(date -u '+%Y-%m-%d %H:%MZ')"
echo "════════════════════════════════════════════════════════════════"

echo ""
echo "── 1. RIESGO DE LIQUIDACIÓN (short) — vigilar que no caiga de ~8% ──"
q "
SELECT protected_pool_id AS pp,
  round(distance_to_liq_pct::numeric,1) AS dist_liq_pct,
  round(effective_band_pct::numeric,2) AS band,
  to_timestamp(created_at/1000) AS ultimo_rebal
FROM protected_pool_delta_rebalance_log l
WHERE created_at = (
  SELECT MAX(created_at) FROM protected_pool_delta_rebalance_log
  WHERE protected_pool_id = l.protected_pool_id)
ORDER BY protected_pool_id;"

echo "── mínimo de distancia a liquidación en la ventana ──"
q "
WITH c AS (SELECT (EXTRACT(EPOCH FROM NOW())::bigint*1000 - ${WIN_MS}) AS t)
SELECT protected_pool_id AS pp,
  round(MIN(distance_to_liq_pct)::numeric,1) AS min_dist_liq_pct,
  COUNT(*) AS rebalances
FROM protected_pool_delta_rebalance_log, c
WHERE created_at >= c.t
GROUP BY protected_pool_id ORDER BY protected_pool_id;"

echo ""
echo "── 2. COBERTURA EFECTIVA (target/delta) — debe tender a ~1.0 en center ──"
q "
WITH c AS (SELECT (EXTRACT(EPOCH FROM NOW())::bigint*1000 - ${WIN_MS}) AS t)
SELECT protected_pool_id AS pp, to_timestamp(created_at/1000) AS ts,
  round((target_qty_after/NULLIF(delta_qty_before,0))::numeric,2) AS ratio_tgt_delta,
  round(effective_band_pct::numeric,2) AS band
FROM protected_pool_delta_rebalance_log, c
WHERE created_at >= c.t
ORDER BY created_at DESC LIMIT 8;"

echo ""
echo "── 3. CONVERGENCIA DEL RESIDUAL — corr(total,lp)→0, CV bajo ──"
q "
WITH c AS (SELECT (EXTRACT(EPOCH FROM NOW())::bigint*1000 - ${WIN_MS}) AS t),
clean AS (
  SELECT * FROM orchestrator_metrics_snapshots, c
  WHERE captured_at >= c.t AND hl_account_usd > 0 AND total_usd > 100
)
SELECT orchestrator_id AS orch, COUNT(*) AS snaps,
  round(MIN(total_usd),2) AS min, round(MAX(total_usd),2) AS max,
  round(AVG(total_usd),2) AS avg,
  round(STDDEV(total_usd)/AVG(total_usd)*100,2) AS cv_pct,
  round(corr(total_usd, lp_usd)::numeric,3) AS corr_total_lp
FROM clean GROUP BY orchestrator_id ORDER BY orchestrator_id;"

echo "── accounting acumulado (residual = priceDrift+hedgeRealized+funding → 0) ──"
q "
SELECT id AS orch,
  round((accounting_json::json->>'lpFeesUsd')::numeric,2) AS fees,
  round((accounting_json::json->>'priceDriftUsd')::numeric,2) AS price_drift,
  round((accounting_json::json->>'hedgeRealizedPnlUsd')::numeric,2) AS hedge_realized,
  round((accounting_json::json->>'hedgeFundingUsd')::numeric,2) AS funding,
  round(
    (accounting_json::json->>'priceDriftUsd')::numeric
    + (accounting_json::json->>'hedgeRealizedPnlUsd')::numeric
    + (accounting_json::json->>'hedgeFundingUsd')::numeric, 2) AS residual,
  round((accounting_json::json->>'totalNetPnlUsd')::numeric,2) AS net_pnl
FROM lp_orchestrators WHERE id IN (4,5) ORDER BY id;"

echo ""
echo "── 4. TIME-IN-RANGE (fees solo dentro de rango) ──"
q "
WITH c AS (SELECT (EXTRACT(EPOCH FROM NOW())::bigint*1000 - ${WIN_MS}) AS t)
SELECT orchestrator_id AS orch, COUNT(*) AS evals,
  round(100.0*COUNT(*) FILTER (
    WHERE current_price BETWEEN range_lower_price AND range_upper_price)/COUNT(*),1) AS time_in_range_pct
FROM lp_orchestrator_action_log, c
WHERE created_at >= c.t AND current_price IS NOT NULL
  AND range_lower_price IS NOT NULL AND range_upper_price IS NOT NULL
GROUP BY orchestrator_id ORDER BY orchestrator_id;"

echo ""
echo "── 5. CALIDAD DE DATOS — anomalías hl=0 (debe ser 0 tras el fix) ──"
q "
WITH c AS (SELECT (EXTRACT(EPOCH FROM NOW())::bigint*1000 - ${WIN_MS}) AS t)
SELECT orchestrator_id AS orch,
  COUNT(*) FILTER (
    WHERE hl_account_usd = 0
    AND breakdown_json->>'hlStatus' IN ('not_linked','unavailable')) AS anomalias_hl0,
  COUNT(*) AS snaps_total
FROM orchestrator_metrics_snapshots, c
WHERE captured_at >= c.t
GROUP BY orchestrator_id ORDER BY orchestrator_id;"

echo ""
echo "════════════════════════════════════════════════════════════════"
echo " Lecturas rápidas:"
echo "  · dist_liq_pct < 8%  → margen apretado, considerar bajar leverage / revertir a 0.85"
echo "  · ratio_tgt_delta ~1.0 en center → el fix tomó efecto (era 0.60)"
echo "  · corr_total_lp → 0 y net_pnl → positivo → el residual está convergiendo"
echo "  · anomalias_hl0 > 0 → el fix de métricas no está corriendo / regresión"
echo "════════════════════════════════════════════════════════════════"
