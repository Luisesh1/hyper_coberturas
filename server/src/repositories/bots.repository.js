const db = require('../db');

const SELECT_BASE = `
  SELECT b.*,
         s.name AS strategy_name,
         s.timeframe AS strategy_timeframe,
         s.default_params_json AS strategy_default_params_json,
         a.alias AS account_alias,
         a.address AS account_address,
         bt.summary_json AS backtest_summary_json
    FROM bot_instances b
    JOIN strategies s ON s.id = b.strategy_id
    JOIN hyperliquid_accounts a ON a.id = b.hyperliquid_account_id
    LEFT JOIN strategy_backtests bt ON bt.strategy_id = s.id
`;

async function listByUser(userId) {
  const { rows } = await db.query(
    `${SELECT_BASE}
      WHERE b.user_id = $1
      ORDER BY b.updated_at DESC, b.id DESC`,
    [userId]
  );
  return rows;
}

async function getById(userId, botId) {
  const { rows } = await db.query(
    `${SELECT_BASE}
      WHERE b.user_id = $1 AND b.id = $2`,
    [userId, botId]
  );
  return rows[0] || null;
}

async function listActiveByUser(userId) {
  const { rows } = await db.query(
    `${SELECT_BASE}
      WHERE b.user_id = $1 AND b.status = 'active'
      ORDER BY b.id ASC`,
    [userId]
  );
  return rows;
}

async function countOtherActiveByAsset(userId, accountId, asset, botId = null) {
  const params = [userId, accountId, asset];
  const exclusion = botId != null ? ' AND id <> $4' : '';
  if (botId != null) params.push(botId);

  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM bot_instances
      WHERE user_id = $1
        AND hyperliquid_account_id = $2
        AND asset = $3
        AND status = 'active'
        ${exclusion}`,
    params
  );
  return rows[0]?.count || 0;
}

async function create(userId, payload) {
  const { rows } = await db.query(
    `INSERT INTO bot_instances (
       user_id, strategy_id, hyperliquid_account_id, asset, timeframe, params_json, leverage,
       margin_mode, size, stop_loss_pct, take_profit_pct, status, last_error,
       created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, $13, $13)
     RETURNING *`,
    [
      userId,
      payload.strategyId,
      payload.accountId,
      payload.asset,
      payload.timeframe,
      payload.paramsJson,
      payload.leverage,
      payload.marginMode,
      payload.size,
      payload.stopLossPct,
      payload.takeProfitPct,
      payload.status,
      payload.now,
    ]
  );
  return rows[0];
}

async function update(userId, botId, payload) {
  const { rows } = await db.query(
    `UPDATE bot_instances
        SET strategy_id = $3,
            hyperliquid_account_id = $4,
            asset = $5,
            timeframe = $6,
            params_json = $7,
            leverage = $8,
            margin_mode = $9,
            size = $10,
            stop_loss_pct = $11,
            take_profit_pct = $12,
            updated_at = $13
      WHERE user_id = $1 AND id = $2
      RETURNING *`,
    [
      userId,
      botId,
      payload.strategyId,
      payload.accountId,
      payload.asset,
      payload.timeframe,
      payload.paramsJson,
      payload.leverage,
      payload.marginMode,
      payload.size,
      payload.stopLossPct,
      payload.takeProfitPct,
      payload.now,
    ]
  );
  return rows[0] || null;
}

async function remove(userId, botId) {
  const { rowCount } = await db.query(
    'DELETE FROM bot_instances WHERE user_id = $1 AND id = $2',
    [userId, botId]
  );
  return rowCount > 0;
}

async function updateRuntime(userId, botId, payload) {
  const { rows } = await db.query(
    `UPDATE bot_instances
        SET status = $3,
            last_candle_at = $4,
            last_signal_hash = $5,
            last_error = $6,
            last_evaluated_at = $7,
            last_signal_json = $8,
            runtime_state = $9,
            consecutive_failures = $10,
            next_retry_at = $11,
            last_recovery_at = $12,
            last_recovery_action = $13,
            system_pause_reason = $14,
            runtime_context_json = $15,
            updated_at = $16
      WHERE user_id = $1 AND id = $2
      RETURNING *`,
    [
      userId,
      botId,
      payload.status,
      payload.lastCandleAt,
      payload.lastSignalHash,
      payload.lastError,
      payload.lastEvaluatedAt,
      payload.lastSignalJson,
      payload.runtimeState,
      payload.consecutiveFailures,
      payload.nextRetryAt,
      payload.lastRecoveryAt,
      payload.lastRecoveryAction,
      payload.systemPauseReason,
      payload.runtimeContextJson,
      payload.updatedAt,
    ]
  );
  return rows[0] || null;
}

async function appendRun(userId, botId, payload) {
  const { rows } = await db.query(
    `INSERT INTO bot_runs (
       bot_instance_id, user_id, status, action, signal_json, candle_time,
       price, details_json, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      botId,
      userId,
      payload.status,
      payload.action,
      payload.signalJson,
      payload.candleTime,
      payload.price,
      payload.detailsJson,
      payload.createdAt,
    ]
  );
  return rows[0];
}

async function listRuns(userId, botId, { limit = 500 } = {}) {
  const { rows } = await db.query(
    `SELECT *
       FROM bot_runs
      WHERE user_id = $1 AND bot_instance_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [userId, botId, limit]
  );
  return rows;
}

module.exports = {
  appendRun,
  countOtherActiveByAsset,
  create,
  getById,
  listActiveByUser,
  listByUser,
  listRuns,
  remove,
  update,
  updateRuntime,
};
