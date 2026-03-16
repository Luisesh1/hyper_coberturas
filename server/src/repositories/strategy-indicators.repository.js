const db = require('../db');

async function listByUser(userId) {
  const { rows } = await db.query(
    `SELECT *
       FROM strategy_indicators
      WHERE user_id = $1
      ORDER BY updated_at DESC, id DESC`,
    [userId]
  );
  return rows;
}

async function getById(userId, indicatorId) {
  const { rows } = await db.query(
    'SELECT * FROM strategy_indicators WHERE user_id = $1 AND id = $2',
    [userId, indicatorId]
  );
  return rows[0] || null;
}

async function getBySlug(userId, slug) {
  const { rows } = await db.query(
    'SELECT * FROM strategy_indicators WHERE user_id = $1 AND slug = $2',
    [userId, slug]
  );
  return rows[0] || null;
}

async function create(userId, payload) {
  const { rows } = await db.query(
    `INSERT INTO strategy_indicators (
       user_id, name, slug, script_source, parameter_schema_json, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING *`,
    [
      userId,
      payload.name,
      payload.slug,
      payload.scriptSource,
      payload.parameterSchemaJson,
      payload.now,
    ]
  );
  return rows[0];
}

async function update(userId, indicatorId, payload) {
  const { rows } = await db.query(
    `UPDATE strategy_indicators
        SET name = $3,
            slug = $4,
            script_source = $5,
            parameter_schema_json = $6,
            updated_at = $7
      WHERE user_id = $1 AND id = $2
      RETURNING *`,
    [
      userId,
      indicatorId,
      payload.name,
      payload.slug,
      payload.scriptSource,
      payload.parameterSchemaJson,
      payload.now,
    ]
  );
  return rows[0] || null;
}

async function remove(userId, indicatorId) {
  const { rowCount } = await db.query(
    'DELETE FROM strategy_indicators WHERE user_id = $1 AND id = $2',
    [userId, indicatorId]
  );
  return rowCount > 0;
}

module.exports = {
  create,
  getById,
  getBySlug,
  listByUser,
  remove,
  update,
};
