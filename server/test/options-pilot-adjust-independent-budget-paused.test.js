const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {adjust,summaryLines,tradingOff,safeTemplate,BASE_PARAMS,NEW_PARAMS}=
  require('../src/scripts/options-pilot-adjust-independent-budget-paused');
const {BOT_LIMITS,MARKER:OLD_MARKER}=
  require('../src/scripts/options-pilot-configure-paused');
const {BOT_MARKER}=require('../src/scripts/options-pilot-create-independent-paused');
const {ALERT_MARKER}=require('../src/scripts/options-pilot-create-dedicated-alert');

const env={OPTIONS_LIVE_TRADING_ENABLED:'false',
 OPTIONS_LIVE_PRODUCTION_APPROVED:'false',
 OPTIONS_LIVE_PILOT_AUTHORIZED:'false'};
const oldStrategy={id:2,user_id:1,name:OLD_MARKER,mode:'paused',
 template:'alert_signal',underlying:'ETH',
 params:JSON.stringify({...BASE_PARAMS,alertIds:[41]}),
 limits:JSON.stringify(BOT_LIMITS)};
function currentStrategy(params=BASE_PARAMS){
 return {id:3,user_id:1,name:BOT_MARKER,mode:'paused',
  template:'alert_signal',underlying:'ETH',
  params:JSON.stringify({...params,alertIds:[77]}),
  limits:JSON.stringify(BOT_LIMITS)};
}
const alert={id:77,user_id:1,name:ALERT_MARKER,
 is_active:true,direction:'bullish',telegram_enabled:false,
 option_expiry_min_days:7,option_expiry_max_days:14};
const riskSettings=[{value:JSON.stringify({maxDailyLossUsdt:1,
 maxMarginUsdt:1,maxLiveStrategies:1,notifyTelegram:true})}];

function fake({strategies=[oldStrategy,currentStrategy()],
 positions=[],orders=[],settings=riskSettings,alerts=[alert]}={}){
 const queries=[];let updated=false;
 const db={transaction:fn=>fn({query:async(sql,args)=>{
  queries.push({sql,args});
  if(sql.includes('pg_advisory_xact_lock'))return {rows:[]};
  if(sql.includes('SELECT * FROM options_strategies'))return {rows:strategies};
  if(sql.includes('SELECT id FROM options_strategy_positions'))return {rows:positions};
  if(sql.includes('SELECT id FROM options_live_orders'))return {rows:orders};
  if(sql.includes('FROM settings'))return {rows:settings};
  if(sql.includes('SELECT * FROM alerts'))return {rows:alerts};
  if(sql.startsWith('UPDATE options_strategies')){
   updated=true;
   return {rows:[{...strategies[1],params:args[2]}]};
  }
  throw Error('unexpected sql '+sql);
 }})};
 return {db,queries,get updated(){return updated;}};
}
test('changes exactly one paused bot row to 0.36 premium / 0.40 capital',async()=>{
 const f=fake(),orig=JSON.stringify([oldStrategy,alert,riskSettings]);
 const out=await adjust({db:f.db,env,now:()=>100});
 assert.equal(out.status,'adjusted_paused');
 assert.equal(f.updated,true);
 const writes=f.queries.filter(x=>/^(UPDATE|INSERT|DELETE)/.test(x.sql));
 assert.equal(writes.length,1);
 const args=writes[0].args;
 assert.equal(args[0],3);
 assert.equal(args[1],1);
 assert.deepEqual(JSON.parse(args[2]),{...NEW_PARAMS,alertIds:[77]});
 assert.equal(JSON.stringify([oldStrategy,alert,riskSettings]),orig);
 assert.equal(safeTemplate({...currentStrategy(NEW_PARAMS)},
   {...NEW_PARAMS,alertIds:[77]},BOT_LIMITS,NEW_PARAMS),true);
 assert.match(summaryLines(out).join('\n'),/pilot_budget_strategy_mode=paused/);
 assert.match(summaryLines(out).join('\n'),/pilot_budget_orders_sent=0/);
});
test('second invocation is idempotent; verify-only does not write',async()=>{
 const f=fake({strategies:[oldStrategy,currentStrategy(NEW_PARAMS)]});
 assert.equal((await adjust({db:f.db,env})).status,'already_adjusted');
 assert.equal((await adjust({db:f.db,env,verifyOnly:true})).status,'verified');
 assert.equal(f.updated,false);
 const g=fake();
 assert.equal((await adjust({db:g.db,env,verifyOnly:true})).reason,'unverified');
 assert.equal(g.updated,false);
});
test('refuses all unexpected activity or setup drift with ZERO writes',async()=>{
 const cases=[
  [{strategies:[oldStrategy]},'strategy_missing'],
  [{strategies:[{...oldStrategy,mode:'live'},currentStrategy()]},'live_activity'],
  [{strategies:[oldStrategy,{...currentStrategy(),mode:'shadow'}]},'strategy_changed'],
  [{strategies:[oldStrategy,{...currentStrategy(),params:JSON.stringify({...BASE_PARAMS,quantity:.02,alertIds:[77]})}]},'strategy_changed'],
  [{strategies:[oldStrategy,{...currentStrategy(),limits:JSON.stringify({...BOT_LIMITS,maxDailyLossUsdt:20})}]},'strategy_changed'],
  [{strategies:[{...oldStrategy,mode:'shadow'},currentStrategy()]},'original_strategy_unavailable'],
  [{strategies:[oldStrategy,currentStrategy(),currentStrategy()]},'strategy_missing'],
  [{orders:[{id:1}]},'live_activity'],
  [{positions:[{id:2}]},'live_activity'],
  [{settings:[{value:JSON.stringify({maxDailyLossUsdt:100,maxMarginUsdt:1,maxLiveStrategies:1,notifyTelegram:true})}]},'global_limits'],
  [{alerts:[{...alert,direction:'bearish'}]},'alert_changed'],
  [{alerts:[{...alert,telegram_enabled:true}]},'alert_changed'],
  [{alerts:[{...alert,option_expiry_max_days:30}]},'alert_changed'],
 ];
 for(const [config,reason] of cases){
  const f=fake(config);
  const result=await adjust({db:f.db,env});
  assert.equal(result.status,'blocked',reason);
  assert.equal(result.reason,reason);
  assert.equal(f.updated,false);
 }
});
test('will not even reach DB if trading controls are on',async()=>{
 for(const flags of [
  {...env,OPTIONS_LIVE_TRADING_ENABLED:'true'},
  {...env,OPTIONS_LIVE_PRODUCTION_APPROVED:'true'},
  {...env,OPTIONS_LIVE_PILOT_AUTHORIZED:'true'},
 ]){
  const f=fake();
  assert.equal(tradingOff(flags),false);
  await assert.rejects(adjust({db:f.db,env:flags}));
  assert.equal(f.queries.length,0);
 }
});
test('does not contain trading calls, configuration flag writes or unrelated strategy update',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,
 '../src/scripts/options-pilot-adjust-independent-budget-paused.js'),'utf8');
 assert.doesNotMatch(source,/\.placeOrder\(|\.cancelOrder\(|\.setMode\(|INSERT INTO|UPDATE alerts|UPDATE settings|OPTIONS_LIVE_TRADING_ENABLED\s*=(?!=)/);
});
