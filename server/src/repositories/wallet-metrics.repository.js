/**
 * wallet-metrics.repository.js
 *
 * Wallets seguidas en /metricas y su serie horaria de valor total.
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

function num(value) {
  return value != null ? Number(value) : null;
}

function mapWallet(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    address: row.address,
    label: row.label || null,
    status: row.status,
    archivedAt: num(row.archived_at),
    lastOrchestratorAt: num(row.last_orchestrator_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapSnapshot(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    walletId: Number(row.tracked_wallet_id),
    capturedAt: Number(row.captured_at),
    totalUsd: Number(row.total_usd),
    tokensUsd: Number(row.tokens_usd),
    lpUsd: Number(row.lp_usd),
    hlUsd: Number(row.hl_usd),
    isPartial: row.is_partial === true,
    staleSources: parseJsonSafe(row.stale_sources, []),
  };
}

/**
 * Da de alta toda wallet (por usuario) que tenga algun orquestador, incluidos
 * los archivados, y reactiva las archivadas que recibieron un orquestador
 * despues de archivarse. Idempotente: se llama antes de cada captura y al
 * listar. Devuelve cuantas filas creo o actualizo.
 */
async function syncFromOrchestrators(executor) {
  const now = Date.now();
  const { rowCount } = await exec(executor).query(
    `WITH src AS (
       SELECT user_id, lower(wallet_address) AS address, MAX(created_at) AS last_at
         FROM lp_orchestrators
        WHERE wallet_address ~* '^0x[0-9a-f]{40}$'
        GROUP BY user_id, lower(wallet_address)
     )
     INSERT INTO tracked_wallets AS tw (
       user_id, address, status, last_orchestrator_at, created_at, updated_at
     )
     SELECT user_id, address, 'active', last_at, $1, $1 FROM src
     ON CONFLICT (user_id, address) DO UPDATE SET
       last_orchestrator_at = EXCLUDED.last_orchestrator_at,
       status = CASE
         WHEN tw.status = 'archived' AND EXCLUDED.last_orchestrator_at > tw.archived_at THEN 'active'
         ELSE tw.status END,
       archived_at = CASE
         WHEN tw.status = 'archived' AND EXCLUDED.last_orchestrator_at > tw.archived_at THEN NULL
         ELSE tw.archived_at END,
       updated_at = $1
     WHERE tw.last_orchestrator_at IS DISTINCT FROM EXCLUDED.last_orchestrator_at`,
    [now]
  );
  return { changed: rowCount || 0 };
}

async function listForUser(userId, { includeArchived = false } = {}, executor) {
  const { rows } = await exec(executor).query(
    `SELECT * FROM tracked_wallets
      WHERE user_id = $1 ${includeArchived ? '' : "AND status = 'active'"}
      ORDER BY status ASC, created_at ASC, id ASC`,
    [userId]
  );
  return rows.map(mapWallet);
}

async function getForUser(userId, id, executor) {
  const { rows } = await exec(executor).query(
    'SELECT * FROM tracked_wallets WHERE user_id = $1 AND id = $2',
    [userId, id]
  );
  if (!rows[0]) return null;
  return { ...mapWallet(rows[0]), lastDetail: parseJsonSafe(rows[0].last_detail, null) };
}

async function listActiveForCapture(executor) {
  const { rows } = await exec(executor).query(
    `SELECT * FROM tracked_wallets WHERE status = 'active' ORDER BY id ASC`
  );
  return rows.map((row) => ({ ...mapWallet(row), lastDetail: parseJsonSafe(row.last_detail, null) }));
}

async function setStatus(userId, id, status, executor) {
  const now = Date.now();
  const { rows } = await exec(executor).query(
    `UPDATE tracked_wallets
        SET status = $3,
            archived_at = CASE WHEN $3 = 'archived' THEN $4::BIGINT ELSE NULL END,
            updated_at = $4
      WHERE user_id = $1 AND id = $2
      RETURNING *`,
    [userId, id, status, now]
  );
  return mapWallet(rows[0]);
}

/** Guarda el punto de la serie y el desglose completo en una transaccion. */
async function saveCapture(walletId, snapshot, detail) {
  return db.transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO wallet_value_snapshots (
         tracked_wallet_id, captured_at, total_usd, tokens_usd, lp_usd, hl_usd,
         is_partial, stale_sources
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        walletId,
        snapshot.capturedAt,
        snapshot.totalUsd,
        snapshot.tokensUsd,
        snapshot.lpUsd,
        snapshot.hlUsd,
        snapshot.isPartial === true,
        JSON.stringify(snapshot.staleSources || []),
      ]
    );
    await client.query(
      'UPDATE tracked_wallets SET last_detail = $2, updated_at = $3 WHERE id = $1',
      [walletId, JSON.stringify(detail), Date.now()]
    );
    return mapSnapshot(rows[0]);
  });
}

async function getLatestCapturedAt(walletIds, executor) {
  if (!walletIds.length) return new Map();
  const { rows } = await exec(executor).query(
    `SELECT tracked_wallet_id, MAX(captured_at) AS last_at
       FROM wallet_value_snapshots
      WHERE tracked_wallet_id = ANY($1::int[])
      GROUP BY tracked_wallet_id`,
    [walletIds]
  );
  return new Map(rows.map((r) => [Number(r.tracked_wallet_id), Number(r.last_at)]));
}

/** Serie de varias wallets en una sola consulta (sin desglose detallado). */
async function listSnapshots(walletIds, { startAt = null, limitPerWallet = 20_000 } = {}, executor) {
  if (!walletIds.length) return [];
  const params = [walletIds];
  let where = 'tracked_wallet_id = ANY($1::int[])';
  if (startAt != null) {
    params.push(Number(startAt));
    where += ` AND captured_at >= $${params.length}`;
  }
  params.push(Math.min(Number(limitPerWallet) || 20_000, 20_000) * walletIds.length);
  const { rows } = await exec(executor).query(
    `SELECT * FROM wallet_value_snapshots
      WHERE ${where}
      ORDER BY captured_at ASC, id ASC
      LIMIT $${params.length}`,
    params
  );
  return rows.map(mapSnapshot);
}

/**
 * tokenIds v4 que la app conoce para una wallet en una red (protecciones,
 * incluidas las reemplazadas, y orquestadores). Respaldo del descubrimiento de
 * posiciones donde no hay indexador.
 */
async function listKnownV4PositionIds(address, network, executor) {
  const { rows } = await exec(executor).query(
    `SELECT position_identifier AS id FROM protected_uniswap_pools
      WHERE lower(wallet_address) = $1 AND network = $2 AND version = 'v4'
     UNION
     SELECT replaced_by_position_identifier FROM protected_uniswap_pools
      WHERE lower(wallet_address) = $1 AND network = $2 AND version = 'v4'
        AND replaced_by_position_identifier IS NOT NULL
     UNION
     SELECT active_position_identifier FROM lp_orchestrators
      WHERE lower(wallet_address) = $1 AND network = $2 AND version = 'v4'
        AND active_position_identifier IS NOT NULL`,
    [String(address).toLowerCase(), network]
  );
  return rows.map((r) => String(r.id)).filter((id) => /^\d+$/.test(id));
}

module.exports = {
  listKnownV4PositionIds,
  syncFromOrchestrators,
  listForUser,
  getForUser,
  listActiveForCapture,
  setStatus,
  saveCapture,
  getLatestCapturedAt,
  listSnapshots,
};
