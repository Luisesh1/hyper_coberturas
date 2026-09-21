const db = require('../db');

function exec(executor) {
  return executor || db;
}

const COLUMNS = `
  id,
  protected_pool_id AS "protectedPoolId",
  alert_type        AS "alertType",
  severity,
  episode_started_at AS "episodeStartedAt",
  message,
  details_json      AS "details",
  resolved_at       AS "resolvedAt",
  created_at        AS "createdAt"
`;

/**
 * Registra un escalon de un episodio. Un episodio (`episodeStartedAt`) puede
 * producir varias filas — una por severidad — y eso es deliberado: interesa
 * saber cuando cruzo cada umbral, no solo el estado final.
 */
async function create(payload, executor) {
  const { rows } = await exec(executor).query(
    `INSERT INTO hedge_alerts (
       protected_pool_id, alert_type, severity, episode_started_at,
       message, details_json, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      payload.protectedPoolId,
      payload.alertType,
      payload.severity,
      payload.episodeStartedAt,
      payload.message ?? null,
      payload.details ? JSON.stringify(payload.details) : null,
      payload.createdAt ?? Date.now(),
    ]
  );
  return rows[0]?.id || null;
}

/**
 * Cierra el episodio completo (todos sus escalones). Idempotente: vuelve a
 * llamarse en cada tick sano y no hace nada si ya estaba cerrado.
 */
async function resolveEpisode({ protectedPoolId, alertType, episodeStartedAt, resolvedAt }, executor) {
  const { rowCount } = await exec(executor).query(
    `UPDATE hedge_alerts
        SET resolved_at = $4
      WHERE protected_pool_id = $1
        AND alert_type = $2
        AND episode_started_at = $3
        AND resolved_at IS NULL`,
    [protectedPoolId, alertType, episodeStartedAt, resolvedAt ?? Date.now()]
  );
  return rowCount;
}

/** Cierra cualquier episodio abierto de ese tipo, sin conocer su inicio. */
async function resolveOpenByType({ protectedPoolId, alertType, resolvedAt }, executor) {
  const { rowCount } = await exec(executor).query(
    `UPDATE hedge_alerts
        SET resolved_at = $3
      WHERE protected_pool_id = $1
        AND alert_type = $2
        AND resolved_at IS NULL`,
    [protectedPoolId, alertType, resolvedAt ?? Date.now()]
  );
  return rowCount;
}

async function listOpen({ limit = 100 } = {}, executor) {
  const { rows } = await exec(executor).query(
    `SELECT ${COLUMNS}
       FROM hedge_alerts
      WHERE resolved_at IS NULL
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Resumen para el health check: cuantos episodios abiertos hay y cual es la
 * severidad mas alta. Cuenta EPISODIOS, no filas, para que un episodio que
 * escalo tres veces no se lea como tres problemas.
 */
async function summarizeOpen(executor) {
  const { rows } = await exec(executor).query(
    `SELECT severity, count(DISTINCT (protected_pool_id, alert_type, episode_started_at)) AS episodes
       FROM hedge_alerts
      WHERE resolved_at IS NULL
      GROUP BY severity`
  );
  const bySeverity = { warning: 0, high: 0, critical: 0 };
  for (const row of rows) {
    if (row.severity in bySeverity) bySeverity[row.severity] = Number(row.episodes) || 0;
  }
  const worst = bySeverity.critical > 0 ? 'critical'
    : bySeverity.high > 0 ? 'high'
      : bySeverity.warning > 0 ? 'warning'
        : null;
  return {
    bySeverity,
    worstSeverity: worst,
    openEpisodes: bySeverity.warning + bySeverity.high + bySeverity.critical,
  };
}

module.exports = {
  create,
  resolveEpisode,
  resolveOpenByType,
  listOpen,
  summarizeOpen,
};
