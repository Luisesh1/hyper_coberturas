const test = require('node:test');
const assert = require('node:assert/strict');
const { apply, chooseOne, expiryWindowAllowed, windowReview, explainAlertFailure, summaryLines } =
  require('../src/scripts/options-pilot-bind-single-alert');
const { BOT_PARAMS, BOT_LIMITS, MARKER } =
  require('../src/scripts/options-pilot-configure-paused');
const { validateParams } = require('../src/services/options/templates/alert-signal');
const normalized = validateParams(BOT_PARAMS);
const env = {
  OPTIONS_LIVE_TRADING_ENABLED:'false',
  OPTIONS_LIVE_PRODUCTION_APPROVED:'false',
  OPTIONS_LIVE_PILOT_AUTHORIZED:'false',
};
const base = {
  id:2, user_id:1, name:MARKER, template:'alert_signal',
  underlying:'ETH', mode:'paused', params:normalized, limits:BOT_LIMITS,
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
  // El runner respeta la ventana y toma el vencimiento mas cercano a 7
  // DENTRO de ella; no exige que el dia 7 este incluido.
  assert.equal(chooseOne([{...alert,option_expiry_min_days:8}]),40);
  assert.equal(chooseOne([{...alert,option_expiry_max_days:6}]),40);
  assert.equal(chooseOne([{...alert,option_expiry_min_days:31,option_expiry_max_days:45}]),40);
  assert.equal(chooseOne([{...alert,option_expiry_min_days:0.5,option_expiry_max_days:2.5}]),40);
  assert.equal(chooseOne([{...alert,option_expiry_min_days:null,option_expiry_max_days:12}]),null);
  assert.equal(chooseOne([{...alert,option_expiry_min_days:null,option_expiry_max_days:null}]),40);
});
test('reports a specific safe blocker for an ineligible ETH alert', () => {
  assert.equal(explainAlertFailure([]),'alert_unavailable');
  assert.equal(explainAlertFailure([{...alert,is_active:false}]),'alert_inactive');
  assert.equal(explainAlertFailure([{...alert,rules_json:'[]'}]),'alert_rules_missing');
  assert.equal(explainAlertFailure([{...alert,option_expiry_min_days:50,option_expiry_max_days:30}]),'alert_expiry_incompatible');
  assert.equal(expiryWindowAllowed({...alert,option_expiry_min_days:8,option_expiry_max_days:12}),true);
  assert.equal(expiryWindowAllowed({...alert,option_expiry_min_days:1,option_expiry_max_days:2}),true);
  assert.equal(expiryWindowAllowed({...alert,option_expiry_min_days:30,option_expiry_max_days:180}),true);
  assert.equal(expiryWindowAllowed({...alert,option_expiry_min_days:31,option_expiry_max_days:180}),true);
  assert.equal(windowReview({...alert,option_expiry_min_days:31,option_expiry_max_days:180}),'outside_3_30');
  assert.equal(windowReview({...alert,option_expiry_min_days:1,option_expiry_max_days:2}),'outside_3_30');
  assert.equal(windowReview({...alert,option_expiry_min_days:8,option_expiry_max_days:12}),'overlaps_3_30');
  assert.equal(windowReview({...alert,option_expiry_min_days:null,option_expiry_max_days:null}),'template_default');
  assert.equal(expiryWindowAllowed({...alert,option_expiry_min_days:13,option_expiry_max_days:12}),false);
  assert.equal(explainAlertFailure([alert,{...alert,id:41}]),'alert_ambiguous');
});
test('reports a specific safe blocker for an ineligible ETH alert', () => {
  assert.equal(explainAlertFailure([]),'alert_unavailable');
  assert.equal(explainAlertFailure([{...alert,is_active:false}]),'alert_inactive');
  assert.equal(explainAlertFailure([{...alert,rules_json:'[]'}]),'alert_rules_missing');
  assert.equal(explainAlertFailure([{...alert,option_expiry_min_days:8}]),'alert_expiry_incompatible');
  assert.equal(explainAlertFailure([alert,{...alert,id:41}]),'alert_ambiguous');
});
test('binds only alertIds while retaining a paused bot and original risk limits',async()=>{
  const {db,calls}=mockDb();
  const result=await apply({db,env,now:()=>7777});
  assert.equal(result.status,'bound');
  assert.equal(result.reason,'none');
  assert.equal(result.windowReview,'overlaps_3_30');
  assert.equal(result.ordersSent,0);
  const writes=calls.filter(c=>/^\s*(UPDATE|INSERT|DELETE)\b/.test(c.sql));
  assert.equal(writes.length,1);
  assert.match(writes[0].sql,/mode='paused'/);
  assert.match(writes[0].sql,/params=jsonb_set/);
  assert.deepEqual(writes[0].args,[2,'[40]',7777,1]);
  assert.match(summaryLines(result).join('\n'),/pilot_alert_binding_live_enabled=no/);
  assert.match(summaryLines(result).join('\n'),/pilot_alert_binding_reason=none/);
});
test('rejects unnormalized fixture but accepts actual stored normalized parameters',async()=>{
  const wrong = mockDb({strategies:[{...base,params:BOT_PARAMS}]});
  const result = await apply({db:wrong.db,env});
  assert.equal(result.status,'blocked');
  assert.equal(result.reason,'strategy_config_mismatch');
  assert.equal(wrong.calls.some(c=>c.sql.startsWith('UPDATE')),false);
});
test('may wire an active short/long-dated signal while explicitly withholding live approval',async()=>{
  for (const days of [[1,2],[31,60]]) {
    const a={...alert,option_expiry_min_days:days[0],option_expiry_max_days:days[1]};
    const {db,calls}=mockDb({alerts:[a]});
    const result=await apply({db,env});
    assert.equal(result.status,'bound');
    assert.equal(result.windowReview,'outside_3_30');
    assert.match(summaryLines(result).join('\n'),/pilot_ready=no/);
    assert.match(summaryLines(result).join('\n'),/pilot_alert_binding_contract_window=outside_3_30/);
    assert.equal(calls.filter(c=>/^UPDATE/.test(c.sql)).length,1);
    assert.ok(calls.every(c=>!c.sql.includes('options_live_orders SET')));
  }
});
test('already linked alert does not mutate DB and remains paused',async()=>{
  const {db,calls}=mockDb({strategies:[{...base,params:{...normalized,alertIds:[40]}}]});
  assert.equal((await apply({db,env})).status,'already_bound');
  assert.equal(calls.some(c=>c.sql.startsWith('UPDATE')),false);
});
test('ambiguous alerts, invalid strategy and live exposure fail without mutation',async()=>{
  for(const scenario of [
    {alerts:[alert,{...alert,id:41}]},
    {alerts:[]},
    {strategies:[{...base,params:{...normalized,tpHorizonHours:99}}]},
    {strategies:[{...base,mode:'live'}]},
    {strategies:[{...base,params:{...normalized,alertIds:[999]}}]},
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
  assert.throws(()=>summaryLines({status:'bound',reason:'none',ordersSent:1}));
  assert.throws(()=>summaryLines({status:'blocked',reason:'not_a_real_reason',ordersSent:0}));
});
