const test = require('node:test');
const assert = require('node:assert/strict');

const { createBinanceOptionsClient } = require('../src/services/options/binance-options.client');
const {
  createOptionsMarketService,
  parseSymbol,
} = require('../src/services/options/options-market.service');

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0); // 14 oct 2026

const EXCHANGE_INFO = {
  optionContracts: [
    { baseAsset: 'ETH', underlying: 'ETHUSDT' },
    { baseAsset: 'BTC', underlying: 'BTCUSDT' },
  ],
  optionSymbols: [
    { symbol: 'BTC-261031-68000-C', underlying: 'BTCUSDT', side: 'CALL', strikePrice: '68000', expiryDate: Date.UTC(2026, 9, 31, 8),
      filters: [{ filterType: 'PRICE_FILTER', minPrice: '0.02', tickSize: '0.01',
        minQty: '0.01', maxQty: '10', stepSize: '0.01' }] },
    { symbol: 'BTC-261031-68000-P', underlying: 'BTCUSDT', side: 'PUT', strikePrice: '68000', expiryDate: Date.UTC(2026, 9, 31, 8) },
    { symbol: 'BTC-261031-66000-P', underlying: 'BTCUSDT', side: 'PUT', strikePrice: '66000', expiryDate: Date.UTC(2026, 9, 31, 8) },
    { symbol: 'BTC-261016-70000-C', underlying: 'BTCUSDT', side: 'CALL', strikePrice: '70000', expiryDate: Date.UTC(2026, 9, 16, 8) },
    // Vencida: no debe aparecer en la lista de vencimientos.
    { symbol: 'BTC-261010-70000-C', underlying: 'BTCUSDT', side: 'CALL', strikePrice: '70000', expiryDate: Date.UTC(2026, 9, 10, 8) },
    { symbol: 'ETH-261031-2500-C', underlying: 'ETHUSDT', side: 'CALL', strikePrice: '2500', expiryDate: Date.UTC(2026, 9, 31, 8) },
  ],
};

const MARKS = [
  { symbol: 'BTC-261031-68000-C', markPrice: '1500', markIV: '0.52', delta: '0.51', gamma: '0.0001', theta: '-45.2', vega: '60.1' },
  { symbol: 'BTC-261031-68000-P', markPrice: '1300', markIV: '0.55', delta: '-0.49', gamma: '0.0001', theta: '-44', vega: '60' },
  { symbol: 'BTC-261031-66000-P', markPrice: '700', markIV: '0.58', delta: '-0.3', gamma: '0.00008', theta: '-30', vega: '50' },
];

const TICKERS = [
  { symbol: 'BTC-261031-68000-C', bidPrice: '1480', askPrice: '1520' },
  { symbol: 'BTC-261031-68000-P', bidPrice: '0', askPrice: '1330' },
];

function mockFetch() {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const { pathname, searchParams } = new URL(url);
    let body;
    switch (pathname) {
      case '/eapi/v1/exchangeInfo': body = EXCHANGE_INFO; break;
      case '/eapi/v1/mark':
        body = searchParams.get('symbol') ? MARKS.filter((m) => m.symbol === searchParams.get('symbol')) : MARKS;
        break;
      case '/eapi/v1/ticker': body = TICKERS; break;
      case '/eapi/v1/index': body = { indexPrice: searchParams.get('underlying') === 'BTCUSDT' ? '67800.5' : '2450' }; break;
      case '/eapi/v1/openInterest': body = [{ symbol: 'BTC-261031-68000-C', sumOpenInterest: '12.5' }]; break;
      case '/eapi/v1/depth': body = { bids: [['1490', '1']], asks: [['1510', '2']] }; break;
      case '/api/v3/ticker/24hr': body = [{ symbol: 'BTCUSDT', priceChangePercent: '1.25' }, { symbol: 'ETHUSDT', priceChangePercent: '-0.5' }]; break;
      default: return { ok: false, status: 404, json: async () => ({ code: -1, msg: 'not found' }) };
    }
    return { ok: true, status: 200, json: async () => body };
  };
  return { calls, fetchImpl };
}

function buildService() {
  const { calls, fetchImpl } = mockFetch();
  let clock = NOW;
  const service = createOptionsMarketService({
    client: createBinanceOptionsClient({ fetchImpl }),
    now: () => clock,
  });
  return { service, calls, advance: (ms) => { clock += ms; } };
}

test('parseSymbol entiende el formato de Binance', () => {
  assert.deepEqual(parseSymbol('BTC-261031-68000-C'), {
    symbol: 'BTC-261031-68000-C', underlying: 'BTC', expiry: '261031', strike: 68000, type: 'C',
  });
  assert.equal(parseSymbol('BTCUSDT'), null);
});

test('getChain arma la cadena del vencimiento más cercano por defecto', async () => {
  const { service } = buildService();
  const chain = await service.getChain('BTC');
  assert.equal(chain.underlying, 'BTC');
  assert.equal(chain.spot, 67800.5);
  assert.deepEqual(chain.expiries.map((e) => e.code), ['261016', '261031']);
  assert.equal(chain.expiries[0].dte, 2);
  assert.equal(chain.expiries[1].label, '31 oct 26');
  assert.equal(chain.expiries[1].expiryMs, Date.UTC(2026, 9, 31, 8));
  assert.equal(chain.expiry, '261016');
  assert.equal(chain.rows.length, 1);
  assert.equal(chain.rows[0].put.symbol, null);
});

test('getChain con vencimiento devuelve filas por strike con griegas y bid/ask', async () => {
  const { service } = buildService();
  const chain = await service.getChain('btc', '261031');
  assert.equal(chain.expiry, '261031');
  assert.deepEqual(chain.rows.map((r) => r.strike), [66000, 68000]);
  const atm = chain.rows[1];
  assert.deepEqual(atm.call, {
    symbol: 'BTC-261031-68000-C',
    bid: 1480,
    ask: 1520,
    mark: 1500,
    iv: 0.52,
    delta: 0.51,
    gamma: 0.0001,
    theta: -45.2,
    vega: 60.1,
    openInterest: 12.5,
    minQty: 0.01,
    maxQty: 10,
    stepSize: 0.01,
  });
  // bid a cero → null (sin liquidez)
  assert.equal(atm.put.bid, null);
  assert.equal(atm.put.ask, 1330);
  assert.equal(chain.rows[0].call.symbol, null);
});

test('getChain valida underlying y vencimiento', async () => {
  const { service } = buildService();
  await assert.rejects(() => service.getChain('SOL'), (err) => err.status === 404);
  await assert.rejects(() => service.getChain('BTC', '2610'), (err) => err.status === 400);
  await assert.rejects(() => service.getChain('BTC', '261010'), (err) => err.status === 404);
  await assert.rejects(() => service.getChain('BTC/../x'), (err) => err.status === 400);
});

test('la caché agrupa snapshots durante 30 s', async () => {
  const { service, calls, advance } = buildService();
  await service.getChain('BTC', '261031');
  const first = calls.length;
  await service.getChain('BTC', '261031');
  assert.equal(calls.length, first);
  advance(31_000);
  await service.getChain('BTC', '261031');
  assert.ok(calls.length > first);
});

test('listUnderlyings ordena por relevancia con spot y cambio 24h', async () => {
  const { service } = buildService();
  const list = await service.listUnderlyings();
  assert.deepEqual(list, [
    { underlying: 'BTC', spot: 67800.5, change24hPct: 1.25 },
    { underlying: 'ETH', spot: 2450, change24hPct: -0.5 },
  ]);
});

test('getQuote usa snapshot para UI y conserva datos del contrato', async () => {
  const { service } = buildService();
  const quote = await service.getQuote('BTC-261031-68000-C');
  assert.equal(quote.bid, 1480);
  assert.equal(quote.ask, 1520);
  assert.equal(quote.mark, 1500);
  assert.equal(quote.iv, 0.52);
  assert.equal(quote.underlying, 'BTC');
  assert.equal(quote.strike, 68000);
  assert.equal(quote.type, 'C');
  assert.equal(quote.expiry, '261031');
  assert.equal(quote.spot, 67800.5);
  await assert.rejects(() => service.getQuote('nope'), (err) => err.status === 400);
});

test('getQuote fresh exige libro real sin usar la caché de 30 s', async () => {
  const { service, calls } = buildService();
  await service.getQuote('BTC-261031-68000-C');
  assert.equal(calls.some((url) => new URL(url).pathname === '/eapi/v1/depth'), false);
  const fresh = await service.getQuote('BTC-261031-68000-C', { fresh: true });
  assert.equal(fresh.bid, 1490);
  assert.equal(fresh.ask, 1510);
  assert.ok(calls.some((url) => new URL(url).pathname === '/eapi/v1/depth'));
  assert.ok(calls.some((url) => new URL(url).pathname === '/eapi/v1/mark'
    && new URL(url).searchParams.get('symbol') === 'BTC-261031-68000-C'));
});
