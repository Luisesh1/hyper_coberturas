const test = require('node:test');
const assert = require('node:assert/strict');
const { apply, chooseOne, summaryLines } =
  require('../src/scripts/options-pilot-bind-single-alert');
const { BOT_PARAMS, BOT_LIMITS, MARKER } =
  require('../src/scripts/options-pilot-configure-paused');
const env = {
  OPTIONS_LIVE_TRADING_ENABLED:'false',
  OPTIONS_LIVE_PRODUCTION_APPROVED:'false',
  OPTIONS_LIVE_PILOT_AUTHORIZED:'false',
};
const base = {
  id:2, user_id:1, name:MARKER, template:'alert_signal',
  underlying:'ETH', mode:'paused', params:BOT_PARAMS, limits:BOT_LIMITS,
};
const alert = {
  id:40, is_active:true, direction:'bullish',
  asset_list_json:'["ETHUSDT"]', rules_json:'[{"id":1}]',
  option_expiry_min_days:5, option_expiry_max_days:12,
};
function mockDb({ strategies=[base], alerts=[alert], positions=[], orders=[],
  global={maxDailyLossUsdt:1,maxMarginUsdt:1,maxLiveStrategies:1,notifyTelegram:true} }={}) {
  const calls=[];
  const db={ transaction:async(fn)=>fn({query:async(sql,args)=>{
    calls.push({sql,args});
    if(sql.includes('pg_advisory'))return {rows:[]};
    if(sql.includes('SELECT * FROM options_strategies'))return {rows:strategies};
    if(sql.includes('SELECT id FROM options_strategy_positions'))return {rows:positions};
    if(sql.includes('SELECT id FROM options_live_orders'))return {rows:orders};
    if(sql.includes("key='options_limits'"))return {rows:[{value:JSON.stringify(global)}]};
    if(sql.includes('FROM alerts WHERE'))return {rows:alerts};
    if(sql.includes('UPDATE options_strategies'))return {rows:[{id:2}]};
    throw Error('Unexpected SQL: '+sql);
  }})};
  return {db,calls};
}
test('accepts only a unique active ETH bullish alert with rules and proper expiry',()=>{
  assert.equal(chooseOne([alert]),40);
  assert.equal(chooseOne([alert,{...alert,id:41}]),null);
  assert.equal(chooseOne([{...alert,is_active:false}]),null);
  assert.equal(chooseOne([{...alert,direction:'bearish'}]),null);
  assert.equal(chooseOne([{...alert,asset_list_json:'["BTCUSDT"]'}]),null);
  assert.equal(chooseOne([{...alert,rules_json:'[]'}]),null);
  assert.equal(chooseOne([{...alert,option_expiry_min_days:8}]),null);
  assert.equal(chooseOne([{...alert,option_expiry_max_days:6}]),null);
});
test('binds only alertIds while retaining a paused bot and original risk limits',async()=>{
  const {db,calls}=mockDb();
  const result=await apply({db,env,now:()=>7777});
  assert.equal(result.status,'bound');
  assert.equal(result.ordersSent,0);
  const writes=calls.filter(c=>/^\s*(UPDATE|INSERT|DELETE)\b/.test(c.sql));
  assert.equal(writes.length,1);
  assert.match(writes[0].sql,/mode='paused'/);
  assert.match(writes[0].sql,/params=jsonb_set/);
  assert.deepEqual(writes[0].args,[2,'[40]',7777,1]);
  assert.match(summaryLines(result).join('\n'),/pilot_alert_binding_live_enabled=no/);
});
test('already linked alert does not mutate DB and remains paused',async()=>{
  const {db,calls}=mockDb({strategies:[{...base,params:{...BOT_PARAMS,alertIds:[40]}}]});
  assert.equal((await apply({db,env})).status,'already_bound');
  assert.equal(calls.some(c=>c.sql.startsWith('UPDATE')),false);
});
test('ambiguous alerts, invalid strategy and live exposure fail without mutation',async()=>{
  for(const scenario of [
    {alerts:[alert,{...alert,id:41}]},
    {alerts:[]},
    {strategies:[{...base,mode:'live'}]},
    {strategies:[{...base,params:{...BOT_PARAMS,alertIds:[999]}}]},
    {global:{maxDailyLossUsdt:500,maxMarginUsdt:500,maxLiveStrategies:3,notifyTelegram:false}},
    {positions:[{id:99}]},
    {orders:[{id:99}]},
  ]){
    const {db,calls}=mockDb(scenario);
    const run=apply({db,env});
    if(scenario.positions?.length || scenario.orders?.length || scenario.strategies?.[0]?.mode==='live') {
      await assert.rejects(run);
    } else {
      assert.equal((await run).status,'blocked');
    }
    assert.equal(calls.some(c=>c.sql.startsWith('UPDATE')),false);
  }
});
test('live flags fail before DB access and no order API exists',async()=>{
  let called=0;
  await assert.rejects(apply({
    db:{transaction:async()=>{called++;}},
    env:{...env,OPTIONS_LIVE_TRADING_ENABLED:'true'},
  }));
  assert.equal(called,0);
  assert.throws(()=>summaryLines({status:'bound',ordersSent:1}));
});
