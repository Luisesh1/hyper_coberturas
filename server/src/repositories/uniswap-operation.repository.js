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

function toJson(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    operationKey: row.operation_key,
    kind: row.kind,
    action: row.action,
    network: row.network,
    version: row.version,
    walletAddress: row.wallet_address,
    positionIdentifier: row.position_identifier || null,
    txHashes: parseJsonSafe(row.tx_hashes_json, []),
    status: row.status,
    step: row.step,
    result: parseJsonSafe(row.result_json, null),
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    replacementMap: parseJsonSafe(row.replacement_map_json, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    finishedAt: row.finished_at != null ? Number(row.finished_at) : null,
  };
}

async function createOrReuse(record, executor) {
  const now = record.createdAt || Date.now();
  const { rows } = await exec(executor).query(
    `INSERT INTO position_action_operations (
       user_id, operation_key, kind, action, network, version, wallet_address,
       position_identifier, tx_hashes_json, status, step, result_json, error_code,
       error_message, replacement_map_json, created_at, updated_at, finished_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18
     )
     ON CONFLICT (operation_key) DO UPDATE
       SET updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      record.userId,
      record.operationKey,
      record.kind,
      record.action,
      record.network,
      record.version,
      record.walletAddress,
      record.positionIdentifier ?? null,
      toJson(record.txHashes || []),
      record.status || 'queued',
      record.step || record.status || 'queued',
      toJson(record.result || null),
      record.errorCode || null,
      record.errorMessage || null,
      toJson(record.replacementMap || {}),
      now,
      now,
      record.finishedAt ?? null,
    ]
  );
  return mapRow(rows[0]);
}

async function getById(userId, id, executor) {
  const { rows } = await exec(executor).query(
    `SELECT * FROM position_action_operations
      WHERE user_id = $1 AND id = $2
      LIMIT 1`,
    [userId, id]
  );
  return mapRow(rows[0]);
}

async function getByOperationKey(userId, operationKey, executor) {
  const { rows } = await exec(executor).query(
    `SELECT * FROM position_action_operations
      WHERE user_id = $1 AND operation_key = $2
      LIMIT 1`,
    [userId, operationKey]
  );
  return mapRow(rows[0]);
}

async function listPending(limit = 20, executor) {
  const { rows } = await exec(executor).query(
    `SELECT * FROM position_action_operations
      WHERE status IN ('queued', 'waiting_receipts', 'refreshing_snapshot', 'migrating_protection')
      ORDER BY updated_at ASC, id ASC
      LIMIT $1`,
    [limit]
  );
  return rows.map(mapRow);
}

async function updateState(id, patch = {}, executor) {
  const now = patch.updatedAt || Date.now();
  const { rows } = await exec(executor).query(
    `UPDATE position_action_operations
        SET status = COALESCE($2, status),
            step = COALESCE($3, step),
            result_json = COALESCE($4, result_json),
            error_code = $5,
            error_message = $6,
            replacement_map_json = COALESCE($7, replacement_map_json),
            updated_at = $8,
            finished_at = COALESCE($9, finished_at)
      WHERE id = $1
      RETURNING *`,
    [
      id,
      patch.status ?? null,
      patch.step ?? null,
      patch.result !== undefined ? toJson(patch.result) : null,
      patch.errorCode ?? null,
      patch.errorMessage ?? null,
      patch.replacementMap !== undefined ? toJson(patch.replacementMap) : null,
      now,
      patch.finishedAt ?? null,
    ]
  );
  return mapRow(rows[0]);
}

module.exports = {
  createOrReuse,
  getById,
  getByOperationKey,
  listPending,
  updateState,
};
