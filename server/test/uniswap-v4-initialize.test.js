const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { buildV4InitializePoolTx } = require('../src/services/uniswap/tx-builders-v4');
const { DYNAMIC_FEE_FLAG } = require('../src/services/uniswap/v4-hook-safety');

test('el inicializador V4 prepara una transacción separada con la PoolKey dinámica exacta', () => {
  const positionManagerAddress = '0x0000000000000000000000000000000000000A11';
  const hook = '0x0000000000000000000000000000000000000080';
  const tx = buildV4InitializePoolTx({
    networkConfig: { chainId: 84532 },
    positionManagerAddress,
  }, {
    poolKey: {
      currency0: '0x0000000000000000000000000000000000000001',
      currency1: '0x0000000000000000000000000000000000000002',
      fee: DYNAMIC_FEE_FLAG,
      tickSpacing: 60,
      hooks: hook,
    },
    sqrtPriceX96: '79228162514264337593543950336',
  });

  assert.equal(tx.kind, 'initialize_pool_v4');
  assert.equal(tx.to, ethers.getAddress(positionManagerAddress));
  assert.equal(tx.poolKey.fee, DYNAMIC_FEE_FLAG);
  assert.equal(tx.poolKey.hooks, ethers.getAddress(hook));
  assert.equal(tx.sqrtPriceX96, '79228162514264337593543950336');
});
