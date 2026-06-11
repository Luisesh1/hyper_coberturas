const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ASSETS,
  CATEGORIES,
  listAssets,
  findAsset,
} = require('../src/services/marketdata-providers/asset-catalog');

test('catalogo expone 100 acciones principales de USA sin IDs duplicados', () => {
  const assets = listAssets();
  const topUsa = assets.filter((asset) => asset.category === 'stock_us_top');
  const ids = assets.map((asset) => asset.id);

  assert.equal(CATEGORIES.stock_us_top, 'USA Top 100');
  assert.equal(topUsa.length, 100);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(topUsa.every((asset) => asset.datasource === 'yahoo'));
  assert.equal(findAsset('yahoo', 'BRK-B')?.name, 'Berkshire Hathaway Class B');
});

test('catalogo incluye la cesta de computacion cuantica', () => {
  const quantum = ASSETS.filter((asset) => asset.category === 'stock_quantum');
  const symbols = new Set(quantum.map((asset) => asset.symbol));

  assert.equal(CATEGORIES.stock_quantum, 'Computación cuántica');
  assert.equal(quantum.length, 9);
  for (const symbol of ['QNT', 'INFQ', 'IONQ', 'QBTS', 'RGTI', 'QUBT', 'ARQQ', 'LAES', 'BTQ']) {
    assert.ok(symbols.has(symbol), `falta ${symbol}`);
  }
  assert.ok(quantum.every((asset) => asset.datasource === 'yahoo'));
});
