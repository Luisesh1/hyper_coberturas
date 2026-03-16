const db = require('../db');

async function listByUser(userId) {
  const { rows } = await db.query(
    `SELECT s.*,
            b.summary_json AS backtest_summary_json,
            b.range_start AS backtest_range_start,
            b.range_end AS backtest_range_end,
            b.updated_at AS backtest_updated_at
     FROM strategies s
     LEFT JOIN strategy_backtests b ON b.strategy_id = s.id
     WHERE s.user_id = $1
     ORDER BY s.updated_at DESC, s.id DESC`,
    [userId]
  );
  return rows;
}

async function getById(userId, strategyId) {
  const { rows } = await db.query(
    `SELECT s.*,
            b.summary_json AS backtest_summary_json,
            b.range_start AS backtest_range_start,
            b.range_end AS backtest_range_end,
            b.updated_at AS backtest_updated_at
     FROM strategies s
     LEFT JOIN strategy_backtests b ON b.strategy_id = s.id
     WHERE s.user_id = $1 AND s.id = $2`,
    [userId, strategyId]
  );
  return rows[0] || null;
}

async function create(userId, payload) {
  const { rows } = await db.query(
    `INSERT INTO strategies (
       user_id, name, description, asset_universe_json, timeframe, script_source,
       default_params_json, is_active_draft, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     RETURNING *`,
    [
      userId,
      payload.name,
      payload.description,
      payload.assetUniverseJson,
      payload.timeframe,
      payload.scriptSource,
      payload.defaultParamsJson,
      payload.isActiveDraft,
      payload.now,
    ]
  );
  return rows[0];
}

async function update(userId, strategyId, payload) {
  const { rows } = await db.query(
    `UPDATE strategies
        SET name = $3,
            description = $4,
            asset_universe_json = $5,
            timeframe = $6,
            script_source = $7,
            default_params_json = $8,
            is_active_draft = $9,
            updated_at = $10
      WHERE user_id = $1 AND id = $2
      RETURNING *`,
    [
      userId,
      strategyId,
      payload.name,
      payload.description,
      payload.assetUniverseJson,
      payload.timeframe,
      payload.scriptSource,
      payload.defaultParamsJson,
      payload.isActiveDraft,
      payload.now,
    ]
  );
  return rows[0] || null;
}

async function remove(userId, strategyId) {
  const { rowCount } = await db.query(
    'DELETE FROM strategies WHERE user_id = $1 AND id = $2',
    [userId, strategyId]
  );
  return rowCount > 0;
}

module.exports = {
  create,
  getById,
  listByUser,
  remove,
  update,
};
