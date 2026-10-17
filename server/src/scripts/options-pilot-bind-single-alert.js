/**
 * Vincula UNA alerta alcista ETH activa con el bot piloto #1 en PAUSA.
 * NO activa el bot, NO envía/cancela ordenes, NO cambia limites.
 * Script opt-in para una sola liberacion bajo los flags de trading OFF.
 */
'use strict';
const defaultDb = require('../db');
const { BOT_PARAMS, BOT_LIMITS, MARKER, paramsMatch } =
  require('./options-pilot-configure-paused');
const { strategyFits, globalFits } = require('./options-pilot-strategy-readiness');
const { assetToUnderlying } =
  require('../services/options/options-auto-trading.service');
const USER_ID = 1;

function parseObject(x) {
  if (x && typeof x === 'object' && !Array.isArray(x)) return x;
  if (typeof x !== 'string') return null;
  try {
    const parsed = JSON.parse(x);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}
function parseArray(x) {
  if (Array.isArray(x)) return x;
  if (typeof x !== 'string') return null;
  try {
    const parsed = JSON.parse(x);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function chooseOne(rows) {
  if (!Array.isArray(rows)) return null;
  const active = rows.filter(a => a?.is_active === true &&
    a.direction === 'bullish' &&
    Number.isSafeInteger(Number(a.id)) && Number(a.id) > 0 &&
    parseArray(a.asset_list_json)?.some(asset => assetToUnderlying(asset) === 'ETH') &&
    (parseArray(a.rules_json)?.length || 0) > 0 &&
    (a.option_expiry_min_days == null || Number(a.option_expiry_min_days) <= 7) &&
    (a.option_expiry_max_days == null || Number(a.option_expiry_max_days) >= 7));
  return active.length === 1 ? Number(active[0].id) : null;
}
function flagsOff(env) {
  return env.OPTIONS_LIVE_TRADING_ENABLED === 'false' &&
    env.OPTIONS_LIVE_PRODUCTION_APPROVED === 'false' &&
    env.OPTIONS_LIVE_PILOT_AUTHORIZED !== 'true';
}

async function apply({
  db = defaultDb, env = process.env, now = Date.now,
} = {}) {
  if (!flagsOff(env)) throw new Error('Pilot alert binding requires live OFF');
  return db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(760218, $1::int)', [USER_ID]);
    const { rows: strategies } = await tx.query(
      'SELECT * FROM options_strategies WHERE user_id=$1 FOR UPDATE',
      [USER_ID],
    );
    const { rows: positions } = await tx.query(
      "SELECT id FROM options_strategy_positions WHERE user_id=$1 AND mode='live' AND closed_at IS NULL LIMIT 1",
      [USER_ID],
    );
    const { rows: orders } = await tx.query(
      'SELECT id FROM options_live_orders WHERE user_id=$1 LIMIT 1',
      [USER_ID],
    );
    if (positions.length || orders.length || strategies.some(s => s.mode === 'live')) {
      throw new Error('Pilot user has live activity; no alert binding allowed');
    }
    const { rows: settings } = await tx.query(
      "SELECT value FROM settings WHERE user_id=$1 AND key='options_limits' FOR UPDATE",
      [USER_ID],
    );
    if (settings.length !== 1 || !globalFits(parseObject(settings[0].value))) {
      return { status: 'blocked', ordersSent: 0 };
    }
    const matches = strategies.filter(s =>
      s.name === MARKER && s.template === 'alert_signal' &&
      s.underlying === 'ETH' && s.mode === 'paused');
    if (matches.length !== 1) return { status: 'blocked', ordersSent: 0 };
    const strategy = matches[0];
    const params = parseObject(strategy.params);
    const limits = parseObject(strategy.limits);
    if (!params || !limits ||
      !paramsMatch({ ...params, alertIds: [] }, BOT_PARAMS) ||
      !paramsMatch(limits, BOT_LIMITS) ||
      !strategyFits({
        id: Number(strategy.id), userId: USER_ID, template: strategy.template,
        underlying: strategy.underlying, mode: strategy.mode,
        params, limits,
      })) return { status: 'blocked', ordersSent: 0 };

    const { rows: alertRows } = await tx.query(
      'SELECT id, is_active, direction, asset_list_json, rules_json, option_expiry_min_days, option_expiry_max_days FROM alerts WHERE user_id=$1 FOR UPDATE',
      [USER_ID],
    );
    const alertId = chooseOne(alertRows);
    if (!alertId) return { status: 'blocked', ordersSent: 0 };
    if (params.alertIds?.length === 1 &&
      Number(params.alertIds[0]) === alertId) {
      return { status: 'already_bound', ordersSent: 0 };
    }
    if (!Array.isArray(params.alertIds) || params.alertIds.length) {
      return { status: 'blocked', ordersSent: 0 };
    }
    const { rows: updated } = await tx.query(
      "UPDATE options_strategies SET params=jsonb_set(params, '{alertIds}', $2::jsonb, true), updated_at=$3 " +
      "WHERE id=$1 AND user_id=$4 AND mode='paused' AND params->'alertIds'='[]'::jsonb RETURNING id",
      [Number(strategy.id), JSON.stringify([alertId]), now(), USER_ID],
    );
    if (updated.length !== 1) throw new Error('Concurrent pilot alert change');
    return { status: 'bound', ordersSent: 0 };
  });
}

function summaryLines(outcome) {
  if (!outcome || !['bound','already_bound','blocked'].includes(outcome.status) ||
    outcome.ordersSent !== 0) throw new Error('Invalid pilot alert binding result');
  return [
    'pilot_alert_binding_status=' + outcome.status,
    'pilot_alert_binding_strategy_mode=paused',
    'pilot_alert_binding_orders_sent=0',
    'pilot_alert_binding_live_enabled=no',
    'pilot_ready=no',
  ];
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--bind-paused-only') {
    throw new Error('Explicit paused-only binding argument required');
  }
  summaryLines(await apply({})).forEach(line => console.log(line));
}
if (require.main === module) {
  main().catch(() => {
    console.log('pilot_alert_binding_status=unavailable');
    console.log('pilot_alert_binding_orders_sent=0');
    console.log('pilot_ready=no');
    process.exitCode = 1;
  }).finally(() => defaultDb.pool.end());
}
module.exports = { chooseOne, flagsOff, apply, summaryLines };
