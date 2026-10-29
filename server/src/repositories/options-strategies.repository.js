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

/**
 * Máximo y mínimo de la prima durante la posición: las muestras guardadas
 * más el precio de salida al cerrar (TP, vencimiento, ejercicio…), que no
 * se muestrea. Ante un empate gana el instante más temprano. null sin
 * registro (posiciones previas al muestreo sin snapshots).
 */
function premiumRange(row) {
  if (!row.premium_range_source) return null;
  const points = [];
  if (row.premium_high != null) points.push({ price: Number(row.premium_high), at: Number(row.premium_high_at) });
  if (row.premium_low != null) points.push({ price: Number(row.premium_low), at: Number(row.premium_low_at) });
  if (row.closed_at != null && row.exit_price != null) {
    points.push({ price: Number(row.exit_price), at: Number(row.closed_at) });
  }
  if (!points.length) return null;
  const pick = (better) => points.reduce((a, b) => (better(b.price, a.price) || (b.price === a.price && b.at < a.at) ? b : a));
  return {
    high: pick((x, y) => x > y),
    low: pick((x, y) => x < y),
    partial: row.premium_range_source !== 'full',
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
    // Desglose (NULL en cerradas históricas, sin reparto fiable).
    entryFeeUsdt: numberOrNull(row.entry_fee_usdt),
    exitFeeUsdt: numberOrNull(row.exit_fee_usdt),
    exerciseFeeUsdt: numberOrNull(row.exercise_fee_usdt),
    closeReason: row.close_reason || null,
    tpTargetPrice: numberOrNull(row.tp_target_price),
    tpTargetMeta: parseJson(row.tp_target_meta, null),
    premiumRange: premiumRange(row),
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
    feesUsdt: numberOrNull(row.fees_usdt),
    feesEstimated: row.fees_estimated === true,
    createdAt: Number(row.created_at),
  };
}

const TRADED_DECISIONS = ['opened', 'closed', 'reversed'];
const FINAL_DECISIONS = ['opened', 'closed', 'reversed', 'ignored', 'error'];

function normalizeUnderlying(underlying) {
  const u = String(underlying ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(u)) throw new Error('Invalid underlying');
  return u;
}

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

  /**
   * Guarda el estado del runner. `blockedUnderlyings` NUNCA sale de aquí:
   * el runner escribe copias en memoria que pueden ser anteriores a un
   * bloqueo (`setUnderlyingBlock`); se conserva siempre el de la fila.
   */
  async function setState(id, state) {
    await db.query(
      `UPDATE options_strategies
          SET state = $2::jsonb || jsonb_build_object('blockedUnderlyings',
                COALESCE(state->'blockedUnderlyings', '{}'::jsonb))
        WHERE id = $1`,
      [id, JSON.stringify(state || {})]
    );
  }

  /**
   * Bloquea un subyacente del bot: `state.blockedUnderlyings[U] = { reason, at }`.
   * La fusión se hace en SQL para no perder claves escritas en paralelo
   * (p. ej. `lastReasons`) ni otros subyacentes bloqueados.
   */
  async function setUnderlyingBlock(strategyId, underlying, { reason, at } = {}) {
    const u = normalizeUnderlying(underlying);
    const { rows } = await db.query(
      `UPDATE options_strategies
          SET state = jsonb_set(
                COALESCE(state, '{}'::jsonb), '{blockedUnderlyings}',
                CASE WHEN jsonb_typeof(state->'blockedUnderlyings') = 'object'
                     THEN state->'blockedUnderlyings' ELSE '{}'::jsonb END
                  || jsonb_build_object($2::text, jsonb_build_object('reason', $3::text, 'at', $4::bigint)),
                true)
        WHERE id = $1
        RETURNING *`,
      [strategyId, u, reason == null ? null : String(reason), at ?? now()]
    );
    return rows[0] ? mapStrategy(rows[0]) : null;
  }

  async function clearUnderlyingBlock(strategyId, underlying) {
    const u = normalizeUnderlying(underlying);
    const { rows } = await db.query(
      `UPDATE options_strategies
          SET state = jsonb_set(state, '{blockedUnderlyings}', (state->'blockedUnderlyings') - $2::text)
        WHERE id = $1 AND jsonb_typeof(state->'blockedUnderlyings') = 'object'
        RETURNING *`,
      [strategyId, u]
    );
    return rows[0] ? mapStrategy(rows[0]) : null;
  }

  async function deleteStrategy(userId, id) {
    const { rowCount } = await db.query('DELETE FROM options_strategies WHERE id = $1 AND user_id = $2', [id, userId]);
    return rowCount > 0;
  }

  // ---------- posiciones ----------

  /** Una apertura solo paga la entrada: `entry_fee_usdt = fees_usdt`. */
  async function insertPosition({ strategyId, userId, mode, symbol, side, quantity, entryPrice, openedAt, feesUsdt = 0 }) {
    const { rows } = await db.query(
      `INSERT INTO options_strategy_positions
         (strategy_id, user_id, mode, symbol, side, quantity, entry_price, opened_at, fees_usdt, entry_fee_usdt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
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

  /**
   * Cierra una posición abierta. `feesUsdt` es el total; `entryFeeUsdt`,
   * `exitFeeUsdt` y `exerciseFeeUsdt` su desglose (entrada ausente: se
   * conserva la guardada).
   */
  async function closePosition(id, { exitPrice, closedAt, pnlUsdt, feesUsdt, closeReason = null,
    entryFeeUsdt = null, exitFeeUsdt = null, exerciseFeeUsdt = null }) {
    const { rows } = await db.query(
      `UPDATE options_strategy_positions
          SET exit_price = $2, closed_at = $3, pnl_usdt = $4, fees_usdt = $5, close_reason = $6,
              entry_fee_usdt = COALESCE($7::numeric, entry_fee_usdt),
              exit_fee_usdt = $8, exercise_fee_usdt = $9
        WHERE id = $1 AND closed_at IS NULL
        RETURNING *`,
      [id, exitPrice, closedAt ?? now(), pnlUsdt, feesUsdt, closeReason,
        entryFeeUsdt, exitFeeUsdt, exerciseFeeUsdt]
    );
    return rows[0] ? mapPosition(rows[0]) : null;
  }

  /**
   * Suma una muestra de la prima al rango de una posición abierta. El SET de
   * Postgres lee los valores previos de la fila, así que cada instante se
   * compara con el extremo anterior; los empates conservan el más temprano.
   */
  async function recordPremiumSample(id, price, at) {
    const { rowCount } = await db.query(
      `UPDATE options_strategy_positions
          SET premium_high_at = CASE WHEN premium_high IS NULL OR $2 > premium_high THEN $3 ELSE premium_high_at END,
              premium_high = GREATEST(premium_high, $2),
              premium_low_at = CASE WHEN premium_low IS NULL OR $2 < premium_low THEN $3 ELSE premium_low_at END,
              premium_low = LEAST(premium_low, $2)
        WHERE id = $1 AND closed_at IS NULL`,
      [id, price, at]
    );
    return rowCount === 1;
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

  /**
   * Resultado definitivo de una señal con su comisión. A diferencia de
   * `finishAutoSignal`, sobrescribe 'pending' y también el 'opened'
   * provisional (p. ej. una entrada en sombra que al final caduca).
   * `feesUsdt`/`feesEstimated` ausentes conservan el valor guardado.
   */
  async function resolveAutoSignal(id, { decision, detail, feesUsdt, feesEstimated } = {}) {
    if (!FINAL_DECISIONS.includes(decision)) throw new Error('Invalid signal decision');
    const { rows } = await db.query(
      `UPDATE options_auto_signals
          SET decision = $2, detail = $3,
              fees_usdt = COALESCE($4::numeric, fees_usdt),
              fees_estimated = COALESCE($5::boolean, fees_estimated)
        WHERE id = $1 AND decision IN ('pending','opened')
        RETURNING *`,
      [id, decision, detail ?? null, feesUsdt ?? null, feesEstimated ?? null]
    );
    return rows[0] ? mapAutoSignal(rows[0]) : null;
  }

  async function setAutoSignalFees(id, { feesUsdt, feesEstimated } = {}) {
    const { rows } = await db.query(
      `UPDATE options_auto_signals SET fees_usdt = $2, fees_estimated = $3
        WHERE id = $1 AND decision = 'pending' RETURNING *`,
      [id, feesUsdt ?? null, feesEstimated === true]
    );
    return rows[0] ? mapAutoSignal(rows[0]) : null;
  }

  /** `filter`: 'all' | 'traded' (abrió, cerró o dio la vuelta) | 'ignored'. */
  async function listAutoSignals(strategyId, { limit = 100, filter = 'all' } = {}) {
    let decisions = null;
    if (filter === 'traded') decisions = TRADED_DECISIONS;
    else if (filter === 'ignored') decisions = ['ignored'];
    // «Operadas» = señales reales: las simuladas solo aparecen en «Todas».
    const { rows } = await db.query(
      `SELECT * FROM options_auto_signals
        WHERE strategy_id = $1 AND ($3::text[] IS NULL OR decision = ANY($3::text[]))
          AND NOT ($4::boolean AND simulated)
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [strategyId, limit, decisions, filter === 'traded']
    );
    return rows.map(mapAutoSignal);
  }

  /** Última señal real (no simulada) de cada bot del usuario. */
  async function lastAutoSignalsByUser(userId) {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (strategy_id) * FROM options_auto_signals
        WHERE user_id = $1 AND NOT simulated
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
    resolveAutoSignal,
    setAutoSignalFees,
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
    setUnderlyingBlock,
    clearUnderlyingBlock,
    deleteStrategy,
    insertPosition,
    recordPremiumSample,
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
