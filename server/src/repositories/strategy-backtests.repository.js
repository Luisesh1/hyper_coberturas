const db = require('../db');

async function upsert(userId, strategyId, payload) {
  const { rows } = await db.query(
    `INSERT INTO strategy_backtests (
       strategy_id, user_id, summary_json, range_start, range_end, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (strategy_id)
     DO UPDATE SET
       summary_json = EXCLUDED.summary_json,
       range_start = EXCLUDED.range_start,
       range_end = EXCLUDED.range_end,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      strategyId,
      userId,
      payload.summaryJson,
      payload.rangeStart,
      payload.rangeEnd,
      payload.now,
    ]
  );
  return rows[0];
}

module.exports = {
  upsert,
};
