const db = require('../db');

function exec(executor) {
  return executor || db;
}

function parseJsonSafe(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapAccount(row) {
  if (!row?.hyperliquid_account_id) return null;
  const address = row.account_address || '';
  const shortAddress = address
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : '';
  const alias = row.account_alias || shortAddress;

  return {
    id: row.hyperliquid_account_id,
    alias,
    address,
    shortAddress,
    label: shortAddress && alias !== shortAddress
      ? `${alias} · ${shortAddress}`
      : alias,
    isDefault: !!row.account_is_default,
  };
}

function mapSummaryHedge(hedge) {
  if (!hedge) return null;
  return {
    id: hedge.id ? Number(hedge.id) : null,
    asset: hedge.asset,
    direction: hedge.direction,
    entryPrice: hedge.entryPrice != null ? Number(hedge.entryPrice) : null,
    exitPrice: hedge.exitPrice != null ? Number(hedge.exitPrice) : null,
    dynamicAnchorPrice: hedge.dynamicAnchorPrice != null ? Number(hedge.dynamicAnchorPrice) : null,
    size: hedge.size != null ? Number(hedge.size) : null,
    leverage: hedge.leverage != null ? Number(hedge.leverage) : null,
    status: hedge.status,
    label: hedge.label || null,
    protectedRole: hedge.protectedRole || null,
    createdAt: hedge.createdAt != null ? Number(hedge.createdAt) : null,
    openedAt: hedge.openedAt != null ? Number(hedge.openedAt) : null,
    closedAt: hedge.closedAt != null ? Number(hedge.closedAt) : null,
    error: hedge.error || null,
  };
}

const IDENTITY_COLUMNS = `
  id, user_id, hyperliquid_account_id, network, version, wallet_address, pool_address, position_identifier,
  token0_symbol, token1_symbol, token0_address, token1_address, range_lower_price, range_upper_price,
  price_current, inferred_asset, hedge_size, hedge_notional_usd, configured_hedge_notional_usd,
  initial_configured_hedge_notional_usd, value_multiplier, stop_loss_difference_pct, protection_mode,
  reentry_buffer_pct, flip_cooldown_sec, max_sequential_flips, breakout_confirm_distance_pct,
  breakout_confirm_duration_sec, dynamic_state_json, band_mode, base_rebalance_price_move_pct,
  rebalance_interval_sec, target_hedge_ratio, min_rebalance_notional_usd, max_slippage_bps,
  twap_min_notional_usd, strategy_state_json, value_mode, leverage, margin_mode, status,
  strategy_engine_version, snapshot_status, snapshot_fresh_at, snapshot_hash,
  next_eligible_attempt_at, cooldown_reason, last_decision, last_decision_reason,
  tracking_error_qty, tracking_error_usd, execution_mode, max_spread_bps,
  max_execution_fee_usd, min_order_notional_usd, twap_slices, twap_duration_sec,
  last_onchain_action, last_tx_hash, last_tx_at, replaced_by_position_identifier,
  in_range_checks, in_range_hits, time_in_range_ms, time_tracked_ms, time_in_range_pct,
  range_last_state_in_range, range_last_state_at, range_computed_at, range_frozen_at,
  created_at, updated_at, deactivated_at
`.replace(/\n/g, ' ').trim();

function mapIdentityRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    accountId: Number(row.hyperliquid_account_id),
    network: row.network,
    version: row.version,
    walletAddress: row.wallet_address,
    poolAddress: row.pool_address || null,
    positionIdentifier: row.position_identifier,
    token0Symbol: row.token0_symbol,
    token1Symbol: row.token1_symbol,
    token0Address: row.token0_address || null,
    token1Address: row.token1_address || null,
    rangeLowerPrice: Number(row.range_lower_price),
    rangeUpperPrice: Number(row.range_upper_price),
    priceCurrent: row.price_current != null ? Number(row.price_current) : null,
    inferredAsset: row.inferred_asset,
    hedgeSize: Number(row.hedge_size),
    hedgeNotionalUsd: Number(row.hedge_notional_usd),
    configuredHedgeNotionalUsd: Number(row.configured_hedge_notional_usd),
    initialConfiguredHedgeNotionalUsd: row.initial_configured_hedge_notional_usd != null
      ? Number(row.initial_configured_hedge_notional_usd)
      : Number(row.configured_hedge_notional_usd),
    valueMultiplier: row.value_multiplier != null ? Number(row.value_multiplier) : null,
    stopLossDifferencePct: row.stop_loss_difference_pct != null ? Number(row.stop_loss_difference_pct) : 0.05,
    protectionMode: row.protection_mode || 'static',
    reentryBufferPct: row.reentry_buffer_pct != null ? Number(row.reentry_buffer_pct) : null,
    flipCooldownSec: row.flip_cooldown_sec != null ? Number(row.flip_cooldown_sec) : null,
    maxSequentialFlips: row.max_sequential_flips != null ? Number(row.max_sequential_flips) : null,
    breakoutConfirmDistancePct: row.breakout_confirm_distance_pct != null ? Number(row.breakout_confirm_distance_pct) : null,
    breakoutConfirmDurationSec: row.breakout_confirm_duration_sec != null ? Number(row.breakout_confirm_duration_sec) : null,
    dynamicState: parseJsonSafe(row.dynamic_state_json, null),
    bandMode: row.band_mode || null,
    baseRebalancePriceMovePct: row.base_rebalance_price_move_pct != null ? Number(row.base_rebalance_price_move_pct) : null,
    rebalanceIntervalSec: row.rebalance_interval_sec != null ? Number(row.rebalance_interval_sec) : null,
    targetHedgeRatio: row.target_hedge_ratio != null ? Number(row.target_hedge_ratio) : null,
    minRebalanceNotionalUsd: row.min_rebalance_notional_usd != null ? Number(row.min_rebalance_notional_usd) : null,
    maxSlippageBps: row.max_slippage_bps != null ? Number(row.max_slippage_bps) : null,
    twapMinNotionalUsd: row.twap_min_notional_usd != null ? Number(row.twap_min_notional_usd) : null,
    strategyState: parseJsonSafe(row.strategy_state_json, null),
    valueMode: row.value_mode || 'usd',
    leverage: Number(row.leverage),
    marginMode: row.margin_mode,
    status: row.status,
    strategyEngineVersion: row.strategy_engine_version || 'v1',
    snapshotStatus: row.snapshot_status || 'ready',
    snapshotFreshAt: row.snapshot_fresh_at != null ? Number(row.snapshot_fresh_at) : null,
    snapshotHash: row.snapshot_hash || null,
    nextEligibleAttemptAt: row.next_eligible_attempt_at != null ? Number(row.next_eligible_attempt_at) : null,
    cooldownReason: row.cooldown_reason || null,
    lastDecision: row.last_decision || null,
    lastDecisionReason: row.last_decision_reason || null,
    trackingErrorQty: row.tracking_error_qty != null ? Number(row.tracking_error_qty) : null,
    trackingErrorUsd: row.tracking_error_usd != null ? Number(row.tracking_error_usd) : null,
    executionMode: row.execution_mode || null,
    maxSpreadBps: row.max_spread_bps != null ? Number(row.max_spread_bps) : null,
    maxExecutionFeeUsd: row.max_execution_fee_usd != null ? Number(row.max_execution_fee_usd) : null,
    minOrderNotionalUsd: row.min_order_notional_usd != null ? Number(row.min_order_notional_usd) : null,
    twapSlices: row.twap_slices != null ? Number(row.twap_slices) : null,
    twapDurationSec: row.twap_duration_sec != null ? Number(row.twap_duration_sec) : null,
    lastOnchainAction: row.last_onchain_action || null,
    lastTxHash: row.last_tx_hash || null,
    lastTxAt: row.last_tx_at != null ? Number(row.last_tx_at) : null,
    replacedByPositionIdentifier: row.replaced_by_position_identifier || null,
    inRangeChecks: Number(row.in_range_checks) || 0,
    inRangeHits: Number(row.in_range_hits) || 0,
    timeInRangeMs: row.time_in_range_ms != null ? Number(row.time_in_range_ms) : null,
    timeTrackedMs: row.time_tracked_ms != null ? Number(row.time_tracked_ms) : null,
    timeInRangePct: row.time_in_range_pct != null ? Number(row.time_in_range_pct) : null,
    rangeLastStateInRange: row.range_last_state_in_range == null ? null : row.range_last_state_in_range === true,
    rangeLastStateAt: row.range_last_state_at != null ? Number(row.range_last_state_at) : null,
    rangeComputedAt: row.range_computed_at != null ? Number(row.range_computed_at) : null,
    rangeFrozenAt: row.range_frozen_at != null ? Number(row.range_frozen_at) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deactivatedAt: row.deactivated_at ? Number(row.deactivated_at) : null,
  };
}

function mapRow(row) {
  const poolSnapshot = parseJsonSafe(row.pool_snapshot_json);
  const hedges = Array.isArray(row.hedges_json)
    ? row.hedges_json
    : parseJsonSafe(row.hedges_json, []);
  const hedgeMap = hedges.reduce((acc, hedge) => {
    if (hedge?.protectedRole) {
      acc[hedge.protectedRole] = mapSummaryHedge(hedge);
    }
    return acc;
  }, {});

  return {
    ...mapIdentityRow(row),
    account: mapAccount(row),
    poolSnapshot,
    hedges: {
      upside: hedgeMap.upside || null,
      downside: hedgeMap.downside || null,
    },
  };
}

async function listByUser(userId, executor) {
  const { rows } = await exec(executor).query(
    `SELECT p.*,
            a.alias AS account_alias,
            a.address AS account_address,
            a.is_default AS account_is_default,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', h.id,
                  'asset', h.asset,
                  'direction', h.direction,
                  'entryPrice', h.entry_price,
                  'exitPrice', h.exit_price,
                  'dynamicAnchorPrice', h.dynamic_anchor_price,
                  'size', h.size,
                  'leverage', h.leverage,
                  'status', h.status,
                  'label', h.label,
                  'protectedRole', h.protected_role,
                  'createdAt', h.created_at,
                  'openedAt', h.opened_at,
                  'closedAt', h.closed_at,
                  'error', h.error
                )
                ORDER BY h.id
              ) FILTER (WHERE h.id IS NOT NULL),
              '[]'
            ) AS hedges_json
       FROM protected_uniswap_pools p
       LEFT JOIN hyperliquid_accounts a ON a.id = p.hyperliquid_account_id
       LEFT JOIN hedges h ON h.protected_pool_id = p.id
      WHERE p.user_id = $1
      GROUP BY p.id, a.id
      ORDER BY p.updated_at DESC, p.id DESC`,
    [userId]
  );

  return rows.map(mapRow);
}

async function listActiveDynamic(executor) {
  const { rows } = await exec(executor).query(
    `SELECT p.*,
            a.alias AS account_alias,
            a.address AS account_address,
            a.is_default AS account_is_default,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', h.id,
                  'asset', h.asset,
                  'direction', h.direction,
                  'entryPrice', h.entry_price,
                  'exitPrice', h.exit_price,
                  'dynamicAnchorPrice', h.dynamic_anchor_price,
                  'size', h.size,
                  'leverage', h.leverage,
                  'status', h.status,
                  'label', h.label,
                  'protectedRole', h.protected_role,
                  'createdAt', h.created_at,
                  'openedAt', h.opened_at,
                  'closedAt', h.closed_at,
                  'error', h.error
                )
                ORDER BY h.id
              ) FILTER (WHERE h.id IS NOT NULL),
              '[]'
            ) AS hedges_json
       FROM protected_uniswap_pools p
       LEFT JOIN hyperliquid_accounts a ON a.id = p.hyperliquid_account_id
       LEFT JOIN hedges h ON h.protected_pool_id = p.id
      WHERE p.status = 'active'
        AND p.protection_mode = 'dynamic'
      GROUP BY p.id, a.id
      ORDER BY p.updated_at DESC, p.id DESC`
  );

  return rows.map(mapRow);
}

async function listActiveByUser(userId, executor) {
  const { rows } = await exec(executor).query(
    `SELECT ${IDENTITY_COLUMNS}
       FROM protected_uniswap_pools
      WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );

  return rows.map(mapIdentityRow);
}

async function listActiveForRefresh(executor) {
  const { rows } = await exec(executor).query(
    `SELECT ${IDENTITY_COLUMNS}, pool_snapshot_json
       FROM protected_uniswap_pools
      WHERE status = 'active'
      ORDER BY user_id, network, version, lower(wallet_address), position_identifier, updated_at DESC, id DESC`
  );

  return rows.map((row) => ({
    ...mapIdentityRow(row),
    poolSnapshot: parseJsonSafe(row.pool_snapshot_json),
  }));
}

async function getById(userId, id, executor) {
  const { rows } = await exec(executor).query(
    `SELECT p.*,
            a.alias AS account_alias,
            a.address AS account_address,
            a.is_default AS account_is_default,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', h.id,
                  'asset', h.asset,
                  'direction', h.direction,
                  'entryPrice', h.entry_price,
                  'exitPrice', h.exit_price,
                  'dynamicAnchorPrice', h.dynamic_anchor_price,
                  'size', h.size,
                  'leverage', h.leverage,
                  'status', h.status,
                  'label', h.label,
                  'protectedRole', h.protected_role,
                  'createdAt', h.created_at,
                  'openedAt', h.opened_at,
                  'closedAt', h.closed_at,
                  'error', h.error
                )
                ORDER BY h.id
              ) FILTER (WHERE h.id IS NOT NULL),
              '[]'
            ) AS hedges_json
       FROM protected_uniswap_pools p
       LEFT JOIN hyperliquid_accounts a ON a.id = p.hyperliquid_account_id
       LEFT JOIN hedges h ON h.protected_pool_id = p.id
      WHERE p.user_id = $1 AND p.id = $2
      GROUP BY p.id, a.id`,
    [userId, id]
  );

  return rows[0] ? mapRow(rows[0]) : null;
}

async function findReusableByIdentity(userId, { network, version, walletAddress, positionIdentifier }, executor) {
  const { rows } = await exec(executor).query(
    `SELECT ${IDENTITY_COLUMNS}
       FROM protected_uniswap_pools
      WHERE user_id = $1
        AND network = $2
        AND version = $3
        AND lower(wallet_address) = lower($4)
        AND position_identifier = $5
      ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC, id DESC
      LIMIT 1`,
    [userId, network, version, walletAddress, positionIdentifier]
  );

  return rows[0] ? mapIdentityRow(rows[0]) : null;
}

async function listActiveDeltaNeutral(executor) {
  const { rows } = await exec(executor).query(
    `SELECT p.*,
            a.alias AS account_alias,
            a.address AS account_address,
            a.is_default AS account_is_default,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', h.id,
                  'asset', h.asset,
                  'direction', h.direction,
                  'entryPrice', h.entry_price,
                  'exitPrice', h.exit_price,
                  'dynamicAnchorPrice', h.dynamic_anchor_price,
                  'size', h.size,
                  'leverage', h.leverage,
                  'status', h.status,
                  'label', h.label,
                  'protectedRole', h.protected_role,
                  'createdAt', h.created_at,
                  'openedAt', h.opened_at,
                  'closedAt', h.closed_at,
                  'error', h.error
                )
                ORDER BY h.id
              ) FILTER (WHERE h.id IS NOT NULL),
              '[]'
            ) AS hedges_json
       FROM protected_uniswap_pools p
       LEFT JOIN hyperliquid_accounts a ON a.id = p.hyperliquid_account_id
       LEFT JOIN hedges h ON h.protected_pool_id = p.id
      WHERE p.status = 'active'
        AND p.protection_mode = 'delta_neutral'
      GROUP BY p.id, a.id
      ORDER BY p.updated_at DESC, p.id DESC`
  );

  return rows.map(mapRow);
}

async function create(record, executor) {
  const { rows } = await exec(executor).query(
    `INSERT INTO protected_uniswap_pools (
       user_id, hyperliquid_account_id, network, version, wallet_address, pool_address, position_identifier,
       token0_symbol, token1_symbol, token0_address, token1_address, range_lower_price, range_upper_price,
       price_current, inferred_asset, hedge_size, hedge_notional_usd, configured_hedge_notional_usd, initial_configured_hedge_notional_usd,
       value_multiplier, stop_loss_difference_pct, protection_mode, reentry_buffer_pct, flip_cooldown_sec,
       max_sequential_flips, breakout_confirm_distance_pct, breakout_confirm_duration_sec, dynamic_state_json,
       band_mode, base_rebalance_price_move_pct, rebalance_interval_sec, target_hedge_ratio,
       min_rebalance_notional_usd, max_slippage_bps, twap_min_notional_usd, strategy_state_json,
       value_mode, leverage, margin_mode, status, strategy_engine_version, snapshot_status, snapshot_fresh_at,
       snapshot_hash, next_eligible_attempt_at, cooldown_reason, last_decision, last_decision_reason,
       tracking_error_qty, tracking_error_usd, execution_mode, max_spread_bps, max_execution_fee_usd,
       min_order_notional_usd, twap_slices, twap_duration_sec, last_onchain_action, last_tx_hash, last_tx_at,
       replaced_by_position_identifier, pool_snapshot_json, time_in_range_ms, time_tracked_ms,
       time_in_range_pct, range_last_state_in_range, range_last_state_at, range_computed_at, range_frozen_at,
       created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, 'active', $40, $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, $51, $52, $53, $54, $55, $56, $57, $58, $59, $60, $61, $62, $63, $64, $65, $66, $67, $68, $69)
     RETURNING id`,
    [
      record.userId,
      record.accountId,
      record.network,
      record.version,
      record.walletAddress,
      record.poolAddress,
      record.positionIdentifier,
      record.token0Symbol,
      record.token1Symbol,
      record.token0Address,
      record.token1Address,
      record.rangeLowerPrice,
      record.rangeUpperPrice,
      record.priceCurrent,
      record.inferredAsset,
      record.hedgeSize,
      record.hedgeNotionalUsd,
      record.configuredHedgeNotionalUsd,
      record.initialConfiguredHedgeNotionalUsd ?? record.configuredHedgeNotionalUsd,
      record.valueMultiplier,
      record.stopLossDifferencePct ?? 0.05,
      record.protectionMode || 'static',
      record.reentryBufferPct ?? null,
      record.flipCooldownSec ?? null,
      record.maxSequentialFlips ?? null,
      record.breakoutConfirmDistancePct ?? null,
      record.breakoutConfirmDurationSec ?? null,
      record.dynamicState ? JSON.stringify(record.dynamicState) : null,
      record.bandMode ?? null,
      record.baseRebalancePriceMovePct ?? null,
      record.rebalanceIntervalSec ?? null,
      record.targetHedgeRatio ?? null,
      record.minRebalanceNotionalUsd ?? null,
      record.maxSlippageBps ?? null,
      record.twapMinNotionalUsd ?? null,
      record.strategyState ? JSON.stringify(record.strategyState) : null,
      record.valueMode || 'usd',
      record.leverage,
      record.marginMode || 'isolated',
      record.strategyEngineVersion || 'v1',
      record.snapshotStatus || 'ready',
      record.snapshotFreshAt ?? null,
      record.snapshotHash || null,
      record.nextEligibleAttemptAt ?? null,
      record.cooldownReason || null,
      record.lastDecision || null,
      record.lastDecisionReason || null,
      record.trackingErrorQty ?? null,
      record.trackingErrorUsd ?? null,
      record.executionMode || null,
      record.maxSpreadBps ?? null,
      record.maxExecutionFeeUsd ?? null,
      record.minOrderNotionalUsd ?? null,
      record.twapSlices ?? null,
      record.twapDurationSec ?? null,
      record.lastOnchainAction || null,
      record.lastTxHash || null,
      record.lastTxAt ?? null,
      record.replacedByPositionIdentifier || null,
      JSON.stringify(record.poolSnapshot),
      record.timeInRangeMs ?? 0,
      record.timeTrackedMs ?? 0,
      record.timeInRangePct ?? null,
      record.rangeLastStateInRange ?? null,
      record.rangeLastStateAt ?? null,
      record.rangeComputedAt ?? null,
      record.rangeFrozenAt ?? null,
      record.createdAt,
      record.updatedAt ?? record.createdAt,
    ]
  );

  return rows[0]?.id || null;
}

async function reactivate(userId, id, record, executor) {
  const updatedAt = record.updatedAt || Date.now();
  const { rows } = await exec(executor).query(
    `UPDATE protected_uniswap_pools
        SET hyperliquid_account_id = $3,
            network = $4,
            version = $5,
            wallet_address = $6,
            pool_address = $7,
            position_identifier = $8,
            token0_symbol = $9,
            token1_symbol = $10,
            token0_address = $11,
            token1_address = $12,
            range_lower_price = $13,
            range_upper_price = $14,
            price_current = $15,
            inferred_asset = $16,
            hedge_size = $17,
            hedge_notional_usd = $18,
            configured_hedge_notional_usd = $19,
            initial_configured_hedge_notional_usd = $20,
            value_multiplier = $21,
            stop_loss_difference_pct = $22,
            protection_mode = $23,
            reentry_buffer_pct = $24,
            flip_cooldown_sec = $25,
            max_sequential_flips = $26,
            breakout_confirm_distance_pct = $27,
            breakout_confirm_duration_sec = $28,
            dynamic_state_json = $29,
            band_mode = $30,
            base_rebalance_price_move_pct = $31,
            rebalance_interval_sec = $32,
            target_hedge_ratio = $33,
            min_rebalance_notional_usd = $34,
            max_slippage_bps = $35,
            twap_min_notional_usd = $36,
            strategy_state_json = $37,
            value_mode = $38,
            leverage = $39,
            margin_mode = $40,
            strategy_engine_version = $41,
            snapshot_status = $42,
            snapshot_fresh_at = $43,
            snapshot_hash = $44,
            next_eligible_attempt_at = $45,
            cooldown_reason = $46,
            last_decision = $47,
            last_decision_reason = $48,
            tracking_error_qty = $49,
            tracking_error_usd = $50,
            execution_mode = $51,
            max_spread_bps = $52,
            max_execution_fee_usd = $53,
            min_order_notional_usd = $54,
            twap_slices = $55,
            twap_duration_sec = $56,
            last_onchain_action = $57,
            last_tx_hash = $58,
            last_tx_at = $59,
            replaced_by_position_identifier = $60,
            status = 'active',
            pool_snapshot_json = $61,
            time_in_range_ms = COALESCE($62, time_in_range_ms),
            time_tracked_ms = COALESCE($63, time_tracked_ms),
            time_in_range_pct = COALESCE($64, time_in_range_pct),
            range_last_state_in_range = COALESCE($65, range_last_state_in_range),
            range_last_state_at = COALESCE($66, range_last_state_at),
            range_computed_at = COALESCE($67, range_computed_at),
            updated_at = $68,
            range_frozen_at = NULL,
            deactivated_at = NULL
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [
      userId,
      id,
      record.accountId,
      record.network,
      record.version,
      record.walletAddress,
      record.poolAddress,
      record.positionIdentifier,
      record.token0Symbol,
      record.token1Symbol,
      record.token0Address,
      record.token1Address,
      record.rangeLowerPrice,
      record.rangeUpperPrice,
      record.priceCurrent,
      record.inferredAsset,
      record.hedgeSize,
      record.hedgeNotionalUsd,
      record.configuredHedgeNotionalUsd,
      record.initialConfiguredHedgeNotionalUsd ?? record.configuredHedgeNotionalUsd,
      record.valueMultiplier,
      record.stopLossDifferencePct ?? 0.05,
      record.protectionMode || 'static',
      record.reentryBufferPct ?? null,
      record.flipCooldownSec ?? null,
      record.maxSequentialFlips ?? null,
      record.breakoutConfirmDistancePct ?? null,
      record.breakoutConfirmDurationSec ?? null,
      record.dynamicState ? JSON.stringify(record.dynamicState) : null,
      record.bandMode ?? null,
      record.baseRebalancePriceMovePct ?? null,
      record.rebalanceIntervalSec ?? null,
      record.targetHedgeRatio ?? null,
      record.minRebalanceNotionalUsd ?? null,
      record.maxSlippageBps ?? null,
      record.twapMinNotionalUsd ?? null,
      record.strategyState ? JSON.stringify(record.strategyState) : null,
      record.valueMode || 'usd',
      record.leverage,
      record.marginMode || 'isolated',
      record.strategyEngineVersion || 'v1',
      record.snapshotStatus || 'ready',
      record.snapshotFreshAt ?? null,
      record.snapshotHash || null,
      record.nextEligibleAttemptAt ?? null,
      record.cooldownReason || null,
      record.lastDecision || null,
      record.lastDecisionReason || null,
      record.trackingErrorQty ?? null,
      record.trackingErrorUsd ?? null,
      record.executionMode || null,
      record.maxSpreadBps ?? null,
      record.maxExecutionFeeUsd ?? null,
      record.minOrderNotionalUsd ?? null,
      record.twapSlices ?? null,
      record.twapDurationSec ?? null,
      record.lastOnchainAction || null,
      record.lastTxHash || null,
      record.lastTxAt ?? null,
      record.replacedByPositionIdentifier || null,
      JSON.stringify(record.poolSnapshot),
      record.timeInRangeMs ?? null,
      record.timeTrackedMs ?? null,
      record.timeInRangePct ?? null,
      record.rangeLastStateInRange ?? null,
      record.rangeLastStateAt ?? null,
      record.rangeComputedAt ?? null,
      updatedAt,
    ]
  );

  return rows[0]?.id || null;
}

async function updateSnapshot(userId, id, record, executor) {
  const updatedAt = record.updatedAt || Date.now();
  const { rows } = await exec(executor).query(
    `UPDATE protected_uniswap_pools
        SET pool_address = $3,
            token0_symbol = $4,
            token1_symbol = $5,
            token0_address = $6,
            token1_address = $7,
            range_lower_price = $8,
            range_upper_price = $9,
            price_current = $10,
            pool_snapshot_json = $11,
            snapshot_status = COALESCE($12, snapshot_status),
            snapshot_fresh_at = COALESCE($13, snapshot_fresh_at),
            snapshot_hash = COALESCE($14, snapshot_hash),
            updated_at = $15,
            in_range_checks = in_range_checks + 1,
            in_range_hits = in_range_hits + CASE WHEN $16 THEN 1 ELSE 0 END,
            time_in_range_ms = COALESCE($17, time_in_range_ms),
            time_tracked_ms = COALESCE($18, time_tracked_ms),
            time_in_range_pct = COALESCE($19, time_in_range_pct),
            range_last_state_in_range = COALESCE($20, range_last_state_in_range),
            range_last_state_at = COALESCE($21, range_last_state_at),
            range_computed_at = COALESCE($22, range_computed_at),
            range_frozen_at = COALESCE($23, range_frozen_at)
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [
      userId,
      id,
      record.poolAddress || null,
      record.token0Symbol,
      record.token1Symbol,
      record.token0Address || null,
      record.token1Address || null,
      record.rangeLowerPrice,
      record.rangeUpperPrice,
      record.priceCurrent,
      JSON.stringify(record.poolSnapshot),
      record.snapshotStatus ?? null,
      record.snapshotFreshAt ?? null,
      record.snapshotHash ?? null,
      updatedAt,
      record.isCurrentlyInRange === true,
      record.timeInRangeMs ?? null,
      record.timeTrackedMs ?? null,
      record.timeInRangePct ?? null,
      record.rangeLastStateInRange ?? null,
      record.rangeLastStateAt ?? null,
      record.rangeComputedAt ?? null,
      record.rangeFrozenAt ?? null,
    ]
  );

  return rows[0]?.id || null;
}

async function deactivate(userId, id, {
  deactivatedAt = Date.now(),
  poolSnapshot = null,
  timeInRangeMs = null,
  timeTrackedMs = null,
  timeInRangePct = null,
  rangeLastStateInRange = null,
  rangeLastStateAt = null,
  rangeComputedAt = null,
  rangeFrozenAt = deactivatedAt,
} = {}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE protected_uniswap_pools
        SET status = 'inactive',
            updated_at = $3,
            deactivated_at = $3,
            pool_snapshot_json = COALESCE($4, pool_snapshot_json),
            time_in_range_ms = COALESCE($5, time_in_range_ms),
            time_tracked_ms = COALESCE($6, time_tracked_ms),
            time_in_range_pct = COALESCE($7, time_in_range_pct),
            range_last_state_in_range = COALESCE($8, range_last_state_in_range),
            range_last_state_at = COALESCE($9, range_last_state_at),
            range_computed_at = COALESCE($10, range_computed_at),
            range_frozen_at = COALESCE($11, range_frozen_at, $3)
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [
      userId,
      id,
      deactivatedAt,
      poolSnapshot ? JSON.stringify(poolSnapshot) : null,
      timeInRangeMs,
      timeTrackedMs,
      timeInRangePct,
      rangeLastStateInRange,
      rangeLastStateAt,
      rangeComputedAt,
      rangeFrozenAt,
    ]
  );

  return rows[0]?.id || null;
}

async function updateDynamicState(userId, id, {
  dynamicState,
  updatedAt = Date.now(),
  reentryBufferPct,
  flipCooldownSec,
  maxSequentialFlips,
  breakoutConfirmDistancePct,
  breakoutConfirmDurationSec,
}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE protected_uniswap_pools
        SET dynamic_state_json = $3,
            reentry_buffer_pct = COALESCE($4, reentry_buffer_pct),
            flip_cooldown_sec = COALESCE($5, flip_cooldown_sec),
            max_sequential_flips = COALESCE($6, max_sequential_flips),
            breakout_confirm_distance_pct = COALESCE($7, breakout_confirm_distance_pct),
            breakout_confirm_duration_sec = COALESCE($8, breakout_confirm_duration_sec),
            updated_at = $9
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [
      userId,
      id,
      dynamicState ? JSON.stringify(dynamicState) : null,
      reentryBufferPct ?? null,
      flipCooldownSec ?? null,
      maxSequentialFlips ?? null,
      breakoutConfirmDistancePct ?? null,
      breakoutConfirmDurationSec ?? null,
      updatedAt,
    ]
  );

  return rows[0]?.id || null;
}

async function updateStrategyState(userId, id, {
  strategyState,
  priceCurrent,
  hedgeSize,
  hedgeNotionalUsd,
  snapshotStatus,
  snapshotFreshAt,
  snapshotHash,
  nextEligibleAttemptAt,
  cooldownReason,
  lastDecision,
  lastDecisionReason,
  trackingErrorQty,
  trackingErrorUsd,
  executionMode,
  updatedAt = Date.now(),
}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE protected_uniswap_pools
        SET strategy_state_json = $3,
            price_current = COALESCE($4, price_current),
            hedge_size = COALESCE($5, hedge_size),
            hedge_notional_usd = COALESCE($6, hedge_notional_usd),
            snapshot_status = COALESCE($7, snapshot_status),
            snapshot_fresh_at = COALESCE($8, snapshot_fresh_at),
            snapshot_hash = COALESCE($9, snapshot_hash),
            next_eligible_attempt_at = COALESCE($10, next_eligible_attempt_at),
            cooldown_reason = $11,
            last_decision = COALESCE($12, last_decision),
            last_decision_reason = $13,
            tracking_error_qty = COALESCE($14, tracking_error_qty),
            tracking_error_usd = COALESCE($15, tracking_error_usd),
            execution_mode = COALESCE($16, execution_mode),
            updated_at = $17
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [
      userId,
      id,
      strategyState ? JSON.stringify(strategyState) : null,
      priceCurrent ?? null,
      hedgeSize ?? null,
      hedgeNotionalUsd ?? null,
      snapshotStatus ?? null,
      snapshotFreshAt ?? null,
      snapshotHash ?? null,
      nextEligibleAttemptAt ?? null,
      cooldownReason ?? null,
      lastDecision ?? null,
      lastDecisionReason ?? null,
      trackingErrorQty ?? null,
      trackingErrorUsd ?? null,
      executionMode ?? null,
      updatedAt,
    ]
  );

  return rows[0]?.id || null;
}

async function updateOnchainOperation(userId, id, {
  lastOnchainAction,
  lastTxHash,
  lastTxAt = Date.now(),
  replacedByPositionIdentifier,
  updatedAt = lastTxAt,
}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE protected_uniswap_pools
        SET last_onchain_action = COALESCE($3, last_onchain_action),
            last_tx_hash = COALESCE($4, last_tx_hash),
            last_tx_at = COALESCE($5, last_tx_at),
            replaced_by_position_identifier = COALESCE($6, replaced_by_position_identifier),
            updated_at = $7
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [
      userId,
      id,
      lastOnchainAction ?? null,
      lastTxHash ?? null,
      lastTxAt ?? null,
      replacedByPositionIdentifier ?? null,
      updatedAt,
    ]
  );

  return rows[0]?.id || null;
}

async function migratePositionIdentity(userId, id, {
  network,
  version,
  walletAddress,
  poolAddress,
  positionIdentifier,
  token0Address,
  token1Address,
  token0Symbol,
  token1Symbol,
  rangeLowerPrice,
  rangeUpperPrice,
  priceCurrent,
  poolSnapshot,
  lastOnchainAction,
  lastTxHash,
  lastTxAt = Date.now(),
}, executor) {
  const updatedAt = lastTxAt || Date.now();
  const { rows } = await exec(executor).query(
    `UPDATE protected_uniswap_pools
        SET network = COALESCE($3, network),
            version = COALESCE($4, version),
            wallet_address = COALESCE($5, wallet_address),
            pool_address = COALESCE($6, pool_address),
            position_identifier = COALESCE($7, position_identifier),
            token0_address = COALESCE($8, token0_address),
            token1_address = COALESCE($9, token1_address),
            token0_symbol = COALESCE($10, token0_symbol),
            token1_symbol = COALESCE($11, token1_symbol),
            range_lower_price = COALESCE($12, range_lower_price),
            range_upper_price = COALESCE($13, range_upper_price),
            price_current = COALESCE($14, price_current),
            pool_snapshot_json = COALESCE($15, pool_snapshot_json),
            last_onchain_action = COALESCE($16, last_onchain_action),
            last_tx_hash = COALESCE($17, last_tx_hash),
            last_tx_at = COALESCE($18, last_tx_at),
            replaced_by_position_identifier = NULL,
            updated_at = $19
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [
      userId,
      id,
      network ?? null,
      version ?? null,
      walletAddress ?? null,
      poolAddress ?? null,
      positionIdentifier ?? null,
      token0Address ?? null,
      token1Address ?? null,
      token0Symbol ?? null,
      token1Symbol ?? null,
      rangeLowerPrice ?? null,
      rangeUpperPrice ?? null,
      priceCurrent ?? null,
      poolSnapshot ? JSON.stringify(poolSnapshot) : null,
      lastOnchainAction ?? null,
      lastTxHash ?? null,
      lastTxAt ?? null,
      updatedAt,
    ]
  );

  return rows[0]?.id || null;
}

async function findByPositionIdentifier(positionIdentifier, network, version, executor) {
  const { rows } = await exec(executor).query(
    `SELECT ${IDENTITY_COLUMNS}
       FROM protected_uniswap_pools
      WHERE position_identifier = $1
        AND network = $2
        AND version = $3
        AND status = 'active'`,
    [String(positionIdentifier), network, version]
  );
  return rows.map(mapIdentityRow);
}

module.exports = {
  create,
  deactivate,
  findByPositionIdentifier,
  findReusableByIdentity,
  getById,
  listActiveByUser,
  listActiveDeltaNeutral,
  listActiveDynamic,
  listActiveForRefresh,
  listByUser,
  migratePositionIdentity,
  reactivate,
  updateOnchainOperation,
  updateDynamicState,
  updateStrategyState,
  updateSnapshot,
};
