/**
 * One-time, operator-approved transition of the isolated ETH pilot to LIVE.
 * No exchange order is sent here. This file must only run with both
 * production options flags still OFF and under one-time release orchestration.
 * The original strategy #2, original alert, and global limits are not changed.
 */
'use strict';
const db=require('../db');
const {goodPilot,BOT_MARKER}=require('./options-pilot-create-independent-paused');
const {ALERT_MARKER}=require('./options-pilot-create-dedicated-alert');
const {globalFits}=require('./options-pilot-strategy-readiness');
const {BOT_LIMITS}=require('./options-pilot-configure-paused');
const {validateParams}=require('../services/options/templates/alert-signal');
const SPEC={
 userId:1,symbol:'ETH-261030-2550-C',qty:.01,limit:36,
 entryCap:.4,
};
function json(v){
 if(v&&typeof v==='object'&&!Array.isArray(v))return v;
 try{const x=JSON.parse(v);return x&&typeof x==='object'&&!Array.isArray(x)?x:null}catch{return null}
}
function flagsOff(env){
 return env.OPTIONS_LIVE_TRADING_ENABLED==='false' &&
 env.OPTIONS_LIVE_PRODUCTION_APPROVED==='false' &&
 env.OPTIONS_LIVE_PILOT_AUTHORIZED!=='true';
}
async function prepare({database=db,env=process.env,now=Date.now}={}){
 if(!flagsOff(env))throw Error('Require all live flags OFF before promotion');
 return database.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(760218,$1::int)',[SPEC.userId]);
  const {rows:strategies}=await tx.query(
   'SELECT * FROM options_strategies WHERE user_id=$1 FOR UPDATE',[SPEC.userId]);
  if(strategies.some(s=>s.mode==='live'))return {status:'blocked',reason:'other_live_strategy'};
  const candidates=strategies.filter(s=>s.name===BOT_MARKER);
  if(candidates.length!==1)return {status:'blocked',reason:'pilot_missing'};
  const s=candidates[0],params=json(s.params),limits=json(s.limits);
  if(!params||!limits||!Array.isArray(params.alertIds)||params.alertIds.length!==1)
   return {status:'blocked',reason:'pilot_modified'};
  const {rows:alerts}=await tx.query(
   'SELECT id,name,is_active,direction,option_expiry_min_days,option_expiry_max_days FROM alerts WHERE user_id=$1 FOR UPDATE',
   [SPEC.userId]);
  const a=alerts.find(r=>Number(r.id)===Number(params.alertIds[0]));
  if(!a||a.name!==ALERT_MARKER||a.is_active!==true||a.direction!=='bullish'||
     Number(a.option_expiry_min_days)!==7||Number(a.option_expiry_max_days)!==14)
   return {status:'blocked',reason:'alert_changed'};
  if(!goodPilot(s,a.id))return {status:'blocked',reason:'pilot_modified'};
  const {rows:settings}=await tx.query(
   "SELECT value FROM settings WHERE user_id=$1 AND key='options_limits' FOR UPDATE",
   [SPEC.userId]);
  if(settings.length!==1||!globalFits(json(settings[0].value)))
   return {status:'blocked',reason:'global_risk'};
  const {rows:positions}=await tx.query(
   "SELECT id FROM options_strategy_positions WHERE user_id=$1 AND mode='live' AND closed_at IS NULL LIMIT 1",[SPEC.userId]);
  const {rows:orders}=await tx.query(
   'SELECT id FROM options_live_orders WHERE user_id=$1 LIMIT 1',[SPEC.userId]);
  if(positions.length||orders.length)return {status:'blocked',reason:'live_exposure'};
  const next=validateParams({...params,capitalUsdt:SPEC.entryCap,maxPremiumUsdt:SPEC.entryCap});
  if(next.structure!=='buy_with'||next.contractCount!==1||next.quantity!==SPEC.qty||
     next.stopLossPct!==50||next.takeProfitPct!==50||next.maxTradesPerDay!==1||
     JSON.stringify(limits)!==JSON.stringify(BOT_LIMITS))
   return {status:'blocked',reason:'risk_mismatch'};
  const {rows:updated}=await tx.query(
   "UPDATE options_strategies SET mode='live',params=$3::jsonb,updated_at=$4 "+
   "WHERE id=$1 AND user_id=$2 AND mode='paused' AND params=$5::jsonb AND limits=$6::jsonb RETURNING id",
   [Number(s.id),SPEC.userId,JSON.stringify(next),now(),
    JSON.stringify(params),JSON.stringify(limits)]);
  if(updated.length!==1)throw Error('Atomic pilot strategy transition failed');
  return {status:'prepared_live',strategyId:Number(updated[0].id),reason:'none'};
 });
}
async function main(){
 if(process.argv.length!==3||process.argv[2]!=='--operator-approved-once')
  throw Error('Explicit one-time operator authorization required');
 const result=await prepare();
 console.log('pilot_one_shot_promotion_status='+result.status);
 console.log('pilot_one_shot_promotion_reason='+result.reason);
 if(result.status==='prepared_live'&&Number.isSafeInteger(result.strategyId)&&result.strategyId>0){
  console.log('pilot_one_shot_promotion_strategy_id='+result.strategyId);
 }else process.exitCode=2;
 console.log('pilot_one_shot_promotion_orders_sent=0');
}
if(require.main===module){
 main().catch(()=>{
  console.log('pilot_one_shot_promotion_status=unavailable');
  console.log('pilot_one_shot_promotion_orders_sent=0');
  process.exitCode=1;
 }).finally(()=>db.pool.end());
}
module.exports={prepare,flagsOff,SPEC};
