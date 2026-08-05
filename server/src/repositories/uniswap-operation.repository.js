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
    // Solo lo usa `orchestrated_lp_create`: es el plan del wizard, guardado
    // antes de la primera firma para poder reconciliar sin el cliente.
    plan: parseJsonSafe(row.plan_json, null),
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    replacementMap: parseJsonSafe(row.replacement_map_json, {}),
    claimToken: row.claim_token || null,
    claimOwner: row.claim_owner || null,
    claimLeaseUntil: row.claim_lease_until != null ? Number(row.claim_lease_until) : null,
    attemptCount: Number(row.attempt_count) || 0,
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
       error_message, replacement_map_json, created_at, updated_at, finished_at,
       plan_json
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18,
       $19
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
      toJson(record.plan || null),
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

/**
 * Reserva atómicamente hasta `limit` operaciones pendientes usando
 * FOR UPDATE SKIP LOCKED y persiste un lease antes de confirmar la
 * transacción. Así la exclusión sobrevive al COMMIT y cubre todo el trabajo
 * externo que viene después.
 */
async function claimPending(limit = 20, {
  claimToken,
  claimOwner,
  leaseMs = 120_000,
  now = Date.now(),
} = {}, executor) {
  if (!executor) {
    throw new Error('claimPending requires a transactional executor');
  }
  if (!claimToken || !claimOwner) {
    throw new Error('claimPending requires claimToken and claimOwner');
  }
  const { rows } = await executor.query(
    `WITH candidates AS (
       SELECT id
         FROM position_action_operations
        WHERE status IN (
          'queued', 'waiting_receipts', 'refreshing_snapshot', 'migrating_protection',
          'committing'
        )
          AND (claim_lease_until IS NULL OR claim_lease_until <= $2)
        ORDER BY updated_at ASC, id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE position_action_operations op
        SET claim_token = $3,
            claim_owner = $4,
            claim_lease_until = $5,
            attempt_count = attempt_count + 1,
            updated_at = $2
       FROM candidates
      WHERE op.id = candidates.id
      RETURNING op.*`,
    [limit, now, claimToken, claimOwner, now + leaseMs]
  );
  return rows.map(mapRow);
}

/**
 * Adquiere el lease de una intención concreta. Se usa en el request HTTP;
 * comparte las mismas columnas que el worker, de modo que ambos compiten por
 * una sola autoridad persistente.
 */
async function claimByOperationKey(userId, operationKey, {
  claimToken,
  claimOwner,
  leaseMs = 120_000,
  now = Date.now(),
} = {}, executor) {
  if (!claimToken || !claimOwner) {
    throw new Error('claimByOperationKey requires claimToken and claimOwner');
  }
  const { rows } = await exec(executor).query(
    `UPDATE position_action_operations
        SET claim_token = $3,
            claim_owner = $4,
            claim_lease_until = $5,
            attempt_count = attempt_count + 1,
            updated_at = $6
      WHERE user_id = $1
        AND operation_key = $2
        AND status NOT IN ('done', 'compensated', 'failed', 'needs_reconcile')
        AND (claim_lease_until IS NULL OR claim_lease_until <= $6 OR claim_token = $3)
      RETURNING *`,
    [userId, operationKey, claimToken, claimOwner, now + leaseMs, now]
  );
  return mapRow(rows[0]);
}

async function renewClaim(id, claimToken, leaseMs = 120_000, executor) {
  const now = Date.now();
  const { rows } = await exec(executor).query(
    `UPDATE position_action_operations
        SET claim_lease_until = $3,
            updated_at = $4
      WHERE id = $1 AND claim_token = $2
      RETURNING *`,
    [id, claimToken, now + leaseMs, now]
  );
  return mapRow(rows[0]);
}

async function releaseClaim(id, claimToken, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE position_action_operations
        SET claim_token = NULL,
            claim_owner = NULL,
            claim_lease_until = NULL,
            updated_at = $3
      WHERE id = $1 AND claim_token = $2
      RETURNING *`,
    [id, claimToken, Date.now()]
  );
  return mapRow(rows[0]);
}

/**
 * Caduca intenciones que nunca llegaron a firmarse. Sin esto se acumularían
 * para siempre planes de wizards que el usuario simplemente cerró.
 *
 * Solo toca las que no tienen ninguna tx asociada: si hay txHashes, el LP
 * puede existir on-chain y la operación necesita conciliación humana, no
 * un borrado silencioso.
 */
async function expireStaleIntents(olderThanMs, executor) {
  const cutoff = Date.now() - olderThanMs;
  const { rows } = await exec(executor).query(
    `UPDATE position_action_operations
        SET status = 'failed',
            step = 'failed',
            error_code = 'INTENT_EXPIRED',
            error_message = 'La intención caducó sin llegar a firmarse.',
            updated_at = $1,
            finished_at = $1
      WHERE kind = 'orchestrated_lp_create'
        AND status = 'awaiting_signature'
        AND updated_at < $2
        AND tx_hashes_json IN ('[]', 'null')
      RETURNING id`,
    [Date.now(), cutoff]
  );
  return rows.length;
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
            finished_at = COALESCE($9, finished_at),
            tx_hashes_json = COALESCE($10, tx_hashes_json),
            position_identifier = COALESCE($11, position_identifier),
            claim_token = CASE
              WHEN $2 IN ('done', 'compensated', 'failed', 'needs_reconcile') THEN NULL
              ELSE claim_token
            END,
            claim_owner = CASE
              WHEN $2 IN ('done', 'compensated', 'failed', 'needs_reconcile') THEN NULL
              ELSE claim_owner
            END,
            claim_lease_until = CASE
              WHEN $2 IN ('done', 'compensated', 'failed', 'needs_reconcile') THEN NULL
              ELSE claim_lease_until
            END
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
      // La intención se registra antes de firmar, así que los txHashes y el
      // identificador de la posición llegan en un update posterior.
      patch.txHashes !== undefined ? toJson(patch.txHashes) : null,
      patch.positionIdentifier ?? null,
    ]
  );
  return mapRow(rows[0]);
}

module.exports = {
  createOrReuse,
  getById,
  getByOperationKey,
  listPending,
  claimPending,
  claimByOperationKey,
  renewClaim,
  releaseClaim,
  expireStaleIntents,
  updateState,
};
