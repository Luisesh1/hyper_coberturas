const test = require('node:test');
const assert = require('node:assert/strict');
const { SUPPORTED_NETWORKS } = require('../src/services/uniswap/networks');
const { getSupportMatrix } = require('../src/services/uniswap.service');
const { computeV4PoolId, getUniversalRouterAddress } = require('../src/services/uniswap-v4-helpers.service');
const { getV3SwapRouterAddress } = require('../src/services/uniswap/constants');
const { buildV3SwapTx } = require('../src/services/uniswap/tx-builders-v3');
const { getCanonicalUsdcToken } = require('../src/services/smart-pool-creator.service');
const { isStableSymbol } = require('../src/services/delta-neutral-math.service');
const { resolveCloseTargetStable } = require('../src/services/uniswap/actions/helpers');

test('Robinhood Chain expone exclusivamente v4 con contratos y RPC propios', () => {
  const network = SUPPORTED_NETWORKS.robinhood;
  assert.equal(network.chainId, 4663);
  assert.deepEqual(network.versions, ['v4']);
  assert.match(network.rpcUrl, /robinhood/i);
  assert.match(network.deployments.v4.eventSource, /^0x[0-9a-f]{40}$/i);
  assert.match(network.deployments.v4.positionManager, /^0x[0-9a-f]{40}$/i);
  assert.match(getUniversalRouterAddress('robinhood'), /^0x[0-9a-f]{40}$/i);
  assert.match(network.deployments.v3.eventSource, /^0x[0-9a-f]{40}$/i);
  assert.match(network.deployments.v3.quoter, /^0x[0-9a-f]{40}$/i);
  assert.equal(getV3SwapRouterAddress(network).toLowerCase(), '0xcaf681a66d020601342297493863e78c959e5cb2');
  assert.ok(getSupportMatrix().networks.some((entry) => entry.id === 'robinhood' && entry.chainId === 4663));
});

test('el swap de fondeo v3 se envía al router de Robinhood y USDG se trata como estable', () => {
  const networkConfig = SUPPORTED_NETWORKS.robinhood;
  const tx = buildV3SwapTx({
    networkConfig,
    normalizedWallet: '0x1111111111111111111111111111111111111111',
  }, {
    tokenIn: { address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', symbol: 'WETH' },
    tokenOut: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG' },
    fee: 100,
    amountIn: 1n,
    amountOutMinimum: 1n,
  });
  assert.equal(tx.to.toLowerCase(), getV3SwapRouterAddress(networkConfig).toLowerCase());
  assert.equal(getCanonicalUsdcToken('robinhood').symbol, 'USDG');
  assert.equal(isStableSymbol('USDG'), true);
  assert.equal(resolveCloseTargetStable({
    token0: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 },
    token1: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', decimals: 6 },
  }, 'robinhood').symbol, 'USDG');
});

test('la identidad de los dos pools dinámicos coincide con la PoolKey de Robinhood', () => {
  const common = {
    currency0: '0x0000000000000000000000000000000000000000',
    currency1: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    fee: 0x800000,
    tickSpacing: 10,
  };
  assert.equal(
    computeV4PoolId({ ...common, hooks: '0xcB787A5cDEA8B3715d984d82F1203Fd7bFeBE0c4' }),
    '0xc7b615a3721594f73664eb3f62d8290d0fcc8d9d1156aed1ddecbd7f32efd9f5'
  );
  assert.equal(
    computeV4PoolId({ ...common, hooks: '0x06a889870C8f83640D6816319f72e2aA579b6080' }),
    '0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551'
  );
});

// La protección del primer LP ETH/USDG falló con "No se pudo calcular el valor
// actual USD del pool": la lista de estables del scan de posiciones no tenía
// USDG, así que el snapshot quedaba sin currentValueUsd.
test('el valor USD de una posición ETH/USDG se calcula tratando USDG como estable', () => {
  const { estimateUsdValueFromPair, isStableSymbol: isPricingStable } = require('../src/services/uniswap/pricing');
  assert.equal(isPricingStable('USDG'), true);
  const value = estimateUsdValueFromPair({ symbol: 'ETH' }, { symbol: 'USDG' }, 0.1, 250, 2500);
  assert.equal(value, 500);
});
