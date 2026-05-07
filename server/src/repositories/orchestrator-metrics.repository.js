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

async function getSummariesForOrchestrators(orchestratorIds, executor) {
  const ids = [...new Set((orchestratorIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0))];

  if (!ids.length) return new Map();

  const { rows } = await exec(executor).query(
    `WITH requested AS (
       SELECT unnest($1::int[]) AS orchestrator_id
     )
     SELECT
       requested.orchestrator_id,
       first_snap.id AS first_id,
       first_snap.captured_at AS first_captured_at,
       first_snap.wallet_usd AS first_wallet_usd,
       first_snap.lp_usd AS first_lp_usd,
       first_snap.hl_account_usd AS first_hl_account_usd,
       first_snap.total_usd AS first_total_usd,
       latest_snap.id AS latest_id,
       latest_snap.captured_at AS latest_captured_at,
       latest_snap.wallet_usd AS latest_wallet_usd,
       latest_snap.lp_usd AS latest_lp_usd,
       latest_snap.hl_account_usd AS latest_hl_account_usd,
       latest_snap.total_usd AS latest_total_usd
     FROM requested
     LEFT JOIN LATERAL (
       SELECT *
         FROM orchestrator_metrics_snapshots
        WHERE orchestrator_id = requested.orchestrator_id
        ORDER BY captured_at ASC
        LIMIT 1
     ) first_snap ON TRUE
     LEFT JOIN LATERAL (
       SELECT *
         FROM orchestrator_metrics_snapshots
        WHERE orchestrator_id = requested.orchestrator_id
        ORDER BY captured_at DESC
        LIMIT 1
     ) latest_snap ON TRUE`,
    [ids]
  );

  const summaries = new Map();
  for (const row of rows) {
    const firstTotalUsd = row.first_total_usd != null ? Number(row.first_total_usd) : null;
    const latestTotalUsd = row.latest_total_usd != null ? Number(row.latest_total_usd) : null;
    const deltaUsd = firstTotalUsd != null && latestTotalUsd != null
      ? latestTotalUsd - firstTotalUsd
      : null;
    const deltaPct = deltaUsd != null && firstTotalUsd > 0
      ? (deltaUsd / firstTotalUsd) * 100
      : null;

    summaries.set(Number(row.orchestrator_id), {
      first: row.first_id != null ? {
        id: Number(row.first_id),
        capturedAt: Number(row.first_captured_at),
        walletUsd: row.first_wallet_usd != null ? Number(row.first_wallet_usd) : null,
        lpUsd: row.first_lp_usd != null ? Number(row.first_lp_usd) : null,
        hlAccountUsd: row.first_hl_account_usd != null ? Number(row.first_hl_account_usd) : null,
        totalUsd: firstTotalUsd,
      } : null,
      current: row.latest_id != null ? {
        id: Number(row.latest_id),
        capturedAt: Number(row.latest_captured_at),
        walletUsd: row.latest_wallet_usd != null ? Number(row.latest_wallet_usd) : null,
        lpUsd: row.latest_lp_usd != null ? Number(row.latest_lp_usd) : null,
        hlAccountUsd: row.latest_hl_account_usd != null ? Number(row.latest_hl_account_usd) : null,
        totalUsd: latestTotalUsd,
      } : null,
      deltaUsd,
      deltaPct,
    });
  }

  return summaries;
}

module.exports = {
  insertSnapshot,
  listSnapshots,
  getLatest,
  getSummariesForOrchestrators,
};
