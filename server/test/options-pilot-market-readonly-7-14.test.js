const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {select,screen,lines,MIN_DAYS,MAX_DAYS,COST_CAP,MIN_QTY}=
 require('../src/scripts/options-pilot-market-readonly-7-14');
const DAY=86400000;
function candidate(dte,cost,delta=0.35,type='CALL',quantity=0.01){
 return {type,quantity,worstEntryEstimate:cost,delta,expiry:1000+dte*DAY};
}
test('limits to 7-14 day one-lot cheap CALLs, prioritizes delta',()=>{
 const rows=[candidate(5,.2),candidate(7,.22,.28),
 candidate(12,.24,.34),candidate(14,.25,.36),
 candidate(15,.18),candidate(10,.3),
 candidate(10,.2,.33,'PUT'),candidate(10,.2,.33,'CALL',.02)];
 const found=select(rows,1000);
 assert.equal(found.length,3);
 assert.deepEqual(found.map(x=>x.delta),[.34,.36,.28]);
 assert.equal(COST_CAP,.26);
 assert.equal(MIN_QTY,.01);
 assert.equal(MIN_DAYS,7);
 assert.equal(MAX_DAYS,14);
});
test('empty market is read-only and cannot authorize trading',async()=>{
 const fake={
  getExchangeInfo:async()=>({optionSymbols:[]}),
  getTicker:async()=>[],
  getMark:async()=>[],
  getIndex:async()=>({indexPrice:'2500'}),
  getDepth:async()=>{throw Error('No depth needed')},
 };
 const result=await screen(fake,{at:1000,now:()=>1000});
 assert.equal(result.readOnly,true);
 assert.equal(result.status,'no_premium_candidate');
 assert.equal(result.books,0);
 assert.match(lines(result).join('\n'),/pilot_ready=no/);
 assert.match(lines(result).join('\n'),/pilot_7_14_market_orders_sent=0/);
});
test('blocks malformed safety output',()=>{
 assert.throws(()=>lines({readOnly:true,ready:true,cap:.26,window:'7_14',
  books:0,compatibleContracts:0,status:'market_candidate'}));
 assert.throws(()=>lines({readOnly:true,ready:false,cap:20,window:'7_14',
  books:0,compatibleContracts:0,status:'market_candidate'}));
});
test('source has no authenticated account reads, DB writes or trading calls',()=>{
 const src=fs.readFileSync(path.resolve(__dirname,
  '../src/scripts/options-pilot-market-readonly-7-14.js'),'utf8');
 assert.doesNotMatch(src,/\.placeOrder\(|\.cancelOrder\(|\.getAccount\(|\.getPositions\(|\.getOpenOrders\(|\.setMode\(|INSERT INTO|UPDATE options_strategies/);
});
