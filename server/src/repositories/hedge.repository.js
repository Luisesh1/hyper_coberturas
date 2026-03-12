const db = require('../db');
const { rowToHedge } = require('../services/hedge.state');

async function loadAllByUser(userId) {
  const { rows } = await db.query(
    `SELECT h.*,
            COALESCE(json_agg(c ORDER BY c.cycle_id) FILTER (WHERE c.id IS NOT NULL), '[]') AS cycles_json
     FROM hedges h
     LEFT JOIN cycles c ON c.hedge_id = h.id
     WHERE h.user_id = $1
     GROUP BY h.id
     ORDER BY h.id`,
    [userId]
  );

  return rows.map((row) => {
    const cycles = Array.isArray(row.cycles_json)
      ? row.cycles_json
      : JSON.parse(row.cycles_json || '[]');
    return rowToHedge(row, cycles);
  });
}

async function create(hedge) {
  const { rows } = await db.query(
    `INSERT INTO hedges (
       user_id, asset, direction, entry_price, exit_price, size, leverage, label,
       margin_mode, status, created_at, position_key, last_reconciled_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'isolated', 'entry_pending', $9, $10, $9)
     RETURNING id`,
    [
      hedge.userId,
      hedge.asset,
      hedge.direction,
      hedge.entryPrice,
      hedge.exitPrice,
      hedge.size,
      hedge.leverage,
      hedge.label,
      hedge.createdAt,
      hedge.positionKey,
    ]
  );
  return rows[0].id;
}

async function save(hedge) {
  await db.query(
    `UPDATE hedges SET
       status = $2,
       entry_oid = $3,
       sl_oid = $4,
       asset_index = $5,
       sz_decimals = $6,
       position_size = $7,
       open_price = $8,
       close_price = $9,
       unrealized_pnl = $10,
       error = $11,
       cycle_count = $12,
       opened_at = $13,
       closed_at = $14,
       position_key = $15,
       closing_started_at = $16,
       sl_placed_at = $17,
       last_fill_at = $18,
       last_reconciled_at = $19,
       entry_fill_oid = $20,
       entry_fill_time = $21,
       entry_fee_paid = $22,
       funding_accum = $23
     WHERE id = $1`,
    [
      hedge.id,
      hedge.status,
      hedge.entryOid,
      hedge.slOid,
      hedge.assetIndex,
      hedge.szDecimals,
      hedge.positionSize,
      hedge.openPrice,
      hedge.closePrice,
      hedge.unrealizedPnl,
      hedge.error,
      hedge.cycleCount,
      hedge.openedAt,
      hedge.closedAt,
      hedge.positionKey,
      hedge.closingStartedAt,
      hedge.slPlacedAt,
      hedge.lastFillAt,
      hedge.lastReconciledAt,
      hedge.entryFillOid,
      hedge.entryFillTime,
      hedge.entryFeePaid ?? 0,
      hedge.fundingAccum ?? 0,
    ]
  );
}

async function saveCycle(hedgeId, cycle) {
  await db.query(
    `INSERT INTO cycles (
       hedge_id, cycle_id, open_price, close_price, opened_at, closed_at,
       entry_fee, exit_fee, closed_pnl, funding_paid,
       entry_fill_oid, exit_fill_oid, entry_fill_time, exit_fill_time,
       entry_slippage, exit_slippage, total_slippage, net_pnl
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      hedgeId,
      cycle.cycleId,
      cycle.openPrice,
      cycle.closePrice,
      cycle.openedAt,
      cycle.closedAt,
      cycle.entryFee ?? 0,
      cycle.exitFee ?? 0,
      cycle.closedPnl ?? null,
      cycle.fundingPaid ?? 0,
      cycle.entryFillOid ?? null,
      cycle.exitFillOid ?? null,
      cycle.entryFillTime ?? null,
      cycle.exitFillTime ?? null,
      cycle.entrySlippage ?? 0,
      cycle.exitSlippage ?? 0,
      cycle.totalSlippage ?? 0,
      cycle.netPnl ?? null,
    ]
  );
}

module.exports = {
  loadAllByUser,
  create,
  save,
  saveCycle,
};
