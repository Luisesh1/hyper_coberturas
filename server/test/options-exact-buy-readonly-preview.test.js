const test=require('node:test');
const assert=require('node:assert/strict');
const {parseInputs,bestBook,availableUsdt,preview,outputLines,CAP_USDT}=
 require('../src/scripts/options-exact-buy-readonly-preview');

const now=Date.UTC(2026,9,16,23,0);
const symbol='ETH-261023-2500-C';
const request={userId:1,symbol,quantity:'0.01',maxLimit:'23.60'};
const flagsOff={OPTIONS_LIVE_TRADING_ENABLED:'false',
  OPTIONS_LIVE_PRODUCTION_APPROVED:'false'};
function fixture(overrides={}){
 return {
  getExchangeInfo:async()=>({optionSymbols:[{
   symbol,status:'TRADING',underlying:'ETHUSDT',quoteAsset:'USDT',
   unit:1,expiryDate:now+7*86400000,
   filters:[{filterType:'PRICE_FILTER',minPrice:'0',maxPrice:'10000',
      tickSize:'0.10'},
    {filterType:'LOT_SIZE',minQty:'0.01',maxQty:'100',stepSize:'0.01'}],
  }]}),
  getTicker:async()=>({symbol,bidPrice:'23.40',askPrice:'23.60'}),
  getDepth:async()=>({T:now,bids:[['23.40','0.10']],asks:[['23.60','0.10']]}),
  getAccount:async()=>({asset:[{asset:'USDT',available:'5.00',
    equity:'1000',marginBalance:'1000'}]}),
  getApiRestrictions:async()=>({ipRestrict:true,enableWithdrawals:false,
   enableReading:true,enableVanillaOptions:true}),
  getPositions:async()=>[],
  getOpenOrders:async()=>[],
  placeOrder:()=>{throw Error('MUST NEVER PLACE AN ORDER');},
  cancelOrder:()=>{throw Error('MUST NEVER CANCEL AN ORDER');},
  ...overrides,
 };
}
const calculate=(client=fixture(),env=flagsOff)=>
 preview({client,input:request,at:now,now:()=>now,env});

test('strict preview inputs never authorize a trade or exceed conservative cap',()=>{
 assert.deepEqual(parseInputs(['1',symbol,'0.01','23.60']),request);
 for(const args of [
  ['1',symbol,'0.01','100000'],['1','BTC-261023-50000-C','0.01','23.60'],
  ['1',symbol,'-0.01','23.60'],['1',symbol,'0.01','0'],
  ['bad',symbol,'0.01','23.60'],
 ]) assert.throws(()=>parseInputs(args));
 assert.equal(CAP_USDT,20);
});

test('exact ETH GET-only preview preserves user-quoted max and never arms live',async()=>{
 const report=await calculate();
 assert.equal(report.technicalStatus,'pass');
 assert.equal(report.eligible,true);
 assert.equal(report.pilotReady,false);
 assert.equal(report.entryPremiumCapUsdt,0.24);
 assert.equal(report.entryFeeReserveUsdt,0.03);
 assert.equal(report.entryTotalCapUsdt,0.26);
 const lines=outputLines(report).join('\n');
 assert.match(lines,/preview_symbol=ETH-261023-2500-C/);
 assert.match(lines,/preview_limit_usdt=23.60/);
 assert.match(lines,/preview_balanceEnough=pass/);
 assert.match(lines,/preview_effective_fee_tier=unverified/);
 assert.match(lines,/preview_strategy_verified=unverified/);
 assert.match(lines,/pilot_ready=no/);
 assert.doesNotMatch(lines,/availableBalance|equity|1000|userId|apiKey/);
});

test('equity or marginBalance is never substituted for available funds',async()=>{
 assert.equal(availableUsdt({asset:[{asset:'USDT',equity:'9999',
   marginBalance:'9999'}]}),null);
 assert.equal(availableUsdt({asset:[{asset:'USDT',available:'0.2'}]}),.2);
 assert.equal(availableUsdt({asset:[{asset:'USDT',availableBalance:'1000'}]}),null);
 const result=await calculate(fixture({getAccount:async()=>
  ({asset:[{asset:'USDT',marginBalance:'1000',equity:'1000'}]})}));
 assert.equal(result.technicalStatus,'unverified');
 assert.equal(result.checks.balanceKnown,false);
 assert.equal(result.checks.balanceEnough,null);
 assert.match(outputLines(result).join('\n'),/preview_balanceEnough=unverified/);
});

test('too little available balance always blocks, without publishing its value',async()=>{
 const result=await calculate(fixture({getAccount:async()=>
  ({asset:[{asset:'USDT',available:'0.20'}]})}));
 assert.equal(result.technicalStatus,'blocked');
 assert.equal(result.eligible,false);
 assert.match(outputLines(result).join('\n'),/preview_balanceEnough=fail/);
 assert.doesNotMatch(outputLines(result).join('\n'),/0\.20/);
});

test('ask above authorized limit, wide spread and thin depth block',async()=>{
 const risen=await calculate(fixture({getTicker:async()=>
  ({symbol,bidPrice:'23.40',askPrice:'23.70'})}));
 assert.equal(risen.technicalStatus,'blocked');
 assert.equal(risen.checks.quoteValid,false);
 assert.equal(risen.checks.marketQuotePresent,true);
 assert.equal(risen.checks.priceWithinLimit,false);
 assert.equal(risen.checks.exactFilters,true);
 assert.match(outputLines(risen).join('\n'),/preview_ask_usdt=23.70/);
 assert.match(outputLines(risen).join('\n'),/preview_market_reason=ask_above_limit/);
 const thin=await calculate(fixture({getDepth:async()=>
  ({T:now,bids:[['23.40','0.001']],asks:[['23.60','0.10']]})}));
 assert.equal(thin.checks.liquidity,false);
 assert.equal(bestBook({bids:[['20','1']],asks:[['23.6','1']]},.01,23.6),null);
});

test('non isolated account or unsafe permissions fail closed',async()=>{
 const orders=await calculate(fixture({getOpenOrders:async()=>[{orderId:'PRIVATE'}]}));
 assert.equal(orders.checks.isolated,false);
 const unsafe=await calculate(fixture({getApiRestrictions:async()=>
  ({ipRestrict:false,enableWithdrawals:true})}));
 assert.equal(unsafe.technicalStatus,'blocked');
 const flags=await calculate(fixture(),{...flagsOff,OPTIONS_LIVE_TRADING_ENABLED:'true'});
 assert.equal(flags.checks.flagsOff,false);
});

test('sanitizer rejects spoofed ready signal and excessive costs',async()=>{
 const result=await calculate();
 assert.throws(()=>outputLines({...result,pilotReady:true}));
 assert.throws(()=>outputLines({...result,entryTotalCapUsdt:30}));
});

test('deploy only previews GET-only buy without exposing account or placing orders',()=>{
 const fs=require('node:fs');
 const path=require('node:path');
 const deploy=fs.readFileSync(path.resolve(__dirname,
   '../../.github/workflows/deploy.yml'),'utf8');
 const step=deploy.split('- name: Verificar BUY ETH exacto y fondos disponibles')[1];
 assert.ok(step);
 assert.match(step,/options-exact-buy-readonly-preview\.js 1 ETH-261023-2500-C 0\.01 23\.60/);
 assert.match(step,/pilot_ready=no/);
 assert.match(step,/preview_balanceEnough|balanceEnough/);
 assert.match(step,/NO OPERAR/);
 assert.doesNotMatch(step,/placeOrder|cancelOrder|OPTIONS_LIVE_TRADING_ENABLED:\s*"true"/);
});

test('Binance quote outage is not misreported as an expensive valid ask',async()=>{
 const unavailable=await calculate(fixture({getTicker:async()=>{throw Error('timeout');}}));
 assert.equal(unavailable.checks.marketQuotePresent,false);
 assert.equal(unavailable.publicOrder.reason,'quote_unavailable');
 assert.match(outputLines(unavailable).join('\n'),/preview_ask_usdt=unverified/);
 assert.equal(unavailable.technicalStatus,'blocked');
});

test('read-only preview fails on stale/missing depth timestamps, even when bid/ask look valid',async()=>{
 for(const T of [undefined,now-11_000,now+2000]){
  const f=fixture({getDepth:async()=>({
   ...(T===undefined?{}:{T}),bids:[['23.40','0.10']],asks:[['23.60','0.10']],
  })});
  const result=await calculate(f);
  assert.equal(result.checks.bookFresh,false);
  assert.equal(result.checks.liquidity,false);
  assert.equal(result.technicalStatus,'blocked');
  assert.equal(result.publicOrder.reason,'depth_missing_or_stale');
 }
});

test('full-size limit can sweep multiple fresh levels but never pay above approved max',async()=>{
 const book={T:now,bids:[['23.40','0.006'],['23.30','0.004']],
  asks:[['23.50','0.006'],['23.60','0.004']]};
 const result=await calculate(fixture({
  getDepth:async()=>book,
  getTicker:async()=>({symbol,bidPrice:'23.40',askPrice:'23.50'}),
 }));
 assert.equal(result.checks.liquidity,true);
 assert.equal(result.eligible,true);
 assert.equal(bestBook(book,0.01,23.6).worstAsk,23.6);
 assert.equal(bestBook(book,0.01,23.5),null);
 const insufficient=await calculate(fixture({
  getDepth:async()=>({...book,asks:[['23.50','0.005'],['23.70','0.005']]}),
  getTicker:async()=>({symbol,bidPrice:'23.40',askPrice:'23.50'}),
 }));
 assert.equal(insufficient.checks.liquidity,false);
});
