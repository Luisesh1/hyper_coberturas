const db = require('../db');

function exec(executor) {
  return executor || db;
}

async function create(payload, executor) {
  const { rows } = await exec(executor).query(
    `INSERT INTO protection_decision_log (
       protected_pool_id, decision, reason, strategy_status, spot_source, snapshot_status,
       snapshot_freshness_ms, execution_skipped_because, execution_mode, estimated_cost_usd,
       realized_cost_usd, target_qty, actual_qty, tracking_error_qty, tracking_error_usd,
       current_price, final_strategy_status, risk_gate_triggered, liquidation_distance_pct, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     RETURNING id`,
    [
      payload.protectedPoolId,
      payload.decision,
      payload.reason ?? null,
      payload.strategyStatus ?? null,
      payload.spotSource ?? null,
      payload.snapshotStatus ?? null,
      payload.snapshotFreshnessMs ?? null,
      payload.executionSkippedBecause ?? null,
      payload.executionMode ?? null,
      payload.estimatedCostUsd ?? null,
      payload.realizedCostUsd ?? null,
      payload.targetQty ?? null,
      payload.actualQty ?? null,
      payload.trackingErrorQty ?? null,
      payload.trackingErrorUsd ?? null,
      payload.currentPrice ?? null,
      payload.finalStrategyStatus ?? null,
      payload.riskGateTriggered ?? null,
      payload.liquidationDistancePct ?? null,
      payload.createdAt ?? Date.now(),
    ]
  );

  return rows[0]?.id || null;
}

async function listByProtectedPoolId(protectedPoolId, { limit = 50 } = {}, executor) {
  const { rows } = await exec(executor).query(
    `SELECT id,
            protected_pool_id AS "protectedPoolId",
            decision,
            reason,
            strategy_status AS "strategyStatus",
            spot_source AS "spotSource",
            snapshot_status AS "snapshotStatus",
            snapshot_freshness_ms AS "snapshotFreshnessMs",
            execution_skipped_because AS "executionSkippedBecause",
            execution_mode AS "executionMode",
            estimated_cost_usd AS "estimatedCostUsd",
            realized_cost_usd AS "realizedCostUsd",
            target_qty AS "targetQty",
            actual_qty AS "actualQty",
            tracking_error_qty AS "trackingErrorQty",
            tracking_error_usd AS "trackingErrorUsd",
            current_price AS "currentPrice",
            final_strategy_status AS "finalStrategyStatus",
            risk_gate_triggered AS "riskGateTriggered",
            liquidation_distance_pct AS "liquidationDistancePct",
            created_at AS "createdAt"
       FROM protection_decision_log
      WHERE protected_pool_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [protectedPoolId, limit]
  );

  return rows.map((row) => ({
    ...row,
    estimatedCostUsd: row.estimatedCostUsd != null ? Number(row.estimatedCostUsd) : null,
    realizedCostUsd: row.realizedCostUsd != null ? Number(row.realizedCostUsd) : null,
    targetQty: row.targetQty != null ? Number(row.targetQty) : null,
    actualQty: row.actualQty != null ? Number(row.actualQty) : null,
    trackingErrorQty: row.trackingErrorQty != null ? Number(row.trackingErrorQty) : null,
    trackingErrorUsd: row.trackingErrorUsd != null ? Number(row.trackingErrorUsd) : null,
    currentPrice: row.currentPrice != null ? Number(row.currentPrice) : null,
    liquidationDistancePct: row.liquidationDistancePct != null ? Number(row.liquidationDistancePct) : null,
    snapshotFreshnessMs: row.snapshotFreshnessMs != null ? Number(row.snapshotFreshnessMs) : null,
    createdAt: Number(row.createdAt),
  }));
}

module.exports = {
  create,
  listByProtectedPoolId,
};
