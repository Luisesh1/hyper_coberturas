const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const positionActionsService = require('../src/services/uniswap-position-actions.service');

const { buildModifyRangeRedeployPlan } = positionActionsService.__test;

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
