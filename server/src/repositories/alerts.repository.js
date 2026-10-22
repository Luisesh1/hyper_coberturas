const db = require('../db');

async function listByUser(userId) {
  const { rows } = await db.query(
    `SELECT * FROM alerts WHERE user_id = $1 ORDER BY updated_at DESC, id DESC`,
    [userId]
  );
  return rows;
}

async function listAllActive() {
  const { rows } = await db.query(
    `SELECT * FROM alerts WHERE is_active = true ORDER BY id`
  );
  return rows;
}

async function getById(userId, alertId) {
  const { rows } = await db.query(
    `SELECT * FROM alerts WHERE user_id = $1 AND id = $2`,
    [userId, alertId]
  );
  return rows[0] || null;
}

async function create(userId, payload) {
  const { rows } = await db.query(
    `INSERT INTO alerts (
       user_id, name, is_active, threshold_percent, asset_list_json, rules_json,
       telegram_enabled, cooldown_seconds, datasource, created_at, updated_at,
       direction
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)
     RETURNING *`,
    [
      userId,
      payload.name,
      payload.isActive,
      payload.thresholdPercent,
      payload.assetListJson,
      payload.rulesJson,
      payload.telegramEnabled,
      payload.cooldownSeconds,
      payload.datasource,
      payload.now,
      payload.direction || 'neutral',
    ]
  );
  return rows[0];
}

async function update(userId, alertId, payload) {
  const { rows } = await db.query(
    `UPDATE alerts SET
        name              = $3,
        is_active         = $4,
        threshold_percent = $5,
        asset_list_json   = $6,
        rules_json        = $7,
        telegram_enabled  = $8,
        cooldown_seconds  = $9,
        datasource        = $10,
        updated_at        = $11,
        direction         = $12
      WHERE user_id = $1 AND id = $2
      RETURNING *`,
    [
      userId,
      alertId,
      payload.name,
      payload.isActive,
      payload.thresholdPercent,
      payload.assetListJson,
      payload.rulesJson,
      payload.telegramEnabled,
      payload.cooldownSeconds,
      payload.datasource,
      payload.now,
      payload.direction || 'neutral',
    ]
  );
  return rows[0] || null;
}

async function remove(userId, alertId) {
  const { rowCount } = await db.query(
    'DELETE FROM alerts WHERE user_id = $1 AND id = $2',
    [userId, alertId]
  );
  return rowCount > 0;
}

async function updateCooldown(alertId, asset, ts) {
  await db.query(
    `UPDATE alerts
        SET last_triggered_at_json = jsonb_set(last_triggered_at_json, ARRAY[$2::text], to_jsonb($3::bigint), true)
      WHERE id = $1`,
    [alertId, asset, ts]
  );
}

async function recordEvent(payload) {
  const { rows } = await db.query(
    `INSERT INTO alert_events (
       alert_id, user_id, asset, timeframe, candle_close_time, score,
       threshold_percent, matched_rules_json, message_text, telegram_sent,
       telegram_error, created_at, direction
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      payload.alertId,
      payload.userId,
      payload.asset,
      payload.timeframe,
      payload.candleCloseTime,
      payload.score,
      payload.thresholdPercent,
      payload.matchedRulesJson,
      payload.messageText,
      payload.telegramSent,
      payload.telegramError,
      payload.now,
      payload.direction || null,
    ]
  );
  return rows[0];
}

async function markEventTelegramResult(eventId, sent, errorText) {
  await db.query(
    `UPDATE alert_events SET telegram_sent = $2, telegram_error = $3 WHERE id = $1`,
    [eventId, sent, errorText || null]
  );
}

async function listEventsForAlert(userId, alertId, { limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM alert_events
      WHERE user_id = $1 AND alert_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [userId, alertId, Math.min(500, Math.max(1, Number(limit) || 50))]
  );
  return rows;
}

/**
 * Disparos históricos con dirección de unas alertas, para el backtest de bots.
 * Descarta los neutrales (o sin dirección) y los de activos cuyo subyacente
 * de opciones no sea `underlying`. Devuelve [{ t, direction, alertId }]
 * ordenado por created_at (ms).
 */
async function listAlertSignals({ userId, alertIds, underlying, from, to }) {
  const ids = [...new Set((alertIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT alert_id, asset, created_at, direction FROM alert_events
      WHERE user_id = $1 AND alert_id = ANY($2::int[])
        AND created_at >= $3 AND created_at <= $4
        AND direction IN ('bullish', 'bearish')
      ORDER BY created_at, id`,
    [userId, ids, from, to]
  );
  // Perezoso: el servicio de bots carga dependencias de opciones.
  // eslint-disable-next-line global-require
  const { assetToUnderlying } = require('../services/options/options-auto-trading.service');
  return rows
    .filter((r) => (r.direction === 'bullish' || r.direction === 'bearish')
      && assetToUnderlying(r.asset) === underlying)
    .map((r) => ({ t: Number(r.created_at), direction: r.direction, alertId: Number(r.alert_id) }))
    .sort((a, b) => a.t - b.t);
}

module.exports = {
  create,
  listAlertSignals,
  getById,
  listByUser,
  listAllActive,
  listEventsForAlert,
  markEventTelegramResult,
  recordEvent,
  remove,
  update,
  updateCooldown,
};
