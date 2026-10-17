const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertTradingOff, tightenedLimits, applyPausedSetup, outputLines,
  MARKER, BOT_PARAMS,
} = require('../src/scripts/options-pilot-configure-paused');
const { validateParams } = require('../src/services/options/templates/alert-signal');

const flagsOff = {
  OPTIONS_LIVE_TRADING_ENABLED: 'false',
  OPTIONS_LIVE_PRODUCTION_APPROVED: 'false',
};
function fakeDb({
  existing = [], originalLimits = {maxMarginUsdt:5000,maxDailyLossUsdt:500,
    maxLiveStrategies:3,notifyTelegram:false},
  hasLive = false, hasOrders = false, hasPosition = false,
  failSettings = false,
} = {}) {
  const data = {
    strategies: [...existing], limits: originalLimits,
    committed: 0, rollbacks: 0, queries: [],
  };
  const db = {
    async transaction(fn) {
      const originalStrategies = data.strategies.map(s => ({...s}));
      const originalLimitsCopy = data.limits && {...data.limits};
      try {
        const answer = await fn({
          async query(sql, values=[]) {
            data.queries.push(sql);
            if (sql.includes('pg_advisory_xact_lock')) return {rows:[]};
            if (sql.includes('FROM users WHERE id')) return {rows:[{id:1}]};
            if (sql.includes('mode='+"'live'"+' LIMIT 1') &&
                sql.includes('options_strategies')) return {rows:hasLive?[{id:7}]:[]};
            if (sql.includes('options_strategy_positions') &&
                sql.includes('mode='+"'live'")) return {rows:hasPosition?[{id:8}]:[]};
            if (sql.includes('FROM options_live_orders')) return {rows:hasOrders?[{id:9}]:[]};
            if (sql.includes('FROM options_strategies WHERE user_id=$1') &&
                sql.includes('SELECT id,name,template')) return {rows:data.strategies};
            if (sql.startsWith('INSERT INTO options_strategies')) {
              const row = {id:42,user_id:1,name:values[1],mode:'paused',
                template:'alert_signal',underlying:'ETH',
                params:JSON.parse(values[2]),limits:JSON.parse(values[3])};
              data.strategies.push(row);
              return {rows:[{id:42}]};
            }
            if (sql.startsWith('SELECT value FROM settings')) return {
              rows:data.limits===null?[]:[{value:JSON.stringify(data.limits)}],
            };
            if (sql.startsWith('INSERT INTO settings')) {
              if(failSettings)throw new Error('DB write refused');
              data.limits=JSON.parse(values[1]);
              return {rows:[]};
            }
            throw new Error('Unexpected SQL');
          },
        });
        data.committed++;
        return answer;
      } catch (err) {
        data.strategies=originalStrategies;
        data.limits=originalLimitsCopy;
        data.rollbacks++;
        throw err;
      }
    },
  };
  return {db,data};
}
test('only runs with all live controls off and never permits implicit action',()=>{
  assert.throws(()=>assertTradingOff({}),/OFF/);
  assert.throws(()=>assertTradingOff({...flagsOff,OPTIONS_LIVE_TRADING_ENABLED:'true'}),/OFF/);
  assert.throws(()=>assertTradingOff({...flagsOff,OPTIONS_LIVE_PILOT_AUTHORIZED:'true'}),/OFF/);
  assert.doesNotThrow(()=>assertTradingOff(flagsOff));
});
test('tightens defaults, never increases existing tighter caps',()=>{
  assert.deepEqual(tightenedLimits(null),{
    maxMarginUsdt:1,maxDailyLossUsdt:1,maxLiveStrategies:1,notifyTelegram:true,
  });
  assert.deepEqual(tightenedLimits({maxMarginUsdt:.5,
    maxDailyLossUsdt:.75,maxLiveStrategies:3,notifyTelegram:false}),{
    maxMarginUsdt:.5,maxDailyLossUsdt:.75,maxLiveStrategies:1,notifyTelegram:true,
  });
  assert.throws(()=>tightenedLimits('{bad'),/Invalid stored/);
});
test('creates a paused no-signal strategy and atomically narrows global risk',async()=>{
  const {db,data}=fakeDb();
  const r=await applyPausedSetup({db,env:flagsOff,now:()=>123456});
  assert.equal(r.status,'prepared_paused');
  assert.equal(r.created,true);
  assert.equal(r.strategyId,42);
  assert.equal(data.committed,1);
  assert.equal(data.strategies.length,1);
  assert.equal(data.strategies[0].mode,'paused');
  assert.equal(data.strategies[0].name,MARKER);
  assert.deepEqual(data.strategies[0].params.alertIds,[]);
  assert.equal(data.strategies[0].params.stopLossPct,50);
  assert.equal(data.strategies[0].params.capitalUsdt,.26);
  assert.deepEqual(data.limits,{maxMarginUsdt:1,maxDailyLossUsdt:1,
    maxLiveStrategies:1,notifyTelegram:true});
  assert.equal(r.ordersSent,0);
  assert.equal(r.liveEnabled,false);
  const lines=outputLines(r).join('\n');
  assert.match(lines,/pilot_setup_status=prepared_paused/);
  assert.match(lines,/pilot_setup_orders_sent=0/);
  assert.match(lines,/pilot_ready=no/);
});
test('is idempotent and preserves unrelated existing strategies',async()=>{
  const unrelated={id:17,name:'Other strategy',mode:'paused',
    template:'alert_signal',underlying:'BTC',params:{},limits:{}};
  const {db,data}=fakeDb({existing:[unrelated]});
  const first=await applyPausedSetup({db,env:flagsOff});
  const second=await applyPausedSetup({db,env:flagsOff});
  assert.equal(first.created,true);
  assert.equal(second.created,false);
  assert.equal(second.preexistingStrategiesPreserved,2);
  assert.equal(data.strategies.length,2);
  assert.equal(data.strategies[0].name,'Other strategy');
  assert.equal(data.committed,2);
  assert.ok(!data.queries.some(sql=>/^UPDATE options_strategies|^DELETE/.test(sql)));
});
test('aborts on exposure or prior order attempt before any writes',async()=>{
  for(const options of [{hasLive:true},{hasPosition:true},{hasOrders:true}]){
    const {db,data}=fakeDb(options);
    await assert.rejects(
      applyPausedSetup({db,env:flagsOff}),/Existing live exposure/);
    assert.equal(data.strategies.length,0);
    assert.equal(data.committed,0);
    assert.equal(data.rollbacks,1);
  }
});
test('rolls back strategy creation when global settings cannot commit',async()=>{
  const {db,data}=fakeDb({failSettings:true});
  await assert.rejects(applyPausedSetup({db,env:flagsOff}),/DB write refused/);
  assert.equal(data.strategies.length,0);
  assert.equal(data.committed,0);
  assert.equal(data.rollbacks,1);
});
test('fails on changed marker rather than changing an existing pilot',async()=>{
  const {db,data}=fakeDb({existing:[{
    id:42,name:MARKER,mode:'live',template:'alert_signal',
    underlying:'ETH',params:validateParams(BOT_PARAMS),limits:{},
  }]});
  await assert.rejects(applyPausedSetup({db,env:flagsOff}),/Pilot marker changed|Existing live exposure/);
  assert.equal(data.committed,0);
});
test('no network, no trade methods or credential access in setup source',()=>{
  const s=fs.readFileSync(path.resolve(__dirname,
    '../src/scripts/options-pilot-configure-paused.js'),'utf8');
  assert.doesNotMatch(s,/\.placeOrder\(|\.cancelOrder\(|\.setMode\(|\.updateStrategy\(|getClientForUser\(/);
  assert.match(s,/OPTIONS_LIVE_TRADING_ENABLED !== 'false'/);
  assert.match(s,/VALUES \(\$1,\$2,'alert_signal','ETH'/);
  assert.match(s,/mode='live'/);
  assert.match(s,/await tx\.query\('SELECT pg_advisory_xact_lock/);
});
