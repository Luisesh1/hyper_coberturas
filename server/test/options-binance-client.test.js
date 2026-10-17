const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  createBinanceOptionsClient,
  signQuery,
  normalizeBinanceError,
} = require('../src/services/options/binance-options.client');

const API_KEY = 'testApiKeyAAAABBBBCCCCDDDDEEEEFFFF0000111122223333';
const API_SECRET = 'testSecretZZZZYYYYXXXXWWWWVVVVUUUU999988887777';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function recordingFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { calls, fetchImpl };
}

test('signQuery reproduce el vector de la documentación de Binance', () => {
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  const query = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
  assert.equal(
    signQuery(query, secret),
    'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71'
  );
});

test('las peticiones firmadas llevan timestamp, recvWindow, firma y X-MBX-APIKEY', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ orderId: 1 }));
  const client = createBinanceOptionsClient({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetchImpl,
    now: () => 1700000000000,
  });

  await client.placeOrder({ symbol: 'BTC-261031-68000-C', side: 'BUY', quantity: 0.1, price: 1250, postOnly: true });

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-MBX-APIKEY'], API_KEY);
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://eapi.binance.com/eapi/v1/order');
  const raw = parsed.search.slice(1);
  const [unsigned, signature] = raw.split('&signature=');
  assert.equal(signature, crypto.createHmac('sha256', API_SECRET).update(unsigned).digest('hex'));
  const params = new URLSearchParams(unsigned);
  assert.equal(params.get('type'), 'LIMIT');
  assert.equal(params.get('timeInForce'), 'GTC');
  assert.equal(params.get('postOnly'), 'true');
  assert.equal(params.get('reduceOnly'), null);
  assert.equal(params.get('timestamp'), '1700000000000');
  assert.equal(params.get('recvWindow'), '5000');
});

test('los endpoints públicos no firman ni envían la key', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ indexPrice: '68000' }));
  const client = createBinanceOptionsClient({ apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl });
  await client.getIndex('BTCUSDT');
  assert.equal(calls[0].url, 'https://eapi.binance.com/eapi/v1/index?underlying=BTCUSDT');
  assert.equal(calls[0].init.headers['X-MBX-APIKEY'], undefined);
});

test('getAccount usa /eapi/v1/marginAccount (Binance retiró /eapi/v1/account: 404)', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ asset: [], greek: [] }));
  const client = createBinanceOptionsClient({ apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl });
  await client.getAccount();
  assert.match(calls[0].url, /^https:\/\/eapi\.binance\.com\/eapi\/v1\/marginAccount\?/);
  assert.equal(calls[0].init.headers['X-MBX-APIKEY'], API_KEY);
});

test('un endpoint firmado sin credenciales lanza ValidationError sin llamar a la red', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({}));
  const client = createBinanceOptionsClient({ fetchImpl });
  await assert.rejects(() => client.getAccount(), (err) => err.code === 'VALIDATION_ERROR');
  assert.equal(calls.length, 0);
});

test('los errores de Binance se normalizan sin filtrar key, secret ni firma', async () => {
  const fetchImpl = async () => jsonResponse({
    code: -1022,
    msg: `Signature for this request is not valid. key=${API_KEY} secret=${API_SECRET} signature=abcdef0123`,
  }, 400);
  const client = createBinanceOptionsClient({ apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl });

  const err = await client.getAccount().catch((e) => e);
  assert.equal(err.status, 400);
  assert.equal(err.code, 'BINANCE_OPTIONS_AUTH_ERROR');
  assert.equal(err.details.binanceCode, -1022);
  assert.equal(err.details.endpoint, '/eapi/v1/marginAccount');
  const serialized = JSON.stringify({ message: err.message, details: err.details });
  assert.ok(!serialized.includes(API_KEY));
  assert.ok(!serialized.includes(API_SECRET));
  assert.ok(!serialized.includes('abcdef0123'));
  assert.ok(!serialized.includes('timestamp='));
});

test('errores de red, rate limit, rechazo y 5xx tienen su clase', async () => {
  const net = createBinanceOptionsClient({
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  const netErr = await net.getExchangeInfo().catch((e) => e);
  assert.equal(netErr.status, 502);
  assert.equal(netErr.code, 'EXTERNAL_SERVICE_ERROR');

  const rate = normalizeBinanceError({ httpStatus: 429, body: { code: -1003, msg: 'Too many' }, path: '/x' });
  assert.equal(rate.status, 429);

  const rejected = normalizeBinanceError({ httpStatus: 400, body: { code: -1111, msg: 'Precision' }, path: '/x' });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.code, 'BINANCE_OPTIONS_REJECTED');

  const server = normalizeBinanceError({ httpStatus: 503, body: null, path: '/x' });
  assert.equal(server.status, 502);
});

test('un 429 aplica cooldown por host entre clientes sin nuevas peticiones hasta Retry-After', async () => {
  // Host aislado: no contamina las pruebas que usan el endpoint real.
  let at = 1_700_000_000_000;
  const requests = [];
  const baseUrl = 'https://options-rate-limit-test.invalid';
  const fetchImpl = async (url) => {
    requests.push(url);
    if (requests.length === 1) {
      return {
        ...jsonResponse({ code: -1003, msg: 'Too many requests' }, 429),
        headers: { get(name) { return name.toLowerCase() === 'retry-after' ? '120' : null; } },
      };
    }
    return jsonResponse({ optionSymbols: [] });
  };
  const makeClient = () => createBinanceOptionsClient({
    baseUrl, fetchImpl, now: () => at,
  });
  const first = makeClient();
  const second = makeClient();
  await assert.rejects(() => first.getExchangeInfo(), (error) =>
    error.status === 429 && error.code === 'BINANCE_OPTIONS_RATE_LIMIT');
  assert.equal(requests.length, 1);

  // Una nueva instancia del cliente comparte el bloqueo por IP/host.
  await assert.rejects(() => second.getExchangeInfo(), (error) =>
    error.status === 429 && error.code === 'BINANCE_OPTIONS_RATE_LIMIT' &&
      error.details.retryAfterMs === 120_000);
  assert.equal(requests.length, 1);

  at += 119_999;
  await assert.rejects(() => second.getExchangeInfo(), (error) =>
    error.status === 429 && error.details.retryAfterMs === 1);
  assert.equal(requests.length, 1);

  at += 1;
  assert.deepEqual(await second.getExchangeInfo(), { optionSymbols: [] });
  assert.equal(requests.length, 2);
});

test('los orderId grandes se conservan como string exacto', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => '[{"orderId":4611875134427365377,"price":"100","createTime":1700000000000}]',
  });
  const client = createBinanceOptionsClient({ apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl });
  const [order] = await client.getOpenOrders();
  assert.equal(order.orderId, '4611875134427365377');
  assert.equal(order.createTime, 1700000000000);
});

test('getApiRestrictions usa el host spot con firma', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ ipRestrict: true }));
  const client = createBinanceOptionsClient({ apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl });
  await client.getApiRestrictions();
  assert.ok(calls[0].url.startsWith('https://api.binance.com/sapi/v1/account/apiRestrictions?'));
  assert.ok(calls[0].url.includes('&signature='));
});

test('endpoints de ejercicios y bills son GET firmados y preservan IDs 64-bit', async () => {
  const { calls, fetchImpl } = recordingFetch((url) => ({
    ok: true, status: 200,
    text: async () => url.includes('/exerciseRecord')
      ? '[{"id":1125899906842624042,"quantity":"0.1","amount":"0","fee":"0"}]'
      : '[{"id":1125899906842624043,"type":"EXERCISE_FEE","amount":"0"}]',
  }));
  const client = createBinanceOptionsClient({
    apiKey: API_KEY, apiSecret: API_SECRET, fetchImpl, now: () => 1700000000000,
  });
  const [record] = await client.getExerciseRecords({
    symbol: 'BTC-261016-60000-C', startTime: 123, endTime: 456,
  });
  const [bill] = await client.getBills({
    currency: 'USDT', startTime: 123, endTime: 456,
  });
  assert.equal(record.id, '1125899906842624042');
  assert.equal(bill.id, '1125899906842624043');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.headers['X-MBX-APIKEY'], API_KEY);
    const url = new URL(call.url);
    assert.equal(url.searchParams.get('startTime'), '123');
    assert.equal(url.searchParams.get('endTime'), '456');
    assert.ok(url.searchParams.get('signature'));
  }
  assert.match(calls[0].url, /\/eapi\/v1\/exerciseRecord\?/);
  assert.match(calls[1].url, /\/eapi\/v1\/bill\?/);
  assert.equal(new URL(calls[1].url).searchParams.get('currency'), 'USDT');
});

test('ETH pilot FOK is signed exactly, closes keep GTC and invalid modes fail before POST',async()=>{
  const {calls,fetchImpl}=recordingFetch(()=>jsonResponse({orderId:'9001',status:'FILLED'}));
  const client=createBinanceOptionsClient({
    apiKey:API_KEY,apiSecret:API_SECRET,fetchImpl,now:()=>1700000000000,
  });
  await client.placeOrder({symbol:'ETH-261023-2500-C',side:'BUY',
    quantity:0.01,price:23.60,timeInForce:'FOK',clientOrderId:'PILOT-FOK-TEST'});
  assert.equal(calls.length,1);
  const q=new URL(calls[0].url).searchParams;
  assert.equal(q.get('timeInForce'),'FOK');
  assert.equal(q.get('type'),'LIMIT');
  assert.equal(q.get('quantity'),'0.01');
  assert.equal(q.get('price'),'23.6');
  assert.equal(q.get('clientOrderId'),'PILOT-FOK-TEST');
  const raw=new URL(calls[0].url).search.slice(1);
  const [unsigned,sig]=raw.split('&signature=');
  assert.equal(sig,crypto.createHmac('sha256',API_SECRET).update(unsigned).digest('hex'));
  await client.placeOrder({symbol:'ETH-261023-2500-C',side:'SELL',
    quantity:0.01,price:35.4,reduceOnly:true});
  assert.equal(new URL(calls[1].url).searchParams.get('timeInForce'),'GTC');
  await assert.rejects(()=>client.placeOrder({
    symbol:'ETH-261023-2500-C',side:'BUY',quantity:0.01,
    price:23.6,timeInForce:'IOC',
  }),/timeInForce/);
  await assert.rejects(()=>client.placeOrder({
    symbol:'ETH-261023-2500-C',side:'BUY',quantity:0.01,
    price:23.6,timeInForce:'FOK',postOnly:true,
  }),/postOnly/);
  assert.equal(calls.length,2);
});
