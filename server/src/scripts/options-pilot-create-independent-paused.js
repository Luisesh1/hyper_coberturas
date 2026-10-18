/**
 * Operator-authorized provisioning of an INDEPENDENT ETH pilot. A separate
 * bullish alert has 7..14 day expiries and Telegram OFF. The original alert
 * and original user-customized strategy are never modified.
 *
 * Creation is atomic under the same per-user advisory lock as earlier pilot
 * scripts. Trading stays disabled; no order, no live strategy, no flag changes.
 */
'use strict';

const defaultDb=require('../db');
const {MARKER:OLD_MARKER,BOT_PARAMS,BOT_LIMITS,paramsMatch}=
  require('./options-pilot-configure-paused');
const {validateParams}=require('../services/options/templates/alert-signal');
const {globalFits,strategyFits}=require('./options-pilot-strategy-readiness');
const {ALERT_MARKER,eligibleSource,expectedClone,cloneMatches}=
  require('./options-pilot-create-dedicated-alert');

const USER_ID=1;
const BOT_MARKER='PILOTO ETH 7-14 - independiente - PAUSADO';
const EXPECTED_PARAMS=validateParams(BOT_PARAMS);
const REASONS=new Set(['none','global_limits','live_activity','source_strategy_ambiguous',
  'source_strategy_unavailable','source_signal_missing','source_alert_ineligible',
  'pilot_duplicate','pilot_modified','clone_duplicate','clone_modified',
  'verification_pending','concurrent_change']);
function parseObject(v){
  if(v && typeof v==='object' && !Array.isArray(v))return v;
  if(typeof v!=='string')return null;
  try{const x=JSON.parse(v);return x && typeof x==='object' && !Array.isArray(x)?x:null}
  catch{return null}
}
function off(env){
  return env.OPTIONS_LIVE_TRADING_ENABLED==='false' &&
    env.OPTIONS_LIVE_PRODUCTION_APPROVED==='false' &&
    env.OPTIONS_LIVE_PILOT_AUTHORIZED!=='true';
}
const blocked=reason=>({status:'blocked',reason,ordersSent:0,paused:true,
  sourcePreserved:true,cloneVerified:false});

function goodPilot(s,cloneId){
  const params=parseObject(s?.params),limits=parseObject(s?.limits);
  return s?.name===BOT_MARKER && s.mode==='paused' &&
    s.template==='alert_signal' && s.underlying==='ETH' &&
    Number(s.user_id)===USER_ID && params && limits &&
    Array.isArray(params.alertIds) && params.alertIds.length===1 &&
    Number(params.alertIds[0])===Number(cloneId) &&
    paramsMatch({...params,alertIds:[]},EXPECTED_PARAMS) &&
    paramsMatch(limits,BOT_LIMITS) &&
    strategyFits({id:Number(s.id),userId:USER_ID,mode:s.mode,
      template:s.template,underlying:s.underlying,params,limits})===true;
}

async function apply({db=defaultDb,env=process.env,now=Date.now,verifyOnly=false}={}){
  if(!off(env))throw new Error('Independent pilot provisioning requires all live flags OFF');
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(760218,$1::int)',[USER_ID]);
    const {rows:strategies}=await tx.query(
      'SELECT * FROM options_strategies WHERE user_id=$1 FOR UPDATE',[USER_ID]);
    const {rows:positions}=await tx.query(
      "SELECT id FROM options_strategy_positions WHERE user_id=$1 AND mode='live' AND closed_at IS NULL LIMIT 1",
      [USER_ID]);
    const {rows:orders}=await tx.query(
      'SELECT id FROM options_live_orders WHERE user_id=$1 LIMIT 1',[USER_ID]);
    if(positions.length || orders.length || strategies.some(s=>s.mode==='live'))
      return blocked('live_activity');
    const {rows:settings}=await tx.query(
      "SELECT value FROM settings WHERE user_id=$1 AND key='options_limits' FOR UPDATE",[USER_ID]);
    if(settings.length!==1||!globalFits(parseObject(settings[0].value)))
      return blocked('global_limits');

    // Use the ONE original strategy's already-bound alert as the source.
    // Its other parameters are intentionally NOT checked against BOT_PARAMS:
    // user customized those, and this code must never replace them.
    const sources=strategies.filter(s=>s.name===OLD_MARKER);
    if(sources.length!==1)return blocked(sources.length?'source_strategy_ambiguous':'source_strategy_unavailable');
    const original=sources[0], originalParams=parseObject(original.params);
    if(original.mode!=='paused'||original.template!=='alert_signal'||
       original.underlying!=='ETH'||!originalParams ||
       !Array.isArray(originalParams.alertIds)||originalParams.alertIds.length!==1 ||
       !Number.isSafeInteger(Number(originalParams.alertIds[0]))||
       Number(originalParams.alertIds[0])<=0)
      return blocked('source_signal_missing');
    const sourceId=Number(originalParams.alertIds[0]);
    const {rows:alerts}=await tx.query(
      'SELECT * FROM alerts WHERE user_id=$1 FOR UPDATE',[USER_ID]);
    const source=alerts.find(a=>Number(a.id)===sourceId);
    if(!source||source.name===ALERT_MARKER||!eligibleSource(source))
      return blocked('source_alert_ineligible');
    const expected=expectedClone(source);
    const clones=alerts.filter(a=>a.name===ALERT_MARKER);
    if(clones.length>1)return blocked('clone_duplicate');
    const clone=clones[0]||null;
    if(clone&&!cloneMatches(clone,expected))return blocked('clone_modified');
    const existing=strategies.filter(s=>s.name===BOT_MARKER);
    if(existing.length>1)return blocked('pilot_duplicate');
    if(existing.length && (!clone||!goodPilot(existing[0],clone.id)))
      return blocked('pilot_modified');

    if(existing.length===1){
      return {status:verifyOnly?'verified':'already_prepared',reason:'none',
        ordersSent:0,paused:true,sourcePreserved:true,cloneVerified:true};
    }
    if(verifyOnly)return blocked('verification_pending');

    let cloneId=clone&&Number(clone.id);
    if(!clone){
      const {rows:created}=await tx.query(
        'INSERT INTO alerts (user_id,name,is_active,threshold_percent,asset_list_json,'+
        'rules_json,telegram_enabled,cooldown_seconds,datasource,direction,'+
        'option_expiry_min_days,option_expiry_max_days,created_at,updated_at) '+
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING id',
        [USER_ID,ALERT_MARKER,true,expected.threshold,
         JSON.stringify(expected.assetList),JSON.stringify(expected.rules),
         false,expected.cooldown,expected.datasource,'bullish',7,14,now()]);
      if(created.length!==1||!Number.isSafeInteger(Number(created[0].id)))
        throw new Error('Dedicated alert insertion failed');
      cloneId=Number(created[0].id);
    }
    const params={...EXPECTED_PARAMS,alertIds:[cloneId]};
    const {rows:createdBot}=await tx.query(
      "INSERT INTO options_strategies (user_id,name,template,underlying,params,limits,"+
      "mode,state,created_at,updated_at) VALUES ($1,$2,'alert_signal','ETH',$3::jsonb,"+
      "$4::jsonb,'paused','{}'::jsonb,$5,$5) RETURNING id",
      [USER_ID,BOT_MARKER,JSON.stringify(params),JSON.stringify(BOT_LIMITS),now()]);
    if(createdBot.length!==1||!Number.isSafeInteger(Number(createdBot[0].id))||
       !goodPilot({id:Number(createdBot[0].id),user_id:USER_ID,name:BOT_MARKER,
         mode:'paused',template:'alert_signal',underlying:'ETH',
         params,limits:BOT_LIMITS},cloneId))
      throw new Error('Independent pilot postcondition failed; rolling back');
    return {status:'created_paused',reason:'none',
      ordersSent:0,paused:true,sourcePreserved:true,cloneVerified:true};
  });
}
const statuses=new Set(['blocked','created_paused','already_prepared','verified']);
function summaryLines(r){
  if(!r||!statuses.has(r.status)||!REASONS.has(r.reason)||
    r.ordersSent!==0||r.paused!==true||r.sourcePreserved!==true||
    typeof r.cloneVerified!=='boolean'||
    (r.status==='blocked' && (r.reason==='none'||r.cloneVerified))||
    (r.status!=='blocked' && (r.reason!=='none'||!r.cloneVerified)))
    throw new Error('Unsafe independent pilot result');
  return [
    'pilot_independent_status='+r.status,
    'pilot_independent_reason='+r.reason,
    'pilot_independent_source_strategy_unchanged=yes',
    'pilot_independent_original_alert_unchanged=yes',
    'pilot_independent_expiry='+(r.cloneVerified?'7_14':'unverified'),
    'pilot_independent_telegram_duplicate=off',
    'pilot_independent_strategy_mode=paused',
    'pilot_independent_orders_sent=0',
    'pilot_independent_live_enabled=no',
    'pilot_ready=no',
  ];
}
async function main(){
  if(process.argv.length!==3||
    !['--create-paused-only','--verify-only'].includes(process.argv[2]))
    throw new Error('Explicit paused-only create or verify command required');
  summaryLines(await apply({verifyOnly:process.argv[2]==='--verify-only'}))
    .forEach(line=>console.log(line));
}
if(require.main===module){
  main().catch(()=>{
    console.log('pilot_independent_status=unavailable');
    console.log('pilot_independent_orders_sent=0');
    console.log('pilot_ready=no');
    process.exitCode=1;
  }).finally(()=>defaultDb.pool.end());
}
module.exports={BOT_MARKER,goodPilot,off,apply,summaryLines};
