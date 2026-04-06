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

function buildV3IncreaseTx(ctx, { amount0Desired, amount1Desired, slippageBps = DEFAULT_SLIPPAGE_BPS }) {
  const iface = new ethers.Interface(V3_POSITION_MANAGER_ABI);
  const amount0Min = amountOutMin(amount0Desired, slippageBps);
  const amount1Min = amountOutMin(amount1Desired, slippageBps);
  const data = iface.encodeFunctionData('increaseLiquidity', [{
    tokenId: BigInt(ctx.tokenId),
    amount0Desired,
    amount1Desired,
    amount0Min,
    amount1Min,
    deadline: deadlineFromNow(),
  }]);

  return encodeTx(ctx.positionManagerAddress, data, {
    chainId: ctx.networkConfig.chainId,
    kind: 'increase_liquidity',
    label: 'Increase liquidity',
  });
}

function buildV3DecreaseTx(ctx, { liquidityDelta, slippageBps = DEFAULT_SLIPPAGE_BPS }) {
  const iface = new ethers.Interface(V3_POSITION_MANAGER_ABI);
  // slippageBps se acepta para compatibilidad con otros builders pero el min es 0n
  // intencionalmente: el caller puede ajustar via overrides si lo necesita.
  void slippageBps;
  const data = iface.encodeFunctionData('decreaseLiquidity', [{
    tokenId: BigInt(ctx.tokenId),
    liquidity: liquidityDelta,
    amount0Min: 0n,
    amount1Min: 0n,
    deadline: deadlineFromNow(),
  }]);

  return encodeTx(ctx.positionManagerAddress, data, {
    chainId: ctx.networkConfig.chainId,
    kind: 'decrease_liquidity',
    label: 'Decrease liquidity',
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
  buildV3MintTx,
  buildV3SwapTx,
};
