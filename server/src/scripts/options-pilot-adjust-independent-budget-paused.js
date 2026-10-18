/**
 * One-time risk budget adjustment for the operator-approved, separate PAUSED
 * 7..14-day ETH CALL pilot. It DOES NOT activate options trading.
 *
 * Contract ETH-261030-2550-C, quantity 0.01, limit <=36.00: maximum premium
 * 0.36 USDT; 10% fee reserve makes a maximum 0.40 USDT (rounded to cents).
 * The original strategy and alert, global limits and existing exits are left
 * completely unchanged. No Binance POST/DELETE reachable.
 */
'use strict';

const dbDefault=require('../db');
const {BOT_PARAMS,BOT_LIMITS,MARKER:OLD_MARKER,paramsMatch}=
  require('./options-pilot-configure-paused');
const {BOT_MARKER}=require('./options-pilot-create-independent-paused');
const {ALERT_MARKER}=require('./options-pilot-create-dedicated-alert');
const {globalFits}=require('./options-pilot-strategy-readiness');
const {validateParams}=require('../services/options/templates/alert-signal');

const USER_ID=1;
const PREMIUM_MAX=0.36;
const CAPITAL_MAX=0.40;
const BASE_PARAMS=validateParams(BOT_PARAMS);
const NEW_PARAMS=validateParams({...BOT_PARAMS,
  maxPremiumUsdt:PREMIUM_MAX,capitalUsdt:CAPITAL_MAX});
const REASONS=new Set(['none','strategy_missing','strategy_changed',
  'original_strategy_unavailable','live_activity','global_limits',
  'alert_missing','alert_changed','unverified','postcondition_failed']);
const ALLOWED_STATUSES=new Set(['blocked','adjusted_paused','already_adjusted','verified']);

function parseObject(x){
  if(x && typeof x==='object' && !Array.isArray(x))return x;
  if(typeof x!=='string')return null;
  try{const o=JSON.parse(x);return o&&typeof o==='object'&&!Array.isArray(o)?o:null}
  catch{return null}
}
function tradingOff(env){
  return env.OPTIONS_LIVE_TRADING_ENABLED==='false' &&
    env.OPTIONS_LIVE_PRODUCTION_APPROVED==='false' &&
    env.OPTIONS_LIVE_PILOT_AUTHORIZED!=='true';
}
function exactParams(actual,expected){
  return Array.isArray(actual?.alertIds)&&actual.alertIds.length===1 &&
    Number.isSafeInteger(Number(actual.alertIds[0])) &&
    Number(actual.alertIds[0])>0 &&
    paramsMatch({...actual,alertIds:[]},{...expected,alertIds:[]});
}
function safeTemplate(s,params,limits,expected){
  return Number(s.user_id)===USER_ID &&
    s.name===BOT_MARKER && s.mode==='paused' &&
    s.template==='alert_signal' && s.underlying==='ETH' &&
    paramsMatch(limits,BOT_LIMITS) && exactParams(params,expected);
}
function safeAlert(alert,alertId){
  return alert && Number(alert.id)===alertId &&
    alert.name===ALERT_MARKER && alert.is_active===true &&
    alert.direction==='bullish' && alert.telegram_enabled===false &&
    Number(alert.option_expiry_min_days)===7 &&
    Number(alert.option_expiry_max_days)===14;
}
function blocked(reason){
  if(!REASONS.has(reason)||reason==='none')throw Error('Unsafe blocked reason');
  return {status:'blocked',reason,ordersSent:0,liveEnabled:false};
}

async function adjust({db=dbDefault,env=process.env,now=Date.now,verifyOnly=false}={}){
  if(!tradingOff(env))throw Error('All options live controls must be OFF');
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(760218,$1::int)',[USER_ID]);
    const {rows:strategies}=await tx.query(
      'SELECT * FROM options_strategies WHERE user_id=$1 FOR UPDATE',[USER_ID]);
    if(strategies.some(s=>s.mode==='live'))return blocked('live_activity');
    const {rows:open}=await tx.query(
      "SELECT id FROM options_strategy_positions WHERE user_id=$1 AND mode='live' AND closed_at IS NULL LIMIT 1",[USER_ID]);
    const {rows:orders}=await tx.query(
      'SELECT id FROM options_live_orders WHERE user_id=$1 LIMIT 1',[USER_ID]);
    if(open.length||orders.length)return blocked('live_activity');
    const {rows:settings}=await tx.query(
      "SELECT value FROM settings WHERE user_id=$1 AND key='options_limits' FOR UPDATE",[USER_ID]);
    if(settings.length!==1||!globalFits(parseObject(settings[0].value)))
      return blocked('global_limits');
    const source=strategies.filter(s=>s.name===OLD_MARKER);
    if(source.length!==1||source[0].mode!=='paused')
      return blocked('original_strategy_unavailable');
    const targets=strategies.filter(s=>s.name===BOT_MARKER);
    if(targets.length!==1)return blocked('strategy_missing');
    const strategy=targets[0],params=parseObject(strategy.params),
      limits=parseObject(strategy.limits);
    const isOriginal=safeTemplate(strategy,params,limits,BASE_PARAMS);
    const isUpdated=safeTemplate(strategy,params,limits,NEW_PARAMS);
    if(!isOriginal && !isUpdated)return blocked('strategy_changed');
    const boundId=Number(params.alertIds[0]);
    const {rows:alerts}=await tx.query(
      'SELECT * FROM alerts WHERE user_id=$1 FOR UPDATE',[USER_ID]);
    const alert=alerts.filter(a=>a.name===ALERT_MARKER);
    if(alert.length!==1||!safeAlert(alert[0],boundId))
      return blocked('alert_changed');
    if(isUpdated)return {status:verifyOnly?'verified':'already_adjusted',
      reason:'none',ordersSent:0,liveEnabled:false};
    if(verifyOnly)return blocked('unverified');

    const after={...params,maxPremiumUsdt:PREMIUM_MAX,capitalUsdt:CAPITAL_MAX};
    if(!exactParams(after,NEW_PARAMS))return blocked('postcondition_failed');
    const {rows:updated}=await tx.query(
      "UPDATE options_strategies SET params=$3::jsonb,updated_at=$4 "+
      "WHERE id=$1 AND user_id=$2 AND mode='paused' "+
      "AND params=$5::jsonb AND limits=$6::jsonb RETURNING *",
      [strategy.id,USER_ID,JSON.stringify(after),now(),
       JSON.stringify(params),JSON.stringify(limits)]);
    if(updated.length!==1||
      !safeTemplate(updated[0],parseObject(updated[0].params),
        parseObject(updated[0].limits),NEW_PARAMS))
      throw Error('Atomic paused-only update failed; rollback');
    return {status:'adjusted_paused',reason:'none',ordersSent:0,liveEnabled:false};
  });
}
function summaryLines(result){
  if(!result||!ALLOWED_STATUSES.has(result.status)||
    !REASONS.has(result.reason)||result.ordersSent!==0||
    result.liveEnabled!==false||
    (result.status==='blocked')!==(result.reason!=='none'))
    throw Error('Invalid pilot budget result');
  return [
    'pilot_budget_status='+result.status,
    'pilot_budget_reason='+result.reason,
    'pilot_budget_symbol=ETH-261030-2550-C',
    'pilot_budget_quantity=0.01',
    'pilot_budget_max_limit_usdt=36.00',
    'pilot_budget_max_premium_usdt=0.36',
    'pilot_budget_max_capital_usdt=0.40',
    'pilot_budget_existing_strategy_preserved=yes',
    'pilot_budget_existing_alert_preserved=yes',
    'pilot_budget_strategy_mode=paused',
    'pilot_budget_trading_enabled=no',
    'pilot_budget_orders_sent=0',
    'pilot_ready=no',
  ];
}
async function main(){
  const mode=process.argv[2];
  if(process.argv.length!==3 || !['--apply-paused-only','--verify-only'].includes(mode))
    throw Error('Explicit paused-only approval required');
  const result=await adjust({verifyOnly:mode==='--verify-only'});
  summaryLines(result).forEach(line=>console.log(line));
  if(result.status==='blocked')process.exitCode=2;
}
if(require.main===module){
  main().catch(()=>{
    console.log('pilot_budget_status=unavailable');
    console.log('pilot_budget_orders_sent=0');
    console.log('pilot_ready=no');
    process.exitCode=1;
  }).finally(()=>dbDefault.pool.end());
}
module.exports={tradingOff,safeTemplate,safeAlert,adjust,summaryLines,
  BASE_PARAMS,NEW_PARAMS,PREMIUM_MAX,CAPITAL_MAX};
