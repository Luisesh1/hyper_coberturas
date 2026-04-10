const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const positionActionsService = require('../src/services/uniswap-position-actions.service');

const { buildModifyRangeRedeployPlan, resolveCloseTargetStable } = positionActionsService.__test;

function makeCtx() {
  return {
    priceCurrent: 2100,
    token0: {
      address: '0x0000000000000000000000000000000000000001',
      symbol: 'WETH',
      decimals: 18,
    },
    token1: {
      address: '0x0000000000000000000000000000000000000002',
      symbol: 'USDC',
      decimals: 6,
    },
  };
}

test('buildModifyRangeRedeployPlan rebalancea hacia el nuevo rango y conserva casi todo el capital', () => {
  const ctx = makeCtx();
  const amount0Available = 0n;
  const amount1Available = ethers.parseUnits('31', 6);

  const plan = buildModifyRangeRedeployPlan(ctx, {
    amount0Available,
    amount1Available,
    lowerPrice: 2050,
    upperPrice: 2150,
    slippageBps: 100,
  });

  assert.equal(plan.swap.direction, 'token1_to_token0');
  assert(plan.amount0Desired > 0n);
  assert(plan.amount1Desired < amount1Available);
  assert.equal(plan.swap.postAmount0, plan.amount0Desired);
  assert.equal(plan.swap.postAmount1, plan.amount1Desired);

  const originalUsd = Number(ethers.formatUnits(amount1Available, 6));
  const finalUsd = (Number(ethers.formatUnits(plan.amount0Desired, 18)) * ctx.priceCurrent)
    + Number(ethers.formatUnits(plan.amount1Desired, 6));

  assert(finalUsd <= originalUsd);
  assert(finalUsd >= originalUsd * 0.99);
});

test('buildModifyRangeRedeployPlan tolera rangos totalmente fuera de precio actual', () => {
  const ctx = makeCtx();
  const amount0Available = 0n;
  const amount1Available = ethers.parseUnits('50', 6);

  const plan = buildModifyRangeRedeployPlan(ctx, {
    amount0Available,
    amount1Available,
    lowerPrice: 2200,
    upperPrice: 2400,
    slippageBps: 100,
  });

  assert.equal(plan.optimalWeight, 100);
  assert.equal(plan.swapTargetWeightToken0Pct, 99);
  assert(plan.swap);
  assert.equal(plan.swap.direction, 'token1_to_token0');
  assert(plan.amount0Desired > 0n);
  assert(plan.amount1Desired < amount1Available);
});

test('resolveCloseTargetStable: par WETH/USDT0 cierra a USDT0 sin canjear stable→stable', () => {
  const result = resolveCloseTargetStable(
    {
      token0: { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
      token1: { symbol: 'USDT0', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    },
    'arbitrum'
  );
  assert.equal(result.symbol, 'USDT0');
  assert.equal(result.sourceFromPair, true);
  assert.equal(result.decimals, 6);
});

test('resolveCloseTargetStable: par WETH/USDC mantiene USDC del par (orden indiferente)', () => {
  const aLikeUsdc = {
    token0: { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    token1: { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
  };
  const result = resolveCloseTargetStable(aLikeUsdc, 'arbitrum');
  assert.equal(result.symbol, 'USDC');
  assert.equal(result.sourceFromPair, true);
});

test('resolveCloseTargetStable: par doble-volátil cae al USDC canónico de la red', () => {
  const result = resolveCloseTargetStable(
    {
      token0: { symbol: 'WBTC', address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
      token1: { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
    },
    'arbitrum'
  );
  assert.equal(result.sourceFromPair, false);
  assert.equal(result.symbol, 'USDC');
});

test('resolveCloseTargetStable: par DAI/WETH usa DAI', () => {
  const result = resolveCloseTargetStable(
    {
      token0: { symbol: 'DAI', address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
      token1: { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
    },
    'arbitrum'
  );
  assert.equal(result.symbol, 'DAI');
  assert.equal(result.sourceFromPair, true);
  assert.equal(result.decimals, 18);
});
