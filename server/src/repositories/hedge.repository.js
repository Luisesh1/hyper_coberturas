const db = require('../db');
const { rowToHedge } = require('./hedge.mapper');

function exec(executor) {
  return executor || db;
}

async function loadAllByUser(userId, accountId = null) {
  const params = [userId];
  const accountClause = accountId != null
    ? ` AND h.hyperliquid_account_id = $2`
    : '';
  if (accountId != null) params.push(accountId);

  const { rows } = await db.query(
    `SELECT h.*,
            a.alias AS account_alias,
            a.address AS account_address,
            a.is_default AS account_is_default,
            COALESCE(json_agg(c ORDER BY c.cycle_id) FILTER (WHERE c.id IS NOT NULL), '[]') AS cycles_json
     FROM hedges h
     LEFT JOIN hyperliquid_accounts a ON a.id = h.hyperliquid_account_id
     LEFT JOIN cycles c ON c.hedge_id = h.id
     WHERE h.user_id = $1
       ${accountClause}
     GROUP BY h.id, a.id
     ORDER BY h.id`,
    params
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
       user_id, hyperliquid_account_id, asset, direction, entry_price, exit_price, size, leverage, label,
       margin_mode, status, created_at, position_key, last_reconciled_at, protected_pool_id, protected_role,
       dynamic_anchor_price
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'entry_pending', $11, $12, $11, $13, $14, $15)
     RETURNING id`,
    [
      hedge.userId,
      hedge.accountId,
      hedge.asset,
      hedge.direction,
      hedge.entryPrice,
      hedge.exitPrice,
      hedge.size,
      hedge.leverage,
      hedge.label,
      hedge.marginMode || 'isolated',
      hedge.createdAt,
      hedge.positionKey,
      hedge.protectedPoolId || null,
      hedge.protectedRole || null,
      hedge.dynamicAnchorPrice ?? hedge.entryPrice,
    ]
  );
  return rows[0].id;
}

async function save(hedge, executor) {
  await exec(executor).query(
    `UPDATE hedges SET
       status = $2,
       entry_price = $3,
       exit_price = $4,
       size = $5,
       leverage = $6,
       label = $7,
       entry_oid = $8,
       sl_oid = $9,
       asset_index = $10,
       sz_decimals = $11,
       position_size = $12,
       dynamic_anchor_price = $13,
       open_price = $14,
       close_price = $15,
       unrealized_pnl = $16,
       error = $17,
       cycle_count = $18,
       opened_at = $19,
       closed_at = $20,
       position_key = $21,
       closing_started_at = $22,
       sl_placed_at = $23,
       last_fill_at = $24,
       last_reconciled_at = $25,
       entry_fill_oid = $26,
       entry_fill_time = $27,
       entry_fee_paid = $28,
       funding_accum = $29
     WHERE id = $1`,
    [
      hedge.id,
      hedge.status,
      hedge.entryPrice,
      hedge.exitPrice,
      hedge.size,
      hedge.leverage,
      hedge.label,
      hedge.entryOid,
      hedge.slOid,
      hedge.assetIndex,
      hedge.szDecimals,
      hedge.positionSize,
      hedge.dynamicAnchorPrice,
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

async function saveCycle(hedgeId, cycle, executor) {
  await exec(executor).query(
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

async function loadByProtectedPoolId(protectedPoolId) {
  const { rows } = await db.query(
    `SELECT h.*,
            a.alias AS account_alias,
            a.address AS account_address,
            a.is_default AS account_is_default,
            COALESCE(json_agg(c ORDER BY c.cycle_id) FILTER (WHERE c.id IS NOT NULL), '[]') AS cycles_json
     FROM hedges h
     LEFT JOIN hyperliquid_accounts a ON a.id = h.hyperliquid_account_id
     LEFT JOIN cycles c ON c.hedge_id = h.id
     WHERE h.protected_pool_id = $1
     GROUP BY h.id, a.id
     ORDER BY h.id`,
    [protectedPoolId]
  );

  return rows.map((row) => {
    const cycles = Array.isArray(row.cycles_json)
      ? row.cycles_json
      : JSON.parse(row.cycles_json || '[]');
    return rowToHedge(row, cycles);
  });
}

async function unlinkByProtectedPoolId(protectedPoolId) {
  await db.query(
    `UPDATE hedges
        SET protected_pool_id = NULL,
            protected_role = NULL
      WHERE protected_pool_id = $1`,
    [protectedPoolId]
  );
}

async function deleteByProtectedPoolIds(protectedPoolIds = []) {
  if (!Array.isArray(protectedPoolIds) || protectedPoolIds.length === 0) return 0;
  const { rowCount } = await db.query(
    `DELETE FROM hedges
      WHERE protected_pool_id = ANY($1::int[])`,
    [protectedPoolIds]
  );
  return rowCount || 0;
}

/**
 * Guarda un ciclo + actualiza el hedge en una sola transacción.
 * Si alguno falla, ambos se revierten.
 */
async function saveHedgeWithCycle(hedge, cycle) {
  await db.transaction(async (client) => {
    await saveCycle(hedge.id, cycle, client);
    await save(hedge, client);
  });
}

module.exports = {
  deleteByProtectedPoolIds,
  loadAllByUser,
  loadByProtectedPoolId,
  create,
  save,
  saveCycle,
  saveHedgeWithCycle,
  unlinkByProtectedPoolId,
};
