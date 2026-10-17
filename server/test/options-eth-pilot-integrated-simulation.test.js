const test = require('node:test');
const assert = require('node:assert/strict');
const alert = require('../src/services/options/templates/alert-signal');
const { OptionsStrategyRunner } =
  require('../src/services/options/options-strategy-runner.service');
const { OptionsLiveExecution } =
  require('../src/services/options/options-live-execution.service');
const { BOT_PARAMS, BOT_LIMITS } =
  require('../src/scripts/options-pilot-configure-paused');

const SYMBOL = 'ETH-261023-2500-C';
const START = Date.UTC(2026, 9, 17, 3);
const EXPIRY = Date.UTC(2026, 9, 23, 8);
const strategy = {
  id: 2, userId: 1, underlying: 'ETH', template: 'alert_signal',
  mode: 'live', params: BOT_PARAMS, limits: BOT_LIMITS,
};
const globalLimits = { maxDailyLossUsdt: 1, maxMarginUsdt: 1,
  maxLiveStrategies: 1, notifyTelegram: true };

function harness() {
  // TEST ONLY: every Binance request hits this in-memory fake.
  // Production environment flags are never modified.
  const clock = { now: START };
  const broker = [];
  const records = [];
  const positions = [];
  const exitRequests = new Set();
  const notices = [];
  const warnings = [];
  let nextLocalId = 1;
  let nextBrokerId = 7000;
  let quote = { bid: 23.20, ask: 23.60, mark: 23.40, delta: 0.35, spot: 2400 };
  const orderInfo = {
    optionSymbols: [{
      symbol: SYMBOL, status: 'TRADING', quoteAsset: 'USDT',
      underlying: 'ETHUSDT', unit: 1, expiryDate: EXPIRY,
      filters: [{ filterType: 'PRICE_FILTER', minPrice: '0',
        maxPrice: '10000', tickSize: '0.1', minQty: '0.01',
        maxQty: '10', stepSize: '0.01' }],
    }],
  };
  const posFor = (id) => positions.find(p => p.id === id);
  const localFor = (id) => records.find(o => o.id === id);
  const brokerClient = {
    async getExchangeInfo() { return orderInfo; },
    async getPositions() {
      return positions.filter(p => p.quantity > 0).map(p =>
        ({ symbol: p.symbol, side: 'LONG', quantity: String(p.quantity) }));
    },
    async getOpenOrders() {
      return broker.filter(b => ['NEW','PARTIALLY_FILLED'].includes(b.status))
        .map(b => ({ symbol: b.symbol, clientOrderId: b.clientOrderId,
          orderId: b.orderId, status: b.status }));
    },
    async placeOrder(data) {
      const row = { ...data, orderId: String(nextBrokerId++),
        status: 'NEW', executedQty: 0, trades: [] };
      broker.push(row);
      return { orderId: row.orderId, symbol: data.symbol, side: data.side,
        clientOrderId: data.clientOrderId };
    },
    async getOrder({orderId,clientOrderId}) {
      const b = broker.find(x => orderId ? x.orderId === String(orderId)
        : x.clientOrderId === clientOrderId);
      if (!b) return null;
      return { orderId:b.orderId, clientOrderId:b.clientOrderId,
        symbol:b.symbol, side:b.side, quantity:String(b.quantity),
        executedQty:String(b.executedQty), status:b.status,
        type:'LIMIT',timeInForce:'GTC' };
    },
    async getUserTrades({symbol,fromId,limit}) {
      return broker.flatMap(b=>b.trades).filter(t=>t.symbol===symbol &&
        (fromId==null || BigInt(t.tradeId)>=BigInt(fromId))).slice(0,limit);
    },
    async cancelOrder({orderId}) {
      const b=broker.find(x=>x.orderId===String(orderId));
      if(!b)throw Error('Not found');
      b.status='CANCELED';
      return {status:'CANCELED'};
    },
  };
  const market = {
    async getQuote(symbol) {
      assert.equal(symbol,SYMBOL);
      return {...quote};
    },
  };
  const repo = {
    async assertExchangeExposure() {return true;},
    async beginBatch({strategy:st,action,legs,key,deadlineAt}){
      if (action==='open' && records.some(o=>o.action==='open')) return null;
      if (records.some(o=>o.key===key || (o.action===action && o.status!=='final'))) return null;
      return legs.map(leg=>{
        const row={id:nextLocalId++,key,action,orderId:null,
          strategyId:st.id,userId:st.userId,
          symbol:leg.symbol,side:leg.side,positionId:leg.positionId??null,
          quantity:leg.quantity,limitPrice:leg.price,
          purpose:'standard',status:'queued',
          processedQty:0,clientOrderId:'HC-TEST-'+nextLocalId,
          createdAt:clock.now,deadlineAt};
        records.push(row);return {...row};
      });
    },
    async markSending(id){
      const o=localFor(id);
      if(o.status!=='queued')return null;
      o.status='sending';return {...o};
    },
    async markActive(id,orderId){
      const o=localFor(id);o.orderId=String(orderId);o.status='active';
    },
    async markAttention(id){localFor(id).status='attention';},
    async listUnresolved(){return records.filter(o=>o.status!=='final').map(o=>({...o}));},
    async claimReconcile(id){
      const o=localFor(id);if(o.leased)return null;
      o.leased=true;return {...o};
    },
    async releaseReconcile(id){localFor(id).leased=false;},
    async applyTrade(order,t){
      const record=localFor(order.id);
      record.tradeIds=record.tradeIds||new Set();
      if(record.tradeIds.has(t.id))return false;
      record.tradeIds.add(t.id);
      record.processedQty+=t.quantity;
      if(record.action==='open'){
        positions.push({id:100+positions.length,strategyId:2,userId:1,
          underlying:'ETH',symbol:SYMBOL,side:'BUY',entryPrice:t.price,
          quantity:t.quantity,expiryMs:EXPIRY,params:BOT_PARAMS});
      }else{
        const p=posFor(record.positionId);
        assert.ok(p,'close must point to known real fill');
        p.quantity=Number((p.quantity-t.quantity).toFixed(12));
        if(p.quantity<0)throw Error('Overclosed position');
      }
      return true;
    },
    async finishOrder(id,orderId,qty){
      const o=localFor(id);
      assert.ok(Math.abs(o.processedQty-qty)<1e-8);
      o.orderId=orderId==null?null:String(orderId);
      o.status='final';
    },
    async listMissingTpPositions(){
      return positions.filter(p=>p.quantity>0&&!exitRequests.has(p.id) &&
        !records.some(o=>o.positionId===p.id &&
          o.purpose==='take_profit'));
    },
    async beginStandingTp({position,price,deadlineAt}){
      if(records.some(o=>o.positionId===position.id&&o.purpose==='take_profit'))return null;
      const row={id:nextLocalId++,strategyId:2,userId:1,
        symbol:position.symbol,side:'SELL',quantity:position.quantity,
        positionId:position.id,action:'close',purpose:'take_profit',
        limitPrice:price,deadlineAt,processedQty:0,
        clientOrderId:'HC-TEST-'+nextLocalId,status:'queued',
        createdAt:clock.now};
      records.push(row);return {...row};
    },
    async listQueuedTpOrders(){
      return records.filter(o=>o.purpose==='take_profit' &&
        o.status==='queued' && !o.cancelRequested).map(o=>({...o}));
    },
    async listUserOrderIds(){
      return records.map(o=>({clientOrderId:o.clientOrderId,orderId:o.orderId,status:o.status}));
    },
    async listRestingTpOrderIds(){
      return records.filter(o=>o.purpose==='take_profit'&&o.status!=='final');
    },
    async countSubmittedSince(){return records.filter(o=>o.action==='open').length;},
    async deferExitIfProtected(st,action){
      const ids=action.legs.map(l=>l.positionId);
      const protectedTp=records.filter(o=>ids.includes(o.positionId)&&
        o.purpose==='take_profit'&&o.status!=='final');
      if(!protectedTp.length)return false;
      for(const id of ids)exitRequests.add(id);
      for(const order of protectedTp)localFor(order.id).cancelRequested=true;
      return true;
    },
    async listReadyExitRequests(){
      return [...exitRequests].map(id=>posFor(id)).filter(p=>p&&p.quantity>0&&
        !records.some(o=>o.positionId===p.id&&o.purpose==='take_profit'&&o.status!=='final')&&
        !records.some(o=>o.positionId===p.id&&o.purpose==='standard'&&
          o.action==='close'&&o.status!=='final')).map(p=>({
            id:p.id,positionId:p.id,strategyId:2,userId:1,
            symbol:p.symbol,side:p.side,quantity:p.quantity,
          }));
    },
    async hasStandingTp(ids){
      return records.some(o=>ids.includes(o.positionId)&&
        o.purpose==='take_profit'&&o.status!=='final');
    },
    async realizedPnlSince(){return 0;},
    async listOpenPositionsByUser(){
      return positions.filter(p=>p.quantity>0).map(p=>({...p}));
    },
    async claimIncidentNotification(){return true;},
  };
  const silent={warn:(reason)=>warnings.push(reason),info(){},error(){}};
  const engine=new OptionsLiveExecution({
    repo,market,credentials:{getClientForUser:async()=>brokerClient},
    logger:silent,notify:async(userId,message)=>notices.push(message),
    now:()=>clock.now,enabled:true,
    settlement:{reconcileExpired:async()=>{}},
  });
  // Account audits are tested separately with signed GET preflight; here
  // we isolate the real order/TP/exit path from unrelated DB services.
  engine.scanExternalAccounts=async()=>({checked:0});
  engine.scanUnprotectedPositions=async()=>({checked:0});
  engine.alertAttention=async()=>0;
  engine.processDeferredReentries=async()=>({sent:0});
  const runner=new OptionsStrategyRunner({
    repo:{
      realizedPnlSince:repo.realizedPnlSince,
      listOpenPositionsByUser:repo.listOpenPositionsByUser,
    },
    market,credentials:{getLimits:async()=>globalLimits},
    liveExecutor:engine,now:()=>clock.now,
    logger:silent,notify:async()=>{},
  });
  function setFill(row,quantity,price,tradeId){
    assert.ok(row);
    const traded=Number(quantity);
    row.executedQty+=traded;
    row.status=row.executedQty>=row.quantity-1e-8?'FILLED':'PARTIALLY_FILLED';
    row.trades.push({
      tradeId:String(tradeId),orderId:row.orderId,side:row.side,symbol:row.symbol,
      quantity:String(traded),price:String(price),fee:'-0.001',
      quoteAsset:'USDT',time:clock.now+1,
    });
  }
  const runEntry=async(eventId=1)=>{
    const params=alert.validateParams(BOT_PARAMS);
    const chain={expiry:'261023',spot:2400,
      rows:[{strike:2500,call:{symbol:SYMBOL,ask:quote.ask,bid:quote.bid,
        delta:0.35,iv:.6,stepSize:.01,minQty:.01,maxQty:10}}],
    };
    const actions=alert.evaluate({now:clock.now,underlying:'ETH',
      spot:2400,chain,params,positions:[],
      signal:{eventId,direction:'bullish'},tradesToday:0});
    const entry=actions.find(a=>a.type==='open');
    assert.ok(entry,JSON.stringify(actions));
    const ctx={now:clock.now,spot:2400,params,positions:[],
      signal:{eventId,direction:'bullish'},produced:[]};
    return runner.executeLive(strategy,entry,ctx);
  };
  return {clock,broker,records,positions,repo,engine,runner,
    notices,warnings,runEntry,setFill,setQuote(q){quote={...quote,...q};}};
}

test('PILOT E2E: exact ETH BUY -> verified fill -> resting TP -> stop cancels TP -> deferred close',async()=>{
  const f=harness();
  const initial=await f.runEntry();
  assert.equal(initial.status,'submitted');
  assert.equal(f.broker.length,1);
  assert.deepEqual({symbol:f.broker[0].symbol,side:f.broker[0].side,
    qty:f.broker[0].quantity,price:f.broker[0].price,reduceOnly:f.broker[0].reduceOnly},
    {symbol:SYMBOL,side:'BUY',qty:.01,price:23.60,reduceOnly:false});
  // Binance acknowledgement is not a fill: no position yet.
  assert.equal(f.positions.length,0);
  const duplicate=await f.runEntry(2);
  assert.equal(duplicate.status,'duplicate_or_unresolved');
  assert.equal(f.broker.length,1);

  f.setFill(f.broker[0],.01,23.60,8001);
  const reconciled=await f.engine.reconcilePending();
  assert.equal(reconciled.errors,0);
  assert.equal(f.positions.filter(p=>p.quantity>0).length,1);
  assert.equal(f.broker.length,2);
  assert.equal(f.broker[1].side,'SELL');
  assert.equal(f.broker[1].reduceOnly,true);
  assert.equal(f.broker[1].quantity,.01);
  assert.equal(f.broker[1].price,35.40);
  assert.equal((await f.engine.reconcilePending()).protectionSent.sent,0);

  f.setQuote({bid:11.70,ask:12,mark:23.50});
  const p={...f.positions[0],quote:{bid:11.70,ask:12,mark:23.50}};
  const actions=alert.evaluate({now:f.clock.now,positions:[p],
    params:alert.validateParams(BOT_PARAMS)});
  assert.equal(actions[0].reason,'stop_loss');
  const out=await f.runner.executeLive(strategy,actions[0],
    {now:f.clock.now,params:alert.validateParams(BOT_PARAMS),produced:[]});
  assert.equal(out.status,'tp_cancel_requested');
  assert.equal(f.broker.length,2,'never send a second SELL until TP terminal');
  await f.engine.reconcilePending();
  assert.equal(f.broker[1].status,'CANCELED');
  assert.equal(f.broker.length,3);
  assert.equal(f.broker[2].side,'SELL');
  assert.equal(f.broker[2].reduceOnly,true);
  assert.equal(f.broker[2].price,11.70);

  f.setFill(f.broker[2],.01,11.70,8002);
  await f.engine.reconcilePending();
  assert.equal(f.positions.reduce((s,p)=>s+p.quantity,0),0);
  assert.equal((await f.runEntry(3)).status,'duplicate_or_unresolved');
  assert.equal(f.broker.length,3,'no second BUY even after stop closure');
});

test('mark-only price must NOT trigger a stop or TP without executable bid',()=>{
  const p={id:100,side:'BUY',symbol:SYMBOL,entryPrice:23.60,
    quantity:.01,expiryMs:EXPIRY,
    quote:{mark:5.0}};
  const params=alert.validateParams(BOT_PARAMS);
  const a=alert.evaluate({now:START,params,positions:[p]});
  assert.equal(a[0].reason,'no_quote');
  const b=alert.evaluate({now:START,params,positions:[
    {...p,quote:{bid:0,mark:40}}]});
  assert.equal(b[0].reason,'no_quote');
});

test('24-hour pre-expiry exit takes precedence even when price unavailable',()=>{
  const p={id:101,side:'BUY',symbol:SYMBOL,
    entryPrice:23.6,quantity:.01,expiryMs:EXPIRY,
    quote:{}};
  const params=alert.validateParams(BOT_PARAMS);
  const a=alert.evaluate({now:EXPIRY-23*3600000,params,positions:[p]});
  assert.equal(a[0].reason,'time_exit');
  assert.deepEqual(a[0].legs[0],{
    positionId:101,symbol:SYMBOL,side:'SELL',quantity:.01,
  });
});

test('partial fill below minimum executable lot is flagged; no fictitious TP',async()=>{
  const f=harness();
  await f.runEntry();
  f.setFill(f.broker[0],.005,23.60,8011);
  const result=await f.engine.reconcilePending();
  assert.equal(result.protection.queued,0);
  assert.equal(f.positions[0].quantity,.005);
  assert.equal(f.broker.length,1,'cannot place invalid 0.005 option TP');
  assert.ok(f.warnings.includes('options_tp_coverage_pending'));
  assert.ok(f.notices.some(n=>n.includes('TP aún no protegido')));
  // Fail-closed: this simulation DOES NOT certify unattended live rollout.
});
