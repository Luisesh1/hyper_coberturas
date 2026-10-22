const test = require('node:test');
const assert = require('node:assert/strict');

const marketData = require('../src/services/market-data.service');

test('la caché de velas se poda: entradas caducadas y tope de 500', async (t) => {
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(marketData.PROVIDERS.binance, 'fetchCandles', async () => []);
  marketData._clearCache();
  for (let i = 0; i < 600; i += 1) {
    await marketData.getCandles('BTCUSDT', '1m', { datasource: 'binance', startTime: i + 1, endTime: 10_000_000 });
  }
  assert.equal(marketData._cacheSize(), 500);
  // Pasado el TTL, el siguiente set barre todo lo caducado.
  clock += 10_001;
  await marketData.getCandles('BTCUSDT', '1m', { datasource: 'binance', startTime: 99_999, endTime: 10_000_000 });
  assert.equal(marketData._cacheSize(), 1);
  marketData._clearCache();
});
