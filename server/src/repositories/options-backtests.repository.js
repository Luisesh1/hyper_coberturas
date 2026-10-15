/**
 * Tareas de backtesting de opciones: se crean `queued`, pasan a `running` y
 * terminan `done` (con resultado) o `failed` (con error).
 */

const defaultDb = require('../db');

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapBacktest(row, { withResult = true } = {}) {
  const out = {
    id: Number(row.id),
    userId: Number(row.user_id),
    strategyId: row.strategy_id == null ? null : Number(row.strategy_id),
    config: parseJson(row.config, {}),
    status: row.status,
    error: row.error || null,
    createdAt: Number(row.created_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
  };
  if (withResult) out.result = parseJson(row.result, null);
  return out;
}

function createOptionsBacktestsRepository({ db = defaultDb, now = Date.now } = {}) {
  async function create({ userId, strategyId = null, config }) {
    const { rows } = await db.query(
      `INSERT INTO options_backtests (user_id, strategy_id, config, status, created_at)
       VALUES ($1, $2, $3, 'queued', $4) RETURNING *`,
      [userId, strategyId, JSON.stringify(config), now()]
    );
    return mapBacktest(rows[0]);
  }

  async function markRunning(id) {
    await db.query("UPDATE options_backtests SET status = 'running' WHERE id = $1", [id]);
  }

  async function finish(id, { status, result = null, error = null }) {
    const { rows } = await db.query(
      `UPDATE options_backtests SET status = $2, result = $3, error = $4, finished_at = $5
        WHERE id = $1 RETURNING *`,
      [id, status, result ? JSON.stringify(result) : null, error, now()]
    );
    return rows[0] ? mapBacktest(rows[0]) : null;
  }

  async function get(userId, id) {
    const { rows } = await db.query('SELECT * FROM options_backtests WHERE id = $1 AND user_id = $2', [id, userId]);
    return rows[0] ? mapBacktest(rows[0]) : null;
  }

  /** Listado sin el `result` completo (puede ser grande); incluye las métricas. */
  async function list(userId, { limit = 50 } = {}) {
    const { rows } = await db.query(
      `SELECT id, user_id, strategy_id, config, status, error, created_at, finished_at,
              result -> 'metrics' AS metrics
         FROM options_backtests WHERE user_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, limit]
    );
    return rows.map((row) => ({ ...mapBacktest(row, { withResult: false }), metrics: parseJson(row.metrics, null) }));
  }

  async function countPending(userId) {
    const { rows } = await db.query(
      "SELECT COUNT(*)::int AS n FROM options_backtests WHERE user_id = $1 AND status IN ('queued', 'running')",
      [userId]
    );
    return Number(rows[0]?.n || 0);
  }

  /** Al arrancar: lo que quedó en cola o corriendo murió con el proceso anterior. */
  async function failStale(message) {
    const { rowCount } = await db.query(
      `UPDATE options_backtests SET status = 'failed', error = $1, finished_at = $2
        WHERE status IN ('queued', 'running')`,
      [message, now()]
    );
    return rowCount || 0;
  }

  return { create, markRunning, finish, get, list, countPending, failStale };
}

module.exports = createOptionsBacktestsRepository();
module.exports.createOptionsBacktestsRepository = createOptionsBacktestsRepository;
