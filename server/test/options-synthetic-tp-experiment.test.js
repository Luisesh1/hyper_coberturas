const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPilotSyntheticTpEligible, experimentalModeEnabled, fixedTargetPrice,
} = require('../src/services/options/options-synthetic-tp-experiment');
const params={takeProfitMode:'fixed',takeProfitPct:50,stopLossPct:50,
  exitHoursBeforeExpiry:24,maxOpenPositions:1};
const candidate={strategyId:2,userId:1,mode:'live',symbol:'ETH-261023-2500-C',
  side:'BUY',quantity:.01,entryPrice:23.6,params};

test('synthetic TP feature requires an exact two-key experiment opt-in',()=>{
  assert.equal(experimentalModeEnabled({}),false);
  assert.equal(experimentalModeEnabled({OPTIONS_ETH_SYNTHETIC_TP_EXPERIMENT:'true'}),false);
  assert.equal(experimentalModeEnabled({OPTIONS_ETH_SYNTHETIC_TP_EXPERIMENT:'true',
    OPTIONS_ETH_SYNTHETIC_TP_EXPERIMENT_ACK:'NO_EXCHANGE_STOP'}),true);
});
test('synthetic TP can only match the exact one-contract pilot, never other bots',()=>{
  assert.equal(isPilotSyntheticTpEligible({candidate,enabled:false}),false);
  assert.equal(isPilotSyntheticTpEligible({candidate,enabled:true}),true);
  const variants=[
    {...candidate,userId:7}, {...candidate,strategyId:7},
    {...candidate,symbol:'BTC-261023-2500-C'},
    {...candidate,side:'SELL'}, {...candidate,quantity:.005},
    {...candidate,quantity:.02}, {...candidate,mode:'paused'},
    {...candidate,params:{...params,takeProfitMode:'volatility'}},
    {...candidate,params:{...params,stopLossPct:20}},
  ];
  for(const item of variants){
    assert.equal(isPilotSyntheticTpEligible({candidate:item,enabled:true}),false,
      JSON.stringify(item));
  }
});
test('fixed target is based on confirmed entry premium, not mark or last price',()=>{
  assert.ok(Math.abs(fixedTargetPrice(candidate,params)-35.4)<1e-8);
  assert.throws(()=>fixedTargetPrice({...candidate,entryPrice:0},params));
  assert.throws(()=>fixedTargetPrice({...candidate,side:'SELL'},params));
});
