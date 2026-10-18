/**
 * Read-only actual market screen for independent ETH 7–14 day CALL pilot.
 * This is not a trade permit or user/account exposure certification.
 * Only queries public Binance endpoints, no DB, no signed account requests.
 */
'use strict';
const {createBinanceOptionsClient}=
  require('../services/options/binance-options.client');
const {findCandidates,executableBook}=
  require('./options-eth-contract-public-review');

const MIN_DAYS=7;
const MAX_DAYS=14;
const COST_CAP=0.26;
const MIN_QTY=0.01;
const MAX_BOOKS=15;
const DAY_MS=86400000;
const FRESH_MS=10000;
function select(publicCandidates,now){
  if(!Array.isArray(publicCandidates))return [];
  return publicCandidates.filter(c=>
    c.type==='CALL' && Number(c.quantity)===MIN_QTY &&
    Number(c.worstEntryEstimate)<=COST_CAP &&
    Number(c.expiry)-now>=MIN_DAYS*DAY_MS &&
    Number(c.expiry)-now<=MAX_DAYS*DAY_MS
  ).sort((a,b)=>Math.abs(a.delta-0.35)-Math.abs(b.delta-0.35) ||
    a.worstEntryEstimate-b.worstEntryEstimate);
}
async function screen(client,{at=Date.now(),now=Date.now}={}){
  const [exchange,tickers,marks,index]=await Promise.all([
    client.getExchangeInfo(),client.getTicker(),client.getMark(),
    client.getIndex('ETHUSDT')]);
  const all=findCandidates({exchange,tickers,marks,index,at});
  const eligible=select(all,at);
  let books=0,validBookFound=false;
  for(const c of eligible.slice(0,MAX_BOOKS)){
    books++;
    let book=null;
    try{book=await client.getDepth(c.symbol,10)}catch{continue}
    const t=Number(book?.T), current=now();
    if(!Number.isSafeInteger(t)||t>current+1000||t<current-FRESH_MS)continue;
    if(executableBook(book,c)){validBookFound=true;break}
  }
  return {
    readOnly:true,ready:false,cap:COST_CAP,window:'7_14',books,
    compatibleContracts:eligible.length,
    status:!eligible.length?'no_premium_candidate':
      validBookFound?'market_candidate':'insufficient_depth',
  };
}
function lines(r){
  if(!r||r.readOnly!==true||r.ready!==false||r.cap!==COST_CAP||
    r.window!=='7_14'||!Number.isSafeInteger(r.books)||
    r.books<0||r.books>MAX_BOOKS||!Number.isSafeInteger(r.compatibleContracts)||
    r.compatibleContracts<0||
    !['no_premium_candidate','market_candidate','insufficient_depth'].includes(r.status))
    throw new Error('Invalid read-only market status');
  return [
    'pilot_7_14_market_read_only=yes',
    'pilot_7_14_market_window=7_14',
    'pilot_7_14_market_entry_cap_usdt=0.26',
    'pilot_7_14_market_compatible_contracts='+r.compatibleContracts,
    'pilot_7_14_market_books_checked='+r.books,
    'pilot_7_14_market_status='+r.status,
    'pilot_7_14_market_orders_sent=0',
    'pilot_ready=no',
  ];
}
async function main(){
  if(process.argv.length!==3||process.argv[2]!=='--read-only')
    throw Error('Explicit read-only argument required');
  const result=await screen(createBinanceOptionsClient());
  lines(result).forEach(x=>console.log(x));
}
if(require.main===module){
  main().catch(()=>{
    console.log('pilot_7_14_market_status=unavailable');
    console.log('pilot_7_14_market_orders_sent=0');
    console.log('pilot_ready=no');
    process.exitCode=1;
  });
}
module.exports={select,screen,lines,MIN_DAYS,MAX_DAYS,COST_CAP,MIN_QTY};
