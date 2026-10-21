const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeSources,
  valueLpPosition,
  valueHyperliquid,
} = require('../src/services/wallet-metrics/valuation');

const NOW = 1_800_000_000_000;

test('mergeSources: fuentes sanas suman por tipo y el punto no es parcial', () => {
  const out = mergeSources({
    'tokens:arbitrum': { ok: true, usd: 100, items: [] },
    'tokens:base': { ok: true, usd: 5, items: [] },
    'lps:arbitrum': { ok: true, items: [{ id: 'v3:arbitrum:1', usd: 400 }] },
    hl: { ok: true, usd: 50, items: [] },
  }, null, NOW);

  assert.deepEqual(out.totals, { tokensUsd: 105, lpUsd: 400, hlUsd: 50, totalUsd: 555 });
  assert.equal(out.isPartial, false);
  assert.deepEqual(out.staleSources, []);
  assert.equal(out.sources['lps:arbitrum'].lastOkAt, NOW);
  assert.equal(out.sources['lps:arbitrum'].stale, false);
});

test('mergeSources: una fuente caida reusa su ultimo valor sin limite de antiguedad', () => {
  const lastOkAt = NOW - 5 * 24 * 3600_000;
  const previous = {
    sources: {
      'lps:arbitrum': { usd: 400, items: [{ id: 'v3:arbitrum:1', usd: 400 }], lastOkAt, stale: false },
    },
  };
  const out = mergeSources({
    'lps:arbitrum': { ok: false, error: 'rpc timeout' },
    hl: { ok: true, usd: 50, items: [] },
  }, previous, NOW);

  assert.equal(out.totals.lpUsd, 400);
  assert.equal(out.totals.totalUsd, 450);
  assert.equal(out.isPartial, true);
  assert.deepEqual(out.staleSources, [{ key: 'lps:arbitrum', lastOkAt }]);
  assert.equal(out.sources['lps:arbitrum'].stale, true);
  assert.equal(out.sources['lps:arbitrum'].error, 'rpc timeout');
  assert.deepEqual(out.sources['lps:arbitrum'].items, [{ id: 'v3:arbitrum:1', usd: 400 }]);
});

test('mergeSources: una fuente que nunca respondio cuenta 0 y marca parcial', () => {
  const out = mergeSources({ hl: { ok: false, error: 'down' } }, null, NOW);
  assert.equal(out.totals.hlUsd, 0);
  assert.equal(out.isPartial, true);
  assert.deepEqual(out.staleSources, [{ key: 'hl', lastOkAt: null }]);
});

test('mergeSources: un LP sin precio reusa su valor previo y el resto de la fuente es fresco', () => {
  const lastOkAt = NOW - 3600_000;
  const previous = {
    sources: {
      'lps:polygon': {
        usd: 300,
        lastOkAt,
        items: [
          { id: 'v3:polygon:7', usd: 200, lastOkAt },
          { id: 'v3:polygon:8', usd: 100, lastOkAt },
        ],
      },
    },
  };
  const out = mergeSources({
    'lps:polygon': {
      ok: true,
      items: [
        { id: 'v3:polygon:7', usd: null },
        { id: 'v3:polygon:9', usd: 50 },
      ],
    },
  }, previous, NOW);

  // #7 reusa 200, #9 es nuevo con 50, #8 ya no existe.
  assert.equal(out.totals.lpUsd, 250);
  assert.equal(out.isPartial, true);
  assert.deepEqual(out.staleSources, [{ key: 'lp:v3:polygon:7', lastOkAt }]);
  const item7 = out.sources['lps:polygon'].items.find((i) => i.id === 'v3:polygon:7');
  assert.equal(item7.stale, true);
  assert.equal(item7.usd, 200);
});

test('mergeSources: un LP sin precio ni valor previo cuenta 0', () => {
  const out = mergeSources({
    'lps:polygon': { ok: true, items: [{ id: 'v3:polygon:7', usd: null }] },
  }, null, NOW);
  assert.equal(out.totals.lpUsd, 0);
  assert.deepEqual(out.staleSources, [{ key: 'lp:v3:polygon:7', lastOkAt: null }]);
});

test('valueLpPosition: con ambos precios suma posicion y fees', () => {
  const v = valueLpPosition({
    token0: { symbol: 'WETH', address: '0xa' },
    token1: { symbol: 'USDC', address: '0xb' },
    positionAmount0: 1, positionAmount1: 1000,
    unclaimedFees0: 0.01, unclaimedFees1: 5,
    priceCurrent: 2000,
  }, (t) => ({ WETH: 2000, USDC: 1 }[t.symbol] ?? null));
  assert.equal(v.usd, 2000 + 1000 + 20 + 5);
  assert.equal(v.positionUsd, 3000);
  assert.equal(v.feesUsd, 25);
});

test('valueLpPosition: deduce el token sin precio desde el precio del pool', () => {
  // token0 = FOO sin precio; pool: 1 FOO = 0.001 WETH.
  const v = valueLpPosition({
    token0: { symbol: 'FOO', address: '0xf' },
    token1: { symbol: 'WETH', address: '0xa' },
    positionAmount0: 1000, positionAmount1: 1,
    unclaimedFees0: 0, unclaimedFees1: 0,
    priceCurrent: 0.001,
  }, (t) => (t.symbol === 'WETH' ? 2000 : null));
  assert.equal(v.usd, 1000 * 2 + 2000);
  assert.equal(v.priceSource0, 'pool');
});

test('valueLpPosition: deduce token1 cuando solo token0 tiene precio', () => {
  const v = valueLpPosition({
    token0: { symbol: 'WETH' }, token1: { symbol: 'BAR' },
    positionAmount0: 1, positionAmount1: 4000,
    unclaimedFees0: 0, unclaimedFees1: 0,
    priceCurrent: 4000, // 1 WETH = 4000 BAR
  }, (t) => (t.symbol === 'WETH' ? 2000 : null));
  assert.equal(v.usd, 2000 + 2000);
  assert.equal(v.priceSource1, 'pool');
});

test('valueLpPosition: sin precio en ningun lado devuelve usd null', () => {
  const v = valueLpPosition({
    token0: { symbol: 'FOO' }, token1: { symbol: 'BAR' },
    positionAmount0: 1, positionAmount1: 1, priceCurrent: 1,
  }, () => null);
  assert.equal(v.usd, null);
});

test('valueHyperliquid: cuenta separada suma perps + spot', () => {
  const v = valueHyperliquid({
    perp: { marginSummary: { accountValue: '91.5' }, assetPositions: [{ position: { coin: 'ETH' } }] },
    spot: { balances: [
      { coin: 'USDC', token: 0, total: '10' },
      { coin: 'HYPE', token: 150, total: '2' },
      { coin: 'DUST', token: 999, total: '5' },
    ] },
    abstraction: 'disabled',
    spotPriceOf: (b) => ({ USDC: 1, HYPE: 80 }[b.coin] ?? null),
  });
  assert.equal(v.perpUsd, 91.5);
  assert.equal(v.spotUsd, 170);
  assert.equal(v.usd, 261.5);
  assert.equal(v.positionsCount, 1);
  assert.equal(v.spot.find((b) => b.coin === 'DUST').priced, false);
});

test('valueHyperliquid: cuenta unificada no suma dos veces el USDC', () => {
  const v = valueHyperliquid({
    perp: { marginSummary: { accountValue: '100' }, assetPositions: [] },
    spot: { balances: [
      { coin: 'USDC', token: 0, total: '100' },
      { coin: 'HYPE', token: 150, total: '1' },
    ] },
    abstraction: 'unifiedAccount',
    spotPriceOf: (b) => ({ USDC: 1, HYPE: 80 }[b.coin] ?? null),
  });
  assert.equal(v.usd, 180);
  assert.equal(v.unified, true);
});
