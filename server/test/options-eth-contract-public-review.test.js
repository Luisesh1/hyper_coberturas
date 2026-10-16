const test = require('node:test');
const assert = require('node:assert/strict');
const { findCandidates, executableBook, review, outputLines } =
  require('../src/scripts/options-eth-contract-public-review');

const at = Date.UTC(2026,9,16);
const symbol = 'ETH-261030-4000-C';
function feed({delta='0.40', ask='25.00', bid='24.00', qty='0.01', iv='0.55',
  unit=1, expiry=at+14*86400000}={}) {
  return {
    exchange: { optionSymbols: [{ symbol, status:'TRADING', underlying:'ETHUSDT',
      quoteAsset:'USDT', expiryDate:expiry, strikePrice:'4000', unit,
      filters:[
        {filterType:'PRICE_FILTER',minPrice:'0.01',maxPrice:'10000',tickSize:'0.01'},
        {filterType:'LOT_SIZE', minQty:qty,maxQty:'100',stepSize:'0.01'},
      ],
    }] },
    tickers:[{ symbol, bidPrice:bid, askPrice:ask }],
    marks:[{ symbol, delta, markPrice:'25.00', markIV:iv }],
    index:{ indexPrice:'3900.00' }, at,
  };
}
function client(input=feed(), book={asks:[['25.00','10']],bids:[['24.00','10']]}) {
  return {
    getExchangeInfo:async()=>input.exchange,
    getTicker:async()=>input.tickers,
    getMark:async()=>input.marks,
    getIndex:async()=>input.index,
    getDepth:async()=>book,
    placeOrder:()=>{throw Error('NEVER PLACE ORDER');},
  };
}
test('minimum lot, Greeks and conservative budget, no account reads',async()=>{
  const input=feed();
  const found=findCandidates(input);
  assert.equal(found.length,1);
  assert.equal(found[0].worstEntryEstimate,0.28);
  const result=await review(client(input),at);
  assert.equal(result.pilotReady,false);
  assert.equal(result.candidates.length,1);
  const lines=outputLines(result).join('\n');
  assert.match(lines,/review_candidate_1_delta=0.4000/);
  assert.match(lines,/review_candidate_1_strike=4000/);
  assert.match(lines,/review_candidate_1_entry_cost_cap_usdt=0.28/);
  assert.match(lines,/review_effective_fees=unverified/);
  assert.match(lines,/pilot_ready=no/);
});
test('risk filters discard far OTM, stale expiry, wide spread and cost >20',()=>{
  assert.deepEqual(findCandidates(feed({delta:'0.01'})),[]);
  assert.deepEqual(findCandidates(feed({expiry:at+86400000})),[]);
  assert.deepEqual(findCandidates(feed({ask:'50.00',bid:'40.00'})),[]);
  assert.deepEqual(findCandidates(feed({ask:'3000',bid:'2900'})),[]);
  assert.deepEqual(findCandidates(feed({iv:'0'})),[]);
});
test('book must have executable minimum size at the advertised ask',()=>{
  const c=findCandidates(feed())[0];
  assert.equal(executableBook({asks:[['25','0.001']],bids:[['24','10']]},c),false);
  assert.equal(executableBook({asks:[['25.1','10']],bids:[['24','10']]},c),false);
  assert.equal(executableBook({asks:[['25','10']],bids:[['20','10']]},c),false);
  assert.equal(executableBook({asks:[['25','10']],bids:[['24','10']]},c),true);
});
test('no valid delta: no trade, no invented contracts',async()=>{
  const result=await review(client(feed({delta:'0.01'})),at);
  assert.equal(result.candidates.length,0);
  assert.match(outputLines(result).join('\n'),/review_status=no_candidate/);
  assert.match(outputLines(result).join('\n'),/pilot_ready=no/);
});
test('output is public market only and rejects fake readiness',async()=>{
  const result=await review(client(),at);
  result.privateBalance='DO_NOT_EMIT';
  result.privateUserId=900;
  const out=outputLines(result).join('\n');
  assert.doesNotMatch(out,/DO_NOT_EMIT|privateUserId/);
  assert.throws(()=>outputLines({...result,pilotReady:true}));
});
