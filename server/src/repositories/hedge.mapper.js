function normalizeStatus(row) {
  if (row.status === 'open') {
    return row.sl_oid ? 'open_protected' : 'entry_filled_pending_sl';
  }
  return row.status;
}

function rowToHedge(row, cycles = []) {
  const account = row.hyperliquid_account_id
    ? {
        id: row.hyperliquid_account_id,
        alias: row.account_alias || null,
        address: row.account_address || null,
        shortAddress: row.account_address
          ? `${row.account_address.slice(0, 6)}...${row.account_address.slice(-4)}`
          : '',
        label: row.account_alias
          ? `${row.account_alias} · ${row.account_address.slice(0, 6)}...${row.account_address.slice(-4)}`
          : (row.account_address
              ? `${row.account_address.slice(0, 6)}...${row.account_address.slice(-4)}`
              : ''),
        isDefault: !!row.account_is_default,
      }
    : null;

  return {
    id: row.id,
    userId: row.user_id,
    accountId: row.hyperliquid_account_id || null,
    account,
    asset: row.asset,
    direction: row.direction || 'short',
    entryPrice: parseFloat(row.entry_price),
    exitPrice: parseFloat(row.exit_price),
    dynamicAnchorPrice: row.dynamic_anchor_price != null ? parseFloat(row.dynamic_anchor_price) : parseFloat(row.entry_price),
    size: parseFloat(row.size),
    leverage: row.leverage,
    label: row.label,
    marginMode: row.margin_mode,
    status: normalizeStatus(row),
    entryOid: row.entry_oid ? Number(row.entry_oid) : null,
    slOid: row.sl_oid ? Number(row.sl_oid) : null,
    assetIndex: row.asset_index,
    szDecimals: row.sz_decimals,
    positionSize: row.position_size != null ? parseFloat(row.position_size) : null,
    openPrice: row.open_price != null ? parseFloat(row.open_price) : null,
    closePrice: row.close_price != null ? parseFloat(row.close_price) : null,
    unrealizedPnl: row.unrealized_pnl != null ? parseFloat(row.unrealized_pnl) : null,
    error: row.error || null,
    cycleCount: row.cycle_count,
    createdAt: Number(row.created_at),
    openedAt: row.opened_at ? Number(row.opened_at) : null,
    closedAt: row.closed_at ? Number(row.closed_at) : null,
    positionKey: row.position_key || null,
    closingStartedAt: row.closing_started_at ? Number(row.closing_started_at) : null,
    slPlacedAt: row.sl_placed_at ? Number(row.sl_placed_at) : null,
    lastFillAt: row.last_fill_at ? Number(row.last_fill_at) : null,
    lastReconciledAt: row.last_reconciled_at ? Number(row.last_reconciled_at) : null,
    entryFillOid: row.entry_fill_oid ? Number(row.entry_fill_oid) : null,
    entryFillTime: row.entry_fill_time ? Number(row.entry_fill_time) : null,
    entryFeePaid: parseFloat(row.entry_fee_paid || 0),
    fundingAccum: parseFloat(row.funding_accum || 0),
    protectedPoolId: row.protected_pool_id ? Number(row.protected_pool_id) : null,
    protectedRole: row.protected_role || null,
    cycles: cycles.map((c) => ({
      cycleId: c.cycle_id,
      openedAt: c.opened_at ? Number(c.opened_at) : null,
      openPrice: c.open_price != null ? parseFloat(c.open_price) : null,
      closedAt: c.closed_at ? Number(c.closed_at) : null,
      closePrice: c.close_price != null ? parseFloat(c.close_price) : null,
      entryFee: parseFloat(c.entry_fee || 0),
      exitFee: parseFloat(c.exit_fee || 0),
      closedPnl: c.closed_pnl != null ? parseFloat(c.closed_pnl) : null,
      fundingPaid: parseFloat(c.funding_paid || 0),
      entryFillOid: c.entry_fill_oid ? Number(c.entry_fill_oid) : null,
      exitFillOid: c.exit_fill_oid ? Number(c.exit_fill_oid) : null,
      entryFillTime: c.entry_fill_time ? Number(c.entry_fill_time) : null,
      exitFillTime: c.exit_fill_time ? Number(c.exit_fill_time) : null,
      entrySlippage: parseFloat(c.entry_slippage || 0),
      exitSlippage: parseFloat(c.exit_slippage || 0),
      totalSlippage: parseFloat(c.total_slippage || 0),
      netPnl: c.net_pnl != null ? parseFloat(c.net_pnl) : null,
      size: c.size != null ? parseFloat(c.size) : null,
    })),
  };
}

module.exports = {
  normalizeStatus,
  rowToHedge,
};
