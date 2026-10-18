const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {range,inspect,lines}=
 require('../src/scripts/options-pilot-7-14-affordability-readonly');
const DAY=86400000,AT=1000;
const candidate=(dte,cost,type='CALL',qty=.01,delta=.35)=>({
 type,quantity:qty,worstEntryEstimate:cost,
 expiry:AT+dte*DAY,delta,ask:cost*80,
});
test('filters actual expiry 7..14, 0.01 CALL and <=20 USDT estimated cost',()=>{
 const a=range([candidate(12,2),candidate(7,1),candidate(14,18),
  candidate(5,.12),candidate(15,.5),candidate(10,20.01),
  candidate(10,.1,'PUT'),candidate(10,.1,'CALL',.02)],AT);
 assert.deepEqual(a.map(x=>x.worstEntryEstimate),[1,2,18]);
});
test('with no quoted contracts, only public GETs and no order attempt',async()=>{
 const fake={
  getExchangeInfo:async()=>({optionSymbols:[]}),
  getTicker:async()=>[],getMark:async()=>[],
  getIndex:async()=>({indexPrice:'2000'}),
  getDepth:async()=>{throw Error('No depth')},
 };
 const r=await inspect(fake,{at:AT,now:()=>AT});
 assert.equal(r.status,'no_quote');
 assert.equal(r.booksChecked,0);
 assert.match(lines(r).join('\n'),/pilot_7_14_affordability_orders_sent=0/);
 assert.match(lines(r).join('\n'),/pilot_ready=no/);
});
test('sanitizer rejects unsupported costs and unreviewed quotes',()=>{
 const quote={symbol:'ETH-261030-2500-C',expiry:'2026-10-30T08:00:00.000Z',
  bid:15,ask:16,qty:.01,delta:.35,estimatedCost:20.01};
 assert.throws(()=>lines({readOnly:true,pilotReady:false,status:'liquid_candidate',
   callsQuoted:1,booksChecked:1,publicQuote:quote}));
 assert.throws(()=>lines({readOnly:true,pilotReady:false,status:'liquid_candidate',
   callsQuoted:1,booksChecked:1,publicQuote:null}));
});
test('source contains no private API/account reads, database writes or Binance POST',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,
  '../src/scripts/options-pilot-7-14-affordability-readonly.js'),'utf8');
 assert.doesNotMatch(source,/\.placeOrder\(|\.cancelOrder\(|\.getAccount\(|\.getPositions\(|\.getOpenOrders\(|UPDATE options_strategies|INSERT INTO/);
});
