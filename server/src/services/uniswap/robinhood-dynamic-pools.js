const { computeV4PoolId } = require('../uniswap-v4-helpers.service');

const ETH = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const FEE = 0x800000;

// PoolKeys contrastadas con Uniswap y StateView. La lista ofrece una identidad
// conocida; el endpoint comprueba en cada consulta que el pool siga inicializado.
const ROBINHOOD_DYNAMIC_POOLS = Object.freeze([
  {
    name: 'EVPLUSAI',
    poolId: '0xc7b615a3721594f73664eb3f62d8290d0fcc8d9d1156aed1ddecbd7f32efd9f5',
    hooks: '0xcB787A5cDEA8B3715d984d82F1203Fd7bFeBE0c4',
    tickSpacing: 10,
    swapReturnsDelta: true,
  },
  {
    name: 'FablesRampETH',
    poolId: '0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551',
    hooks: '0x06a889870C8f83640D6816319f72e2aA579b6080',
    tickSpacing: 10,
    swapReturnsDelta: false,
  },
]);

async function discoverRobinhoodDynamicPools(stateView) {
  const pools = await Promise.all(ROBINHOOD_DYNAMIC_POOLS.map(async (entry) => {
    const computedId = computeV4PoolId({
      currency0: ETH, currency1: USDG, fee: FEE,
      tickSpacing: entry.tickSpacing, hooks: entry.hooks,
    });
    if (computedId.toLowerCase() !== entry.poolId.toLowerCase()) return null;
    try {
      const slot0 = await stateView.getSlot0(entry.poolId);
      if (BigInt(slot0?.sqrtPriceX96 || 0) <= 0n) return null;
      const liquidity = await stateView.getLiquidity(entry.poolId).catch(() => 0n);
      return {
        ...entry,
        network: 'robinhood', version: 'v4', fee: FEE,
        token0: { symbol: 'ETH', address: ETH, decimals: 18 },
        token1: { symbol: 'USDG', address: USDG, decimals: 6 },
        label: `ETH/USDG · ${entry.name}`,
        poolAddress: null,
        isNative: true,
        hasLiquidity: BigInt(liquidity) > 0n,
        existingPool: true,
      };
    } catch {
      return null;
    }
  }));
  return pools.filter(Boolean);
}

module.exports = { ROBINHOOD_DYNAMIC_POOLS, discoverRobinhoodDynamicPools };
