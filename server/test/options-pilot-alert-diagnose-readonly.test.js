const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {compute,lines,diagnose,EXPECTED_PARAMS}=
  require('../src/scripts/options-pilot-alert-diagnose-readonly');
const {BOT_LIMITS,MARKER}=
  require('../src/scripts/options-pilot-configure-paused');
const limits={maxMarginUsdt:1,maxDailyLossUsdt:1,maxLiveStrategies:1,notifyTelegram:true};
const base={id:2,user_id:1,name:MARKER,mode:'paused',
  template:'alert_signal',underlying:'ETH',
  params:{...EXPECTED_PARAMS,alertIds:[41]},limits:BOT_LIMITS};
function state(row=base){return {rows:[row],limits,livePositions:[],orders:[]};}
test('reports every expected field as pass without leaking values',()=>{
  const s=lines(compute(state())).join('\n');
  assert.match(s,/pilot_alert_diag_strategyFits=pass/);
  assert.match(s,/pilot_alert_diag_param_quantity=pass/);
  assert.match(s,/pilot_alert_diag_limit_maxDailyLossUsdt=pass/);
  assert.match(s,/pilot_alert_diag_alertBound=pass/);
  assert.match(s,/pilot_ready=no/);
  assert.doesNotMatch(s,/PILOTO ETH|alertIds:|41|0\.26|0\.01|USDT/);
});
test('isolates each mismatch without printing actual parameter values',()=>{
  const changed={...base,params:{...EXPECTED_PARAMS,alertIds:[41],quantity:5.56}};
  const s=lines(compute(state(changed))).join('\n');
  assert.match(s,/pilot_alert_diag_param_quantity=fail/);
  assert.match(s,/pilot_alert_diag_strategyFits=fail/);
  assert.match(s,/pilot_alert_diag_param_targetDelta=pass/);
  assert.doesNotMatch(s,/5\.56/);
});
test('detects mode, limit and marker changes',()=>{
  assert.match(lines(compute(state({...base,mode:'shadow'}))).join('\n'),
    /pilot_alert_diag_strategyPaused=fail/);
  assert.match(lines(compute(state({...base,name:'another'}))).join('\n'),
    /pilot_alert_diag_singlePilotMarker=fail/);
  assert.match(lines(compute(state({...base,limits:{...BOT_LIMITS,maxDailyLossUsdt:51}}))).join('\n'),
    /pilot_alert_diag_limit_maxDailyLossUsdt=fail/);
});
test('read-only mode refuses to query DB when live flags are enabled',async()=>{
  let n=0;
  await assert.rejects(diagnose({
    env:{OPTIONS_LIVE_TRADING_ENABLED:'true'},
    db:{query:async()=>{n++;throw Error('Must not query');}},
  }));
  assert.equal(n,0);
});
test('source never sends or mutates exchange orders or database',()=>{
  const source=fs.readFileSync(path.resolve(__dirname,
    '../src/scripts/options-pilot-alert-diagnose-readonly.js'),'utf8');
  assert.doesNotMatch(source,/\.placeOrder\(|\.cancelOrder\(|\.updateStrategy\(|\.setMode\(/);
  assert.doesNotMatch(source,/db\.query\(['"](?:UPDATE|INSERT|DELETE)/);
});
