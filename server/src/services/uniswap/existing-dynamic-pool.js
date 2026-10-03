const { ethers } = require('ethers');
const { ValidationError } = require('../../errors/app-error');
const onChainManager = require('../onchain-manager.service');
const { SUPPORTED_NETWORKS } = require('./networks');
const { isLiquidityDeltaReturning } = require('./v4-hook-safety');
const { V4_STATE_VIEW_ABI, computeV4PoolId } = require('../uniswap-v4-helpers.service');

async function assertExistingDynamicPool(payload) {
  const network = SUPPORTED_NETWORKS[String(payload.network || '').toLowerCase()];
  if (payload.version !== 'v4' || Number(payload.fee) !== 0x800000 || !payload.hooks
    || !network?.deployments?.v4 || isLiquidityDeltaReturning(payload.hooks)) {
    throw new ValidationError('Hook V4 no soportado para gestionar liquidez.');
  }
  let poolId;
  try {
    const currencies = [ethers.getAddress(payload.token0Address), ethers.getAddress(payload.token1Address)]
      .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
    poolId = computeV4PoolId({
      currency0: currencies[0], currency1: currencies[1], fee: 0x800000,
      tickSpacing: Number(payload.tickSpacing), hooks: ethers.getAddress(payload.hooks),
    });
  } catch {
    throw new ValidationError('Pool V4 dinámico inválido.');
  }
  if (payload.poolId && String(payload.poolId).toLowerCase() !== poolId.toLowerCase()) {
    throw new ValidationError('El poolId no coincide con los parámetros del pool V4.');
  }
  const provider = onChainManager.getProvider(network, { scope: 'uniswap-dynamic-fee-hook' });
  const stateView = onChainManager.getContract({
    runner: provider, address: network.deployments.v4.stateView, abi: V4_STATE_VIEW_ABI,
  });
  const slot0 = await stateView.getSlot0(poolId).catch(() => null);
  if (!slot0?.sqrtPriceX96 || BigInt(slot0.sqrtPriceX96) <= 0n) {
    throw new ValidationError('Sin hook verificado sólo se admite un pool V4 dinámico ya inicializado.');
  }
  return poolId;
}

module.exports = { assertExistingDynamicPool };
