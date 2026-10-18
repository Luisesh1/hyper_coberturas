const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {apply,summaryLines,goodPilot,BOT_MARKER}=
 require('../src/scripts/options-pilot-create-independent-paused');
const {MARKER,BOT_PARAMS,BOT_LIMITS}=
 require('../src/scripts/options-pilot-configure-paused');
const {ALERT_MARKER,expectedClone}=
 require('../src/scripts/options-pilot-create-dedicated-alert');
const {validateParams}=require('../src/services/options/templates/alert-signal');

const env={OPTIONS_LIVE_TRADING_ENABLED:'false',OPTIONS_LIVE_PRODUCTION_APPROVED:'false',
 OPTIONS_LIVE_PILOT_AUTHORIZED:'false'};
const originalStrategy={id:2,user_id:1,name:MARKER,mode:'paused',
 template:'alert_signal',underlying:'ETH',params:{
  ...validateParams(BOT_PARAMS),structure:'sell_with',targetDelta:0.4,
  maxPremiumUsdt:0.35,stopLossPct:35,alertIds:[41],
 },limits:{...BOT_LIMITS,maxMarginUsdt:0.9}};
const originalAlert={
 id:41,user_id:1,name:'Alerta original ETH',is_active:true,
 direction:'bullish',asset_list_json:'["BTCUSDT","ETHUSDT"]',
 rules_json:'[{"label":"rsi","conditions":[{"operator":">"}]}]',
 threshold_percent:70,cooldown_seconds:900,telegram_enabled:true,
 datasource:'binance',option_expiry_min_days:31,option_expiry_max_days:60,
};
const globalLimits={maxDailyLossUsdt:1,maxMarginUsdt:1,maxLiveStrategies:1,
 notifyTelegram:true};
function clone(){
 const expected=expectedClone(originalAlert);
 return {id:77,user_id:1,name:ALERT_MARKER,is_active:true,
  threshold_percent:expected.threshold,
  asset_list_json:JSON.stringify(expected.assetList),
  rules_json:JSON.stringify(expected.rules),telegram_enabled:false,
  cooldown_seconds:expected.cooldown,datasource:expected.datasource,
  direction:'bullish',option_expiry_min_days:7,option_expiry_max_days:14};
}
function newBot(){
 return {id:7,user_id:1,name:BOT_MARKER,mode:'paused',template:'alert_signal',
  underlying:'ETH',params:{...validateParams(BOT_PARAMS),alertIds:[77]},
  limits:BOT_LIMITS};
}
function mock({strategies=[originalStrategy],alerts=[originalAlert],
 positions=[],orders=[],settings=[{value:JSON.stringify(globalLimits)}]}={}){
 const calls=[];
 const db={transaction:async fn=>fn({query:async(sql,args)=>{
  calls.push({sql,args});
  if(sql.includes('pg_advisory_xact_lock'))return {rows:[]};
  if(sql.includes('SELECT * FROM options_strategies'))return {rows:strategies};
  if(sql.includes('SELECT id FROM options_strategy_positions'))return {rows:positions};
  if(sql.includes('SELECT id FROM options_live_orders'))return {rows:orders};
  if(sql.includes('FROM settings'))return {rows:settings};
  if(sql.includes('SELECT * FROM alerts'))return {rows:alerts};
  if(sql.includes('INSERT INTO alerts'))return {rows:[{id:77}]};
  if(sql.includes('INSERT INTO options_strategies'))return {rows:[{id:7}]};
  throw Error('Unexpected SQL: '+sql);
 }})};
 return {db,calls};
}
function writes(c){return c.filter(x=>/^(INSERT|UPDATE|DELETE)/.test(x.sql))}
test('creates independent paused bot, clones ETH-only alert without touching source',async()=>{
 const sourceBackup=JSON.stringify([originalStrategy,originalAlert]);
 const {db,calls}=mock();
 const result=await apply({db,env,now:()=>123});
 assert.equal(result.status,'created_paused');
 assert.equal(result.ordersSent,0);
 assert.equal(JSON.stringify([originalStrategy,originalAlert]),sourceBackup);
 assert.equal(writes(calls).length,2);
 const [alertInsert,botInsert]=writes(calls);
 assert.match(alertInsert.sql,/^INSERT INTO alerts/);
 assert.deepEqual(alertInsert.args,[1,ALERT_MARKER,true,70,
  '["ETHUSDT"]',originalAlert.rules_json,false,900,'binance','bullish',7,14,123]);
 assert.match(botInsert.sql,/^INSERT INTO options_strategies/);
 assert.equal(botInsert.args[0],1);
 assert.equal(botInsert.args[1],BOT_MARKER);
 assert.deepEqual(JSON.parse(botInsert.args[2]).alertIds,[77]);
 assert.deepEqual(JSON.parse(botInsert.args[3]),BOT_LIMITS);
 assert.equal(goodPilot(newBot(),77),true);
 assert.equal(goodPilot({...newBot(),mode:'live'},77),false);
 assert.match(summaryLines(result).join('\n'),/pilot_independent_original_alert_unchanged=yes/);
 assert.match(summaryLines(result).join('\n'),/pilot_ready=no/);
});
test('verification is independent and read-only; repeated create idempotent',async()=>{
 const {db,calls}=mock({strategies:[originalStrategy,newBot()],
  alerts:[originalAlert,clone()]});
 assert.equal((await apply({db,env,verifyOnly:true})).status,'verified');
 assert.equal((await apply({db,env})).status,'already_prepared');
 assert.equal(writes(calls).length,0);
});
test('verify-only without existing objects cannot mutate',async()=>{
 const {db,calls}=mock();
 assert.equal((await apply({db,env,verifyOnly:true})).reason,'verification_pending');
 assert.equal(writes(calls).length,0);
});
test('existing dedicated clone can be reused for independent bot',async()=>{
 const {db,calls}=mock({alerts:[originalAlert,clone()]});
 assert.equal((await apply({db,env})).status,'created_paused');
 assert.equal(writes(calls).length,1);
 assert.match(writes(calls)[0].sql,/INSERT INTO options_strategies/);
});
test('all blockers avoid writes and preserve original',async()=>{
 const cases=[
  [{strategies:[]},'source_strategy_unavailable'],
  [{strategies:[originalStrategy,originalStrategy]},'source_strategy_ambiguous'],
  [{strategies:[{...originalStrategy,mode:'shadow'}]},'source_signal_missing'],
  [{strategies:[{...originalStrategy,params:{...originalStrategy.params,alertIds:[]}}]},'source_signal_missing'],
  [{alerts:[{...originalAlert,direction:'neutral'}]},'source_alert_ineligible'],
  [{alerts:[originalAlert,clone(),clone()]},'clone_duplicate'],
  [{alerts:[originalAlert,{...clone(),telegram_enabled:true}]},'clone_modified'],
  [{strategies:[originalStrategy,newBot(),newBot()],alerts:[originalAlert,clone()]},'pilot_duplicate'],
  [{strategies:[originalStrategy,{...newBot(),mode:'live'}],alerts:[originalAlert,clone()]},'live_activity'],
  [{strategies:[originalStrategy,{...newBot(),params:{...newBot().params,quantity:0.03}}],alerts:[originalAlert,clone()]},'pilot_modified'],
  [{positions:[{id:9}]},'live_activity'],
  [{orders:[{id:9}]},'live_activity'],
  [{settings:[{value:JSON.stringify({...globalLimits,maxMarginUsdt:100})}]},'global_limits'],
 ];
 for(const [setup,reason] of cases){
  const {db,calls}=mock(setup);
  const result=await apply({db,env});
  assert.equal(result.status,'blocked',reason);
  assert.equal(result.reason,reason);
  assert.equal(writes(calls).length,0);
 }
});
test('requires live flags OFF and never submits exchange orders or enables trading',async()=>{
 let count=0;
 await assert.rejects(apply({env:{...env,OPTIONS_LIVE_PILOT_AUTHORIZED:'true'},
  db:{transaction:async()=>{count++;}}}));
 assert.equal(count,0);
 const src=fs.readFileSync(path.resolve(__dirname,
 '../src/scripts/options-pilot-create-independent-paused.js'),'utf8');
 assert.doesNotMatch(src,/\.placeOrder\(|\.cancelOrder\(|\.setMode\(|UPDATE options_strategies|UPDATE alerts/);
 assert.throws(()=>summaryLines({status:'created_paused',reason:'none',ordersSent:1,
  paused:true,sourcePreserved:true,cloneVerified:true}));
});
