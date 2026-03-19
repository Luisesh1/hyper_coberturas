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
    valueMultiplier: row.value_multiplier != null ? Number(row.value_multiplier) : null,
    stopLossDifferencePct: row.stop_loss_difference_pct != null ? Number(row.stop_loss_difference_pct) : 0.05,
    protectionMode: row.protection_mode || 'static',
    reentryBufferPct: row.reentry_buffer_pct != null ? Number(row.reentry_buffer_pct) : null,
    flipCooldownSec: row.flip_cooldown_sec != null ? Number(row.flip_cooldown_sec) : null,
    maxSequentialFlips: row.max_sequential_flips != null ? Number(row.max_sequential_flips) : null,
    dynamicState: parseJsonSafe(row.dynamic_state_json, null),
    valueMode: row.value_mode || 'usd',
    leverage: Number(row.leverage),
    marginMode: row.margin_mode,
    status: row.status,
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
    `SELECT id, user_id, hyperliquid_account_id, network, version, wallet_address, pool_address, position_identifier,
            token0_symbol, token1_symbol, token0_address, token1_address, range_lower_price, range_upper_price,
            price_current, inferred_asset, hedge_size, hedge_notional_usd, configured_hedge_notional_usd,
            value_multiplier, stop_loss_difference_pct, protection_mode, reentry_buffer_pct, flip_cooldown_sec,
            max_sequential_flips, dynamic_state_json, value_mode, leverage, margin_mode, status, created_at,
            updated_at, deactivated_at
       FROM protected_uniswap_pools
      WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );

  return rows.map(mapIdentityRow);
}

async function listActiveForRefresh(executor) {
  const { rows } = await exec(executor).query(
    `SELECT id, user_id, hyperliquid_account_id, network, version, wallet_address, pool_address, position_identifier,
            token0_symbol, token1_symbol, token0_address, token1_address, range_lower_price, range_upper_price,
            price_current, inferred_asset, hedge_size, hedge_notional_usd, configured_hedge_notional_usd,
            value_multiplier, stop_loss_difference_pct, protection_mode, reentry_buffer_pct, flip_cooldown_sec,
            max_sequential_flips, dynamic_state_json, value_mode, leverage, margin_mode, status, created_at,
            updated_at, deactivated_at, pool_snapshot_json
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
    `SELECT id, user_id, hyperliquid_account_id, network, version, wallet_address, pool_address, position_identifier,
            token0_symbol, token1_symbol, token0_address, token1_address, range_lower_price, range_upper_price,
            price_current, inferred_asset, hedge_size, hedge_notional_usd, configured_hedge_notional_usd,
            value_multiplier, stop_loss_difference_pct, protection_mode, reentry_buffer_pct, flip_cooldown_sec,
            max_sequential_flips, dynamic_state_json, value_mode, leverage, margin_mode, status, created_at,
            updated_at, deactivated_at
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

async function create(record, executor) {
  const { rows } = await exec(executor).query(
    `INSERT INTO protected_uniswap_pools (
       user_id, hyperliquid_account_id, network, version, wallet_address, pool_address, position_identifier,
       token0_symbol, token1_symbol, token0_address, token1_address, range_lower_price, range_upper_price,
       price_current, inferred_asset, hedge_size, hedge_notional_usd, configured_hedge_notional_usd,
       value_multiplier, stop_loss_difference_pct, protection_mode, reentry_buffer_pct, flip_cooldown_sec,
       max_sequential_flips, dynamic_state_json, value_mode, leverage, margin_mode, status, pool_snapshot_json,
       created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, 'active', $29, $30, $30)
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
      record.valueMultiplier,
      record.stopLossDifferencePct ?? 0.05,
      record.protectionMode || 'static',
      record.reentryBufferPct ?? null,
      record.flipCooldownSec ?? null,
      record.maxSequentialFlips ?? null,
      record.dynamicState ? JSON.stringify(record.dynamicState) : null,
      record.valueMode || 'usd',
      record.leverage,
      record.marginMode || 'isolated',
      JSON.stringify(record.poolSnapshot),
      record.createdAt,
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
            value_multiplier = $20,
            stop_loss_difference_pct = $21,
            protection_mode = $22,
            reentry_buffer_pct = $23,
            flip_cooldown_sec = $24,
            max_sequential_flips = $25,
            dynamic_state_json = $26,
            value_mode = $27,
            leverage = $28,
            margin_mode = $29,
            status = 'active',
            pool_snapshot_json = $30,
            updated_at = $31,
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
      record.valueMultiplier,
      record.stopLossDifferencePct ?? 0.05,
      record.protectionMode || 'static',
      record.reentryBufferPct ?? null,
      record.flipCooldownSec ?? null,
      record.maxSequentialFlips ?? null,
      record.dynamicState ? JSON.stringify(record.dynamicState) : null,
      record.valueMode || 'usd',
      record.leverage,
      record.marginMode || 'isolated',
      JSON.stringify(record.poolSnapshot),
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
            updated_at = $12
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
      updatedAt,
    ]
  );

  return rows[0]?.id || null;
}

async function deactivate(userId, id, { deactivatedAt = Date.now() } = {}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE protected_uniswap_pools
        SET status = 'inactive',
            updated_at = $3,
            deactivated_at = $3
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [userId, id, deactivatedAt]
  );

  return rows[0]?.id || null;
}

async function updateDynamicState(userId, id, {
  dynamicState,
  updatedAt = Date.now(),
  reentryBufferPct,
  flipCooldownSec,
  maxSequentialFlips,
}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE protected_uniswap_pools
        SET dynamic_state_json = $3,
            reentry_buffer_pct = COALESCE($4, reentry_buffer_pct),
            flip_cooldown_sec = COALESCE($5, flip_cooldown_sec),
            max_sequential_flips = COALESCE($6, max_sequential_flips),
            updated_at = $7
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [
      userId,
      id,
      dynamicState ? JSON.stringify(dynamicState) : null,
      reentryBufferPct ?? null,
      flipCooldownSec ?? null,
      maxSequentialFlips ?? null,
      updatedAt,
    ]
  );

  return rows[0]?.id || null;
}

module.exports = {
  create,
  deactivate,
  findReusableByIdentity,
  getById,
  listActiveByUser,
  listActiveDynamic,
  listActiveForRefresh,
  listByUser,
  reactivate,
  updateDynamicState,
  updateSnapshot,
};
