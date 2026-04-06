const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAutoFundingSelection,
  computeAmountsFromWeight,
  computeRangeSuggestions,
  orientPriceToSelectedOrder,
  orientRangeToCanonicalOrder,
  pickTargetTokenByUsdDeficit,
  sortTokensByAddress,
} = require('../src/services/smart-pool-creator.service');

test('computeRangeSuggestions genera presets ATR y fallback validos', () => {
  const atrSuggestions = computeRangeSuggestions(2500, 50, true);
  const fallbackSuggestions = computeRangeSuggestions(2500, null, false);

  assert.equal(atrSuggestions.length, 3);
  assert.equal(fallbackSuggestions.length, 3);
  assert.equal(atrSuggestions[1].preset, 'balanced');
  assert.ok(atrSuggestions[0].rangeLowerPrice < atrSuggestions[0].rangeUpperPrice);
  assert.ok(fallbackSuggestions[2].widthPct > 0);
});

test('computeAmountsFromWeight reparte el valor objetivo segun el balance deseado', () => {
  const result = computeAmountsFromWeight(60, 1000, 2500, 1, 18, 6);

  assert.equal(result.amount0Desired, '0.24');
  assert.equal(result.amount1Desired, '400.0');
});

test('buildAutoFundingSelection prioriza tokens del par y stables antes de otros activos', () => {
  const selection = buildAutoFundingSelection({
    token0Address: '0x00000000000000000000000000000000000000aa',
    token1Address: '0x00000000000000000000000000000000000000bb',
    totalUsdTarget: 1000,
    assets: [
      {
        id: '0x00000000000000000000000000000000000000cc',
        address: '0x00000000000000000000000000000000000000cc',
        symbol: 'ARB',
        usableBalance: '100',
        usableBalanceRaw: '100000000000000000000',
        usdValue: 120,
      },
      {
        id: '0x00000000000000000000000000000000000000bb',
        address: '0x00000000000000000000000000000000000000bb',
        symbol: 'USDC',
        usableBalance: '500',
        usableBalanceRaw: '500000000',
        usdValue: 500,
        isStable: true,
      },
      {
        id: '0x00000000000000000000000000000000000000aa',
        address: '0x00000000000000000000000000000000000000aa',
        symbol: 'WETH',
        usableBalance: '0.3',
        usableBalanceRaw: '300000000000000000',
        usdValue: 750,
      },
    ],
  });

  assert.equal(selection.length, 2);
  assert.equal(selection[0].assetId, '0x00000000000000000000000000000000000000aa');
  assert.equal(selection[1].assetId, '0x00000000000000000000000000000000000000bb');
});

test('orienta el precio del pool al orden seleccionado por el usuario', () => {
  assert.equal(orientPriceToSelectedOrder(2050, false), 2050);
  assert.equal(Number(orientPriceToSelectedOrder(1 / 2050, true).toFixed(6)), 2050);
});

test('invierte el rango al convertir del orden seleccionado al orden canonico del pool', () => {
  const canonical = orientRangeToCanonicalOrder(2050, 2250, true);

  assert.equal(Number(canonical.rangeLowerPrice.toFixed(9)), Number((1 / 2250).toFixed(9)));
  assert.equal(Number(canonical.rangeUpperPrice.toFixed(9)), Number((1 / 2050).toFixed(9)));
});

test('sortTokensByAddress detecta cuando el orden solicitado difiere del orden del pool', () => {
  const ordered = sortTokensByAddress(
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 }
  );

  assert.equal(ordered.reversed, true);
  assert.equal(ordered.token0.symbol, 'USDC');
  assert.equal(ordered.token1.symbol, 'WETH');
});

test('pickTargetTokenByUsdDeficit prioriza el deficit económico real y no el raw amount', () => {
  const token0 = { address: '0x00000000000000000000000000000000000000aa', symbol: 'WETH', decimals: 18 };
  const token1 = { address: '0x00000000000000000000000000000000000000bb', symbol: 'USDC', decimals: 6 };

  const picked = pickTargetTokenByUsdDeficit({
    remaining0Raw: 1000000000000000n, // 0.001 WETH ~= $2.5
    remaining1Raw: 10000000n, // 10 USDC = $10
    token0,
    token1,
    token0UsdPrice: 2500,
    token1UsdPrice: 1,
  });

  assert.equal(picked.symbol, 'USDC');
});
