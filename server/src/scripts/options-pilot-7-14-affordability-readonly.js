/**
 * Cheapest executable ETH CALL quote within 7–14 days and the user's
 * authorized <=20 USD per-order envelope. Public GET only, USDT estimates,
 * no account balances, order submission, strategy mutation, or approval.
 */
'use strict';
const {createBinanceOptionsClient}=
  require('../services/options/binance-options.client');
const {findCandidates,executableBook}=
  require('./options-eth-contract-public-review');
const DAY=86400000;
const MAX_USDT=20;
const MAX_BOOKS=20;
const BOOK_MAX_AGE=10000;
const LIMIT_QTY=.01;

function range(candidates,at){
  return (Array.isArray(candidates)?candidates:[])
    .filter(c=>c.type==='CALL' && c.quantity===LIMIT_QTY &&
      c.expiry>=at+7*DAY && c.expiry<=at+14*DAY &&
      c.worstEntryEstimate<=MAX_USDT)
    .sort((a,b)=>a.worstEntryEstimate-b.worstEntryEstimate ||
      Math.abs(a.delta-.35)-Math.abs(b.delta-.35));
}
async function inspect(client,{at=Date.now(),now=Date.now}={}){
  const [exchange,tickers,marks,index]=await Promise.all([
    client.getExchangeInfo(),client.getTicker(),client.getMark(),
    client.getIndex('ETHUSDT'),
  ]);
  const candidates=range(findCandidates({exchange,tickers,marks,index,at}),at);
  let selected=null,booksChecked=0;
  for(const c of candidates.slice(0,MAX_BOOKS)){
    booksChecked++;
    let book;
    try { book=await client.getDepth(c.symbol,20); } catch {continue}
    const timestamp=Number(book?.T),current=now();
    if(!Number.isSafeInteger(timestamp)||
       timestamp<current-BOOK_MAX_AGE||timestamp>current+1000)continue;
    if(!executableBook(book,c))continue;
    selected=c;
    break;
  }
  return {readOnly:true,pilotReady:false,status:
    selected?'liquid_candidate':candidates.length?'depth_unverified':'no_quote',
    callsQuoted:candidates.length,booksChecked,
    publicQuote:selected&&{
      symbol:selected.symbol,expiry:new Date(selected.expiry).toISOString(),
      bid:selected.bid,ask:selected.ask,qty:selected.quantity,delta:selected.delta,
      estimatedCost:selected.worstEntryEstimate,
    },
  };
}
function lines(r){
  if(!r||r.readOnly!==true||r.pilotReady!==false||
    !['liquid_candidate','depth_unverified','no_quote'].includes(r.status)||
    !Number.isSafeInteger(r.callsQuoted)||r.callsQuoted<0||
    !Number.isSafeInteger(r.booksChecked)||r.booksChecked<0||
    r.booksChecked>MAX_BOOKS||
    Boolean(r.publicQuote)!==(r.status==='liquid_candidate')||
    (r.publicQuote&&(
      !/^ETH-\d{6}-\d+(?:\.\d+)?-C$/.test(r.publicQuote.symbol)||
      !(r.publicQuote.estimatedCost>0&&r.publicQuote.estimatedCost<=MAX_USDT)||
      r.publicQuote.qty!==LIMIT_QTY ||
      !Number.isFinite(r.publicQuote.ask)||
      !Number.isFinite(r.publicQuote.bid))))
    throw Error('Invalid public market price scan output');
  const v=[
    'pilot_7_14_affordability_read_only=yes',
    'pilot_7_14_affordability_cap_usdt=20',
    'pilot_7_14_affordability_status='+r.status,
    'pilot_7_14_affordability_quoted_calls='+r.callsQuoted,
    'pilot_7_14_affordability_books_checked='+r.booksChecked,
  ];
  if(r.publicQuote){
    const p=r.publicQuote;
    v.push('pilot_7_14_affordability_symbol='+p.symbol);
    v.push('pilot_7_14_affordability_expiry='+p.expiry);
    v.push('pilot_7_14_affordability_bid_usdt='+p.bid);
    v.push('pilot_7_14_affordability_ask_usdt='+p.ask);
    v.push('pilot_7_14_affordability_quantity='+p.qty);
    v.push('pilot_7_14_affordability_delta='+p.delta);
    v.push('pilot_7_14_affordability_max_estimated_cost_usdt='+p.estimatedCost);
  }
  v.push('pilot_7_14_affordability_effective_fees=unverified');
  v.push('pilot_7_14_affordability_usd_conversion=unverified');
  v.push('pilot_7_14_affordability_orders_sent=0');
  v.push('pilot_ready=no');
  return v;
}
async function main(){
  if(process.argv.length!==3||process.argv[2]!=='--read-only')
    throw Error('Read-only explicit argument required');
  lines(await inspect(createBinanceOptionsClient())).forEach(x=>console.log(x));
}
if(require.main===module){
  main().catch(()=>{
    console.log('pilot_7_14_affordability_status=unavailable');
    console.log('pilot_7_14_affordability_orders_sent=0');
    console.log('pilot_ready=no');
    process.exitCode=1;
  });
}
module.exports={inspect,range,lines,MAX_USDT,LIMIT_QTY};
