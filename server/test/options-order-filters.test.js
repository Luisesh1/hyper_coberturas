const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesStep, requireOrderFilters, validateBinanceOrderBatch,
} = require('../src/services/options/options-order-filters');

const expiryDate = Date.UTC(2026, 9, 30, 8);
const option = {
  symbol: 'BTC-261030-60000-C', status: 'TRADING', quoteAsset: 'USDT',
  expiryDate,
  filters: [{ filterType: 'PRICE_FILTER', minPrice: '0.02',
    maxPrice: '10000.02', tickSize: '0.05', minQty: '0.01', maxQty: '10',
    stepSize: '0.01' }],
};
const valid = { symbol: option.symbol, price: 99.97, quantity: 0.03 };
const now = expiryDate - 2 * 86400000;
const deadline = now + 600000;

test('valida exactamente ticks y lotes con offset de mínimos, no con floats aproximados', () => {
  assert.equal(matchesStep('99.97', '0.02', '0.05'), true);
  assert.equal(matchesStep('99.95', '0.02', '0.05'), false);
  assert.equal(matchesStep('0.03', '0.01', '0.01'), true);
  assert.equal(matchesStep('0.035', '0.01', '0.01'), false);
  assert.equal(matchesStep('1e-2', '0', '0.01'), false);
  assert.equal(requireOrderFilters({ optionSymbols: [option] }, valid, now, deadline), true);
});

test('la cuenta no emite órdenes fuera del tick, lote, estado o vencimiento', () => {
  const info = { optionSymbols: [option] };
  assert.throws(() => validateBinanceOrderBatch(info, [{ ...valid, price: 99.95 }], now, deadline), /tickSize/);
  assert.throws(() => validateBinanceOrderBatch(info, [{ ...valid, quantity: 0.035 }], now, deadline), /stepSize/);
  assert.throws(() => validateBinanceOrderBatch(info, [{ ...valid, quantity: 15 }], now, deadline), /limits/);
  assert.throws(() => validateBinanceOrderBatch(info, [{ ...valid, price: 10000.07 }], now, deadline), /limits/);
  assert.throws(() => validateBinanceOrderBatch(info, [valid], now, expiryDate), /expires/);
  assert.throws(() => validateBinanceOrderBatch({ optionSymbols: [
    { ...option, status: 'BREAK' },
  ] }, [valid], now, deadline), /TRADING/);
  assert.throws(() => validateBinanceOrderBatch({ optionSymbols: [
    { ...option, filters: [] },
  ] }, [valid], now, deadline), /filter/);
  assert.throws(() => validateBinanceOrderBatch(null, [valid], now, deadline), /exchangeInfo/);
});

test('no acepta ticks inválidos en cualquiera de las patas de un batch', () => {
  assert.throws(() => validateBinanceOrderBatch({ optionSymbols: [option] }, [
    valid, { ...valid, price: 99.95 },
  ], now, deadline), /tickSize/);
});
