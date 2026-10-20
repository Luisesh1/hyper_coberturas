/**
 * ETH-261030-2550-C exact BUY pilot: read-only diagnostics (no POST/DELETE).
 * Account's actual Options taker rate comes from signed GET /eapi/v1/commission.
 * No trading approval: the option and book can change immediately.
 */
'use strict';
const {parseInputs,preview}=require('./options-exact-buy-readonly-preview');
const {adjust}=require('./options-pilot-adjust-independent-budget-paused');
const {getClientForUser}=require('../services/options/options-credentials.service');

const SYMBOL='ETH-261030-2550-C', QUANTITY=0.01;
const MAX_PRICE=36, MAX_PREMIUM=0.36, MAX_CAPITAL=0.40;
const roundUp=x=>Math.ceil((x-1e-10)*100)/100;
function flagsOff(env){
  return env.OPTIONS_LIVE_TRADING_ENABLED==='false' &&
    env.OPTIONS_LIVE_PRODUCTION_APPROVED==='false' &&
    env.OPTIONS_LIVE_PILOT_AUTHORIZED!=='true';
}
function commissionRate(raw){
  const rows=raw?.commissions;
  if(!Array.isArray(rows))return null;
  const eth=rows.filter(x=>x?.underlying==='ETHUSDT');
  if(eth.length!==1)return null;
  const n=Number(eth[0].takerFee);
  return Number.isFinite(n)&&n>=0&&n<=0.05?n:null;
}
async function assess({client,input,env=process.env,now=Date.now,
  previewFn=preview,budgetFn=adjust}={}){
  if(!flagsOff(env))return {status:'blocked',checks:{flagsOff:false},
    price:null,feeCost:null,feeVerified:false,ordersSent:0};
  if(input?.userId!==1 || input?.symbol!==SYMBOL ||
     Number(input.quantity)!==QUANTITY || Number(input.maxLimit)!==MAX_PRICE)
    throw Error('Only the exact previously approved ETH pilot can be verified');
  const budget=await budgetFn({env,verifyOnly:true});
  const paused=budget?.status==='verified'&&budget?.ordersSent===0&&budget?.liveEnabled===false;
  const q=await previewFn({client,input,env,at:now(),now});
  const quotePass=q?.readOnly===true&&q?.pilotReady===false&&
    q?.eligible===true&&q?.technicalStatus==='pass';
  const quoteFresh=Number.isFinite(q?.reviewedAt) &&
    now()-q.reviewedAt>=0 && now()-q.reviewedAt<=10000;
  const [fee,index]=await Promise.allSettled([
    client.getUserCommission(),client.getIndex('ETHUSDT'),
  ]);
  const rate=fee.status==='fulfilled'?commissionRate(fee.value):null;
  const indexPrice=index.status==='fulfilled'?Number(index.value?.indexPrice):NaN;
  const indexTime=index.status==='fulfilled'?Number(index.value?.time):NaN;
  const indexFresh=Number.isSafeInteger(indexTime)&&
    Math.abs(now()-indexTime)<=15000;
  const feeVerified=rate!==null && Number.isFinite(indexPrice)&&
    indexPrice>0 && indexFresh;
  // User-specific taker fee as per Binance formula; 10% premium ceiling.
  // The maximum is calculated for the WHOLE approved limit, not just best ask.
  const feeCost=feeVerified?
    Math.min(rate*indexPrice*QUANTITY,MAX_PREMIUM*0.10):null;
  const total=feeCost==null?null:roundUp(MAX_PREMIUM+feeCost);
  const checks={flagsOff:true,pausedBudget:paused,quotePass,
    quoteFresh,feeVerified,withinCapital:total!==null&&total<=MAX_CAPITAL+1e-9};
  const status=Object.values(checks).every(Boolean)?'candidate':
    !feeVerified?'unverified':'blocked';
  return {status,checks,price:q?.publicOrder||null,feeCost,total,
    feeVerified,ordersSent:0};
}
function lines(r){
  if(!r||!['candidate','blocked','unverified'].includes(r.status)||
     r.ordersSent!==0||!r.checks)throw Error('Unsafe ETH diagnostic');
  const keys=['flagsOff','pausedBudget','quotePass','quoteFresh',
    'feeVerified','withinCapital'];
  if(keys.some(k=>typeof r.checks[k]!=='boolean'))throw Error('Missing required gate');
  if(r.status==='candidate' && keys.some(k=>!r.checks[k]))
    throw Error('Invalid candidate');
  const bid=r.price?.bid,ask=r.price?.ask;
  return [
    'exact_eth_preflight_read_only=yes',
    'exact_eth_status='+r.status,
    'exact_eth_contract='+SYMBOL,
    'exact_eth_quantity=0.01',
    'exact_eth_price_cap_usdt=36.00',
    'exact_eth_premium_cap_usdt=0.36',
    'exact_eth_capital_cap_usdt=0.40',
    'exact_eth_ask_usdt='+(ask==null?'unverified':String(ask)),
    'exact_eth_bid_usdt='+(bid==null?'unverified':String(bid)),
    ...keys.map(k=>'exact_eth_'+k+'='+(r.checks[k]?'pass':'fail')),
    'exact_eth_commission_get='+(r.feeVerified?'verified':'unverified'),
    'exact_eth_estimated_entry_fee_usdt='+
      (r.feeCost==null?'unverified':r.feeCost.toFixed(6)),
    'exact_eth_max_entry_total_usdt='+
      (r.total==null?'unverified':r.total.toFixed(2)),
    'exact_eth_future_exit_fee=unverified',
    'exact_eth_orders_sent=0','pilot_ready=no',
  ];
}
async function main(){
  if(process.argv.length!==7||process.argv[2]!=='--read-only')
    throw Error('Read-only argument required');
  const input=parseInputs(process.argv.slice(3));
  if(!flagsOff(process.env))throw Error('Trading must be off');
  const client=await getClientForUser(1);
  lines(await assess({client,input})).forEach(x=>console.log(x));
}
if(require.main===module)main().catch(()=>{
  console.log('exact_eth_status=unavailable');
  console.log('exact_eth_orders_sent=0');
  console.log('pilot_ready=no');
  process.exitCode=1;
});
module.exports={flagsOff,commissionRate,assess,lines};
