const { ethers } = require('ethers');
const { ValidationError } = require('../../../../errors/app-error');

function amountOutMin(rawAmountOut, slippageBps = 100) {
  const bps = BigInt(Math.max(0, Math.min(5000, Number(slippageBps) || 100)));
  return rawAmountOut - ((rawAmountOut * bps) / 10_000n);
}

function computeOptimalWeightToken0Pct(priceCurrent, lowerPrice, upperPrice) {
  if (priceCurrent <= lowerPrice) return 100;
  if (priceCurrent >= upperPrice) return 0;
  const sqrtP = Math.sqrt(priceCurrent);
  const sqrtL = Math.sqrt(lowerPrice);
  const sqrtU = Math.sqrt(upperPrice);
  const amount0Value = priceCurrent * (sqrtU - sqrtP) / (sqrtP * sqrtU);
  const amount1Value = sqrtP - sqrtL;
  const total = amount0Value + amount1Value;
  if (!Number.isFinite(total) || total <= 0) return 50;
  return Math.max(1, Math.min(99, (amount0Value / total) * 100));
}

function buildRebalanceSwap(ctx, {
  amount0Available,
  amount1Available,
  targetWeightToken0Pct,
  slippageBps,
}) {
  const price = Number(ctx.priceCurrent);
  if (!Number.isFinite(price) || price <= 0) return null;
  const targetPct = Number(targetWeightToken0Pct);
  if (!Number.isFinite(targetPct) || targetPct <= 0 || targetPct >= 100) {
    throw new ValidationError('targetWeightToken0Pct debe estar entre 0 y 100');
  }

  const value0 = Number(ethers.formatUnits(amount0Available, ctx.token0.decimals)) * price;
  const value1 = Number(ethers.formatUnits(amount1Available, ctx.token1.decimals));
  const totalValue = value0 + value1;
  if (!Number.isFinite(totalValue) || totalValue <= 0) return null;

  const targetValue0 = totalValue * (targetPct / 100);
  if (value0 > targetValue0) {
    const valueToSwap = value0 - targetValue0;
    const amountIn = ethers.parseUnits(String((valueToSwap / price).toFixed(8)), ctx.token0.decimals);
    if (amountIn <= 0n) return null;
    const expectedOut = ethers.parseUnits(String(valueToSwap.toFixed(6)), ctx.token1.decimals);
    const minimumOut = amountOutMin(expectedOut, slippageBps);
    return {
      tokenIn: ctx.token0,
      tokenOut: ctx.token1,
      amountIn,
      amountOutMinimum: minimumOut,
      postAmount0: amount0Available - amountIn,
      postAmount1: amount1Available + minimumOut,
      direction: 'token0_to_token1',
    };
  }

  const valueToSwap = value1 - (totalValue - targetValue0);
  const amountIn = ethers.parseUnits(String(valueToSwap.toFixed(6)), ctx.token1.decimals);
  if (amountIn <= 0n) return null;
  const expectedToken0 = ethers.parseUnits(String((valueToSwap / price).toFixed(8)), ctx.token0.decimals);
  const minimumToken0 = amountOutMin(expectedToken0, slippageBps);
  return {
    tokenIn: ctx.token1,
    tokenOut: ctx.token0,
    amountIn,
    amountOutMinimum: minimumToken0,
    postAmount0: amount0Available + minimumToken0,
    postAmount1: amount1Available - amountIn,
    direction: 'token1_to_token0',
  };
}

function estimateSwapValueUsd(ctx, swap) {
  if (!swap || swap.amountIn <= 0n) return 0;
  if (swap.tokenIn.address.toLowerCase() === ctx.token0.address.toLowerCase()) {
    return Number(ethers.formatUnits(swap.amountIn, swap.tokenIn.decimals)) * Number(ctx.priceCurrent);
  }
  return Number(ethers.formatUnits(swap.amountIn, swap.tokenIn.decimals));
}

function buildModifyRangeRedeployPlan(ctx, {
  amount0Available,
  amount1Available,
  lowerPrice,
  upperPrice,
  slippageBps,
}) {
  const optimalWeight = computeOptimalWeightToken0Pct(ctx.priceCurrent, lowerPrice, upperPrice);
  const swapTargetWeightToken0Pct = Math.max(1, Math.min(99, Number(optimalWeight)));
  const swap = buildRebalanceSwap(ctx, {
    amount0Available,
    amount1Available,
    targetWeightToken0Pct: swapTargetWeightToken0Pct,
    slippageBps,
  });

  return {
    optimalWeight,
    swapTargetWeightToken0Pct,
    swap,
    amount0Desired: swap?.postAmount0 ?? amount0Available,
    amount1Desired: swap?.postAmount1 ?? amount1Available,
  };
}

module.exports = {
  amountOutMin,
  buildModifyRangeRedeployPlan,
  buildRebalanceSwap,
  computeOptimalWeightToken0Pct,
  estimateSwapValueUsd,
};
