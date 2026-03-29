const db = require('../db');

function exec(executor) {
  return executor || db;
}

async function create(payload, executor) {
  const { rows } = await exec(executor).query(
    `INSERT INTO protected_pool_delta_rebalance_log (
       protected_pool_id, reason, execution_mode, twap_slices_planned, twap_slices_completed,
       price, rv4h_pct, rv24h_pct, effective_band_pct, delta_qty_before, gamma_before,
       target_qty_before, actual_qty_before, target_qty_after, actual_qty_after, drift_usd,
       execution_fee_usd, slippage_usd, funding_snapshot_usd, distance_to_liq_pct, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     RETURNING id`,
    [
      payload.protectedPoolId,
      payload.reason,
      payload.executionMode,
      payload.twapSlicesPlanned ?? null,
      payload.twapSlicesCompleted ?? null,
      payload.price ?? null,
      payload.rv4hPct ?? null,
      payload.rv24hPct ?? null,
      payload.effectiveBandPct ?? null,
      payload.deltaQtyBefore ?? null,
      payload.gammaBefore ?? null,
      payload.targetQtyBefore ?? null,
      payload.actualQtyBefore ?? null,
      payload.targetQtyAfter ?? null,
      payload.actualQtyAfter ?? null,
      payload.driftUsd ?? null,
      payload.executionFeeUsd ?? null,
      payload.slippageUsd ?? null,
      payload.fundingSnapshotUsd ?? null,
      payload.distanceToLiqPct ?? null,
      payload.createdAt ?? Date.now(),
    ]
  );

  return rows[0]?.id || null;
}

async function listByProtectedPoolId(protectedPoolId, { limit = 100 } = {}, executor) {
  const { rows } = await exec(executor).query(
    `SELECT id,
            protected_pool_id AS "protectedPoolId",
            reason,
            execution_mode AS "executionMode",
            twap_slices_planned AS "twapSlicesPlanned",
            twap_slices_completed AS "twapSlicesCompleted",
            price,
            rv4h_pct AS "rv4hPct",
            rv24h_pct AS "rv24hPct",
            effective_band_pct AS "effectiveBandPct",
            delta_qty_before AS "deltaQtyBefore",
            gamma_before AS "gammaBefore",
            target_qty_before AS "targetQtyBefore",
            actual_qty_before AS "actualQtyBefore",
            target_qty_after AS "targetQtyAfter",
            actual_qty_after AS "actualQtyAfter",
            drift_usd AS "driftUsd",
            execution_fee_usd AS "executionFeeUsd",
            slippage_usd AS "slippageUsd",
            funding_snapshot_usd AS "fundingSnapshotUsd",
            distance_to_liq_pct AS "distanceToLiqPct",
            created_at AS "createdAt"
       FROM protected_pool_delta_rebalance_log
      WHERE protected_pool_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [protectedPoolId, limit]
  );

  return rows.map((row) => ({
    ...row,
    price: row.price != null ? Number(row.price) : null,
    rv4hPct: row.rv4hPct != null ? Number(row.rv4hPct) : null,
    rv24hPct: row.rv24hPct != null ? Number(row.rv24hPct) : null,
    effectiveBandPct: row.effectiveBandPct != null ? Number(row.effectiveBandPct) : null,
    deltaQtyBefore: row.deltaQtyBefore != null ? Number(row.deltaQtyBefore) : null,
    gammaBefore: row.gammaBefore != null ? Number(row.gammaBefore) : null,
    targetQtyBefore: row.targetQtyBefore != null ? Number(row.targetQtyBefore) : null,
    actualQtyBefore: row.actualQtyBefore != null ? Number(row.actualQtyBefore) : null,
    targetQtyAfter: row.targetQtyAfter != null ? Number(row.targetQtyAfter) : null,
    actualQtyAfter: row.actualQtyAfter != null ? Number(row.actualQtyAfter) : null,
    driftUsd: row.driftUsd != null ? Number(row.driftUsd) : null,
    executionFeeUsd: row.executionFeeUsd != null ? Number(row.executionFeeUsd) : null,
    slippageUsd: row.slippageUsd != null ? Number(row.slippageUsd) : null,
    fundingSnapshotUsd: row.fundingSnapshotUsd != null ? Number(row.fundingSnapshotUsd) : null,
    distanceToLiqPct: row.distanceToLiqPct != null ? Number(row.distanceToLiqPct) : null,
    createdAt: Number(row.createdAt),
  }));
}

module.exports = {
  create,
  listByProtectedPoolId,
};
