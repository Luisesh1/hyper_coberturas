/**
 * Simulated exchange boundary tests for an exact ETH CALL lot of 0.01.
 * Never touch real accounts, credentials or exchange endpoints.
 * These tests DO NOT certify that a live GTC partial position can be closed.
 */
'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {OptionsLiveExecution}=require('../src/services/options/options-live-execution.service');
const SYMBOL='ETH-261030-2550-C';
const ORDER_ID='8214';
const CLIENT_ID='HC77L0';
const NOW=Date.UTC(2026,9,19,0,0,0);
const ORDER_QTY=.01,PARTIAL=.005;

function mockExchange({status='PARTIALLY_FILLED',filled=PARTIAL,
  lotMin='0.01',lotStep='0.01',filtersKnown=true,
  tradesComplete=true,allowCancel=false}={}){
 const calls={getOrder:0,getExchangeInfo:0,getUserTrades:0,cancel:0,
  tradesApplied:[],markedActive:[],finalized:[],audits:[]};
 const order={
  id:77,userId:1,strategyId:13,
  symbol:SYMBOL,side:'SELL',purpose:'take_profit',action:'close',
  status:'active',quantity:ORDER_QTY,processedQty:0,
  orderId:ORDER_ID,clientOrderId:CLIENT_ID,
  createdAt:NOW-120000,deadlineAt:NOW-1000,
  cancelRequested:false,
 };
 const response={
  symbol:SYMBOL,side:'SELL',orderId:ORDER_ID,clientOrderId:CLIENT_ID,
  type:'LIMIT',timeInForce:'GTC',
  quantity:String(ORDER_QTY),executedQty:String(filled),
  status,price:'45.5',
 };
 const client={
  async getOrder(){calls.getOrder++;return {...response}},
  async getExchangeInfo(){calls.getExchangeInfo++;
   return {optionSymbols:[{symbol:SYMBOL,status:'TRADING',filters:
     filtersKnown?[{filterType:'LOT_SIZE',minQty:lotMin,
      stepSize:lotStep,maxQty:'10'}]:[]}]};
  },
  async getUserTrades(){calls.getUserTrades++;
   if(!filled||!tradesComplete)return [];
   return [{orderId:ORDER_ID,symbol:SYMBOL,side:'SELL',
    tradeId:'10012',quantity:String(filled),price:'45.5',
    fee:'0.0001',time:NOW-2000,quoteAsset:'USDT'}];
  },
  async cancelOrder(){calls.cancel++;if(!allowCancel)throw Error('UNEXPECTED_CANCEL');
   response.status='CANCELED';return {status:'CANCELED'};
  },
 };
 const repo={
  async markActive(id,orderId){calls.markedActive.push([id,orderId])},
  async applyTrade(o,trade){calls.tradesApplied.push([o,trade])},
  async finishOrder(...args){calls.finalized.push(args)},
 };
 const executor=new OptionsLiveExecution({
  repo,credentials:{},market:{},enabled:false,now:()=>NOW,
  logger:{warn(kind,details){calls.audits.push({kind,details})}},notify:async()=>{},
  settlement:{reconcileExpired:async()=>{}},
 });
 return {executor,client,order,calls};
}

test('ETH GTC TP 0.005/0.01 stays on Binance and records fill before ATTENTION',async()=>{
 const f=mockExchange();
 await assert.rejects(f.executor.reconcileOrder(f.order,f.client),
  /GTC_PARTIAL_DUST.*keep resting TP/);
 assert.equal(f.calls.cancel,0,'must never cancel only order able to close dust');
 assert.equal(f.calls.markedActive.length,1);
 assert.equal(f.calls.tradesApplied.length,1);
 assert.equal(f.calls.tradesApplied[0][1].quantity,PARTIAL);
 assert.equal(f.calls.finalized.length,0,'never falsely finalize a partial');
 assert.equal(f.calls.getExchangeInfo,1);
 const audit=f.calls.audits.find(x=>x.kind==='options_gtc_partial_exit_incident');
 assert.ok(audit,'a partial TP must produce an incident trace');
 assert.equal(audit.details.observedAt,new Date(NOW).toISOString());
 assert.equal(audit.details.symbol,SYMBOL);
 assert.equal(audit.details.binanceOrderId,ORDER_ID);
 assert.equal(audit.details.originalQty,.01);
 assert.equal(audit.details.executedQty,.005);
 assert.equal(audit.details.remainingQty,.005);
 assert.equal(audit.details.firstFillAt,new Date(NOW-2000).toISOString());
 assert.equal(audit.details.lastFillAt,new Date(NOW-2000).toISOString());
 assert.equal(audit.details.tpOrderPreserved,true);
 assert.equal(audit.details.requiresOperatorReview,true);
});

test('ETH GTC TP incomplete trades: block without cancel or false FINAL',async()=>{
 const f=mockExchange({tradesComplete:false});
 await assert.rejects(f.executor.reconcileOrder(f.order,f.client),
  /trades not yet complete/);
 assert.equal(f.calls.cancel,0);
 assert.equal(f.calls.finalized.length,0);
 assert.equal(f.calls.tradesApplied.length,0);
});

test('ETH GTC missing lot filters: fail closed without sending cancel',async()=>{
 const f=mockExchange({filtersKnown:false});
 await assert.rejects(f.executor.reconcileOrder(f.order,f.client),
  /lot constraints/);
 assert.equal(f.calls.cancel,0);
 assert.equal(f.calls.finalized.length,0);
});

test('ETH GTC terminal canceled partial: do not falsely close remaining 0.005',async()=>{
 const f=mockExchange({status:'CANCELED'});
 await assert.rejects(f.executor.reconcileOrder(f.order,f.client),
  /residual position requires operator review/);
 assert.equal(f.calls.cancel,0);
 assert.equal(f.calls.tradesApplied.length,1);
 assert.equal(f.calls.finalized.length,0);
 const audit=f.calls.audits.find(x=>x.kind==='options_gtc_partial_exit_incident');
 assert.ok(audit);
 assert.equal(audit.details.binanceStatus,'CANCELED');
 assert.equal(audit.details.remainingQty,.005);
 assert.equal(audit.details.tpOrderPreserved,false);
});

test('ETH GTC TP fully filled gets reconciled normally',async()=>{
 const f=mockExchange({status:'FILLED',filled:.01});
 await f.executor.reconcileOrder(f.order,f.client);
 assert.equal(f.calls.cancel,0);
 assert.equal(f.calls.finalized.length,1);
 assert.equal(f.calls.tradesApplied.length,1);
 assert.equal(f.calls.audits.filter(x=>x.kind==='options_gtc_partial_exit_incident').length,0);
});

test('even with a valid residual lot, cancelled partial remains ATTENTION for review',async()=>{
 const f=mockExchange({lotMin:'0.005',lotStep:'0.005',allowCancel:true});
 await assert.rejects(f.executor.reconcileOrder(f.order,f.client),
  /residual position requires operator review/);
 assert.equal(f.calls.cancel,1);
 assert.equal(f.calls.tradesApplied.length,1);
 assert.equal(f.calls.finalized.length,0);
});

test('reconciler records ATTENTION and issues alert without canceling partial resting TP',async()=>{
 const f=mockExchange();
 const status={attention:false,alerted:false,released:false};
 const notifications=[];
 f.executor.credentials={getClientForUser:async()=>f.client};
 f.executor.repo={
  ...f.executor.repo,
  async listUnresolved(){return [f.order]},
  async claimReconcile(){return {...f.order,leaseUntil:NOW+5000}},
  async releaseReconcile(){status.released=true},
  async markAttention(){status.attention=true},
  async listAttentionOrders(){return status.attention?[f.order.id]:[]},
  async claimAttentionNotification(){
   if(status.alerted)return null;
   status.alerted=true;
   return {user_id:1,strategy_id:f.order.strategyId,
     symbol:SYMBOL,client_order_id:CLIENT_ID,
     last_error:'GTC_PARTIAL_DUST',attention_notified_at:NOW};
  },
 };
 f.executor.notify=async(userId,message)=>notifications.push({userId,message});
 f.executor.lastExternalScanAt=NOW;
 const result=await f.executor.reconcilePending();
 assert.equal(result.checked,1);
 assert.equal(result.errors,1);
 assert.equal(result.alerts,1);
 assert.equal(status.attention,true);
 assert.equal(status.released,true);
 assert.equal(status.alerted,true);
 assert.equal(notifications.length,1);
 assert.match(notifications[0].message,/Binance Opciones sin conciliar/);
 assert.equal(f.calls.cancel,0);
 assert.equal(f.calls.finalized.length,0);
 assert.equal(f.calls.tradesApplied.length,1);
});
