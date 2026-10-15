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
