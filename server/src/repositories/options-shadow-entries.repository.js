/**
 * Entradas simuladas (modo sombra) de los bots por alertas: un LIMIT al
 * precio medio que espera la misma ventana que una orden real.
 * Spec: docs/superpowers/specs/2026-10-23-options-mid-gtc-entries-design.md
 */
const dbDefault = require('../db');

const FINAL_STATUSES = ['filled', 'expired', 'canceled'];
const numberOrNull = (value) => (value == null ? null : Number(value));

const mapEntry = (r) => ({
  id: Number(r.id),
  strategyId: Number(r.strategy_id),
  userId: Number(r.user_id),
  autoSignalId: numberOrNull(r.auto_signal_id),
  alertEventId: numberOrNull(r.alert_event_id),
  symbol: r.symbol,
  side: r.side,
  optionType: r.option_type,
  quantity: Number(r.quantity),
  limitPrice: Number(r.limit_price),
  spot: numberOrNull(r.spot),
  deadlineAt: Number(r.deadline_at),
  status: r.status,
  createdAt: Number(r.created_at),
  resolvedAt: numberOrNull(r.resolved_at),
});

function createOptionsShadowEntriesRepository({ db = dbDefault, now = Date.now } = {}) {
  async function insertEntry({ strategyId, userId, autoSignalId = null, alertEventId = null, symbol, side,
    optionType, quantity, limitPrice, spot = null, deadlineAt, createdAt }) {
    if (!['BUY', 'SELL'].includes(side) || !symbol || !optionType ||
        !(Number(quantity) > 0) || !(Number(limitPrice) > 0) || !Number.isFinite(Number(deadlineAt)) ||
        deadlineAt == null) {
      throw new Error('Invalid shadow entry');
    }
    const { rows } = await db.query(
      `INSERT INTO options_shadow_entries
         (strategy_id,user_id,auto_signal_id,alert_event_id,symbol,side,option_type,
          quantity,limit_price,spot,deadline_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [strategyId, userId, autoSignalId ?? null, alertEventId ?? null, symbol, side, optionType,
        quantity, limitPrice, spot ?? null, deadlineAt, createdAt ?? now()]
    );
    return mapEntry(rows[0]);
  }

  async function listPending({ strategyId = null } = {}) {
    const { rows } = await db.query(
      `SELECT * FROM options_shadow_entries
        WHERE status='pending' AND ($1::bigint IS NULL OR strategy_id=$1)
        ORDER BY created_at,id`,
      [strategyId ?? null]
    );
    return rows.map(mapEntry);
  }

  /** Pasa a un estado final SOLO desde 'pending': resolver dos veces no hace nada. */
  async function resolveEntry(id, status, at) {
    if (!FINAL_STATUSES.includes(status)) throw new Error('Invalid shadow entry status');
    const { rows } = await db.query(
      `UPDATE options_shadow_entries SET status=$2,resolved_at=$3
        WHERE id=$1 AND status='pending' RETURNING *`,
      [id, status, at ?? now()]
    );
    return rows[0] ? mapEntry(rows[0]) : null;
  }

  /** Cancela las pendientes de `ids`; las ya resueltas se ignoran. */
  async function cancelEntries(ids, at) {
    if (!Array.isArray(ids) || !ids.length) return [];
    const { rows } = await db.query(
      `UPDATE options_shadow_entries SET status='canceled',resolved_at=$2
        WHERE id=ANY($1::bigint[]) AND status='pending' RETURNING *`,
      [ids.map(Number), at ?? now()]
    );
    return rows.map(mapEntry);
  }

  return { insertEntry, listPending, resolveEntry, cancelEntries };
}

module.exports = createOptionsShadowEntriesRepository();
module.exports.createOptionsShadowEntriesRepository = createOptionsShadowEntriesRepository;
