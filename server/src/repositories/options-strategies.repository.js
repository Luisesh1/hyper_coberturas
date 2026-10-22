/**
 * Estrategias de opciones, sus posiciones (sombra/real) y su registro de
 * eventos. Spec: docs/superpowers/specs/2026-10-14-options-module-design.md
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

const numberOrNull = (value) => (value == null ? null : Number(value));

function mapStrategy(row) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    name: row.name,
    template: row.template,
    underlying: row.underlying,
    params: parseJson(row.params, {}),
    limits: parseJson(row.limits, {}),
    mode: row.mode,
    state: parseJson(row.state, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapPosition(row) {
  return {
    id: Number(row.id),
    strategyId: Number(row.strategy_id),
    userId: Number(row.user_id),
    mode: row.mode,
    symbol: row.symbol,
    side: row.side,
    quantity: Number(row.quantity),
    entryPrice: Number(row.entry_price),
    exitPrice: numberOrNull(row.exit_price),
    openedAt: Number(row.opened_at),
    closedAt: numberOrNull(row.closed_at),
    pnlUsdt: numberOrNull(row.pnl_usdt),
    feesUsdt: Number(row.fees_usdt || 0),
    closeReason: row.close_reason || null,
    tpTargetPrice: numberOrNull(row.tp_target_price),
    tpTargetMeta: parseJson(row.tp_target_meta, null),
  };
}

function mapEvent(row) {
  return {
    id: Number(row.id),
    strategyId: Number(row.strategy_id),
    mode: row.mode,
    action: row.action,
    detail: row.detail || null,
    legs: parseJson(row.legs, null),
    premiumUsdt: numberOrNull(row.premium_usdt),
    createdAt: Number(row.created_at),
  };
}

function mapAutoSignal(row) {
  return {
    id: Number(row.id),
    strategyId: Number(row.strategy_id),
    alertId: numberOrNull(row.alert_id),
    alertEventId: numberOrNull(row.alert_event_id),
    alertName: row.alert_name || null,
    direction: row.direction || null,
    asset: row.asset || null,
    score: numberOrNull(row.score),
    decision: row.decision,
    detail: row.detail || null,
    simulated: row.simulated === true,
    createdAt: Number(row.created_at),
  };
}

const TRADED_DECISIONS = ['opened', 'closed', 'reversed'];

function createOptionsStrategiesRepository({ db = defaultDb, now = Date.now } = {}) {
  // ---------- estrategias ----------

  async function createStrategy({ userId, name, template, underlying, params, limits, mode = 'paused' }) {
    const at = now();
    const { rows } = await db.query(
      `INSERT INTO options_strategies (user_id, name, template, underlying, params, limits, mode, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8, $8)
       RETURNING *`,
      [userId, name, template, underlying, JSON.stringify(params || {}), JSON.stringify(limits || {}), mode, at]
    );
    return mapStrategy(rows[0]);
  }

  async function getStrategy(userId, id) {
    const { rows } = await db.query('SELECT * FROM options_strategies WHERE id = $1 AND user_id = $2', [id, userId]);
    return rows[0] ? mapStrategy(rows[0]) : null;
  }

  async function getStrategyById(id) {
    const { rows } = await db.query('SELECT * FROM options_strategies WHERE id = $1', [id]);
    return rows[0] ? mapStrategy(rows[0]) : null;
  }

  async function listStrategies(userId) {
    const { rows } = await db.query('SELECT * FROM options_strategies WHERE user_id = $1 ORDER BY id', [userId]);
    return rows.map(mapStrategy);
  }

  async function listActiveStrategies() {
    const { rows } = await db.query(
      "SELECT * FROM options_strategies WHERE mode IN ('shadow', 'live') ORDER BY id"
    );
    return rows.map(mapStrategy);
  }

  /** Bots `alert_signal` del usuario que no están en pausa. */
  async function listActiveAlertBots(userId) {
    const { rows } = await db.query(
      `SELECT * FROM options_strategies
        WHERE user_id = $1 AND template = 'alert_signal' AND mode IN ('shadow', 'live')
        ORDER BY id`,
      [userId]
    );
    return rows.map(mapStrategy);
  }

  async function countLiveStrategies(userId, excludeId = null) {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM options_strategies
        WHERE user_id = $1 AND mode = 'live' AND ($2::bigint IS NULL OR id <> $2)`,
      [userId, excludeId]
    );
    return Number(rows[0]?.n || 0);
  }

  async function updateStrategy(userId, id, { name, underlying, params, limits }) {
    const { rows } = await db.query(
      `UPDATE options_strategies
          SET name = COALESCE($3, name),
              underlying = COALESCE($4, underlying),
              params = COALESCE($5, params),
              limits = COALESCE($6, limits),
              updated_at = $7
        WHERE id = $1 AND user_id = $2
        RETURNING *`,
      [
        id,
        userId,
        name ?? null,
        underlying ?? null,
        params ? JSON.stringify(params) : null,
        limits ? JSON.stringify(limits) : null,
        now(),
      ]
    );
    return rows[0] ? mapStrategy(rows[0]) : null;
  }

  async function setMode(userId, id, mode) {
    const { rows } = await db.query(
      'UPDATE options_strategies SET mode = $3, updated_at = $4 WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, userId, mode, now()]
    );
    return rows[0] ? mapStrategy(rows[0]) : null;
  }

  async function setState(id, state) {
    await db.query('UPDATE options_strategies SET state = $2 WHERE id = $1', [id, JSON.stringify(state || {})]);
  }

  async function deleteStrategy(userId, id) {
    const { rowCount } = await db.query('DELETE FROM options_strategies WHERE id = $1 AND user_id = $2', [id, userId]);
    return rowCount > 0;
  }

  // ---------- posiciones ----------

  async function insertPosition({ strategyId, userId, mode, symbol, side, quantity, entryPrice, openedAt, feesUsdt = 0 }) {
    const { rows } = await db.query(
      `INSERT INTO options_strategy_positions
         (strategy_id, user_id, mode, symbol, side, quantity, entry_price, opened_at, fees_usdt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [strategyId, userId, mode, symbol, side, quantity, entryPrice, openedAt ?? now(), feesUsdt]
    );
    return mapPosition(rows[0]);
  }

  /**
   * Fija el objetivo de venta (banda ATR) SOLO si sigue vacío: una vez
   * escrito no se recalcula. Devuelve la fila guardada (la de quien ganó).
   */
  async function setTpTarget(id, price, meta) {
    const { rows } = await db.query(
      `UPDATE options_strategy_positions
          SET tp_target_price = $2, tp_target_meta = $3::jsonb
        WHERE id = $1 AND tp_target_price IS NULL
        RETURNING *`,
      [id, price, JSON.stringify(meta ?? null)]
    );
    if (rows[0]) return mapPosition(rows[0]);
    const { rows: current } = await db.query('SELECT * FROM options_strategy_positions WHERE id = $1', [id]);
    return current[0] ? mapPosition(current[0]) : null;
  }

  /** Cierra una posición abierta. `feesUsdt` es el total (entrada + salida). */
  async function closePosition(id, { exitPrice, closedAt, pnlUsdt, feesUsdt, closeReason = null }) {
    const { rows } = await db.query(
      `UPDATE options_strategy_positions
          SET exit_price = $2, closed_at = $3, pnl_usdt = $4, fees_usdt = $5, close_reason = $6
        WHERE id = $1 AND closed_at IS NULL
        RETURNING *`,
      [id, exitPrice, closedAt ?? now(), pnlUsdt, feesUsdt, closeReason]
    );
    return rows[0] ? mapPosition(rows[0]) : null;
  }

  async function listOpenPositions(strategyId, mode) {
    const { rows } = await db.query(
      `SELECT * FROM options_strategy_positions
        WHERE strategy_id = $1 AND mode = $2 AND closed_at IS NULL
        ORDER BY id`,
      [strategyId, mode]
    );
    return rows.map(mapPosition);
  }

  async function listOpenPositionsByUser(userId, mode) {
    const { rows } = await db.query(
      `SELECT * FROM options_strategy_positions
        WHERE user_id = $1 AND mode = $2 AND closed_at IS NULL
        ORDER BY id`,
      [userId, mode]
    );
    return rows.map(mapPosition);
  }

  async function listAllOpenPositions() {
    const { rows } = await db.query('SELECT * FROM options_strategy_positions WHERE closed_at IS NULL ORDER BY id');
    return rows.map(mapPosition);
  }

  async function listPositions(strategyId, { limit = 5000 } = {}) {
    const { rows } = await db.query(
      'SELECT * FROM options_strategy_positions WHERE strategy_id = $1 ORDER BY opened_at, id LIMIT $2',
      [strategyId, limit]
    );
    return rows.map(mapPosition);
  }

  async function lastOpenedAt(strategyId, mode) {
    const { rows } = await db.query(
      'SELECT MAX(opened_at) AS at FROM options_strategy_positions WHERE strategy_id = $1 AND mode = $2',
      [strategyId, mode]
    );
    return numberOrNull(rows[0]?.at);
  }

  /** PnL realizado desde `since`, por estrategia o por usuario (strategyId null). */
  async function realizedPnlSince({ userId, strategyId = null, mode, since }) {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(pnl_usdt), 0) AS pnl FROM options_strategy_positions
        WHERE user_id = $1 AND mode = $2 AND closed_at >= $3
          AND ($4::bigint IS NULL OR strategy_id = $4)`,
      [userId, mode, since, strategyId]
    );
    return Number(rows[0]?.pnl || 0);
  }

  /** PnL realizado desde `since` agrupado por estrategia y modo, para un usuario. */
  async function pnlByStrategySince(userId, since) {
    const { rows } = await db.query(
      `SELECT strategy_id, mode, COALESCE(SUM(pnl_usdt), 0) AS pnl
         FROM options_strategy_positions
        WHERE user_id = $1 AND closed_at >= $2
        GROUP BY strategy_id, mode`,
      [userId, since]
    );
    return rows.map((r) => ({ strategyId: Number(r.strategy_id), mode: r.mode, pnlUsdt: Number(r.pnl) }));
  }

  async function openCountsByStrategy(userId) {
    const { rows } = await db.query(
      `SELECT strategy_id, mode, COUNT(*)::int AS n
         FROM options_strategy_positions
        WHERE user_id = $1 AND closed_at IS NULL
        GROUP BY strategy_id, mode`,
      [userId]
    );
    return rows.map((r) => ({ strategyId: Number(r.strategy_id), mode: r.mode, count: Number(r.n) }));
  }

  // ---------- eventos ----------

  async function insertEvent({ strategyId, userId, mode, action, detail = null, legs = null, premiumUsdt = null, createdAt }) {
    const { rows } = await db.query(
      `INSERT INTO options_strategy_events
         (strategy_id, user_id, mode, action, detail, legs, premium_usdt, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [strategyId, userId, mode, action, detail, legs ? JSON.stringify(legs) : null, premiumUsdt, createdAt ?? now()]
    );
    return mapEvent(rows[0]);
  }

  async function listEvents(strategyId, { limit = 100 } = {}) {
    const { rows } = await db.query(
      `SELECT * FROM options_strategy_events WHERE strategy_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [strategyId, limit]
    );
    return rows.map(mapEvent);
  }

  /** Último evento de cada estrategia del usuario (para el estado en el listado). */
  async function lastEventsByUser(userId) {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (strategy_id) * FROM options_strategy_events
        WHERE user_id = $1
        ORDER BY strategy_id, created_at DESC, id DESC`,
      [userId]
    );
    return rows.map(mapEvent);
  }

  /** Eventos de una acción (`open`, `close`…) desde `since`, por estrategia y modo. */
  async function countEventsSince(strategyId, mode, action, since) {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM options_strategy_events
        WHERE strategy_id = $1 AND mode = $2 AND action = $3 AND created_at >= $4`,
      [strategyId, mode, action, since]
    );
    return Number(rows[0]?.n || 0);
  }

  /**
   * Órdenes enviadas desde `since`: patas con `orderId` en eventos open/close
   * (las liquidaciones al vencimiento no llevan `orderId`).
   */
  async function countOrdersSince(strategyId, mode, since) {
    if (mode === 'live') {
      const { rows } = await db.query(
        "SELECT COUNT(*)::int AS n FROM options_live_orders WHERE strategy_id=$1 AND created_at >= $2 AND status<>'queued'",
        [strategyId, since]
      );
      return Number(rows[0]?.n || 0);
    }
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n
         FROM options_strategy_events ev
         CROSS JOIN LATERAL jsonb_array_elements(ev.legs) AS leg
        WHERE ev.strategy_id = $1 AND ev.mode = $2 AND ev.action IN ('open', 'close')
          AND ev.legs IS NOT NULL AND jsonb_typeof(ev.legs) = 'array'
          AND leg ? 'orderId' AND ev.created_at >= $3`,
      [strategyId, mode, since]
    );
    return Number(rows[0]?.n || 0);
  }

  // ---------- señales de los bots por alertas ----------

  /**
   * Reserva el procesamiento de un disparo para un bot. Devuelve la fila, o
   * null si ese `alertEventId` ya se procesó (índice único por bot y evento).
   */
  async function claimAutoSignal({ strategyId, userId, alertId, alertEventId, alertName, direction, asset, score, decision, detail = null, simulated = false, createdAt }) {
    const { rows } = await db.query(
      `INSERT INTO options_auto_signals
         (strategy_id, user_id, alert_id, alert_event_id, alert_name, direction, asset, score, decision, detail, simulated, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (strategy_id, alert_event_id) DO NOTHING
       RETURNING *`,
      [strategyId, userId, alertId ?? null, alertEventId ?? null, alertName ?? null, direction ?? null, asset ?? null, score ?? null, decision, detail, simulated === true, createdAt ?? now()]
    );
    return rows[0] ? mapAutoSignal(rows[0]) : null;
  }

  async function finishAutoSignal(id, { decision, detail }) {
    const { rows } = await db.query(
      `UPDATE options_auto_signals SET decision = $2, detail = $3
       WHERE id = $1
         AND (decision = 'pending' OR $2 IN ('opened', 'closed', 'reversed'))
       RETURNING *`,
      [id, decision, detail ?? null]
    );
    return rows[0] ? mapAutoSignal(rows[0]) : null;
  }

  /** `filter`: 'all' | 'traded' (abrió, cerró o dio la vuelta) | 'ignored'. */
  async function listAutoSignals(strategyId, { limit = 100, filter = 'all' } = {}) {
    let decisions = null;
    if (filter === 'traded') decisions = TRADED_DECISIONS;
    else if (filter === 'ignored') decisions = ['ignored'];
    const { rows } = await db.query(
      `SELECT * FROM options_auto_signals
        WHERE strategy_id = $1 AND ($3::text[] IS NULL OR decision = ANY($3::text[]))
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [strategyId, limit, decisions]
    );
    return rows.map(mapAutoSignal);
  }

  /** Última señal de cada bot del usuario. */
  async function lastAutoSignalsByUser(userId) {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (strategy_id) * FROM options_auto_signals
        WHERE user_id = $1
        ORDER BY strategy_id, created_at DESC, id DESC`,
      [userId]
    );
    return rows.map(mapAutoSignal);
  }

  return {
    createStrategy,
    listActiveAlertBots,
    countEventsSince,
    claimAutoSignal,
    finishAutoSignal,
    listAutoSignals,
    lastAutoSignalsByUser,
    getStrategy,
    getStrategyById,
    listStrategies,
    listActiveStrategies,
    countLiveStrategies,
    updateStrategy,
    setMode,
    setState,
    deleteStrategy,
    insertPosition,
    setTpTarget,
    closePosition,
    listOpenPositions,
    listOpenPositionsByUser,
    listAllOpenPositions,
    listPositions,
    lastOpenedAt,
    realizedPnlSince,
    pnlByStrategySince,
    openCountsByStrategy,
    insertEvent,
    listEvents,
    lastEventsByUser,
    countOrdersSince,
  };
}

module.exports = createOptionsStrategiesRepository();
module.exports.createOptionsStrategiesRepository = createOptionsStrategiesRepository;
