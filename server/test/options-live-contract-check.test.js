const test = require('node:test');
const assert = require('node:assert/strict');
const { checkContracts } = require('../src/scripts/options-live-contract-check');

const NOW = Date.UTC(2026, 9, 15, 12);
const symbol = 'BTC-261030-100000-C';
const makeClient = (trace) => ({
  async getExchangeInfo() {
    trace.push('exchangeInfo');
    return { optionSymbols: [{
      symbol, status: 'TRADING', underlying: 'BTCUSDT',
      expiryDate: NOW + 15 * 86400000,
      filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1', stepSize: '0.01' }],
    }] };
  },
  async getSpotKlines() {
    trace.push('klines');
    return Array.from({ length: 17 }, () => [1, 2, 3, 4, 5, 6, 7]);
  },
  async getAccount() { trace.push('account'); return { asset: [{ asset: 'USDT', equity: '300' }], greek: [] }; },
  async getPositions() { trace.push('positions'); return []; },
  async getOpenOrders() { trace.push('openOrders'); return []; },
  async getExerciseRecords() { trace.push('exercise'); return []; },
  async getBills() { trace.push('bill'); return []; },
  async getOrder() {
    trace.push('order');
    return { orderId: '1234567890123456789', symbol, side: 'BUY',
      status: 'FILLED', quantity: '0.10', executedQty: '0.10' };
  },
  async getUserTrades() {
    trace.push('trades');
    return [{ tradeId: '9999999999999999999', orderId: '1234567890123456789',
      symbol, side: 'BUY', quantity: '0.10', price: '120',
      fee: '0.01', quoteAsset: 'USDT', time: NOW - 10000 }];
  },
});

test('READ-ONLY: checks shapes/filters/orders without sending or cancelling', async () => {
  const trace = [];
  const client = makeClient(trace);
  client.placeOrder = () => { throw Error('POST forbidden'); };
  client.cancelOrder = () => { throw Error('DELETE forbidden'); };
  const database = { async query(sql, args) {
    assert.match(sql, /^SELECT/);
    assert.deepEqual(args, [11]);
    return { rows: [{ symbol, exchange_order_id: '1234567890123456789' }] };
  } };
  const out = await checkContracts({ userId: 11, client, database, at: NOW });
  assert.equal(out.readOnly, true);
  assert.equal(out.ready, true);
  assert.ok(trace.includes('order'));
  assert.ok(trace.includes('trades'));
  assert.equal(out.results.find((r) => r.endpoint === 'optionFilters').ok, true);
  assert.equal(out.results.find((r) => r.endpoint === 'marginAccount').ok, true);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('300'));
  assert.ok(!json.includes(symbol));
  assert.ok(!json.includes('1234567890123456789'));
});

test('si no existen órdenes históricas, no inventa getOrder/trades confirmados', async () => {
  const trace = [];
  const out = await checkContracts({ userId: 1, client: makeClient(trace),
    database: { async query() { return { rows: [] }; } }, at: NOW });
  assert.equal(out.ready, false);
  assert.equal(out.results.find((r) => r.endpoint === 'getOrder').skipped, 'NO_HISTORICAL_ORDER');
  assert.equal(trace.includes('order'), false);
  assert.equal(trace.includes('trades'), false);
});

test('array vacío de userTrades no cuenta como esquema de fill validado', async () => {
  const trace = [];
  const client = makeClient(trace);
  client.getUserTrades = async () => [];
  const out = await checkContracts({ userId: 11, client,
    database: { async query() {
      return { rows: [{ symbol, exchange_order_id: '1234567890123456789' }] };
    } }, at: NOW });
  assert.equal(out.ready, false);
  const trades = out.results.find((r) => r.endpoint === 'userTrades');
  assert.equal(trades.ok, null);
  assert.equal(trades.skipped, 'NO_RECENT_TRADES');
});

test('si faltan filtros o falla endpoint, la validación falla cerrada sin filtrar errores', async () => {
  const trace = [];
  const client = makeClient(trace);
  client.getSpotKlines = async () => { throw Error('API_KEY_IS_SENSITIVE'); };
  client.getExchangeInfo = async () => ({ optionSymbols: [{
    symbol, status: 'TRADING', underlying: 'BTCUSDT', expiryDate: NOW + 3600000, filters: [],
  }] });
  const out = await checkContracts({ userId: 1, client,
    database: { async query() { return { rows: [] }; } }, at: NOW });
  assert.equal(out.ready, false);
  assert.equal(out.results.find((r) => r.endpoint === 'optionFilters').ok, false);
  assert.equal(out.results.find((r) => r.endpoint === 'spotKlines1h').ok, false);
  assert.ok(!JSON.stringify(out).includes('API_KEY_IS_SENSITIVE'));
});

test('HTTP 200 con fills incompletos no certifica ledger real de Binance', async () => {
  const trace = [];
  const client = makeClient(trace);
  client.getUserTrades = async () => [{
    tradeId: '9999999999999999999', orderId: '1234567890123456789',
    symbol, side: 'BUY', price: '120',
    fee: '0.01', time: NOW - 10000,
    // Faltan quantity y quoteAsset: el ledger no puede aplicar este fill.
  }];
  const out = await checkContracts({ userId: 11, client,
    database: { async query() {
      return { rows: [{ symbol, exchange_order_id: '1234567890123456789' }] };
    } }, at: NOW });
  assert.equal(out.ready, false);
  const trades = out.results.find((r) => r.endpoint === 'userTrades');
  assert.equal(trades.ok, false);
  assert.equal(trades.code, 'INCOMPATIBLE_TRADE_SHAPE');
  assert.ok(!JSON.stringify(out).includes('9999999999999999999'));
});

test('HTTP 200 con orden sin estado o cantidad no certifica el contrato de cancelación', async () => {
  const trace = [];
  const client = makeClient(trace);
  client.getOrder = async () => ({ orderId: '1234567890123456789', symbol });
  const out = await checkContracts({ userId: 11, client,
    database: { async query() {
      return { rows: [{ symbol, exchange_order_id: '1234567890123456789' }] };
    } }, at: NOW });
  assert.equal(out.ready, false);
  const order = out.results.find((r) => r.endpoint === 'getOrder');
  assert.equal(order.ok, false);
  assert.equal(order.code, 'INCOMPATIBLE_ORDER_SHAPE');
});
