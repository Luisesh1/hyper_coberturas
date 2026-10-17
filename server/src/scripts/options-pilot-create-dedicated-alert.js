/**
 * Create an independent ETH bullish alert for the supervised OPTIONS pilot.
 * Clone existing alert rules without changing the source alert. The new alert
 * has the 7..14 day option-expiry window and no duplicate Telegram messages.
 * Bind it ONLY to the already paused pilot strategy, with trading flags OFF.
 * One-time controlled release / independent no-write verification.
 */
'use strict';

const dbDefault = require('../db');
const { BOT_PARAMS, BOT_LIMITS, MARKER, paramsMatch } =
  require('./options-pilot-configure-paused');
const { globalFits, strategyFits } = require('./options-pilot-strategy-readiness');
const { validateParams } = require('../services/options/templates/alert-signal');
const { assetToUnderlying } =
  require('../services/options/options-auto-trading.service');

const USER_ID = 1;
const ALERT_MARKER = 'PILOTO ETH Opciones - senal exclusiva 7-14 dias';
const EXPECTED_PARAMS = validateParams(BOT_PARAMS);
const REASONS = new Set(['none','global_limits','strategy_not_paused',
  'live_activity','strategy_mismatch','source_alert_invalid',
  'source_alert_ambiguous','duplicate_pilot_alert','clone_modified',
  'binding_changed','no_dedicated_alert','concurrent_update']);
const STATES = new Set(['created_and_bound','already_bound','verified','blocked']);

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const x = JSON.parse(value);
    return x && typeof x === 'object' && !Array.isArray(x) ? x : null;
  } catch { return null; }
}
function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const x = JSON.parse(value);
    return Array.isArray(x) ? x : null;
  } catch { return null; }
}
function flagsOff(env) {
  return env.OPTIONS_LIVE_TRADING_ENABLED === 'false' &&
    env.OPTIONS_LIVE_PRODUCTION_APPROVED === 'false' &&
    env.OPTIONS_LIVE_PILOT_AUTHORIZED !== 'true';
}
function eligibleSource(row) {
  const assets = parseArray(row?.asset_list_json);
  const rules = parseArray(row?.rules_json);
  const ethAsset = assets?.find(x => assetToUnderlying(x) === 'ETH');
  const threshold = Number(row?.threshold_percent);
  const cooldown = Number(row?.cooldown_seconds);
  return row?.is_active === true &&
    row?.direction === 'bullish' && !!ethAsset &&
    Array.isArray(rules) && rules.length > 0 &&
    Number.isFinite(threshold) && threshold >= 0 && threshold <= 100 &&
    Number.isInteger(cooldown) && cooldown >= 0 &&
    ['binance','hyperliquid','yahoo'].includes(row?.datasource);
}
function expectedClone(source) {
  if (!eligibleSource(source)) return null;
  const asset = parseArray(source.asset_list_json)
    .find(x => assetToUnderlying(x) === 'ETH');
  return {
    userId: USER_ID,
    name: ALERT_MARKER,
    isActive: true,
    threshold: Number(source.threshold_percent),
    assetList: [asset],
    rules: parseArray(source.rules_json),
    telegramEnabled: false,
    cooldown: Number(source.cooldown_seconds),
    datasource: source.datasource,
    direction: 'bullish',
    minDays: 7,
    maxDays: 14,
  };
}
function cloneMatches(row, expected) {
  if (!row || !expected) return false;
  return Number(row.user_id) === expected.userId &&
    row.name === expected.name && row.is_active === expected.isActive &&
    Number(row.threshold_percent) === expected.threshold &&
    JSON.stringify(parseArray(row.asset_list_json)) === JSON.stringify(expected.assetList) &&
    JSON.stringify(parseArray(row.rules_json)) === JSON.stringify(expected.rules) &&
    row.telegram_enabled === false &&
    Number(row.cooldown_seconds) === expected.cooldown &&
    row.datasource === expected.datasource &&
    row.direction === expected.direction &&
    Number(row.option_expiry_min_days) === expected.minDays &&
    Number(row.option_expiry_max_days) === expected.maxDays;
}
const blocked = reason => ({ status:'blocked', reason, ordersSent:0,
  originalPreserved:true, paused:true, expiry:'unverified' });

async function apply({ db=dbDefault, env=process.env, now=Date.now, verifyOnly=false }={}) {
  if (!flagsOff(env)) throw new Error('Trading flags must be OFF');
  return db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(760218, $1::int)', [USER_ID]);
    const [{rows:strategies},{rows:positions},{rows:orders},{rows:settings}] =
      await Promise.all([
        tx.query('SELECT * FROM options_strategies WHERE user_id=$1 FOR UPDATE',[USER_ID]),
        tx.query("SELECT id FROM options_strategy_positions WHERE user_id=$1 AND mode='live' AND closed_at IS NULL LIMIT 1",[USER_ID]),
        tx.query('SELECT id FROM options_live_orders WHERE user_id=$1 LIMIT 1',[USER_ID]),
        tx.query("SELECT value FROM settings WHERE user_id=$1 AND key='options_limits' FOR UPDATE",[USER_ID]),
      ]);
    if (positions.length || orders.length || strategies.some(s=>s.mode==='live')) return blocked('live_activity');
    if (settings.length !== 1 || !globalFits(parseObject(settings[0].value)))
      return blocked('global_limits');
    const own = strategies.filter(s=>s.name===MARKER && s.template==='alert_signal' &&
      s.underlying==='ETH' && s.mode==='paused');
    if (own.length !== 1) return blocked('strategy_not_paused');
    const s = own[0], params = parseObject(s.params), limits=parseObject(s.limits);
    if (!params || !limits ||
        !Array.isArray(params.alertIds) || params.alertIds.length !== 1 ||
        !paramsMatch({...params,alertIds:[]},EXPECTED_PARAMS) ||
        !paramsMatch(limits,BOT_LIMITS) ||
        !strategyFits({id:Number(s.id),userId:USER_ID,mode:s.mode,
          template:s.template,underlying:s.underlying,params,limits}))
      return blocked('strategy_mismatch');

    const {rows:alerts} = await tx.query(
      'SELECT * FROM alerts WHERE user_id=$1 FOR UPDATE',[USER_ID]);
    const named = alerts.filter(a=>a.name===ALERT_MARKER);
    if (named.length > 1) return blocked('duplicate_pilot_alert');
    const clone = named[0] || null;
    // The original is the current linked alert before the first run, and
    // the sole eligible non-pilot ETH source on later idempotent runs.
    const sources = alerts.filter(a=>a.name!==ALERT_MARKER && eligibleSource(a));
    if (sources.length !== 1) return blocked(
      sources.length===0?'source_alert_invalid':'source_alert_ambiguous');
    const source=sources[0];
    const expected=expectedClone(source);
    if (!expected) return blocked('source_alert_invalid');
    if (clone && !cloneMatches(clone,expected)) return blocked('clone_modified');

    const boundId=Number(params.alertIds[0]);
    if (clone && boundId===Number(clone.id)) {
      return {status:verifyOnly?'verified':'already_bound',reason:'none',
        ordersSent:0,originalPreserved:true,paused:true,expiry:'7_14'};
    }
    if (verifyOnly) return blocked('no_dedicated_alert');
    if (boundId!==Number(source.id)) return blocked('binding_changed');

    let dedicatedId=clone && Number(clone.id);
    if (!clone) {
      const {rows:inserted} = await tx.query(
        'INSERT INTO alerts (user_id,name,is_active,threshold_percent,asset_list_json,rules_json,' +
        'telegram_enabled,cooldown_seconds,datasource,direction,option_expiry_min_days,' +
        'option_expiry_max_days,created_at,updated_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING id',
        [USER_ID,ALERT_MARKER,true,expected.threshold,
          JSON.stringify(expected.assetList),JSON.stringify(expected.rules),
          false,expected.cooldown,expected.datasource,'bullish',7,14,now()]);
      if (inserted.length!==1 || !Number.isSafeInteger(Number(inserted[0].id)))
        throw new Error('Dedicated alert insertion did not complete');
      dedicatedId=Number(inserted[0].id);
    }
    const {rows:updated} = await tx.query(
      "UPDATE options_strategies SET params=jsonb_set(params,'{alertIds}',$3::jsonb,true)," +
      " updated_at=$4 WHERE id=$1 AND user_id=$2 AND mode='paused' " +
      "AND params->'alertIds'=$5::jsonb RETURNING id",
      [Number(s.id),USER_ID,JSON.stringify([dedicatedId]),now(),
        JSON.stringify([boundId])]);
    if (updated.length!==1) throw new Error('Concurrent strategy update, transaction rolled back');
    return {status:'created_and_bound',reason:'none',ordersSent:0,
      originalPreserved:true,paused:true,expiry:'7_14'};
  });
}

function summaryLines(r) {
  if (!r || !STATES.has(r.status) || !REASONS.has(r.reason) ||
    r.ordersSent!==0 || r.originalPreserved!==true || r.paused!==true ||
    !['7_14','unverified'].includes(r.expiry) ||
    (r.status==='blocked' && r.reason==='none') ||
    (r.status!=='blocked' && (r.reason!=='none' || r.expiry!=='7_14')))
    throw new Error('Unsafe pilot alert cloning result');
  return [
    'pilot_dedicated_alert_status='+r.status,
    'pilot_dedicated_alert_reason='+r.reason,
    'pilot_dedicated_alert_expiry='+r.expiry,
    'pilot_dedicated_alert_source_untouched=yes',
    'pilot_dedicated_alert_telegram_duplication=off',
    'pilot_dedicated_alert_strategy_mode=paused',
    'pilot_dedicated_alert_orders_sent=0',
    'pilot_dedicated_alert_trading_enabled=no',
    'pilot_ready=no',
  ];
}

async function main() {
  const args=process.argv.slice(2);
  if (args.length!==1 ||
      !['--create-paused-only','--verify-only'].includes(args[0]))
    throw new Error('Explicit paused-only or verify-only argument required');
  const r=await apply({verifyOnly:args[0]==='--verify-only'});
  summaryLines(r).forEach(line=>console.log(line));
}
if (require.main===module) {
  main().catch(()=>{
    console.log('pilot_dedicated_alert_status=unavailable');
    console.log('pilot_dedicated_alert_orders_sent=0');
    console.log('pilot_ready=no');
    process.exitCode=1;
  }).finally(()=>dbDefault.pool.end());
}

module.exports={flagsOff,eligibleSource,expectedClone,cloneMatches,apply,summaryLines,
  ALERT_MARKER};
