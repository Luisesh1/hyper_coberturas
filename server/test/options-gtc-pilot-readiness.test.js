const test = require('node:test');
const assert = require('node:assert/strict');
const { assess, checkPolicy, summaryLines } =
  require('../src/scripts/options-gtc-pilot-readiness');

const input = {
  userId:1,symbol:'ETH-261023-2500-C',
  quantity:'0.01',maxLimit:'23.60',
};
const env = {
  OPTIONS_LIVE_TRADING_ENABLED:'false',
  OPTIONS_LIVE_PRODUCTION_APPROVED:'false',
  OPTIONS_LIVE_PILOT_AUTHORIZED:'false',
};
const strategy = {
  readOnly:true,pilotReady:false,status:'strategy_candidate',
  candidateStrategyId:2,
};
const quote = {
  readOnly:true,pilotReady:false,eligible:true,technicalStatus:'pass',
  publicOrder:{symbol:input.symbol,quantity:input.quantity,
    limitPrice:input.maxLimit},
};
const deps = {
  input,client:{},env,now:()=>Date.UTC(2026,9,17,18,30),
  inspectFn:async()=>strategy,
  previewFn:async()=>quote,
};

test('GTC preparation preserves FOK BUY, resident GTC TP after fill and never returns approval',async()=>{
  const report = await assess(deps);
  assert.equal(report.status,'candidate');
  assert.equal(report.readOnly,true);
  assert.equal(report.pilotReady,false);
  assert.equal(report.checks.exchangeGtc,true);
  assert.equal(report.checks.ethFokEntry,true);
  const lines=summaryLines(report).join('\n');
  assert.match(lines,/gtc_pilot_take_profit_tif=GTC/);
  assert.match(lines,/gtc_pilot_take_profit_placement=after_confirmed_fill/);
  assert.match(lines,/gtc_pilot_partial_fill_dust_resolution=unverified/);
  assert.match(lines,/pilot_ready=no/);
  assert.doesNotMatch(lines,/pilot_ready=yes/);
});

test('if flags are enabled no market/account or DB inspection is permitted',async()=>{
  let calls=0;
  const report=await assess({...deps,env:{...env,OPTIONS_LIVE_TRADING_ENABLED:'true'},
    inspectFn:async()=>{calls++;throw Error('Must not be called');},
    previewFn:async()=>{calls++;throw Error('Must not be called');},
  });
  assert.equal(report.status,'blocked');
  assert.equal(calls,0);
  assert.equal(report.checks.liveOff,false);
});

test('fails on wrong account, size, or risk budget without sending anything',async()=>{
  for(const candidate of [
    {...input,userId:2},
    {...input,quantity:'0.02'},
    {...input,maxLimit:'25.00'}, // gross .25, total .275 exceeds 0.26 capital
    {...input,maxLimit:'50.00'},
  ]){
    let attempts=0;
    const outcome=await assess({...deps,input:candidate,
      inspectFn:async()=>{attempts++;return strategy;},
      previewFn:async()=>{attempts++;return quote;},
    });
    assert.equal(outcome.status,'blocked');
    assert.equal(outcome.pilotReady,false);
    assert.equal(outcome.checks.riskBudget,Number(candidate.maxLimit)<=23.60 &&
      Number(candidate.quantity)===0.01);
  }
});

test('market drift, missing quote and unprepared strategy cannot be approved',async()=>{
  for(const q of [
    {...quote,eligible:false,technicalStatus:'blocked'},
    {...quote,publicOrder:{...quote.publicOrder,symbol:'ETH-261023-3000-C'}},
    null,
  ]){
    assert.equal((await assess({...deps,previewFn:async()=>q})).status,'blocked');
  }
  let previewCalls=0;
  const out=await assess({...deps,
    inspectFn:async()=>({...strategy,status:'strategy_not_ready'}),
    previewFn:async()=>{previewCalls++;return quote;},
  });
  assert.equal(out.status,'blocked');
  assert.equal(previewCalls,0);
});

test('only validated summaries may be written; no private quote or account fields emitted',()=>{
  const checks=checkPolicy({input,quote,strategy,env});
  const line=summaryLines({readOnly:true,pilotReady:false,status:'candidate',checks}).join('\n');
  assert.doesNotMatch(line,/ETH-261023|23\.60|balance|userId/);
  assert.throws(()=>summaryLines({readOnly:false,pilotReady:true,status:'candidate',checks}));
  assert.throws(()=>summaryLines({readOnly:true,pilotReady:false,status:'candidate',
    checks:{...checks,liveOff:false}}));
});
