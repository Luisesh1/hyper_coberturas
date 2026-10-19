const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {strategyFits,globalFits,inspect,safeLines,USER_ID}=
  require('../src/scripts/options-pilot-strategy-readiness');

const valid={
 id:41,userId:1,mode:'paused',underlying:'ETH',template:'alert_signal',
 params:{
  structure:'buy_with',contractCount:1,quantity:.01,
  maxOpenPositions:1,maxTradesPerDay:1,onOpposite:'close',
  takeProfitMode:'fixed',takeProfitPct:50,stopLossPct:50,
  exitHoursBeforeExpiry:24,maxPremiumUsdt:.26,capitalUsdt:.26,
 },
 limits:{maxOrdersPerDay:2,maxDailyLossUsdt:20,maxMarginUsdt:20},
};
const limits={maxDailyLossUsdt:20,maxMarginUsdt:20,
 maxLiveStrategies:1,notifyTelegram:true};
function deps(strategies=[valid],global=limits,positions=[]){
 return {repo:{
  listStrategies:async()=>strategies,
  listOpenPositionsByUser:async()=>positions,
 },credentials:{getLimits:async()=>global},userId:USER_ID};
}

test('requires exactly one paused/shadow buy-only low risk strategy',async()=>{
 assert.equal(strategyFits(valid),true);
 const result=await inspect(deps());
 assert.equal(result.status,'strategy_candidate');
 assert.equal(result.candidateStrategyId,41);
 assert.equal(result.pilotReady,false);
 assert.equal(result.entrySignalConfigured,false); // paused setup has alertIds: []
 assert.match(safeLines(result).join('\n'),/strategy_preview_entry_signal_configured=no/);
 assert.match(safeLines(result).join('\n'),/strategy_preview_candidate_id=41/);
 assert.match(safeLines(result).join('\n'),/pilot_ready=no/);
});

test('no suitable strategies cannot silently configure or activate a bot',async()=>{
 const r=await inspect(deps([]));
 assert.equal(r.status,'strategy_not_ready');
 assert.equal(r.candidateStrategyId,null);
 assert.equal(r.checks.exactStrategyAvailable,false);
 assert.match(safeLines(r).join('\n'),/strategy_preview_execution_approved=no/);
});
test('multiple matching strategies fail-closed',async()=>{
 const r=await inspect(deps([valid,{...valid,id:42}]));
 assert.equal(r.status,'strategy_not_ready');
 assert.equal(r.candidateStrategyId,null);
});
test('unsafe bot modes, naked short and broad limits are rejected',async()=>{
 for(const s of [
  {...valid,mode:'live'},
  {...valid,params:{...valid.params,structure:'sell_against'}},
  {...valid,params:{...valid.params,contractCount:2}},
  {...valid,params:{...valid.params,maxTradesPerDay:4}},
  {...valid,params:{...valid.params,onOpposite:'reverse'}},
  {...valid,params:{...valid.params,maxPremiumUsdt:null}},
  {...valid,params:{...valid.params,stopLossPct:100}},
  {...valid,limits:{...valid.limits,maxDailyLossUsdt:500}},
  {...valid,limits:{...valid.limits,maxOrdersPerDay:100}},
 ]) assert.equal(strategyFits(s),false);
 assert.equal(globalFits({...limits,maxDailyLossUsdt:500}),false);
 assert.equal(globalFits({...limits,maxLiveStrategies:3}),false);
 assert.equal(globalFits({...limits,notifyTelegram:false}),false);
});
test('any other live strategy or existing position is a hard blocker',async()=>{
 const live=await inspect(deps([valid,{...valid,id:50,mode:'live'}]));
 assert.equal(live.checks.noActiveLiveStrategies,false);
 assert.equal(live.status,'strategy_not_ready');
 const pos=await inspect(deps([valid],limits,[{id:1}]));
 assert.equal(pos.checks.noLivePositions,false);
 assert.equal(pos.status,'strategy_not_ready');
});
test('global limits are checked and every status stays read-only',async()=>{
 const r=await inspect(deps([valid],{...limits,maxMarginUsdt:5000}));
 assert.equal(r.checks.globalRiskRestricted,false);
 assert.equal(r.status,'strategy_not_ready');
 assert.equal(r.candidateStrategyId,null);
 assert.match(safeLines(r).join('\n'),/strategy_preview_globalRiskRestricted=fail/);
 assert.throws(()=>safeLines({...r,pilotReady:true}));
 const script=fs.readFileSync(path.resolve(__dirname,
  '../src/scripts/options-pilot-strategy-readiness.js'),'utf8');
 assert.doesNotMatch(script,/\.createStrategy\(|\.updateStrategy\(|\.setMode\(|\.placeOrder\(|\.cancelOrder\(/);
});

test('pilot distinguishes a valid paused strategy from an actual alert-bound entry',async()=>{
 const idle=await inspect(deps([{...valid,params:{...valid.params,alertIds:[]}}]));
 assert.equal(idle.status,'strategy_candidate');
 assert.equal(idle.entrySignalConfigured,false);
 const bound=await inspect(deps([{...valid,params:{...valid.params,alertIds:[74]}}]));
 assert.equal(bound.status,'strategy_candidate');
 assert.equal(bound.entrySignalConfigured,true);
 assert.match(safeLines(bound).join('\n'),/strategy_preview_entry_signal_configured=yes/);
 const absent=await inspect(deps([]));
 assert.equal(absent.entrySignalConfigured,false);
 assert.throws(()=>safeLines({...bound,entrySignalConfigured:null}));
});

test('new independent 0.40 budget is recognized only with exact pause + alert + risk caps',async()=>{
 const independent={
  ...valid,id:77,name:'PILOTO ETH 7-14 - independiente - PAUSADO',
  limits:{maxOrdersPerDay:3,maxDailyLossUsdt:1,maxMarginUsdt:1},
  params:{...valid.params,alertIds:[119],
    expiryDays:7,targetDelta:.35,
    maxPremiumUsdt:.36,capitalUsdt:.40},
 };
 assert.equal(strategyFits(independent),true);
 const oldModified={...valid,id:41,params:{...valid.params,quantity:.02}};
 const readiness=await inspect(deps([oldModified,independent],
  {maxDailyLossUsdt:1,maxMarginUsdt:1,maxLiveStrategies:1,notifyTelegram:true}));
 assert.equal(readiness.status,'strategy_candidate');
 assert.equal(readiness.candidateStrategyId,77);
 assert.equal(readiness.entrySignalConfigured,true);
 assert.equal(readiness.pilotReady,false);
 assert.match(safeLines(readiness).join('\n'),/strategy_preview_entry_signal_configured=yes/);
 for(const bad of [
  {...independent,name:'otro-bot'},
  {...independent,mode:'shadow'},
  {...independent,params:{...independent.params,alertIds:[]}},
  {...independent,params:{...independent.params,alertIds:[119,120]}},
  {...independent,params:{...independent.params,maxPremiumUsdt:.41}},
  {...independent,params:{...independent.params,capitalUsdt:.41}},
  {...independent,params:{...independent.params,stopLossPct:70}},
  {...independent,params:{...independent.params,takeProfitMode:'volatility'}},
  {...independent,params:{...independent.params,expiryDays:30}},
  {...independent,params:{...independent.params,targetDelta:.6}},
  {...independent,limits:{...independent.limits,maxDailyLossUsdt:5}},
  {...independent,limits:{...independent.limits,maxMarginUsdt:5}},
 ]){
  assert.equal(strategyFits(bad),false,'reject altered independent pilot budget or safeguards');
 }
});
