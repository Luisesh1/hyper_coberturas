const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAutoFundingSelection,
  buildOptimalFundingSelection,
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

test('buildAutoFundingSelection prioriza tokens del par sin agregar fillers innecesarios', () => {
  const selection = buildAutoFundingSelection({
    token0Address: '0x00000000000000000000000000000000000000aa',
    token1Address: '0x00000000000000000000000000000000000000bb',
    totalUsdTarget: 1000,
    targetWeightToken0Pct: 50,
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

  // WETH ($750) + USDC ($500) suman $1250 → ya cubren target $1000 con
  // buffer 1.05 ($1050). El planner óptimo NO agrega ARB porque WETH
  // tiene leftover ($225 después de cubrir need0=$525) que se usa como
  // swap source para llenar el último $25 de need1. Total: 2 assets.
  assert.equal(selection.length, 2);
  assert.equal(selection[0].assetId, '0x00000000000000000000000000000000000000aa');
  assert.equal(selection[1].assetId, '0x00000000000000000000000000000000000000bb');
});

test('buildAutoFundingSelection: un solo direct asset alcanza para todo el LP via leftover swap', () => {
  const selection = buildAutoFundingSelection({
    token0Address: '0x00000000000000000000000000000000000000aa',
    token1Address: '0x00000000000000000000000000000000000000bb',
    totalUsdTarget: 1000,
    targetWeightToken0Pct: 50,
    assets: [
      {
        id: '0x00000000000000000000000000000000000000aa',
        address: '0x00000000000000000000000000000000000000aa',
        symbol: 'WETH',
        usableBalance: '0.7',
        usableBalanceRaw: '700000000000000000',
        usdValue: 1500, // 3× target
      },
      {
        id: '0x00000000000000000000000000000000000000cc',
        address: '0x00000000000000000000000000000000000000cc',
        symbol: 'ARB',
        usableBalance: '100',
        usableBalanceRaw: '100000000000000000000',
        usdValue: 120,
      },
    ],
  });
  // WETH alone covers BOTH sides: $525 directo + 1 swap WETH→USDC para
  // los $525 del otro lado. ARB es innecesario y no se selecciona.
  assert.equal(selection.length, 1);
  assert.equal(selection[0].assetId, '0x00000000000000000000000000000000000000aa');
});

test('buildOptimalFundingSelection: un solo asset USDC cubre BTC + USDT con 2 swaps del mismo origen', () => {
  // El caso del usuario: necesita $50 BTC + $50 USDT, solo tiene $200 USDC.
  // El planner debe seleccionar SOLO USDC y devolver swapCount=2.
  const result = buildOptimalFundingSelection({
    token0Address: '0x00000000000000000000000000000000000000aa', // BTC
    token1Address: '0x00000000000000000000000000000000000000bb', // USDT
    totalUsdTarget: 100,
    targetWeightToken0Pct: 50,
    assets: [
      {
        id: '0x00000000000000000000000000000000000000cc',
        address: '0x00000000000000000000000000000000000000cc',
        symbol: 'USDC',
        usableBalance: '200',
        usableBalanceRaw: '200000000',
        usdValue: 200,
        isStable: true,
      },
    ],
  });
  assert.equal(result.selection.length, 1);
  assert.equal(result.selection[0].assetId, '0x00000000000000000000000000000000000000cc');
  assert.equal(result.estimatedSwapCount, 2);
  assert.equal(result.uncoveredUsd, 0);
});

test('buildOptimalFundingSelection: NO toca ETH nativo si WETH y ERC20s ya alcanzan', () => {
  // Caso real del usuario: WETH/USDC pool, target $80, wallet con
  // ETH=$7.48 (usable $3.04 después de gas reserve), WETH=$27, USDC=$8.19,
  // USDT=$43.19. El planner debe usar WETH+USDC+USDT y NO tocar ETH.
  // Wrappear $3 de ETH agrega una tx fallable y reduce el gas disponible.
  const result = buildOptimalFundingSelection({
    token0Address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
    token1Address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
    wrappedNativeAddress: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    totalUsdTarget: 80,
    targetWeightToken0Pct: 50,
    assets: [
      {
        id: 'native',
        address: 'native',
        symbol: 'ETH',
        usableBalance: '0.00138',
        usableBalanceRaw: '1380000000000000',
        usdValue: 3.04,
        isNative: true,
        isWrappedNative: false,
      },
      {
        id: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
        address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
        symbol: 'WETH',
        usableBalance: '0.0122',
        usableBalanceRaw: '12200000000000000',
        usdValue: 27.05,
        isNative: false,
      },
      {
        id: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
        address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
        symbol: 'USDC',
        usableBalance: '8.192',
        usableBalanceRaw: '8192000',
        usdValue: 8.19,
        isStable: true,
      },
      {
        id: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
        address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
        symbol: 'USDT',
        usableBalance: '43.188',
        usableBalanceRaw: '43188000',
        usdValue: 43.19,
        isStable: true,
      },
    ],
  });
  // Debe seleccionar WETH (direct token0) + USDC (direct token1) + USDT
  // (filler que cubre los 2 sides via 2 swaps). NO debe seleccionar ETH.
  const selectedIds = result.selection.map((s) => s.assetId);
  assert.ok(selectedIds.includes('0x82af49447d8a07e3bd95bd0d56f35241523fbab1'), 'WETH selected');
  assert.ok(selectedIds.includes('0xaf88d065e77c8cc2239327c5edb3a432268e5831'), 'USDC selected');
  assert.ok(selectedIds.includes('0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'), 'USDT selected');
  assert.ok(!selectedIds.includes('native'), 'ETH NOT selected (no wrap needed)');
});

test('buildOptimalFundingSelection: skip dust below MIN_SWAP_USD evita swaps mini', () => {
  // 100 USDT para target $50, weight 99/1 → need0=$49.5*1.05=$51.975,
  // need1=$0.5*1.05=$0.525. El segundo swap es dust y se debe saltear.
  const result = buildOptimalFundingSelection({
    token0Address: '0x00000000000000000000000000000000000000aa',
    token1Address: '0x00000000000000000000000000000000000000bb',
    totalUsdTarget: 50,
    targetWeightToken0Pct: 99,
    assets: [
      {
        id: '0x00000000000000000000000000000000000000cc',
        address: '0x00000000000000000000000000000000000000cc',
        symbol: 'USDT',
        usableBalance: '100',
        usableBalanceRaw: '100000000',
        usdValue: 100,
        isStable: true,
      },
    ],
  });
  // Solo 1 swap real (el del lado token0). El lado token1 ($0.525) está
  // por debajo de MIN_SWAP_USD=1.5 y no se cuenta.
  assert.equal(result.estimatedSwapCount, 1);
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
