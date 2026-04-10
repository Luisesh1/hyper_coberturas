/**
 * Constructores de transacciones para Uniswap V3 (mint, increase, decrease, swap).
 *
 * Cada función recibe un `ctx` con la información del network/position manager
 * y retorna una transacción serializable lista para enviar al wallet.
 */

const { ethers } = require('ethers');
const { V3_POSITION_MANAGER_ABI, V3_SWAP_ROUTER_ABI } = require('./abis');
const { DEFAULT_SLIPPAGE_BPS, V3_SWAP_ROUTER_ADDRESS } = require('./constants');
const { encodeTx, deadlineFromNow } = require('./tx-encoders');
const { amountOutMin } = require('../../domains/uniswap/pools/domain/position-action-math');

const MAX_UINT128 = (1n << 128n) - 1n;

function encodeV3DecreaseData(ctx, liquidityDelta) {
  const iface = new ethers.Interface(V3_POSITION_MANAGER_ABI);
  return iface.encodeFunctionData('decreaseLiquidity', [{
    tokenId: BigInt(ctx.tokenId),
    liquidity: liquidityDelta,
    amount0Min: 0n,
    amount1Min: 0n,
    deadline: deadlineFromNow(),
  }]);
}

function encodeV3CollectData(ctx, recipient, amount0Max = MAX_UINT128, amount1Max = MAX_UINT128) {
  const iface = new ethers.Interface(V3_POSITION_MANAGER_ABI);
  return iface.encodeFunctionData('collect', [{
    tokenId: BigInt(ctx.tokenId),
    recipient,
    amount0Max,
    amount1Max,
  }]);
}

function encodeV3IncreaseData(ctx, { amount0Desired, amount1Desired, slippageBps = DEFAULT_SLIPPAGE_BPS }) {
  const iface = new ethers.Interface(V3_POSITION_MANAGER_ABI);
  return iface.encodeFunctionData('increaseLiquidity', [{
    tokenId: BigInt(ctx.tokenId),
    amount0Desired,
    amount1Desired,
    amount0Min: amountOutMin(amount0Desired, slippageBps),
    amount1Min: amountOutMin(amount1Desired, slippageBps),
    deadline: deadlineFromNow(),
  }]);
}

function buildV3IncreaseTx(ctx, { amount0Desired, amount1Desired, slippageBps = DEFAULT_SLIPPAGE_BPS }) {
  const data = encodeV3IncreaseData(ctx, { amount0Desired, amount1Desired, slippageBps });

  return encodeTx(ctx.positionManagerAddress, data, {
    chainId: ctx.networkConfig.chainId,
    kind: 'increase_liquidity',
    label: 'Increase liquidity',
  });
}

function buildV3DecreaseTx(ctx, { liquidityDelta, slippageBps = DEFAULT_SLIPPAGE_BPS }) {
  // slippageBps se acepta para compatibilidad con otros builders pero el min es 0n
  // intencionalmente: el caller puede ajustar via overrides si lo necesita.
  void slippageBps;
  const data = encodeV3DecreaseData(ctx, liquidityDelta);

  return encodeTx(ctx.positionManagerAddress, data, {
    chainId: ctx.networkConfig.chainId,
    kind: 'decrease_liquidity',
    label: 'Decrease liquidity',
  });
}

function buildV3CollectTx(ctx, { recipient, amount0Max = MAX_UINT128, amount1Max = MAX_UINT128 }) {
  const data = encodeV3CollectData(ctx, recipient, amount0Max, amount1Max);

  return encodeTx(ctx.positionManagerAddress, data, {
    chainId: ctx.networkConfig.chainId,
    kind: 'collect_fees',
    label: 'Collect to wallet',
    meta: {
      recipient,
    },
  });
}

function buildV3DecreaseAndCollectTx(ctx, {
  liquidityDelta,
  recipient,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
  amount0Max = MAX_UINT128,
  amount1Max = MAX_UINT128,
}) {
  void slippageBps;
  const iface = new ethers.Interface(V3_POSITION_MANAGER_ABI);
  const data = iface.encodeFunctionData('multicall', [[
    encodeV3DecreaseData(ctx, liquidityDelta),
    encodeV3CollectData(ctx, recipient, amount0Max, amount1Max),
  ]]);

  return encodeTx(ctx.positionManagerAddress, data, {
    chainId: ctx.networkConfig.chainId,
    kind: 'decrease_liquidity',
    label: 'Decrease liquidity',
    meta: {
      recipient,
      multicallActions: ['decreaseLiquidity', 'collect'],
    },
  });
}

function buildV3CollectAndIncreaseTx(ctx, {
  recipient,
  amount0Desired,
  amount1Desired,
}) {
  // slippage min = 0 because collect+increase is atomic inside a single
  // multicall — no MEV window between the two calls, and the amounts are
  // fees we already own.  A tight min here only causes unnecessary reverts
  // when the pool price moves between prepare and execute.
  const iface = new ethers.Interface(V3_POSITION_MANAGER_ABI);
  const data = iface.encodeFunctionData('multicall', [[
    encodeV3CollectData(ctx, recipient),
    encodeV3IncreaseData(ctx, { amount0Desired, amount1Desired, slippageBps: 0 }),
  ]]);

  return encodeTx(ctx.positionManagerAddress, data, {
    chainId: ctx.networkConfig.chainId,
    kind: 'reinvest_fees',
    label: 'Collect & reinvest fees',
    meta: {
      multicallActions: ['collect', 'increaseLiquidity'],
    },
  });
}

function buildV3MintTx(ctx, {
  tickLower,
  tickUpper,
  amount0Desired,
  amount1Desired,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
  recipient,
  amount0Min: overrideAmount0Min,
  amount1Min: overrideAmount1Min,
  gasEstimate,
}) {
  const iface = new ethers.Interface(V3_POSITION_MANAGER_ABI);
  const data = iface.encodeFunctionData('mint', [{
    token0: ctx.token0.address,
    token1: ctx.token1.address,
    fee: ctx.position?.fee ?? ctx.fee,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    amount0Min: overrideAmount0Min ?? amountOutMin(amount0Desired, slippageBps),
    amount1Min: overrideAmount1Min ?? amountOutMin(amount1Desired, slippageBps),
    recipient,
    deadline: deadlineFromNow(),
  }]);

  const txOpts = {
    chainId: ctx.networkConfig.chainId,
    kind: 'mint_position',
    label: 'Mint new position',
  };
  if (gasEstimate) txOpts.gas = gasEstimate;
  return encodeTx(ctx.positionManagerAddress, data, txOpts);
}

function buildV3SwapTx(ctx, swap) {
  if (!swap || swap.amountIn <= 0n) return null;
  const iface = new ethers.Interface(V3_SWAP_ROUTER_ABI);
  const data = iface.encodeFunctionData('exactInputSingle', [{
    tokenIn: swap.tokenIn.address,
    tokenOut: swap.tokenOut.address,
    fee: swap.fee ?? ctx.position?.fee ?? ctx.fee,
    recipient: ctx.normalizedWallet,
    amountIn: swap.amountIn,
    amountOutMinimum: swap.amountOutMinimum,
    sqrtPriceLimitX96: 0n,
  }]);

  return encodeTx(V3_SWAP_ROUTER_ADDRESS, data, {
    chainId: ctx.networkConfig.chainId,
    kind: 'swap',
    label: `Swap ${swap.tokenIn.symbol} -> ${swap.tokenOut.symbol}`,
  });
}

module.exports = {
  buildV3IncreaseTx,
  buildV3DecreaseTx,
  buildV3DecreaseAndCollectTx,
  buildV3CollectAndIncreaseTx,
  buildV3CollectTx,
  buildV3MintTx,
  buildV3SwapTx,
};
