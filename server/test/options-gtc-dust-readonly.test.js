const test = require('node:test');
const assert = require('node:assert/strict');
const { assess, checkLot, summaryLines } =
  require('../src/scripts/options-gtc-dust-readonly');

const symbol = 'ETH-261023-2500-C';
const now = () => Date.UTC(2026, 9, 17);
const off = {
  OPTIONS_LIVE_TRADING_ENABLED: 'false',
  OPTIONS_LIVE_PRODUCTION_APPROVED: 'false',
  OPTIONS_LIVE_PILOT_AUTHORIZED: 'false',
};

function exchange(minQty = '0.01', stepSize = '0.01') {
  return { optionSymbols: [{
    symbol, status: 'TRADING', underlying: 'ETHUSDT', quoteAsset: 'USDT',
    expiryDate: Date.UTC(2026, 9, 23), maxQty: '100',
    filters: [{ filterType: 'LOT_SIZE', minQty, stepSize, maxQty: '100' }],
  }] };
}

function readonlyClient(info = exchange()) {
  return {
    getExchangeInfo: async () => info,
    getPositions: async () => [],
    getOpenOrders: async () => [],
    getApiRestrictions: async () => ({
      ipRestrict: true, enableWithdrawals: false, enableReading: true,
      enableVanillaOptions: true,
    }),
    placeOrder: () => { throw new Error('POST must never be called'); },
    cancelOrder: () => { throw new Error('DELETE must never be called'); },
  };
}

test('current Binance lot forbids replacing 0.005 of a 0.01 GTC order', async () => {
  const outcome = await assess({ client: readonlyClient(), symbol, env: off, now });
  assert.equal(outcome.status, 'risk_detected');
  assert.equal(outcome.initialOrderValid, true);
  assert.equal(outcome.residualNewOrderValid, false);
  assert.equal(outcome.pilotReady, false);
  const lines = summaryLines(outcome).join('\n');
  assert.match(lines, /gtc_dust_new_residual_order_filter=fail/);
  assert.match(lines, /gtc_dust_existing_gtc_partial_behavior=unverified/);
  assert.match(lines, /gtc_dust_real_orders_sent=0/);
  assert.match(lines, /pilot_ready=no/);
});

test('if exchange permits 0.005 new order, real GTC behavior stays unverified', async () => {
  const outcome = await assess({
    client: readonlyClient(exchange('0.005', '0.005')),
    symbol, env: off, now,
  });
  assert.equal(outcome.status, 'filter_only');
  assert.equal(outcome.residualNewOrderValid, true);
  assert.match(summaryLines(outcome).join('\n'), /actual_residual_liquidation=unverified/);
});

test('unknown exchange filters never count as clearance', async () => {
  assert.equal(checkLot(exchange('0', '0.01'), symbol, now()), null);
  assert.equal(checkLot(exchange(), 'ETH-999999-2000-C', now()), null);
  assert.equal(checkLot(exchange(), symbol, Date.UTC(2026, 9, 24)), null);
  const outcome = await assess({
    client: readonlyClient(exchange('0', '0.01')), symbol, env: off, now,
  });
  assert.equal(outcome.status, 'blocked');
});

test('a single live flag ON blocks before all Binance GETs', async () => {
  for (const key of ['OPTIONS_LIVE_TRADING_ENABLED',
    'OPTIONS_LIVE_PRODUCTION_APPROVED', 'OPTIONS_LIVE_PILOT_AUTHORIZED']) {
    let calls = 0;
    const client = {
      getExchangeInfo: () => { calls++; throw new Error('forbidden'); },
    };
    const outcome = await assess({
      client, symbol, env: { ...off, [key]: 'true' }, now,
    });
    assert.equal(outcome.status, 'blocked');
    assert.equal(calls, 0);
  }
});

test('signed Binance GET failure or unexpected positions fail closed', async () => {
  const denied = readonlyClient();
  denied.getOpenOrders = async () => { throw new Error('Binance unavailable'); };
  assert.equal((await assess({ client: denied, symbol, env: off, now })).status,
    'blocked');
  const exposed = readonlyClient();
  exposed.getPositions = async () => [{ symbol, quantity: '0.005' }];
  assert.equal((await assess({ client: exposed, symbol, env: off, now })).status,
    'blocked');
  const unsafe = readonlyClient();
  unsafe.getApiRestrictions = async () => ({ enableWithdrawals: true });
  assert.equal((await assess({ client: unsafe, symbol, env: off, now })).status,
    'blocked');
});

test('diagnostic prints only fixed booleans and no account/order identifiers', async () => {
  const lines = summaryLines(await assess({
    client: readonlyClient(), symbol, env: off, now,
  })).join('\n');
  assert.doesNotMatch(lines, /ETH-|2500|orderId|apiKey|margin|balance|clientOrderId/);
  assert.doesNotMatch(lines, /pilot_ready=yes/);
});
