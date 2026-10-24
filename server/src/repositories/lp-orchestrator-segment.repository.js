/**
 * lp-orchestrator-segment.repository.js
 *
 * Persistencia de los tramos (segmentos) de un orquestador de LP. Mismo estilo
 * que `lp-orchestrator.repository.js`: mapRow + parseJsonSafe + executor.
 */

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

function num(value) {
  return value != null ? Number(value) : null;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    orchestratorId: Number(row.orchestrator_id),
    seq: Number(row.seq),
    status: row.status,
    accuracy: row.accuracy,
    positionIdentifier: row.position_identifier || null,
    poolAddress: row.pool_address || null,
    protectedPoolId: num(row.protected_pool_id),
    policyVersion: row.policy_version || null,
    openedAt: Number(row.opened_at),
    openPrice: num(row.open_price),
    rangeLowerPrice: num(row.range_lower_price),
    rangeUpperPrice: num(row.range_upper_price),
    openValueUsd: num(row.open_value_usd),
    openAmount0: num(row.open_amount0),
    openAmount1: num(row.open_amount1),
    openReason: row.open_reason || null,
    openTxHashes: parseJsonSafe(row.open_tx_hashes_json, null),
    closingStartedAt: num(row.closing_started_at),
    closedAt: num(row.closed_at),
    closePrice: num(row.close_price),
    closeValueUsd: num(row.close_value_usd),
    closeReason: row.close_reason || null,
    closeTxHashes: parseJsonSafe(row.close_tx_hashes_json, null),
    accounting: parseJsonSafe(row.accounting_json, {}),
    baselineAccounting: parseJsonSafe(row.baseline_accounting_json, {}),
    hedgeBaseline: parseJsonSafe(row.hedge_baseline_json, null),
    shadowBaselines: parseJsonSafe(row.shadow_baselines_json, null),
    lpBaselineSnapshot: parseJsonSafe(row.lp_baseline_snapshot_json, null),
    hedgeOpenQty: num(row.hedge_open_qty),
    hedgeCloseQty: num(row.hedge_close_qty),
    coverage: parseJsonSafe(row.coverage_json, null),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const INSERT_COLUMNS = `orchestrator_id, seq, status, accuracy,
       position_identifier, pool_address, protected_pool_id, policy_version,
       opened_at, open_price, range_lower_price, range_upper_price,
       open_value_usd, open_amount0, open_amount1, open_reason, open_tx_hashes_json,
       closed_at, close_price, close_value_usd, close_reason, close_tx_hashes_json,
       accounting_json, baseline_accounting_json, hedge_baseline_json,
       shadow_baselines_json, lp_baseline_snapshot_json,
       hedge_open_qty, hedge_close_qty, coverage_json, created_at, updated_at`;

function insertParams(orchestratorId, s, now) {
  return [
    orchestratorId,
    s.status || 'open',
    s.accuracy || 'exact',
    s.positionIdentifier != null ? String(s.positionIdentifier) : null,
    s.poolAddress ?? null,
    s.protectedPoolId ?? null,
    s.policyVersion ?? null,
    s.openedAt ?? now,
    s.openPrice ?? null,
    s.rangeLowerPrice ?? null,
    s.rangeUpperPrice ?? null,
    s.openValueUsd ?? null,
    s.openAmount0 ?? null,
    s.openAmount1 ?? null,
    s.openReason ?? null,
    toJson(s.openTxHashes ?? null),
    s.closedAt ?? null,
    s.closePrice ?? null,
    s.closeValueUsd ?? null,
    s.closeReason ?? null,
    toJson(s.closeTxHashes ?? null),
    toJson(s.accounting || {}),
    toJson(s.baselineAccounting || {}),
    toJson(s.hedgeBaseline ?? null),
    toJson(s.shadowBaselines ?? null),
    toJson(s.lpBaselineSnapshot ?? null),
    s.hedgeOpenQty ?? null,
    s.hedgeCloseQty ?? null,
    toJson(s.coverage ?? null),
    now,
  ];
}

// $1 = orchestrator_id; seq se calcula en la misma sentencia; el resto $2..$30.
const INSERT_SQL = `INSERT INTO lp_orchestrator_segments (${INSERT_COLUMNS})
     VALUES (
       $1,
       (SELECT COALESCE(MAX(seq), 0) + 1 FROM lp_orchestrator_segments WHERE orchestrator_id = $1),
       $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
       $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $30
     )
     RETURNING *`;

async function create(input, executor) {
  const now = Date.now();
  const { rows } = await exec(executor).query(
    INSERT_SQL,
    insertParams(input.orchestratorId, { ...input, status: 'open', closedAt: null }, now)
  );
  return mapRow(rows[0]);
}

async function getActive(orchestratorId, executor) {
  const { rows } = await exec(executor).query(
    `SELECT * FROM lp_orchestrator_segments
      WHERE orchestrator_id = $1 AND status IN ('open','closing')
      LIMIT 1`,
    [orchestratorId]
  );
  return mapRow(rows[0]);
}

async function getById(orchestratorId, segmentId, executor) {
  const { rows } = await exec(executor).query(
    `SELECT * FROM lp_orchestrator_segments WHERE orchestrator_id = $1 AND id = $2`,
    [orchestratorId, segmentId]
  );
  return mapRow(rows[0]);
}

async function listByOrchestrator(orchestratorId, executor) {
  const { rows } = await exec(executor).query(
    `SELECT * FROM lp_orchestrator_segments WHERE orchestrator_id = $1 ORDER BY seq DESC`,
    [orchestratorId]
  );
  return rows.map(mapRow);
}

async function markClosing(segmentId, { at = Date.now() } = {}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE lp_orchestrator_segments
        SET status = 'closing', closing_started_at = $2, updated_at = $3
      WHERE id = $1 AND status = 'open'
      RETURNING id`,
    [segmentId, at, Date.now()]
  );
  return rows[0]?.id ?? null;
}

async function reopen(segmentId, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE lp_orchestrator_segments
        SET status = 'open', closing_started_at = NULL, updated_at = $2
      WHERE id = $1 AND status = 'closing'
      RETURNING id`,
    [segmentId, Date.now()]
  );
  return rows[0]?.id ?? null;
}

async function close(segmentId, {
  closedAt = Date.now(),
  closePrice,
  closeValueUsd,
  closeReason,
  closeTxHashes,
  accounting,
  hedgeCloseQty,
  coverage,
} = {}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE lp_orchestrator_segments
        SET status = 'closed',
            closed_at = $2,
            close_price = $3,
            close_value_usd = $4,
            close_reason = $5,
            close_tx_hashes_json = $6,
            accounting_json = COALESCE($7, accounting_json),
            hedge_close_qty = $8,
            coverage_json = COALESCE($9, coverage_json),
            updated_at = $10
      WHERE id = $1 AND status IN ('open','closing')
      RETURNING id`,
    [
      segmentId,
      closedAt,
      closePrice ?? null,
      closeValueUsd ?? null,
      closeReason ?? null,
      toJson(closeTxHashes ?? null),
      toJson(accounting ?? null),
      hedgeCloseQty ?? null,
      toJson(coverage ?? null),
      Date.now(),
    ]
  );
  return rows[0]?.id ?? null;
}

/**
 * Pone el motivo real al cierre de un tramo que se cortó como `unknown`
 * (reconciliación antes de que llegara el finalize). Solo toca `unknown`.
 */
async function relabelClose(segmentId, { closeReason, closeTxHashes } = {}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE lp_orchestrator_segments
        SET close_reason = $2,
            close_tx_hashes_json = COALESCE($3, close_tx_hashes_json),
            updated_at = $4
      WHERE id = $1 AND status = 'closed' AND close_reason = 'unknown'
      RETURNING id`,
    [segmentId, closeReason, toJson(closeTxHashes ?? null), Date.now()]
  );
  return rows[0]?.id ?? null;
}

/**
 * Motivo y hashes de apertura de un tramo abierto sin hashes (por el corte
 * de una reconciliación). No pisa una apertura que ya tenga hashes.
 */
async function relabelOpen(segmentId, { openReason, openTxHashes } = {}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE lp_orchestrator_segments
        SET open_reason = COALESCE($2, open_reason),
            open_tx_hashes_json = $3,
            updated_at = $4
      WHERE id = $1 AND status IN ('open','closing')
        AND (open_tx_hashes_json IS NULL OR open_tx_hashes_json IN ('null','[]'))
      RETURNING id`,
    [segmentId, openReason ?? null, toJson(openTxHashes ?? null), Date.now()]
  );
  return rows[0]?.id ?? null;
}

/**
 * Sustituye el historico sembrado (cerrado, open_reason deploy/backfill/backfill_diff) por
 * `segments` y renumera `seq` de todos los tramos por orden temporal. Nunca
 * toca el tramo vivo. Debe ejecutarse dentro de una transaccion.
 */
async function replaceHistorical(orchestratorId, segments, executor) {
  const q = exec(executor);
  await q.query(
    `DELETE FROM lp_orchestrator_segments
      WHERE orchestrator_id = $1
        AND status = 'closed'
        AND accuracy = 'approximate'
        AND open_reason IN ('deploy','backfill','backfill_diff')`,
    [orchestratorId]
  );
  const now = Date.now();
  for (const s of segments || []) {
    await q.query(
      INSERT_SQL,
      insertParams(orchestratorId, { ...s, status: 'closed', accuracy: s.accuracy || 'approximate' }, now)
    );
  }
  // Renumera en dos pasos para no chocar con UNIQUE (orchestrator_id, seq).
  await q.query(
    `UPDATE lp_orchestrator_segments SET seq = -seq WHERE orchestrator_id = $1`,
    [orchestratorId]
  );
  await q.query(
    `UPDATE lp_orchestrator_segments t
        SET seq = r.n
       FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY opened_at ASC, id ASC) AS n
           FROM lp_orchestrator_segments WHERE orchestrator_id = $1
       ) r
      WHERE t.id = r.id`,
    [orchestratorId]
  );
}

module.exports = {
  mapRow,
  create,
  getActive,
  getById,
  listByOrchestrator,
  markClosing,
  reopen,
  close,
  relabelClose,
  relabelOpen,
  replaceHistorical,
};
