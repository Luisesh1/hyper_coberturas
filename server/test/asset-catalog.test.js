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
  assert.equal(quantum.length, 11);
  for (const symbol of ['QNT', 'INFQ', 'IONQ', 'QBTS', 'RGTI', 'QUBT', 'ARQQ', 'LAES', 'BTQ']) {
    assert.ok(symbols.has(symbol), `falta ${symbol}`);
  }
  assert.ok(quantum.every((asset) => asset.datasource === 'yahoo'));
});

function inCategory(asset, key) {
  return asset.category === key || (asset.extraCategories || []).includes(key);
}

test('catalogo incluye los principales indices mundiales', () => {
  const indices = new Set(ASSETS.filter((asset) => asset.category === 'index').map((asset) => asset.symbol));
  for (const symbol of [
    '^GSPC', '^NDX', '^DJI', '^RUT', '^VIX', '^IXIC', '^FTSE', '^N225',
    '^GDAXI', '^STOXX50E', '^STOXX', '^FCHI', '^HSI', '000001.SS', '^MXX', '^GSPTSE', '^KS11', '^NSEI', '^BVSP', '^AXJO', '^SOX',
  ]) {
    assert.ok(indices.has(symbol), `falta ${symbol}`);
  }
});

test('catalogo incluye la cesta de inteligencia artificial sin duplicar acciones del Top 100', () => {
  const ai = ASSETS.filter((asset) => inCategory(asset, 'stock_ai'));
  const symbols = new Set(ai.map((asset) => asset.symbol));
  const ids = ASSETS.map((asset) => asset.id);

  assert.equal(CATEGORIES.stock_ai, 'Inteligencia artificial');
  for (const symbol of [
    'NVDA', 'MSFT', 'GOOGL', 'META', 'AMZN', 'AMD', 'AVGO', 'PLTR', 'ORCL',
    'TSM', 'ARM', 'ASML', 'SMCI', 'AI', 'SOUN', 'BBAI', 'PATH', 'SNOW', 'CRWV', 'NBIS', 'TEM',
    'MRVL', 'DELL', 'ANET', 'VRT', 'CRDO', 'ALAB', 'BOTZ', 'AIQ',
  ]) {
    assert.ok(symbols.has(symbol), `falta ${symbol}`);
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(findAsset('yahoo', 'NVDA')?.category, 'stock_us_top');
  assert.ok(ai.every((asset) => asset.datasource === 'yahoo'));
});

test('computacion cuantica suma Xanadu, Quantum eMotion, el ETF y las grandes con programa cuantico', () => {
  const quantum = new Set(ASSETS.filter((asset) => inCategory(asset, 'stock_quantum')).map((asset) => asset.symbol));
  for (const symbol of ['XNDU', 'QNC.V', 'QTUM', 'IBM', 'GOOGL', 'HON']) {
    assert.ok(quantum.has(symbol), `falta ${symbol}`);
  }
});
