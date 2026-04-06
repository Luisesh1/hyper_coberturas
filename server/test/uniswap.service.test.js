const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const {
  buildUniversalRouterCalldata,
  buildV4ModifyLiquiditiesCalldata,
  encodeV4MintParams,
  getUniversalRouterAddress,
  V4_ACTIONS,
} = require('../src/services/uniswap-v4-helpers.service');

const {
  computeDistanceToRange,
  computePnlMetrics,
  computeRangeVisual,
  computeV4UnclaimedFees,
  decodeV4PositionInfo,
  estimateTvlApproxUsd,
  estimateUsdValueFromPair,
  extractMintInputAmounts,
  getSupportMatrix,
  liquidityToTokenAmounts,
  parseCreationLogs,
  resolveHistoricalSpotPrice,
  resolveInitialValuation,
  SUPPORTED_NETWORKS,
  tickToPrice,
} = require('../src/services/uniswap.service');

function buildReceiptLog(version, address, values) {
  const abiByVersion = {
    v1: ['event NewExchange(address indexed token, address indexed exchange)'],
    v2: ['event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'],
    v3: ['event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'],
    v4: ['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'],
  };

  const iface = new ethers.Interface(abiByVersion[version]);
  const eventName = version === 'v1'
    ? 'NewExchange'
    : version === 'v2'
      ? 'PairCreated'
      : version === 'v3'
        ? 'PoolCreated'
        : 'Initialize';
  const encoded = iface.encodeEventLog(iface.getEvent(eventName), values);

  return {
    address,
    topics: encoded.topics,
    data: encoded.data,
    index: 0,
  };
}

function buildTransferLog(tokenAddress, from, to, value) {
  const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const encoded = iface.encodeEventLog(iface.getEvent('Transfer'), [from, to, BigInt(value)]);

  return {
    address: tokenAddress,
    topics: encoded.topics,
    data: encoded.data,
    index: 0,
  };
}

const LP_PRICE_INFERENCE_FIXTURE = {
  positionLiquidity: '33950879957265',
  tickLower: -200760,
  tickUpper: -199380,
  amount0: '0.03407014',
  amount1: '35',
};

test('support matrix expone redes populares con versiones soportadas', () => {
  const matrix = getSupportMatrix();

  assert.deepEqual(matrix.versions, ['v1', 'v2', 'v3', 'v4']);
  assert.deepEqual(
    matrix.networks.map((network) => network.id),
    ['ethereum', 'arbitrum', 'base', 'optimism', 'polygon']
  );
  assert.ok(matrix.networks.find((network) => network.id === 'ethereum').versions.includes('v1'));
  assert.ok(!matrix.networks.find((network) => network.id === 'arbitrum').versions.includes('v1'));
});

test('supported networks incluye deployments oficiales relevantes', () => {
  assert.equal(
    SUPPORTED_NETWORKS.polygon.deployments.v4.eventSource,
    '0x67366782805870060151383f4bbff9dab53e5cd6'
  );
  assert.equal(
    SUPPORTED_NETWORKS.base.deployments.v3.eventSource,
    '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'
  );
});

test('parseCreationLogs reconoce evento v2', () => {
  const address = SUPPORTED_NETWORKS.ethereum.deployments.v2.eventSource;
  const receipt = {
    logs: [
      buildReceiptLog('v2', address, [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
        1n,
      ]),
    ],
  };

  const parsed = parseCreationLogs('v2', receipt, address);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].parsed.name, 'PairCreated');
});

test('parseCreationLogs reconoce evento v4', () => {
  const address = SUPPORTED_NETWORKS.polygon.deployments.v4.eventSource;
  const receipt = {
    logs: [
      buildReceiptLog('v4', address, [
        `0x${'11'.repeat(32)}`,
        '0x0000000000000000000000000000000000000000',
        '0x0000000000000000000000000000000000000002',
        3000,
        60,
        '0x0000000000000000000000000000000000000003',
        123n,
        10,
      ]),
    ],
  };

  const parsed = parseCreationLogs('v4', receipt, address);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].parsed.name, 'Initialize');
});

test('tickToPrice convierte tick a precio aproximado', () => {
  const price = tickToPrice(-200400, 18, 6);
  assert.ok(price > 1900 && price < 2000);
});

test('estimateTvlApproxUsd infiere TVL cuando hay stablecoin', () => {
  const tvl = estimateTvlApproxUsd(
    { symbol: 'WETH' },
    '1.5',
    { symbol: 'USDC' },
    '3000'
  );
  assert.equal(tvl, 6000);
});

test('decodeV4PositionInfo extrae tickLower y tickUpper del packed info', () => {
  const poolIdPart = BigInt(`0x${'11'.repeat(25)}`) << 56n;
  const tickLowerEncoded = BigInt(0x1000000 + (-200000));
  const tickUpperEncoded = 200400n;
  const packed =
    poolIdPart |
    (tickUpperEncoded << 32n) |
    (tickLowerEncoded << 8n);

  const decoded = decodeV4PositionInfo(packed);
  assert.equal(decoded.tickLower, -200000);
  assert.equal(decoded.tickUpper, 200400);
  assert.equal(decoded.hasSubscriber, false);
});

test('resolveHistoricalSpotPrice usa lectura exacta si el bloque esta disponible', async () => {
  const result = await resolveHistoricalSpotPrice({
    blockNumber: 1000,
    fetchAtBlock: async (block) => ({ tick: block, price: 123.4567, sqrtPriceX96: 321n }),
  });

  assert.equal(result.accuracy, 'exact');
  assert.equal(result.blockNumber, 1000);
  assert.equal(result.price, 123.4567);
  assert.equal(result.sqrtPriceX96, '321');
});

test('resolveHistoricalSpotPrice cae a bloque anterior cuando el exacto falla', async () => {
  const result = await resolveHistoricalSpotPrice({
    blockNumber: 1000,
    fetchAtBlock: async (block) => {
      if (block > 995) {
        throw new Error('historical state unavailable');
      }
      return { tick: 55, price: 98.7654, sqrtPriceX96: 999n };
    },
  });

  assert.equal(result.accuracy, 'approximate');
  assert.equal(result.blockNumber, 995);
  assert.equal(result.tick, 55);
  assert.equal(result.sqrtPriceX96, '999');
});

test('resolveHistoricalSpotPrice no usa bloques futuros ni latest como precio de apertura', async () => {
  const calls = [];
  const result = await resolveHistoricalSpotPrice({
    blockNumber: 1000,
    fetchAtBlock: async (block) => {
      calls.push(block);
      if (typeof block === 'number' && block >= 1000) {
        throw new Error('historical state unavailable');
      }
      throw new Error('historical state unavailable');
    },
  });

  assert.equal(result.accuracy, 'unavailable');
  assert.deepEqual(calls, [1000, 999, 995, 975, 900, 500]);
});

test('resolveHistoricalSpotPrice devuelve unavailable si ningun bloque responde', async () => {
  const result = await resolveHistoricalSpotPrice({
    blockNumber: 1000,
    fetchAtBlock: async () => {
      throw new Error('historical state unavailable');
    },
  });

  assert.equal(result.accuracy, 'unavailable');
  assert.equal(result.price, null);
  assert.equal(result.blockNumber, null);
});

test('computeRangeVisual detecta cuando el precio actual sale por arriba del rango', () => {
  const visual = computeRangeVisual(1900, 2100, 1950, 2150);
  assert.equal(visual.currentOutOfRangeSide, 'above');
  assert.equal(visual.openMarkerPct, 25);
  assert.equal(visual.currentMarkerPct, 100);
});

test('liquidityToTokenAmounts estima cantidades del LP con el precio actual', () => {
  const amounts = liquidityToTokenAmounts({
    liquidity: '118921496068917',
    sqrtPriceX96: '3637950759960803672862868930969594',
    tickLower: -200400,
    tickUpper: -199860,
    token0Decimals: 18,
    token1Decimals: 6,
  });

  assert.ok(Number(amounts.amount0) >= 0);
  assert.ok(Number(amounts.amount1) > 0);
});

test('estimateUsdValueFromPair valora un par cuando quote es stable', () => {
  const usd = estimateUsdValueFromPair(
    { symbol: 'WETH' },
    { symbol: 'USDC' },
    0.5,
    100,
    2000
  );

  assert.equal(usd, 1100);
});

test('extractMintInputAmounts decodifica calldata V3 mint', () => {
  const token0 = '0x0000000000000000000000000000000000000001';
  const token1 = '0x0000000000000000000000000000000000000002';
  const iface = new ethers.Interface([
    'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  ]);
  const tx = {
    to: SUPPORTED_NETWORKS.ethereum.deployments.v3.positionManager,
    data: iface.encodeFunctionData('mint', [[
      token0,
      token1,
      3000,
      -200000,
      -199000,
      ethers.parseUnits('0.5', 18),
      ethers.parseUnits('1000', 6),
      0n,
      0n,
      '0x00000000000000000000000000000000000000aa',
      123n,
    ]]),
    value: 0n,
  };

  const mint = extractMintInputAmounts({
    tx,
    networkConfig: SUPPORTED_NETWORKS.ethereum,
    version: 'v3',
    token0: { address: token0, decimals: 18 },
    token1: { address: token1, decimals: 6 },
  });

  assert.deepEqual(mint, {
    amount0: 0.5,
    amount1: 1000,
    source: 'tx_input_estimated',
  });
});

test('extractMintInputAmounts decodifica calldata V4 modifyLiquidities', () => {
  const token0 = '0x0000000000000000000000000000000000000001';
  const token1 = '0x0000000000000000000000000000000000000002';
  const mintParam = encodeV4MintParams({
    poolKey: {
      currency0: token0,
      currency1: token1,
      fee: 3000,
      tickSpacing: 60,
      hooks: ethers.ZeroAddress,
    },
    tickLower: -200000,
    tickUpper: -199000,
    liquidity: 1n,
    amount0Max: ethers.parseUnits('0.75', 18),
    amount1Max: ethers.parseUnits('1500', 6),
    owner: '0x00000000000000000000000000000000000000aa',
  });
  const tx = {
    to: SUPPORTED_NETWORKS.arbitrum.deployments.v4.positionManager,
    data: buildV4ModifyLiquiditiesCalldata({
      actions: [V4_ACTIONS.MINT_POSITION],
      params: [mintParam],
      deadline: 123,
    }),
    value: 0n,
  };

  const mint = extractMintInputAmounts({
    tx,
    networkConfig: SUPPORTED_NETWORKS.arbitrum,
    version: 'v4',
    token0: { address: token0, decimals: 18 },
    token1: { address: token1, decimals: 6 },
  });

  assert.deepEqual(mint, {
    amount0: 0.75,
    amount1: 1500,
    source: 'tx_input_estimated',
  });
});

test('extractMintInputAmounts decodifica calldata V4 via Universal Router', () => {
  const token0 = '0x0000000000000000000000000000000000000001';
  const token1 = '0x0000000000000000000000000000000000000002';
  const mintParam = encodeV4MintParams({
    poolKey: {
      currency0: token0,
      currency1: token1,
      fee: 3000,
      tickSpacing: 60,
      hooks: ethers.ZeroAddress,
    },
    tickLower: -200000,
    tickUpper: -199000,
    liquidity: 1n,
    amount0Max: ethers.parseUnits(LP_PRICE_INFERENCE_FIXTURE.amount0, 18),
    amount1Max: ethers.parseUnits(LP_PRICE_INFERENCE_FIXTURE.amount1, 6),
    owner: '0x00000000000000000000000000000000000000aa',
  });
  const tx = {
    to: getUniversalRouterAddress('arbitrum'),
    data: buildUniversalRouterCalldata({
      actions: [V4_ACTIONS.MINT_POSITION],
      params: [mintParam],
      deadline: 123,
    }),
    value: 0n,
  };

  const mint = extractMintInputAmounts({
    tx,
    networkConfig: SUPPORTED_NETWORKS.arbitrum,
    version: 'v4',
    token0: { address: token0, decimals: 18 },
    token1: { address: token1, decimals: 6 },
  });

  assert.deepEqual(mint, {
    amount0: 0.03407014,
    amount1: 35,
    source: 'tx_input_estimated',
  });
});

test('computeDistanceToRange devuelve cero si el precio esta dentro del rango', () => {
  const distance = computeDistanceToRange(100, 120, 110);
  assert.equal(distance.distanceToRangePct, 0);
  assert.equal(distance.distanceToRangePrice, 0);
});

test('computeDistanceToRange detecta distancia cuando el precio queda por arriba', () => {
  const distance = computeDistanceToRange(100, 120, 132);
  assert.equal(distance.distanceToRangePrice, 12);
  assert.equal(distance.distanceToRangePct, 10);
});

test('resolveInitialValuation conserva RPC exacto cuando esta disponible', async () => {
  const result = await resolveInitialValuation({
    provider: {},
    networkConfig: SUPPORTED_NETWORKS.ethereum,
    record: { version: 'v3', mintBlockNumber: 100 },
    token0: { symbol: 'WETH' },
    token1: { symbol: 'USDC' },
    historicalPrice: { price: 2000, accuracy: 'exact', blockNumber: 100 },
    historicalAmounts: { amount0: 0.5, amount1: 1000 },
    currentValueUsd: 2100,
    unclaimedFeesUsd: 50,
  });

  assert.equal(result.priceAtOpen, 2000);
  assert.equal(result.priceAtOpenAccuracy, 'exact');
  assert.equal(result.priceAtOpenSource, 'rpc_exact');
  assert.equal(result.initialValueUsd, 2000);
  assert.equal(result.initialValueUsdAccuracy, 'exact');
  assert.equal(result.initialValueUsdSource, 'rpc_exact');
});

test('resolveInitialValuation etiqueta RPC previo como aproximado', async () => {
  const result = await resolveInitialValuation({
    provider: {},
    networkConfig: SUPPORTED_NETWORKS.ethereum,
    record: { version: 'v3', mintBlockNumber: 99 },
    token0: { symbol: 'WETH' },
    token1: { symbol: 'USDC' },
    historicalPrice: { price: 1995, accuracy: 'approximate', blockNumber: 98 },
    historicalAmounts: { amount0: 0.5, amount1: 997.5 },
    currentValueUsd: 2100,
    unclaimedFeesUsd: 50,
  });

  assert.equal(result.priceAtOpenSource, 'rpc_prior_block');
  assert.equal(result.priceAtOpenAccuracy, 'approximate');
  assert.equal(result.initialValueUsdSource, 'rpc_prior_block');
  assert.equal(result.initialValueUsdAccuracy, 'approximate');
});

test('resolveInitialValuation reconstruye V3 desde transferencias del receipt', async () => {
  const wallet = '0x00000000000000000000000000000000000000aa';
  const token0 = { symbol: 'WETH', address: '0x0000000000000000000000000000000000000001', decimals: 18 };
  const token1 = { symbol: 'USDC', address: '0x0000000000000000000000000000000000000002', decimals: 6 };
  const tx = {
    hash: '0xabc',
    to: SUPPORTED_NETWORKS.ethereum.deployments.v3.positionManager,
    data: '0x',
    value: 0n,
    blockNumber: 321,
  };
  const receipt = {
    blockNumber: 321,
    logs: [
      buildTransferLog(token0.address, wallet, '0x00000000000000000000000000000000000000bb', ethers.parseUnits(LP_PRICE_INFERENCE_FIXTURE.amount0, 18)),
      buildTransferLog(token1.address, wallet, '0x00000000000000000000000000000000000000bb', ethers.parseUnits(LP_PRICE_INFERENCE_FIXTURE.amount1, 6)),
    ],
  };

  const result = await resolveInitialValuation({
    provider: {},
    networkConfig: SUPPORTED_NETWORKS.ethereum,
    positionLiquidity: LP_PRICE_INFERENCE_FIXTURE.positionLiquidity,
    record: {
      version: 'v3',
      txHash: tx.hash,
      owner: wallet,
      mintBlockNumber: 321,
      tickLower: LP_PRICE_INFERENCE_FIXTURE.tickLower,
      tickUpper: LP_PRICE_INFERENCE_FIXTURE.tickUpper,
      positionLiquidity: LP_PRICE_INFERENCE_FIXTURE.positionLiquidity,
    },
    token0,
    token1,
    historicalPrice: { price: null, accuracy: 'unavailable', blockNumber: null },
    historicalAmounts: { amount0: null, amount1: null },
    currentValueUsd: 2100,
    unclaimedFeesUsd: 50,
    getTransactionByHash: async () => tx,
    getReceiptByHash: async () => receipt,
  });

  assert.ok(result.priceAtOpen > 2000 && result.priceAtOpen < 2005);
  assert.equal(result.priceAtOpenSource, 'tx_receipt_transfers');
  assert.ok(result.initialValueUsd > 103 && result.initialValueUsd < 104);
  assert.equal(result.initialValueUsdSource, 'tx_receipt_transfers');
});

test('resolveInitialValuation reconstruye V4 desde transferencias del receipt', async () => {
  const wallet = '0x00000000000000000000000000000000000000aa';
  const token0 = { symbol: 'WETH', address: '0x0000000000000000000000000000000000000001', decimals: 18 };
  const token1 = { symbol: 'USDC', address: '0x0000000000000000000000000000000000000002', decimals: 6 };
  const mintParam = encodeV4MintParams({
    poolKey: {
      currency0: token0.address,
      currency1: token1.address,
      fee: 3000,
      tickSpacing: 60,
      hooks: ethers.ZeroAddress,
    },
    tickLower: -200000,
    tickUpper: -199000,
    liquidity: 1n,
    amount0Max: ethers.parseUnits('0.25', 18),
    amount1Max: ethers.parseUnits('500', 6),
    owner: wallet,
  });
  const tx = {
    hash: '0xdef',
    to: SUPPORTED_NETWORKS.arbitrum.deployments.v4.positionManager,
    data: buildV4ModifyLiquiditiesCalldata({
      actions: [V4_ACTIONS.MINT_POSITION],
      params: [mintParam],
      deadline: 123,
    }),
    value: 0n,
    blockNumber: 654,
  };
  const receipt = {
    blockNumber: 654,
    logs: [
      buildTransferLog(token0.address, wallet, '0x00000000000000000000000000000000000000bb', ethers.parseUnits(LP_PRICE_INFERENCE_FIXTURE.amount0, 18)),
      buildTransferLog(token1.address, wallet, '0x00000000000000000000000000000000000000bb', ethers.parseUnits(LP_PRICE_INFERENCE_FIXTURE.amount1, 6)),
    ],
  };

  const result = await resolveInitialValuation({
    provider: {},
    networkConfig: SUPPORTED_NETWORKS.arbitrum,
    positionLiquidity: LP_PRICE_INFERENCE_FIXTURE.positionLiquidity,
    record: {
      version: 'v4',
      txHash: tx.hash,
      owner: wallet,
      mintBlockNumber: 654,
      tickLower: LP_PRICE_INFERENCE_FIXTURE.tickLower,
      tickUpper: LP_PRICE_INFERENCE_FIXTURE.tickUpper,
    },
    token0,
    token1,
    historicalPrice: { price: null, accuracy: 'unavailable', blockNumber: null },
    historicalAmounts: { amount0: null, amount1: null },
    currentValueUsd: 1100,
    unclaimedFeesUsd: 20,
    getTransactionByHash: async () => tx,
    getReceiptByHash: async () => receipt,
  });

  assert.ok(result.priceAtOpen > 2000 && result.priceAtOpen < 2005);
  assert.equal(result.priceAtOpenSource, 'tx_receipt_transfers');
  assert.ok(result.initialValueUsd > 103 && result.initialValueUsd < 104);
  assert.equal(result.initialValueUsdSource, 'tx_receipt_transfers');
});

test('resolveInitialValuation cae a calldata cuando no hay montos reales en el receipt', async () => {
  const token0 = { symbol: 'WETH', address: '0x0000000000000000000000000000000000000001', decimals: 18 };
  const token1 = { symbol: 'USDC', address: '0x0000000000000000000000000000000000000002', decimals: 6 };
  const mintParam = encodeV4MintParams({
    poolKey: {
      currency0: token0.address,
      currency1: token1.address,
      fee: 3000,
      tickSpacing: 60,
      hooks: ethers.ZeroAddress,
    },
    tickLower: -200000,
    tickUpper: -199000,
    liquidity: 1n,
    amount0Max: ethers.parseUnits(LP_PRICE_INFERENCE_FIXTURE.amount0, 18),
    amount1Max: ethers.parseUnits(LP_PRICE_INFERENCE_FIXTURE.amount1, 6),
    owner: '0x00000000000000000000000000000000000000aa',
  });
  const tx = {
    hash: '0x123',
    to: getUniversalRouterAddress('arbitrum'),
    data: buildUniversalRouterCalldata({
      actions: [V4_ACTIONS.MINT_POSITION],
      params: [mintParam],
      deadline: 123,
    }),
    value: 0n,
    blockNumber: 777,
  };

  const result = await resolveInitialValuation({
    provider: {},
    networkConfig: SUPPORTED_NETWORKS.arbitrum,
    positionLiquidity: LP_PRICE_INFERENCE_FIXTURE.positionLiquidity,
    record: {
      version: 'v4',
      txHash: tx.hash,
      owner: '0x00000000000000000000000000000000000000aa',
      mintBlockNumber: 777,
      tickLower: LP_PRICE_INFERENCE_FIXTURE.tickLower,
      tickUpper: LP_PRICE_INFERENCE_FIXTURE.tickUpper,
    },
    token0,
    token1,
    historicalPrice: { price: null, accuracy: 'unavailable', blockNumber: null },
    historicalAmounts: { amount0: null, amount1: null },
    currentValueUsd: 1100,
    unclaimedFeesUsd: 20,
    getTransactionByHash: async () => tx,
    getReceiptByHash: async () => ({ blockNumber: 777, logs: [] }),
  });

  assert.ok(result.priceAtOpen > 2000 && result.priceAtOpen < 2005);
  assert.equal(result.priceAtOpenSource, 'tx_input_estimated');
  assert.ok(result.initialValueUsd > 103 && result.initialValueUsd < 104);
  assert.equal(result.initialValueUsdSource, 'tx_input_estimated');
});

test('resolveInitialValuation devuelve unavailable si no existe ninguna estrategia util', async () => {
  const result = await resolveInitialValuation({
    provider: {},
    networkConfig: SUPPORTED_NETWORKS.ethereum,
    record: { version: 'v3', mintBlockNumber: 10 },
    token0: { symbol: 'ARB' },
    token1: { symbol: 'ETH' },
    historicalPrice: { price: null, accuracy: 'unavailable', blockNumber: null },
    historicalAmounts: { amount0: null, amount1: null },
    currentValueUsd: null,
    unclaimedFeesUsd: null,
  });

  assert.equal(result.priceAtOpen, null);
  assert.equal(result.priceAtOpenSource, 'unavailable');
  assert.equal(result.initialValueUsd, null);
  assert.equal(result.initialValueUsdSource, 'unavailable');
  assert.equal(result.valuationAccuracy, 'unavailable');
});

test('computePnlMetrics calcula PnL total y rendimiento', () => {
  const pnl = computePnlMetrics(1000, 1120, 30);
  assert.equal(pnl.pnlTotalUsd, 150);
  assert.equal(pnl.pnlTotalPct, 15);
  assert.equal(pnl.yieldPct, 15);
});

test('computeV4UnclaimedFees replica la formula base de growth inside', () => {
  const q128 = 2n ** 128n;
  const fees = computeV4UnclaimedFees({
    liquidity: 10n,
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 2n * q128,
    feeGrowthInside0X128: 3n * q128,
    feeGrowthInside1X128: 5n * q128,
  });

  assert.equal(fees.fees0, 30n);
  assert.equal(fees.fees1, 30n);
});

test('computeV4UnclaimedFees maneja wraparound uint256 sin perder fees', () => {
  const q128 = 2n ** 128n;
  const maxUint256 = (1n << 256n) - 1n;
  const fees = computeV4UnclaimedFees({
    liquidity: 10n,
    feeGrowthInside0LastX128: maxUint256 - (2n * q128) + 1n,
    feeGrowthInside1LastX128: maxUint256 - q128 + 1n,
    feeGrowthInside0X128: q128,
    feeGrowthInside1X128: 4n * q128,
  });

  assert.equal(fees.fees0, 30n);
  assert.equal(fees.fees1, 50n);
});
