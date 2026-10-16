const test = require('node:test');
const assert = require('node:assert/strict');
const { candidateList, bookHasTwoWayLiquidity, minLossScan, sanitizedLines } =
  require('../src/scripts/options-pilot-min-loss-quote');

const at = Date.UTC(2026, 9, 16);
const symbol = 'ETH-261030-4000-C';
const option = (overrides = {}) => ({
  symbol, underlying: 'ETHUSDT', quoteAsset: 'USDT', status: 'TRADING',
  expiryDate: at + 14 * 86400_000, unit: 1,
  filters: [
    { filterType: 'PRICE_FILTER', minPrice: '0.01', maxPrice: '10000',
      tickSize: '0.01' },
    { filterType: 'LOT_SIZE', minQty: '0.01', maxQty: '10', stepSize: '0.01' },
  ],
  ...overrides,
});
const market = (askPrice = '1.00', bidPrice = '0.95') => [{
  symbol, askPrice, bidPrice,
}];
const info = list => ({ optionSymbols: list });

test('lowest lot: only BUY minimum quantity with liquidity and 10% fee bound', async () => {
  const c = {
    getExchangeInfo: async () => info([option()]),
    getTicker: async () => market(),
    getDepth: async () => ({ asks: [['1.00', '0.1']],
      bids: [['0.95', '0.1']] }),
    placeOrder: () => { throw Error('must never trade'); },
  };
  const report = await minLossScan(c, at);
  assert.equal(report.pilotReady, false);
  assert.equal(report.affordableLiquid, true);
  assert.equal(report.minimumEstimatedUpperEntryCostUsdt, 0.02);
  const lines = sanitizedLines(report).join('\n');
  assert.match(lines, /pilot_smallest_liquid_entry_estimate_usdt=0.02/);
  assert.match(lines, /pilot_ready=no/);
});

test('illiquid books and excessive spread are rejected', async () => {
  assert.equal(bookHasTwoWayLiquidity({ asks: [['1', '0.001']],
    bids: [['0.95', '1']] }, 0.01), false);
  assert.equal(candidateList(info([option()]), market('2.00', '1.00'), at).length, 0);
  assert.equal(candidateList(info([option()]), market('2.005', '2.000'), at).length, 0);
});

test('cannot exceed provisional 20 USDT screen or accept past-expiry', () => {
  assert.equal(candidateList(info([option()]), market('3000.00', '2950.00'), at).length, 0);
  assert.equal(candidateList(info([option({ expiryDate: at + 3600_000 })]),
    market(), at).length, 0);
});

test('all quotes rejected means no trade, never automatically relax liquidity', async () => {
  const r = await minLossScan({
    getExchangeInfo: async () => info([option()]),
    getTicker: async () => market(),
    getDepth: async () => ({ asks: [], bids: [] }),
  }, at);
  assert.equal(r.affordableLiquid, false);
  assert.equal(r.minimumEstimatedUpperEntryCostUsdt, null);
  assert.match(sanitizedLines(r).join('\n'), /pilot_min_loss_scan=unverified/);
  assert.match(sanitizedLines(r).join('\n'), /pilot_ready=no/);
});

test('output excludes symbols, IDs, premiums, balances and ignores extra keys', async () => {
  const r = await minLossScan({
    getExchangeInfo: async () => info([option()]),
    getTicker: async () => market(),
    getDepth: async () => ({ asks: [['1', '1']], bids: [['0.95', '1']] }),
  }, at);
  r.symbol = symbol;
  r.accountBalance = 'PRIVATE_123';
  r.orderId = '999999999999999';
  assert.doesNotMatch(sanitizedLines(r).join('\n'),
    /ETH-261030|PRIVATE_123|999999999999999/);
  assert.throws(() => sanitizedLines({ ...r, pilotReady: true }));
});
