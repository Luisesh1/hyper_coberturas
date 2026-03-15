const db = require('../db');

function exec(executor) {
  return executor || db;
}

async function countByUser(userId, executor) {
  const { rows } = await exec(executor).query(
    'SELECT COUNT(*)::int AS count FROM hyperliquid_accounts WHERE user_id = $1',
    [userId]
  );
  return rows[0]?.count || 0;
}

async function listByUser(userId, executor) {
  const { rows } = await exec(executor).query(
    `SELECT *
       FROM hyperliquid_accounts
      WHERE user_id = $1
      ORDER BY is_default DESC, updated_at DESC, id DESC`,
    [userId]
  );
  return rows;
}

async function getById(userId, accountId, executor) {
  const { rows } = await exec(executor).query(
    `SELECT *
       FROM hyperliquid_accounts
      WHERE user_id = $1 AND id = $2`,
    [userId, accountId]
  );
  return rows[0] || null;
}

async function getDefaultByUser(userId, executor) {
  const { rows } = await exec(executor).query(
    `SELECT *
       FROM hyperliquid_accounts
      WHERE user_id = $1 AND is_default = true
      ORDER BY id ASC
      LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function create(userId, account, executor) {
  const { rows } = await exec(executor).query(
    `INSERT INTO hyperliquid_accounts (
       user_id, alias, address, private_key_encrypted, is_default, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING *`,
    [
      userId,
      account.alias,
      account.address,
      account.privateKeyEncrypted,
      !!account.isDefault,
      account.createdAt,
    ]
  );
  return rows[0];
}

async function update(userId, accountId, account, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE hyperliquid_accounts
        SET alias = $3,
            address = $4,
            private_key_encrypted = $5,
            is_default = $6,
            updated_at = $7
      WHERE user_id = $1 AND id = $2
      RETURNING *`,
    [
      userId,
      accountId,
      account.alias,
      account.address,
      account.privateKeyEncrypted,
      !!account.isDefault,
      account.updatedAt,
    ]
  );
  return rows[0] || null;
}

async function clearDefault(userId, executor) {
  await exec(executor).query(
    `UPDATE hyperliquid_accounts
        SET is_default = false,
            updated_at = $2
      WHERE user_id = $1 AND is_default = true`,
    [userId, Date.now()]
  );
}

async function setDefault(userId, accountId, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE hyperliquid_accounts
        SET is_default = true,
            updated_at = $3
      WHERE user_id = $1 AND id = $2
      RETURNING *`,
    [userId, accountId, Date.now()]
  );
  return rows[0] || null;
}

async function deleteById(userId, accountId, executor) {
  const { rows } = await exec(executor).query(
    `DELETE FROM hyperliquid_accounts
      WHERE user_id = $1 AND id = $2
      RETURNING *`,
    [userId, accountId]
  );
  return rows[0] || null;
}

async function countHedgesByAccount(userId, accountId, executor) {
  const { rows } = await exec(executor).query(
    `SELECT COUNT(*)::int AS count
       FROM hedges
      WHERE user_id = $1 AND hyperliquid_account_id = $2`,
    [userId, accountId]
  );
  return rows[0]?.count || 0;
}

async function assignLegacyHedges(userId, accountId, executor) {
  await exec(executor).query(
    `UPDATE hedges
        SET hyperliquid_account_id = $2
      WHERE user_id = $1 AND hyperliquid_account_id IS NULL`,
    [userId, accountId]
  );
}

module.exports = {
  assignLegacyHedges,
  clearDefault,
  countByUser,
  countHedgesByAccount,
  create,
  deleteById,
  getById,
  getDefaultByUser,
  listByUser,
  setDefault,
  update,
};
