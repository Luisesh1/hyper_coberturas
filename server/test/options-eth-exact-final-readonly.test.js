const test=require('node:test');
const assert=require('node:assert/strict');
const {commissionRate,assess,lines}=
  require('../src/scripts/options-eth-exact-final-readonly');
const at=Date.UTC(2026,9,20,20);
const env={OPTIONS_LIVE_TRADING_ENABLED:'false',
 OPTIONS_LIVE_PRODUCTION_APPROVED:'false',
 OPTIONS_LIVE_PILOT_AUTHORIZED:'false'};
const input={userId:1,symbol:'ETH-261030-2550-C',
  quantity:'0.01',maxLimit:'36.00'};
const client={
 getUserCommission:async()=>({commissions:[{
  underlying:'ETHUSDT',makerFee:'0.00024',takerFee:'0.00024'}]}),
 getIndex:async()=>({time:at,indexPrice:'2500'}),
 placeOrder:()=>{throw Error('POST FORBIDDEN')},
 cancelOrder:()=>{throw Error('DELETE FORBIDDEN')},
};
const previewFn=async()=>({readOnly:true,pilotReady:false,
 eligible:true,technicalStatus:'pass',reviewedAt:at,
 publicOrder:{symbol:input.symbol,bid:'34.2',ask:'34.4'}});
const budgetFn=async()=>({status:'verified',ordersSent:0,liveEnabled:false});
const run=(overrides={})=>assess({client,input,env,previewFn,budgetFn,
 now:()=>at,...overrides});
test('signed GET fee and exact 0.36/0.40 limit returns candidate WITHOUT approval',async()=>{
 const r=await run();
 assert.equal(r.status,'candidate');
 assert.equal(r.total,0.37);
 const s=lines(r).join('\n');
 assert.match(s,/exact_eth_commission_get=verified/);
 assert.match(s,/exact_eth_max_entry_total_usdt=0.37/);
 assert.match(s,/exact_eth_orders_sent=0/);
 assert.match(s,/pilot_ready=no/);
 assert.doesNotMatch(s,/takerFee|makerFee|2500|userId|apiKey/);
 assert.equal(commissionRate({commissions:[]}),null);
});
test('quote above cap, unexpected budget or commission denies candidate',async()=>{
 assert.equal((await run({previewFn:async()=>({...await previewFn(),
  technicalStatus:'blocked',eligible:false})})).status,'blocked');
 assert.equal((await run({budgetFn:async()=>({status:'blocked'})})).status,'blocked');
 const noFees=await run({client:{...client,getUserCommission:async()=>({commissions:[]})}});
 assert.equal(noFees.status,'unverified');
 assert.match(lines(noFees).join('\n'),/exact_eth_commission_get=unverified/);
 assert.notEqual((await run({now:()=>at+20000})).status,'candidate');
 await assert.rejects(run({input:{...input,maxLimit:'36.10'}}));
});
test('live flags refuse to query private account at all',async()=>{
 let count=0;
 const c={getUserCommission:()=>{count++;},getIndex:()=>{count++;}};
 const r=await run({env:{...env,OPTIONS_LIVE_TRADING_ENABLED:'true'},client:c});
 assert.equal(r.status,'blocked');assert.equal(count,0);
});
