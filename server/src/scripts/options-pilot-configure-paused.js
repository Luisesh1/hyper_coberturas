/**
 * ONE-TIME SETUP: tighten user #1 risk limits and prepare one PAUSED ETH
 * alert strategy. Never submits/cancels orders, or activates live bots.
 *
 * Must be invoked with --apply-paused-only after CI and a safe deploy.
 * Changes are atomic under a PostgreSQL per-user advisory lock.
 * No existing strategy is changed or removed.
 */
const dbDefault = require('../db');
const { validateParams } = require('../services/options/templates/alert-signal');
const { strategyFits, globalFits } = require('./options-pilot-strategy-readiness');

const USER_ID = 1;
const MARKER = 'PILOTO ETH - compra unica - PAUSADO';
const TARGET_LIMITS = Object.freeze({
  maxMarginUsdt: 1, maxDailyLossUsdt: 1, maxLiveStrategies: 1,
  notifyTelegram: true,
});
const BOT_LIMITS = Object.freeze({
  maxOrdersPerDay: 3, maxDailyLossUsdt: 1, maxMarginUsdt: 1,
});
const BOT_PARAMS = Object.freeze({
  alertIds: [], structure: 'buy_with', targetDelta: 0.35,
  expiryDays: 7, quantity: 0.01, contractCount: 1,
  capitalUsdt: 0.26, maxPremiumUsdt: 0.26,
  onOpposite: 'close', takeProfitMode: 'fixed',
  takeProfitPct: 50, stopLossPct: 50, exitHoursBeforeExpiry: 24,
  maxOpenPositions: 1, maxTradesPerDay: 1,
});

function assertTradingOff(env) {
  if (env.OPTIONS_LIVE_TRADING_ENABLED !== 'false' ||
      env.OPTIONS_LIVE_PRODUCTION_APPROVED !== 'false' ||
      env.OPTIONS_LIVE_PILOT_AUTHORIZED === 'true') {
    throw new Error('Paused pilot setup requires all live order controls OFF');
  }
}

function safeStoredLimits(raw) {
  if (raw === null || raw === undefined) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); }
    catch (_) { throw new Error('Invalid stored limits'); }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Invalid stored limits');
  }
  for (const key of ['maxMarginUsdt', 'maxDailyLossUsdt', 'maxLiveStrategies']) {
    if (obj[key] !== undefined &&
        (!Number.isFinite(Number(obj[key])) || Number(obj[key]) < 0)) {
      throw new Error('Invalid stored risk limit');
    }
  }
  return obj;
}
function tightenedLimits(previous) {
  const raw = safeStoredLimits(previous) || {};
  const bounded = name => raw[name] === undefined ? TARGET_LIMITS[name] :
    Math.min(Number(raw[name]), TARGET_LIMITS[name]);
  return {
    ...raw,
    maxMarginUsdt: bounded('maxMarginUsdt'),
    maxDailyLossUsdt: bounded('maxDailyLossUsdt'),
    maxLiveStrategies: 1,
    notifyTelegram: true,
  };
}
function parseStored(raw) {
  if (typeof raw === 'string') return JSON.parse(raw);
  return raw;
}
function paramsMatch(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(b);
  return Object.keys(a).length === keys.length &&
    keys.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

async function applyPausedSetup({ db = dbDefault, env = process.env, now = Date.now } = {}) {
  assertTradingOff(env);
  const params = validateParams(BOT_PARAMS);
  if (params.alertIds.length !== 0 || params.onOpposite !== 'close' ||
      params.structure !== 'buy_with') {
    throw new Error('Unsafe template defaults');
  }
  const at = now();
  return db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock($1,$2)', [760218, USER_ID]);
    const { rows: users } = await tx.query(
      'SELECT id FROM users WHERE id=$1 AND active=true LIMIT 1', [USER_ID]
    );
    if (users.length !== 1) throw new Error('Target account unavailable');
    const { rows: liveBots } = await tx.query(
      "SELECT id FROM options_strategies WHERE user_id=$1 AND mode='live' LIMIT 1",
      [USER_ID]
    );
    const { rows: livePos } = await tx.query(
      "SELECT id FROM options_strategy_positions WHERE user_id=$1 AND mode='live' AND closed_at IS NULL LIMIT 1",
      [USER_ID]
    );
    const { rows: orderAttempts } = await tx.query(
      'SELECT id FROM options_live_orders WHERE user_id=$1 LIMIT 1', [USER_ID]
    );
    if (liveBots.length || livePos.length || orderAttempts.length) {
      throw new Error('Existing live exposure, live bot or order history; NO MUTATION');
    }

    const { rows: records } = await tx.query(
      'SELECT id,name,template,underlying,params,limits,mode FROM options_strategies WHERE user_id=$1',
      [USER_ID]
    );
    const ours = records.filter(x => x.name === MARKER);
    if (ours.length > 1) throw new Error('Duplicate pilot marker; abort');
    let strategyId;
    let created = false;
    if (ours.length) {
      const s = ours[0];
      if (s.mode !== 'paused' || s.template !== 'alert_signal' ||
          s.underlying !== 'ETH' ||
          !paramsMatch(parseStored(s.params), params) ||
          !paramsMatch(parseStored(s.limits), BOT_LIMITS)) {
        throw new Error('Pilot marker changed; refuse to overwrite');
      }
      strategyId = Number(s.id);
    } else {
      const { rows: inserted } = await tx.query(
        "INSERT INTO options_strategies (user_id,name,template,underlying,params,limits,mode,state,created_at,updated_at) " +
        "VALUES ($1,$2,'alert_signal','ETH',$3,$4,'paused','{}'::jsonb,$5,$5) RETURNING id",
        [USER_ID, MARKER, JSON.stringify(params), JSON.stringify(BOT_LIMITS), at]
      );
      if (inserted.length !== 1) throw new Error('Pilot insertion failed');
      strategyId = Number(inserted[0].id);
      created = true;
    }
    if (!Number.isSafeInteger(strategyId) || strategyId <= 0 ||
        !strategyFits({
          id: strategyId, userId: USER_ID, underlying: 'ETH',
          template: 'alert_signal', mode: 'paused', params, limits: BOT_LIMITS,
        })) throw new Error('Pilot strategy does not satisfy safety gates');

    const { rows: settings } = await tx.query(
      "SELECT value FROM settings WHERE user_id=$1 AND key='options_limits'",
      [USER_ID]
    );
    const prior = settings.length ? settings[0].value : null;
    const next = tightenedLimits(prior);
    if (!globalFits(next)) throw new Error('Global limits failed postcondition');
    const mustWrite = !settings.length ||
      JSON.stringify(safeStoredLimits(prior)) !== JSON.stringify(next);
    if (mustWrite) {
      await tx.query(
        "INSERT INTO settings(user_id,key,value,updated_at) " +
        "VALUES ($1,'options_limits',$2,$3) ON CONFLICT(user_id,key) " +
        "DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at",
        [USER_ID, JSON.stringify(next), at]
      );
    }
    return {
      status: 'prepared_paused', created, strategyId,
      limitsRestricted: true, ordersSent: 0, liveEnabled: false,
      preexistingStrategiesPreserved: records.length,
    };
  });
}
function outputLines(result) {
  if (result?.status !== 'prepared_paused' ||
      !Number.isSafeInteger(result.strategyId) || result.strategyId <= 0 ||
      result.limitsRestricted !== true || result.liveEnabled !== false ||
      result.ordersSent !== 0 ||
      !Number.isSafeInteger(result.preexistingStrategiesPreserved) ||
      typeof result.created !== 'boolean') {
    throw new Error('Unexpected pilot setup result');
  }
  return [
    'pilot_setup_status=prepared_paused',
    'pilot_setup_strategy_id=' + result.strategyId,
    'pilot_setup_strategy_mode=paused',
    'pilot_setup_global_risk=pass',
    'pilot_setup_existing_strategies_preserved=' + result.preexistingStrategiesPreserved,
    'pilot_setup_created=' + (result.created ? 'yes' : 'no'),
    'pilot_setup_orders_sent=0',
    'pilot_setup_live_enabled=no',
    'pilot_ready=no',
  ];
}
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply-paused-only') {
    throw new Error('Explicit paused-only setup argument required');
  }
  const result = await applyPausedSetup();
  for (const line of outputLines(result)) console.log(line);
}
if (require.main === module) {
  main().catch(() => {
    // Never log private settings, credentials or DB records.
    console.log('pilot_setup_status=unavailable');
    process.exitCode = 1;
  }).finally(() => dbDefault.pool.end());
}
module.exports = { assertTradingOff, safeStoredLimits, tightenedLimits,
  paramsMatch, applyPausedSetup, outputLines, MARKER, TARGET_LIMITS,
  BOT_LIMITS, BOT_PARAMS };
