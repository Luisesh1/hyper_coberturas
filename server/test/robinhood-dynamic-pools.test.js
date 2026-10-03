const test = require('node:test');
const assert = require('node:assert/strict');
const { ROBINHOOD_DYNAMIC_POOLS, discoverRobinhoodDynamicPools } = require('../src/services/uniswap/robinhood-dynamic-pools');

test('ofrece ambos pools dinámicos sólo si StateView confirma su inicialización', async () => {
  const seen = [];
  const pools = await discoverRobinhoodDynamicPools({
    getSlot0: async (poolId) => {
      seen.push(poolId);
      return { sqrtPriceX96: 1n };
    },
    getLiquidity: async () => 10n,
  });

  assert.deepEqual(pools.map((pool) => pool.name), ['EVPLUSAI', 'FablesRampETH']);
  assert.deepEqual(seen, ROBINHOOD_DYNAMIC_POOLS.map((pool) => pool.poolId));
  assert.ok(pools.every((pool) => pool.existingPool && pool.hasLiquidity && pool.fee === 0x800000));
});

test('oculta un pool dinámico que deja de responder en cadena', async () => {
  const pools = await discoverRobinhoodDynamicPools({
    getSlot0: async (poolId) => {
      if (poolId === ROBINHOOD_DYNAMIC_POOLS[0].poolId) throw new Error('RPC revert');
      return { sqrtPriceX96: 1n };
    },
    getLiquidity: async () => 1n,
  });
  assert.deepEqual(pools.map((pool) => pool.name), ['FablesRampETH']);
});
