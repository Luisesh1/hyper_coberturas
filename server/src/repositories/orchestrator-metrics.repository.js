/**
 * orchestrator-metrics.repository.js
 *
 * CRUD + queries para los snapshots horarios de metricas agregadas por
 * orquestador (wallet + LP + HL). Alimenta la pagina /metricas.
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

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    orchestratorId: Number(row.orchestrator_id),
    capturedAt: Number(row.captured_at),
    walletUsd: row.wallet_usd != null ? Number(row.wallet_usd) : null,
    lpUsd: row.lp_usd != null ? Number(row.lp_usd) : null,
    hlAccountUsd: row.hl_account_usd != null ? Number(row.hl_account_usd) : null,
    totalUsd: Number(row.total_usd),
    breakdown: parseJsonSafe(row.breakdown_json, null),
    createdAt: Number(row.created_at),
  };
}

async function insertSnapshot(entry, executor) {
  const { rows } = await exec(executor).query(
    `INSERT INTO orchestrator_metrics_snapshots (
       orchestrator_id, captured_at, wallet_usd, lp_usd, hl_account_usd,
       total_usd, breakdown_json
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      entry.orchestratorId,
      entry.capturedAt || Date.now(),
      entry.walletUsd ?? null,
      entry.lpUsd ?? null,
      entry.hlAccountUsd ?? null,
      entry.totalUsd,
      entry.breakdown ? JSON.stringify(entry.breakdown) : null,
    ]
  );
  return mapRow(rows[0]);
}

async function listSnapshots(orchestratorId, { startAt, endAt, limit = 5000 } = {}, executor) {
  const params = [orchestratorId];
  let where = 'orchestrator_id = $1';

  if (startAt != null) {
    params.push(Number(startAt));
    where += ` AND captured_at >= $${params.length}`;
  }
  if (endAt != null) {
    params.push(Number(endAt));
    where += ` AND captured_at <= $${params.length}`;
  }

  params.push(Math.min(Number(limit) || 5000, 20_000));
  const { rows } = await exec(executor).query(
    `SELECT *
       FROM orchestrator_metrics_snapshots
      WHERE ${where}
      ORDER BY captured_at ASC
      LIMIT $${params.length}`,
    params
  );
  return rows.map(mapRow);
}

async function getLatest(orchestratorId, executor) {
  const { rows } = await exec(executor).query(
    `SELECT *
       FROM orchestrator_metrics_snapshots
      WHERE orchestrator_id = $1
      ORDER BY captured_at DESC
      LIMIT 1`,
    [orchestratorId]
  );
  return mapRow(rows[0]);
}

module.exports = {
  insertSnapshot,
  listSnapshots,
  getLatest,
};
