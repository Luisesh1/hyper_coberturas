const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {loadPermit,enforcePilotEntry,COST_CAP_USDT}=require(
  '../src/services/options/options-live-pilot-policy'
);
const at=Date.UTC(2026,9,16,23,0);
const term={
  OPTIONS_LIVE_TRADING_ENABLED:'true',
  OPTIONS_LIVE_PRODUCTION_APPROVED:'true',
  OPTIONS_LIVE_PILOT_AUTHORIZED:'true',
  OPTIONS_LIVE_PILOT_USER_ID:'1',
  OPTIONS_LIVE_PILOT_STRATEGY_ID:'42',
  OPTIONS_LIVE_PILOT_SYMBOL:'ETH-261030-4000-C',
  OPTIONS_LIVE_PILOT_QUANTITY:'0.01',
  OPTIONS_LIVE_PILOT_MAX_PRICE:'100',
  OPTIONS_LIVE_PILOT_EXPIRES_AT_MS:String(at+5*60000),
};
const strategy={id:42,userId:1,underlying:'ETH'};
const order={type:'open',legs:[{symbol:term.OPTIONS_LIVE_PILOT_SYMBOL,
  side:'BUY',quantity:0.01,price:90}]};
const check=(env=term,action=order,st=strategy)=>
  enforcePilotEntry({env,action,strategy:st,now:at});

test('default production is fail closed until exact authorized order is declared',()=>{
  assert.throws(()=>check({...term,OPTIONS_LIVE_PILOT_AUTHORIZED:'false'}),/separately authorized/);
  assert.throws(()=>check({...term,OPTIONS_LIVE_PILOT_SYMBOL:''}),/invalid/);
  assert.throws(()=>check({...term,OPTIONS_LIVE_PILOT_EXPIRES_AT_MS:String(at-1)}),/expired/);
  assert.throws(()=>check({...term,OPTIONS_LIVE_PILOT_EXPIRES_AT_MS:String(at+3600000)}),/invalid/);
  assert.throws(()=>check({...term,OPTIONS_LIVE_PILOT_MAX_PRICE:'100000'}),/cap/);
  assert.throws(()=>check({...term,OPTIONS_LIVE_PILOT_USER_ID:'2'}),/one approved ETH leg/);
  assert.throws(()=>check({...term,OPTIONS_LIVE_PILOT_STRATEGY_ID:'8'}),/one approved ETH leg/);
  assert.throws(()=>check({...term,OPTIONS_LIVE_PRODUCTION_APPROVED:'false'}),/Both live/);
});

test('one exact BUY and short-lived permit passes, no SELL, BTC or multiple legs',()=>{
  assert.doesNotThrow(()=>check());
  assert.equal(loadPermit(term,at).userId,1);
  assert.throws(()=>check(term,{...order,legs:[{...order.legs[0],side:'SELL'}]}),/BUY limit/);
  assert.throws(()=>check(term,{...order,legs:[{...order.legs[0],price:101}]}),/BUY limit/);
  assert.throws(()=>check(term,{...order,legs:[{...order.legs[0],quantity:0.02}]}),/BUY limit/);
  assert.throws(()=>check(term,{...order,legs:[{...order.legs[0],symbol:'BTC-261030-50000-C'}]}),/BUY limit/);
  assert.throws(()=>check(term,{...order,legs:[...order.legs,...order.legs]}),/one approved ETH leg/);
  assert.throws(()=>check(term,order,{...strategy,underlying:'BTC'}),/one approved ETH leg/);
});

test('exit protection is always allowed, entry cap cannot exceed 20 USDT',()=>{
  assert.equal(COST_CAP_USDT,20);
  assert.doesNotThrow(()=>check({...term,OPTIONS_LIVE_PILOT_AUTHORIZED:'false'},
    {type:'close',legs:[{symbol:term.OPTIONS_LIVE_PILOT_SYMBOL,side:'SELL',quantity:.01}]}));
  assert.doesNotThrow(()=>check({OPTIONS_LIVE_TRADING_ENABLED:'false',
    OPTIONS_LIVE_PRODUCTION_APPROVED:'false'}));
  const cost=0.2*95*1.1;
  assert.ok(cost>COST_CAP_USDT);
  assert.throws(()=>check({...term,OPTIONS_LIVE_PILOT_QUANTITY:'0.2',
    OPTIONS_LIVE_PILOT_MAX_PRICE:'95'},
    {type:'open',legs:[{...order.legs[0],quantity:0.2,price:95}]}),/cap/);
});

test('repository one-shot count occurs under per-user advisory lock',()=>{
  const s=fs.readFileSync(path.resolve(__dirname,
    '../src/repositories/options-live-orders.repository.js'),'utf8');
  const i=s.indexOf('async function beginBatch(');
  const j=s.indexOf('async function queueReversal(',i);
  const body=s.slice(i,j);
  const lock=body.indexOf('pg_advisory_xact_lock(760218');
  const count=body.indexOf("SELECT id FROM options_live_orders WHERE user_id=$1 AND action='open'");
  const insert=body.indexOf('INSERT INTO options_live_batches');
  assert.ok(lock>=0 && count>lock && insert>count);
  assert.match(body,/alreadyAttempted.length/);
  assert.match(body,/One-shot pilot already used/);
});

test('execution enforces pilot check after exchange tick/lot and before DB batch',()=>{
  const s=fs.readFileSync(path.resolve(__dirname,
    '../src/services/options/options-live-execution.service.js'),'utf8');
  const i=s.indexOf('async submit(strategy, action, ctx)');
  const j=s.indexOf('async reconcileOrder',i);
  const body=s.slice(i,j);
  const filters=body.indexOf('validateBinanceOrderBatch(');
  const permit=body.indexOf('enforcePilotEntry(');
  const batch=body.indexOf('this.repo.beginBatch(');
  const post=body.indexOf('client.placeOrder(');
  assert.ok(filters>=0 && permit>filters && batch>permit && post>batch);
});

test('deploy reads ETH public quote automatically but never arms trading',()=>{
  const flow=fs.readFileSync(path.resolve(__dirname,
    '../../.github/workflows/deploy.yml'),'utf8');
  const step=flow.split('- name: Revisar opciones ETH públicas tras el deploy')[1];
  assert.ok(step,'expected public market-only step');
  assert.match(step,/options-eth-contract-public-review\.js/);
  assert.match(step,/review_read_only=pass/);
  assert.match(step,/pilot_ready=no/);
  assert.match(step,/NO OPERAR/);
  assert.doesNotMatch(step,/placeOrder|cancelOrder|OPTIONS_LIVE_PILOT_AUTHORIZED=true|docker compose .*up -d/);
  assert.match(flow,/options_deployed_read_only=pass/);
});
