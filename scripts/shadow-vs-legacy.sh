#!/usr/bin/env bash
#
# shadow-vs-legacy.sh — Compara la cobertura SOMBRA (contrafactual
# `net_profit_v1`) contra la cobertura LEGACY que se ejecuta de verdad
# (`legacy_zones_v1`), usando la contabilidad acumulada del orquestador y el
# snapshot de sombra que persiste el motor delta-neutral.
#
# SOLO LECTURA: mismo guard que scripts/hedge-followup.sh.
#
# Uso: scripts/shadow-vs-legacy.sh [VENTANA_DIAS]   (default 7)

set -euo pipefail

CONTAINER="${FOLLOWUP_DB_CONTAINER:-testbot-postgres-prod}"
DB="${FOLLOWUP_DB:-hyperbot}"
DBUSER="${FOLLOWUP_DB_USER:-hyperBot}"
WIN_DAYS="${1:-7}"

q() {
  local sql="$1"
  if printf '%s' "$sql" | grep -iqE '\b(insert|update|delete|drop|alter|truncate|create|grant)\b'; then
    echo "ABORT: query no-read detectada, bloqueada." >&2; exit 2
  fi
  docker exec "$CONTAINER" psql -U "$DBUSER" -d "$DB" -P pager=off -c "$sql"
}

echo "════════ sombra vs legacy · ventana=${WIN_DAYS}d · $(date -u '+%F %HZ') ════════"

echo
echo "── A. QUÉ POLÍTICA CORRE CADA PROTECCIÓN ──"
q "SELECT p.id pp, p.status,
     p.strategy_state_json::jsonb->>'policyVersion'       AS policy_live,
     p.strategy_state_json::jsonb->>'executionIntent'     AS intent,
     p.strategy_state_json::jsonb->>'shadowPolicyVersion' AS policy_shadow,
     (p.strategy_state_json::jsonb->'shadowSnapshot') IS NOT NULL AS tiene_snapshot_sombra
   FROM protected_uniswap_pools p
   WHERE p.status = 'active' OR p.updated_at > (extract(epoch from now())*1000 - ${WIN_DAYS}*86400000)
   ORDER BY p.id DESC LIMIT 15;"

echo
echo "── B. ACCOUNTING ACUMULADO: pata REAL vs pata SOMBRA (USD, lifetime) ──"
q "SELECT o.id orch, o.status,
     round((o.accounting_json::jsonb->>'hedgeRealizedPnlUsd')::numeric,3)   AS real_realizado,
     round((o.accounting_json::jsonb->>'hedgeUnrealizedPnlUsd')::numeric,3) AS real_latente,
     round((o.accounting_json::jsonb->>'hedgeFundingUsd')::numeric,3)       AS real_funding,
     round((o.accounting_json::jsonb->>'hedgeExecutionFeesUsd')::numeric,3) AS real_fees,
     round((o.accounting_json::jsonb->>'hedgeSlippageUsd')::numeric,3)      AS real_slip,
     round(( (o.accounting_json::jsonb->>'hedgeRealizedPnlUsd')::numeric
           + (o.accounting_json::jsonb->>'hedgeUnrealizedPnlUsd')::numeric
           + (o.accounting_json::jsonb->>'hedgeFundingUsd')::numeric
           - (o.accounting_json::jsonb->>'hedgeExecutionFeesUsd')::numeric
           - (o.accounting_json::jsonb->>'hedgeSlippageUsd')::numeric ),3)  AS real_neto,
     round((o.accounting_json::jsonb->>'shadowRealizedPnlUsd')::numeric,3)   AS som_realizado,
     round((o.accounting_json::jsonb->>'shadowUnrealizedPnlUsd')::numeric,3) AS som_latente,
     round((o.accounting_json::jsonb->>'shadowFundingUsd')::numeric,3)       AS som_funding,
     round((o.accounting_json::jsonb->>'shadowExecutionFeesUsd')::numeric,3) AS som_fees,
     round((o.accounting_json::jsonb->>'shadowSlippageUsd')::numeric,3)      AS som_slip,
     round((o.accounting_json::jsonb->>'shadowNetPnlUsd')::numeric,3)        AS som_neto
   FROM lp_orchestrators o
   WHERE o.status = 'active' OR o.updated_at > (extract(epoch from now())*1000 - ${WIN_DAYS}*86400000)
   ORDER BY o.id;"

echo
echo "── C. SNAPSHOT DE SOMBRA CRUDO (estado actual por protección) ──"
q "SELECT p.id pp,
     p.strategy_state_json::jsonb->'shadowSnapshot' AS shadow_snapshot,
     p.strategy_state_json::jsonb->>'lastDeltaQty'  AS delta_qty,
     p.strategy_state_json::jsonb->>'lastActualQty' AS actual_qty,
     p.strategy_state_json::jsonb->>'lastShadowTargetQty' AS shadow_target_qty
   FROM protected_uniswap_pools p
   WHERE p.status = 'active' ORDER BY p.id;"

echo
echo "── D. TRACKING DE LA COBERTURA REAL (distribución actual/target) ──"
q "SELECT protected_pool_id pp, count(*) n,
     round(avg(actual_qty/nullif(target_qty,0))::numeric,3)  AS media,
     round(percentile_cont(0.05) WITHIN GROUP (ORDER BY actual_qty/nullif(target_qty,0))::numeric,3) AS p05,
     round(percentile_cont(0.50) WITHIN GROUP (ORDER BY actual_qty/nullif(target_qty,0))::numeric,3) AS p50,
     round(percentile_cont(0.95) WITHIN GROUP (ORDER BY actual_qty/nullif(target_qty,0))::numeric,3) AS p95,
     round((100.0*count(*) FILTER (WHERE actual_qty/nullif(target_qty,0) BETWEEN 0.9 AND 1.1)/count(*))::numeric,1) AS pct_en_banda,
     round((100.0*count(*) FILTER (WHERE actual_qty/nullif(target_qty,0) < 0.8)/count(*))::numeric,1) AS pct_bajo_08
   FROM protection_decision_log
   WHERE created_at > (extract(epoch from now())*1000 - ${WIN_DAYS}*86400000)
     AND target_qty > 0.0005
   GROUP BY 1 ORDER BY 1;"

echo
echo "── E. DECISIONES REGISTRADAS (qué gatea cada política) ──"
q "SELECT protected_pool_id pp, decision, count(*)
   FROM protection_decision_log
   WHERE created_at > (extract(epoch from now())*1000 - ${WIN_DAYS}*86400000)
   GROUP BY 1,2 ORDER BY 1, 3 DESC;"

echo
echo "── F. VIDA DE LA SOMBRA: desde cuándo corre cada protección/orquestador ──"
q "SELECT p.id pp, p.status,
     to_timestamp(p.created_at/1000) AS creada,
     round((extract(epoch from now())*1000 - p.created_at)/3600000.0,1) AS horas_vida,
     p.strategy_state_json::jsonb->>'policyVersion' AS policy,
     p.strategy_state_json::jsonb->>'executionIntent' AS intent
   FROM protected_uniswap_pools p ORDER BY p.id DESC LIMIT 12;"

echo
echo "── G. ¿ALGUNA PROTECCIÓN HISTÓRICA CORRIÓ net_profit_v1? ──"
q "SELECT count(*) FILTER (WHERE p.strategy_state_json LIKE '%net_profit_v1%') AS con_net_profit,
          count(*) FILTER (WHERE p.strategy_state_json LIKE '%shadowSnapshot%') AS con_snapshot_sombra,
          count(*) AS total
   FROM protected_uniswap_pools p;"

echo
echo "── H. ¿HAY HISTORIA DE LA SOMBRA EN LOS SNAPSHOTS DE MÉTRICAS? ──"
q "SELECT orchestrator_id, count(*) n,
     count(*) FILTER (WHERE breakdown_json::text LIKE '%shadow%') AS con_shadow,
     to_timestamp(min(captured_at)/1000) AS desde, to_timestamp(max(captured_at)/1000) AS hasta
   FROM orchestrator_metrics_snapshots
   WHERE captured_at > (extract(epoch from now())*1000 - ${WIN_DAYS}*86400000)
   GROUP BY 1 ORDER BY 1;"

echo
echo "── I. EJECUCIÓN REAL DEL HEDGE (rebalanceos ejecutados por protección) ──"
q "SELECT protected_pool_id pp, count(*) rebalanceos,
     to_timestamp(min(created_at)/1000) AS primero, to_timestamp(max(created_at)/1000) AS ultimo,
     round(sum(coalesce(target_qty_after,0))::numeric,4) AS qty_final
   FROM protected_pool_delta_rebalance_log
   WHERE created_at > (extract(epoch from now())*1000 - ${WIN_DAYS}*86400000)
   GROUP BY 1 ORDER BY 1;"

echo
echo "── J. SERIE HORARIA: neto REAL vs neto SOMBRA (breakdown_json) ──"
q "SELECT orchestrator_id orch, to_timestamp(captured_at/1000) AS ts,
     round((breakdown_json::jsonb->'accounting'->>'hedgeRealizedPnlUsd')::numeric
         + (breakdown_json::jsonb->'accounting'->>'hedgeUnrealizedPnlUsd')::numeric
         + (breakdown_json::jsonb->'accounting'->>'hedgeFundingUsd')::numeric
         - (breakdown_json::jsonb->'accounting'->>'hedgeExecutionFeesUsd')::numeric
         - (breakdown_json::jsonb->'accounting'->>'hedgeSlippageUsd')::numeric, 4) AS real_neto,
     round((breakdown_json::jsonb->'accounting'->>'shadowNetPnlUsd')::numeric,4) AS sombra_neto,
     round((breakdown_json::jsonb->'accounting'->>'shadowExecutionFeesUsd')::numeric,4) AS som_fees,
     round((breakdown_json::jsonb->'accounting'->>'shadowSlippageUsd')::numeric,4) AS som_slip,
     round((breakdown_json::jsonb->'accounting'->>'hedgeExecutionFeesUsd')::numeric,4) AS real_fees
   FROM orchestrator_metrics_snapshots
   WHERE orchestrator_id = 41 ORDER BY captured_at;"

echo
echo "── K. CORPUS DISPONIBLE PARA REPLAY OFFLINE de la política ──"
q "SELECT protected_pool_id pp, count(*) filas,
     to_timestamp(min(created_at)/1000)::date AS desde,
     to_timestamp(max(created_at)/1000)::date AS hasta,
     round((max(created_at)-min(created_at))/86400000.0,1) AS dias,
     count(*) FILTER (WHERE current_price IS NOT NULL AND target_qty IS NOT NULL) AS con_precio_y_target,
     count(*) FILTER (WHERE estimated_cost_usd IS NOT NULL) AS con_coste
   FROM protection_decision_log GROUP BY 1 ORDER BY 1;"

echo
echo "── L. REPARTICIÓN REAL DEL CAPITAL (wallet / LP / colateral HL) ──"
q "SELECT s.orchestrator_id orch, to_timestamp(max(s.captured_at)/1000) AS ts,
     round(avg((s.breakdown_json::jsonb->>'walletUsd')::numeric),2)     AS wallet,
     round(avg((s.breakdown_json::jsonb->>'lpUsd')::numeric),2)         AS lp,
     round(avg((s.breakdown_json::jsonb->>'hlAccountUsd')::numeric),2)  AS colateral_hl,
     round(avg(s.total_usd),2) AS total,
     round(100*avg((s.breakdown_json::jsonb->>'lpUsd')::numeric)/avg(s.total_usd),1)        AS pct_lp,
     round(100*avg((s.breakdown_json::jsonb->>'hlAccountUsd')::numeric)/avg(s.total_usd),1) AS pct_hl,
     round(100*avg((s.breakdown_json::jsonb->>'walletUsd')::numeric)/avg(s.total_usd),1)    AS pct_wallet
   FROM orchestrator_metrics_snapshots s
   WHERE s.captured_at > (extract(epoch from now())*1000 - 2*86400000)
   GROUP BY 1 ORDER BY 1;"

echo
echo "── M. NOTIONAL DEL HEDGE vs VALOR DEL LP (¿cuánto delta hay que cubrir?) ──"
q "SELECT d.protected_pool_id pp, count(*) n,
     round(avg(d.target_qty*d.current_price)::numeric,1)  AS notional_medio,
     round(percentile_cont(0.50) WITHIN GROUP (ORDER BY d.target_qty*d.current_price)::numeric,1) AS notional_p50,
     round(percentile_cont(0.95) WITHIN GROUP (ORDER BY d.target_qty*d.current_price)::numeric,1) AS notional_p95,
     round(avg(d.tracking_error_usd)::numeric,2) AS err_medio,
     round(percentile_cont(0.95) WITHIN GROUP (ORDER BY d.tracking_error_usd)::numeric,2) AS err_p95,
     round(max(d.tracking_error_usd)::numeric,2) AS err_max
   FROM protection_decision_log d
   WHERE d.created_at > (extract(epoch from now())*1000 - 7*86400000) AND d.target_qty > 0
   GROUP BY 1 ORDER BY 1;"

echo
echo "── N. RED, ANCHO Y COLATERAL vs NOTIONAL (anclaje para dimensionar) ──"
q "SELECT p.id pp, p.network, p.version, p.leverage,
     round(p.range_lower_price::numeric,1) AS rango_inf, round(p.range_upper_price::numeric,1) AS rango_sup,
     round((100*(p.range_upper_price-p.range_lower_price)/nullif((p.range_upper_price+p.range_lower_price)/2,0))::numeric,2) AS ancho_pct
   FROM protected_uniswap_pools p WHERE p.status='active' ORDER BY p.id;"
