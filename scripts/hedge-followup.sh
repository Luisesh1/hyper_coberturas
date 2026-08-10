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
# Qué vigila:
#   0. Inventario de la flota viva (se detecta, no se hardcodea: rota seguido)
#   1. Riesgo de liquidación del short   ← el riesgo que introdujo subir el hedge
#   2. Diagnóstico del rebalanceo        ← target/delta NO prueba cobertura
#   3a. COBERTURA REAL (actual/delta)    ← la métrica buena
#   3b. hedge_beta                       ← ⚠️ NO FIABLE, solo diagnóstico
#   4. Time-in-range · 5. Calidad de datos · 6. Coste de cobertura
#
# Modos extra (read-only): FOLLOWUP_VERIFY_WEEKLY=1 valida el SQL del reporte
# semanal; FOLLOWUP_BETA_SWEEP=1 diagnostica el sesgo de hedge_beta.

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

# Diagnostico de por que `hedge_beta` miente. La cobertura real medida como
# actualQty/deltaQty da 0.99-1.10, pero la regresion sobre snapshots daba
# 0.29-0.50. Si la causa es sesgo de atenuacion (ruido de medicion en la
# variable independiente empuja la pendiente hacia 0), el beta debe SUBIR al
# ensanchar el filtro y dejar entrar movimientos con mas senal que ruido.
if [ "${FOLLOWUP_BETA_SWEEP:-0}" = "1" ]; then
  echo "── beta vs. umbral del filtro (atenuacion si crece con el umbral) ──"
  q "
  WITH c AS (SELECT (EXTRACT(EPOCH FROM NOW())::bigint*1000 - ${WIN_MS}) AS t),
  d AS (
    SELECT orchestrator_id oid, total_usd tot,
      lp_usd - lag(lp_usd) OVER w AS dlp,
      hl_account_usd - lag(hl_account_usd) OVER w AS dhl
    FROM orchestrator_metrics_snapshots, c
    WHERE captured_at >= c.t AND hl_account_usd > 0 AND total_usd > 100
    WINDOW w AS (PARTITION BY orchestrator_id ORDER BY captured_at))
  SELECT oid,
    round((-regr_slope(dhl,dlp) FILTER (WHERE abs(dlp)<0.005*tot AND abs(dhl)<0.005*tot))::numeric,2) AS b_0_5pct,
    round((-regr_slope(dhl,dlp) FILTER (WHERE abs(dlp)<0.01*tot  AND abs(dhl)<0.01*tot ))::numeric,2) AS b_1pct,
    round((-regr_slope(dhl,dlp) FILTER (WHERE abs(dlp)<0.03*tot  AND abs(dhl)<0.03*tot ))::numeric,2) AS b_3pct,
    round((-regr_slope(dhl,dlp) FILTER (WHERE abs(dlp)<0.10*tot  AND abs(dhl)<0.10*tot ))::numeric,2) AS b_10pct,
    round((-regr_slope(dhl,dlp))::numeric,2) AS b_sin_filtro,
    count(*) FILTER (WHERE abs(dlp)<0.01*tot) AS n_1pct,
    count(*) AS n_total
  FROM d WHERE dlp IS NOT NULL GROUP BY oid ORDER BY oid;"

  echo "── magnitud tipica de los incrementos (senal vs ruido) ──"
  q "
  WITH c AS (SELECT (EXTRACT(EPOCH FROM NOW())::bigint*1000 - ${WIN_MS}) AS t),
  d AS (
    SELECT orchestrator_id oid, total_usd tot,
      lp_usd - lag(lp_usd) OVER w AS dlp,
      hl_account_usd - lag(hl_account_usd) OVER w AS dhl
    FROM orchestrator_metrics_snapshots, c
    WHERE captured_at >= c.t AND hl_account_usd > 0 AND total_usd > 100
    WINDOW w AS (PARTITION BY orchestrator_id ORDER BY captured_at))
  SELECT oid, count(*) n,
    round(avg(abs(dlp))::numeric,4) AS abs_dlp_medio,
    round(avg(abs(dhl))::numeric,4) AS abs_dhl_medio,
    round(stddev(dlp)::numeric,4) AS sd_dlp,
    round(stddev(dhl)::numeric,4) AS sd_dhl,
    round(corr(dlp,dhl)::numeric,3) AS corr_sin_filtro
  FROM d WHERE dlp IS NOT NULL GROUP BY oid ORDER BY oid;"
  exit 0
fi

# Valida que las queries de `server/weekly-hedge-report.js` ejecutan contra el
# esquema real. Ese fichero no lo cubren ni los tests ni el lint (que solo mira
# src/ y test/), y solo corre dentro del contenedor de prod, asi que sin esto su
# SQL viaja sin verificar. Uso: FOLLOWUP_VERIFY_WEEKLY=1 scripts/hedge-followup.sh
if [ "${FOLLOWUP_VERIFY_WEEKLY:-0}" = "1" ]; then
  echo "── verificando SQL de weekly-hedge-report.js ──"
  q "WITH s AS (
       SELECT orchestrator_id oid, total_usd t,
         lp_usd - lag(lp_usd) OVER w AS dlp,
         hl_account_usd - lag(hl_account_usd) OVER w AS dhl
       FROM orchestrator_metrics_snapshots
       WHERE captured_at >= (EXTRACT(EPOCH FROM NOW())::bigint*1000 - ${WIN_MS})
         AND hl_account_usd > 0 AND total_usd > 50
       WINDOW w AS (PARTITION BY orchestrator_id ORDER BY captured_at))
     SELECT oid, count(*) snaps,
       round(avg(t)::numeric,2) avg_total,
       round((stddev(t)/nullif(avg(t),0)*100)::numeric,3) cv_pct,
       round(corr(dlp,dhl) FILTER (WHERE abs(dlp) < 0.01*t AND abs(dhl) < 0.01*t)::numeric,3) corr_lp_hl,
       round((-regr_slope(dhl,dlp) FILTER (WHERE abs(dlp) < 0.01*t AND abs(dhl) < 0.01*t))::numeric,3) hedge_beta
     FROM s GROUP BY oid ORDER BY oid;"
  q "SELECT id oid,
       round(((accounting_json::json->>'hedgeExecutionFeesUsd')::numeric
            + (accounting_json::json->>'hedgeSlippageUsd')::numeric),2) exec_cost,
       round(((accounting_json::json->>'hedgeExecutionFeesUsd')::numeric
            + (accounting_json::json->>'hedgeSlippageUsd')::numeric)
            / nullif((accounting_json::json->>'lpFeesUsd')::numeric,0),2) cost_ratio
     FROM lp_orchestrators
     WHERE accounting_json IS NOT NULL
     ORDER BY id;"
  exit 0
fi

# Conjunto activo: orquestadores con snapshots dentro de la ventana. Se detecta
# en vivo en vez de hardcodear ids — la flota rota (antes #4/#5, hoy #35/#36/#37).
ACTIVE="SELECT DISTINCT orchestrator_id FROM orchestrator_metrics_snapshots
        WHERE captured_at >= (EXTRACT(EPOCH FROM NOW())::bigint*1000 - ${WIN_MS})"

echo ""
echo "── 0. INVENTARIO — quién está vivo y con cuánto capital ──"
q "
WITH act AS (${ACTIVE})
SELECT o.id AS orch, o.active_protected_pool_id AS pp, o.status, o.phase,
  o.token0_symbol||'/'||o.token1_symbol AS par, o.version AS ver,
  round(o.initial_total_usd,0) AS capital_ini,
  (SELECT round(s.total_usd,2) FROM orchestrator_metrics_snapshots s
   WHERE s.orchestrator_id=o.id ORDER BY s.captured_at DESC LIMIT 1) AS total_hoy,
  to_timestamp(o.last_evaluation_at/1000) AS ultima_eval,
  o.consecutive_failures AS fallos, left(coalesce(o.last_error,''),40) AS ult_error
FROM lp_orchestrators o
WHERE o.id IN (SELECT orchestrator_id FROM act) OR o.stopped_at IS NULL
ORDER BY o.id;"

echo ""
echo "── 1. RIESGO DE LIQUIDACIÓN — EN VIVO, del último snapshot ──"
# Lee `breakdown_json->hedgeTracking->distanceToLiqPct`, que se calcula en cada
# snapshot desde la posicion real de Hyperliquid. La columna del log de
# rebalanceos solo se escribe AL REBALANCEAR, asi que se congelaba durante horas:
# el 2026-08-10, con el ultimo rebalanceo 6h atras, reportaba #35 al 8.4%
# (real 14.9%) y #37 al 13.7% (real 8.4%, pegado al umbral). Se muestran las dos
# para que la divergencia sea visible.
q "
WITH ultimo AS (
  SELECT DISTINCT ON (orchestrator_id) orchestrator_id, captured_at,
    (breakdown_json->'hedgeTracking'->>'distanceToLiqPct')::numeric AS dist_vivo
  FROM orchestrator_metrics_snapshots
  ORDER BY orchestrator_id, captured_at DESC),
rebal AS (
  SELECT DISTINCT ON (protected_pool_id) protected_pool_id, distance_to_liq_pct, created_at
  FROM protected_pool_delta_rebalance_log ORDER BY protected_pool_id, created_at DESC)
SELECT o.id AS orch, o.active_protected_pool_id AS pp,
  round(u.dist_vivo,1) AS dist_liq_VIVO,
  round(r.distance_to_liq_pct::numeric,1) AS dist_del_ultimo_rebal,
  to_timestamp(r.created_at/1000) AS ese_rebal_fue,
  CASE WHEN u.dist_vivo < 8 THEN '<<< BAJO 8%' ELSE '' END AS alerta
FROM lp_orchestrators o
LEFT JOIN ultimo u ON u.orchestrator_id = o.id
LEFT JOIN rebal r ON r.protected_pool_id = o.active_protected_pool_id
WHERE o.stopped_at IS NULL AND o.active_protected_pool_id IS NOT NULL
ORDER BY o.id;"

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
echo "── 2. DIAGNÓSTICO DEL REBALANCEO — ojo: target/delta NO prueba cobertura ──"
# `ratio_tgt_delta` sale 1.00 SIEMPRE porque delta_qty_before, target_qty_after y
# actual_qty_after se escriben del mismo valor calculado en el rebalanceo. Solo
# confirma que el multiplicador de zona esta en 1.0; no dice nada de si se cubre
# la exposicion real —los v4 lo pasaban perfecto con hedge_beta de 0.29-0.50—.
# El KPI de cobertura es `hedge_beta` (seccion 3b). Esto queda como diagnostico
# de la ejecucion: fill_ratio y drift_usd si son observaciones independientes.
q "
WITH c AS (SELECT (EXTRACT(EPOCH FROM NOW())::bigint*1000 - ${WIN_MS}) AS t)
SELECT protected_pool_id AS pp, to_timestamp(created_at/1000) AS ts, reason,
  round(delta_qty_before::numeric,4) AS delta_lp,
  round(target_qty_after::numeric,4) AS target,
  round(actual_qty_after::numeric,4) AS actual,
  round((target_qty_after/NULLIF(delta_qty_before,0))::numeric,2) AS ratio_tgt_delta,
  round((actual_qty_after/NULLIF(target_qty_after,0))::numeric,2) AS fill_ratio,
  round(drift_usd::numeric,2) AS drift_usd
FROM protected_pool_delta_rebalance_log, c
WHERE created_at >= c.t
ORDER BY created_at DESC LIMIT 12;"

echo "── 2b. ESTABILIDAD DEL DELTA — el delta de un LP debe moverse suave ──"
# Un delta que salta de 0.46 a 0.001 ETH en horas sobre la misma posición no es
# físico: apunta a que snapshot.liquidity llega mal/vacío en algunos ciclos, con
# lo que el target del hedge se calcula sobre un delta subestimado.
q "
WITH c AS (SELECT (EXTRACT(EPOCH FROM NOW())::bigint*1000 - ${WIN_MS}) AS t)
SELECT protected_pool_id AS pp, COUNT(*) AS rebal,
  round(MIN(delta_qty_before)::numeric,4) AS delta_min,
  round(MAX(delta_qty_before)::numeric,4) AS delta_max,
  round(AVG(delta_qty_before)::numeric,4) AS delta_avg,
  round((MAX(delta_qty_before)/NULLIF(MIN(NULLIF(delta_qty_before,0)),0))::numeric,0) AS spread_x
FROM protected_pool_delta_rebalance_log, c
WHERE created_at >= c.t
GROUP BY protected_pool_id ORDER BY protected_pool_id;"

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

echo "── accounting acumulado — descomposición COMPLETA de recomputeNetPnl ──"
# netPnl = fees − gas − swapSlip + hedgeReal + hedgeUnreal + funding
#          − execFees − hedgeSlip + priceDrift   (accounting.js:80-93)
# La columna `check` debe dar ~0: si no, la fila está desincronizada.
q "
WITH a AS (
  SELECT id AS orch,
    (accounting_json::json->>'lpFeesUsd')::numeric AS fees,
    (accounting_json::json->>'gasSpentUsd')::numeric AS gas,
    (accounting_json::json->>'swapSlippageUsd')::numeric AS swap_slip,
    (accounting_json::json->>'hedgeRealizedPnlUsd')::numeric AS h_real,
    (accounting_json::json->>'hedgeUnrealizedPnlUsd')::numeric AS h_unreal,
    (accounting_json::json->>'hedgeFundingUsd')::numeric AS funding,
    (accounting_json::json->>'hedgeExecutionFeesUsd')::numeric AS exec_fees,
    (accounting_json::json->>'hedgeSlippageUsd')::numeric AS h_slip,
    (accounting_json::json->>'priceDriftUsd')::numeric AS drift,
    (accounting_json::json->>'totalNetPnlUsd')::numeric AS net_pnl
  FROM lp_orchestrators
  WHERE (id IN (${ACTIVE}) OR stopped_at IS NULL)
    AND accounting_json IS NOT NULL)
SELECT orch,
  round(fees,2) AS fees, round(gas,2) AS gas, round(swap_slip,2) AS swap_slip,
  round(h_real,2) AS h_real, round(h_unreal,2) AS h_unreal,
  round(funding,2) AS funding, round(exec_fees,2) AS exec_fees,
  round(h_slip,2) AS h_slip, round(drift,2) AS drift,
  round(net_pnl,2) AS net_pnl,
  round(fees-gas-swap_slip+h_real+h_unreal+funding-exec_fees-h_slip+drift-net_pnl,4) AS check
FROM a ORDER BY orch;"

echo ""
echo "── 3a. COBERTURA REAL (actual/delta) — ESTA es la métrica buena ──"
# actualQty y deltaQty tal como las vio el MISMO ciclo de evaluacion, sin pasar
# por snapshots ni por hl_account_usd. 1.0 es lo ideal; desviarse cuesta dinero
# en las dos direcciones (por debajo queda delta expuesto, por encima net-short).
q "
SELECT p.id AS pp, o.id AS orch,
  round((p.strategy_state_json::json->>'lastDeltaQty')::numeric,6) AS delta,
  round((p.strategy_state_json::json->>'lastActualQty')::numeric,6) AS actual,
  round(((p.strategy_state_json::json->>'lastActualQty')::numeric
       / nullif((p.strategy_state_json::json->>'lastDeltaQty')::numeric,0)),4) AS cobertura
FROM protected_uniswap_pools p
JOIN lp_orchestrators o ON o.active_protected_pool_id = p.id
WHERE p.strategy_state_json IS NOT NULL
ORDER BY o.id;"

echo ""
echo "── 3b. hedge_beta — ⚠️ NO FIABLE, solo diagnóstico ──"
# Se calcula sobre `hl_account_usd` y las dos patas NO se muestrean
# sincronizadas: `lp_usd` se queda congelado en hasta el 53% de los intervalos
# mientras el lado HL si se actualiza. Eso es error en la variable independiente
# y hunde la pendiente hacia 0. Daba 0.29-0.50 cuando la cobertura real (3a) era
# 0.99-1.10. Se conserva para vigilar el sesgo, NO para decidir.
# En ventanas >~2d los NIVELES se lavan (rebalanceos mueven el tamaño de ambas
# patas → serie no estacionaria) y dan falso negativo. Lo correcto es correlacionar
# los INCREMENTOS entre snapshots consecutivos, descartando los saltos de
# rebalanceo con un umbral RELATIVO al tamaño (1% del total) para que valga igual
# en un orquestador de $140 que en uno de $1000.
q "
WITH c AS (SELECT (EXTRACT(EPOCH FROM NOW())::bigint*1000 - ${WIN_MS}) AS t),
clean AS (
  SELECT orchestrator_id, captured_at, lp_usd, hl_account_usd, total_usd
  FROM orchestrator_metrics_snapshots, c
  WHERE captured_at >= c.t AND hl_account_usd > 0 AND total_usd > 100),
d AS (
  SELECT orchestrator_id, total_usd,
    lp_usd - lag(lp_usd) OVER w AS dlp,
    hl_account_usd - lag(hl_account_usd) OVER w AS dhl
  FROM clean WINDOW w AS (PARTITION BY orchestrator_id ORDER BY captured_at)),
v AS (
  SELECT orchestrator_id,
    round((1 - variance(total_usd)/NULLIF(variance(lp_usd),0))::numeric,3) AS var_reduccion
  FROM clean GROUP BY orchestrator_id)
SELECT d.orchestrator_id AS orch, COUNT(*) AS deltas,
  round(corr(dlp, dhl)::numeric,3) AS d_corr,
  round((-regr_slope(dhl, dlp))::numeric,3) AS hedge_beta,
  v.var_reduccion
FROM d JOIN v ON v.orchestrator_id = d.orchestrator_id
WHERE dlp IS NOT NULL AND abs(dlp) < 0.01*total_usd AND abs(dhl) < 0.01*total_usd
GROUP BY d.orchestrator_id, v.var_reduccion
ORDER BY d.orchestrator_id;"

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
echo "── 6. COSTO DE COBERTURA — comisiones+slippage por rango/fee tier ──"
# El fee tier NO entra en la lógica de cobertura, pero correlaciona con el ancho
# de rango: un pool 0.05% se usa con rango estrecho → gamma alta y precio cerca
# del borde → deriveBandSettings parte la banda a la mitad → el doble de
# rebalanceos, y cada rebalanceo es una orden taker en HL.
q "
WITH per_pool AS (
  SELECT l.protected_pool_id AS pp,
    COUNT(*) AS rebal,
    (MAX(l.created_at)-MIN(l.created_at))/86400000.0 AS dias,
    AVG(l.effective_band_pct) AS band,
    SUM(COALESCE(l.execution_fee_usd,0)+COALESCE(l.slippage_usd,0)) AS costo,
    MAX(o.fee_tier) AS fee_tier, MAX(o.id) AS orch,
    MAX(o.initial_total_usd) AS cap
  FROM protected_pool_delta_rebalance_log l
  LEFT JOIN lp_orchestrators o ON o.active_protected_pool_id = l.protected_pool_id
  GROUP BY l.protected_pool_id)
SELECT pp, orch, fee_tier, round(band::numeric,2) AS band_avg, rebal,
  round(dias::numeric,1) AS dias,
  round((rebal/NULLIF(dias,0))::numeric,2) AS rebal_dia,
  round(costo::numeric,2) AS costo_usd,
  round((costo/NULLIF(cap,0)*100)::numeric,2) AS costo_pct_cap
FROM per_pool ORDER BY pp;"

echo "── ancho de rango del LP por fee tier (la causa raíz de la frecuencia) ──"
q "
WITH c AS (SELECT (EXTRACT(EPOCH FROM NOW())::bigint*1000 - ${WIN_MS}) AS t)
SELECT a.orchestrator_id AS orch, o.fee_tier,
  COUNT(*) AS evals,
  round(AVG((a.range_upper_price - a.range_lower_price)
    / NULLIF(a.current_price,0) * 100)::numeric,2) AS ancho_rango_pct,
  round(AVG(a.current_price)::numeric,2) AS px_medio
FROM lp_orchestrator_action_log a
CROSS JOIN c
JOIN lp_orchestrators o ON o.id = a.orchestrator_id
WHERE a.created_at >= c.t AND a.current_price IS NOT NULL
  AND a.range_lower_price IS NOT NULL AND a.range_upper_price IS NOT NULL
GROUP BY a.orchestrator_id, o.fee_tier ORDER BY a.orchestrator_id;"

echo "── costo agregado por banda efectiva ──"
q "
SELECT round(effective_band_pct::numeric,2) AS band, COUNT(*) AS rebal,
  round(AVG(COALESCE(execution_fee_usd,0)+COALESCE(slippage_usd,0))::numeric,4) AS costo_medio_rebal,
  round(SUM(COALESCE(execution_fee_usd,0)+COALESCE(slippage_usd,0))::numeric,2) AS costo_total
FROM protected_pool_delta_rebalance_log
WHERE effective_band_pct IS NOT NULL
GROUP BY 1 ORDER BY 1;"

echo ""
echo "════════════════════════════════════════════════════════════════"
echo " Lecturas rápidas:"
echo "  · dist_liq_pct < 8%  → margen apretado, considerar bajar leverage / revertir a 0.85"
echo "  · ratio_tgt_delta ~1.0 → SOLO dice que el mult. de zona es 1.0, NO que se cubra"
echo "  · corr_total_lp → 0 y net_pnl → positivo → el residual está convergiendo"
echo "  · anomalias_hl0 > 0 → el fix de métricas no está corriendo / regresión"
echo "  · cobertura (3a) ~1.0 → el delta esta cubierto; <1 expuesto, >1 net-short"
echo "  · hedge_beta (3b) NO sirve para decidir: subestima por patas asincronas"
echo "════════════════════════════════════════════════════════════════"
