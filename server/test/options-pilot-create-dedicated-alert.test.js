const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {
  apply, eligibleSource, expectedClone, cloneMatches, summaryLines, ALERT_MARKER,
}=require('../src/scripts/options-pilot-create-dedicated-alert');
const {BOT_PARAMS,BOT_LIMITS,MARKER}=
  require('../src/scripts/options-pilot-configure-paused');
const {validateParams}=
  require('../src/services/options/templates/alert-signal');

const env={OPTIONS_LIVE_TRADING_ENABLED:'false',
  OPTIONS_LIVE_PRODUCTION_APPROVED:'false',
  OPTIONS_LIVE_PILOT_AUTHORIZED:'false'};
const source={
  id:41,user_id:1,name:'ETH alarma original',is_active:true,
  direction:'bullish',asset_list_json:'["ETHUSDT","BTCUSDT"]',
  rules_json:'[{"label":"rsi","conditions":[{"operator":">"}]}]',
  threshold_percent:'70',cooldown_seconds:'900',datasource:'binance',
  telegram_enabled:true,option_expiry_min_days:45,option_expiry_max_days:60,
  updated_at:100,
};
const strategy={id:2,user_id:1,name:MARKER,template:'alert_signal',
  underlying:'ETH',mode:'paused',
  params:{...validateParams(BOT_PARAMS),alertIds:[source.id]},limits:BOT_LIMITS};
const limits={maxDailyLossUsdt:1,maxMarginUsdt:1,
  maxLiveStrategies:1,notifyTelegram:true};
const cloned=(overrides={})=>{
  const x=expectedClone(source);
  return {id:77,user_id:1,name:ALERT_MARKER,is_active:true,
    threshold_percent:x.threshold,asset_list_json:JSON.stringify(x.assetList),
    rules_json:JSON.stringify(x.rules),telegram_enabled:false,
    cooldown_seconds:x.cooldown,datasource:x.datasource,direction:'bullish',
    option_expiry_min_days:7,option_expiry_max_days:14,...overrides};
};

function makeDb({alertRows=[source], strategies=[strategy], global=limits,
  positions=[],orders=[]}={}) {
  const calls=[];
  const db={transaction:async fn=>fn({query:async(sql,args)=>{
    calls.push({sql,args});
    if(sql.includes('pg_advisory_xact_lock')) return {rows:[]};
    if(sql.includes('SELECT * FROM options_strategies'))return {rows:strategies};
    if(sql.includes('SELECT id FROM options_strategy_positions'))return {rows:positions};
    if(sql.includes('SELECT id FROM options_live_orders'))return {rows:orders};
    if(sql.includes("key='options_limits'"))return {rows:[{value:JSON.stringify(global)}]};
    if(sql.includes('SELECT * FROM alerts'))return {rows:alertRows};
    if(sql.includes('INSERT INTO alerts'))return {rows:[{id:77}]};
    if(sql.includes('UPDATE options_strategies'))return {rows:[{id:2}]};
    throw new Error('unexpected SQL '+sql);
  }})};
  return {db,calls};
}
test('clones ETH only, keeps original threshold/rules but disables duplicate Telegram',()=>{
  assert.equal(eligibleSource(source),true);
  const expected=expectedClone(source);
  assert.deepEqual(expected.assetList,['ETHUSDT']);
  assert.deepEqual(expected.rules,JSON.parse(source.rules_json));
  assert.equal(expected.telegramEnabled,false);
  assert.equal(expected.minDays,7);
  assert.equal(expected.maxDays,14);
  assert.equal(expected.threshold,70);
  assert.equal(cloneMatches(cloned(),expected),true);
  assert.equal(cloneMatches(cloned({option_expiry_max_days:30}),expected),false);
  assert.equal(cloneMatches(cloned({telegram_enabled:true}),expected),false);
  assert.equal(cloneMatches(cloned({rules_json:'[]'}),expected),false);
});
test('clones and binds atomically while preserving original and all budgets',async()=>{
  const original=JSON.stringify(source);
  const {db,calls}=makeDb();
  const r=await apply({db,env,now:()=>111});
  assert.equal(r.status,'created_and_bound');
  assert.equal(r.expiry,'7_14');
  assert.equal(JSON.stringify(source),original);
  const writes=calls.filter(c=>/^(INSERT|UPDATE|DELETE)/.test(c.sql));
  assert.equal(writes.length,2);
  assert.match(writes[0].sql,/INSERT INTO alerts/);
  assert.match(writes[1].sql,/UPDATE options_strategies/);
  assert.match(writes[1].sql,/mode='paused'/);
  assert.deepEqual(writes[1].args,[2,1,'[77]',111,'[41]']);
  assert.deepEqual(writes[0].args,
    [1,ALERT_MARKER,true,70,'["ETHUSDT"]',source.rules_json,false,
      900,'binance','bullish',7,14,111]);
  assert.match(summaryLines(r).join('\n'),/pilot_ready=no/);
  assert.match(summaryLines(r).join('\n'),/pilot_dedicated_alert_source_untouched=yes/);
  assert.equal(calls.some(c=>/UPDATE alerts|DELETE FROM alerts/.test(c.sql)),false);
});
test('standalone verify-only cannot create or relink anything',async()=>{
  const {db,calls}=makeDb();
  const r=await apply({db,env,verifyOnly:true});
  assert.equal(r.status,'blocked');
  assert.equal(r.reason,'no_dedicated_alert');
  assert.equal(calls.some(c=>/^(INSERT|UPDATE|DELETE)/.test(c.sql)),false);
});
test('second execution recognizes existing clone and requires no writes',async()=>{
  const bound={...strategy,params:{...strategy.params,alertIds:[77]}};
  const {db,calls}=makeDb({alertRows:[source,cloned()],strategies:[bound]});
  assert.equal((await apply({db,env})).status,'already_bound');
  assert.equal((await apply({db,env,verifyOnly:true})).status,'verified');
  assert.equal(calls.some(c=>/^(INSERT|UPDATE|DELETE)/.test(c.sql)),false);
});
test('rejects modified clone, multiple originals, nonmatching binding, live mode, limits',async()=>{
  const scenarios=[
    {alertRows:[source,cloned({telegram_enabled:true})],reason:'clone_modified'},
    {alertRows:[source,{...source,id:42}],reason:'source_alert_ambiguous'},
    {alertRows:[{...source,direction:'neutral'}],reason:'source_alert_invalid'},
    {strategies:[{...strategy,params:{...strategy.params,alertIds:[999]}}],reason:'binding_changed'},
    {strategies:[{...strategy,mode:'live'}],reason:'live_activity'},
    {positions:[{id:3}],reason:'live_activity'},
    {orders:[{id:3}],reason:'live_activity'},
    {global:{...limits,maxDailyLossUsdt:500}},reason:'global_limits'},
    {strategies:[{...strategy,params:{...strategy.params,quantity:0.05}}],reason:'strategy_mismatch'},
  ];
  for(const scenario of scenarios){
    const {reason,...args}=scenario;
    const {db,calls}=makeDb(args);
    const result=await apply({db,env});
    assert.equal(result.reason,reason);
    assert.equal(result.status,'blocked');
    assert.equal(calls.some(c=>/^(INSERT|UPDATE|DELETE)/.test(c.sql)),false);
  }
});
test('refuses DB or Telegram access if flags are not OFF',async()=>{
  let count=0;
  await assert.rejects(apply({
    env:{...env,OPTIONS_LIVE_PILOT_AUTHORIZED:'true'},
    db:{transaction:async()=>{count++}},
  }));
  assert.equal(count,0);
});
test('script never enables trading or submits Binance orders',()=>{
  const src=fs.readFileSync(path.resolve(__dirname,
    '../src/scripts/options-pilot-create-dedicated-alert.js'),'utf8');
  assert.doesNotMatch(src,/\.placeOrder\(|\.cancelOrder\(|\.setMode\(|\.setLimits\(/);
  assert.throws(()=>summaryLines({status:'created_and_bound',reason:'none',
    expiry:'7_14',ordersSent:1,originalPreserved:true,paused:true}));
});
