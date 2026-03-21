const db = require('../db');

async function getByKey(userId, key) {
  const { rows } = await db.query(
    'SELECT value, updated_at FROM settings WHERE user_id = $1 AND key = $2',
    [userId, key]
  );
  return rows[0] || null;
}

async function listByKey(key) {
  const { rows } = await db.query(
    'SELECT user_id, value, updated_at FROM settings WHERE key = $1 ORDER BY user_id ASC',
    [key]
  );
  return rows;
}

async function upsert(userId, key, value) {
  await db.query(
    `INSERT INTO settings (user_id, key, value, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [userId, key, value, Date.now()]
  );
}

module.exports = {
  getByKey,
  listByKey,
  upsert,
};
