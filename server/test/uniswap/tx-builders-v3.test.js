const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const { buildV3CollectTx, buildV3DecreaseAndCollectTx } = require('../../src/services/uniswap/tx-builders-v3');

test('buildV3CollectTx envia el collect al recipient indicado con max uint128', () => {
  const ctx = {
    tokenId: '123',
    positionManagerAddress: '0x00000000000000000000000000000000000000AA',
    networkConfig: {
      chainId: 42161,
    },
  };
  const recipient = '0x00000000000000000000000000000000000000bb';

  const tx = buildV3CollectTx(ctx, { recipient });
  const iface = new ethers.Interface([
    'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint128 amount0, uint128 amount1)',
  ]);
  const decoded = iface.decodeFunctionData('collect', tx.data);

  assert.equal(tx.to, ctx.positionManagerAddress);
  assert.equal(tx.chainId, 42161);
  assert.equal(tx.kind, 'collect_fees');
  assert.equal(tx.label, 'Collect to wallet');
  assert.equal(tx.recipient, recipient);
  assert.equal(decoded[0].tokenId.toString(), '123');
  assert.equal(decoded[0].recipient, ethers.getAddress(recipient));
  assert.equal(decoded[0].amount0Max.toString(), ((1n << 128n) - 1n).toString());
  assert.equal(decoded[0].amount1Max.toString(), ((1n << 128n) - 1n).toString());
});

test('buildV3DecreaseAndCollectTx empaqueta decrease + collect en un multicall', () => {
  const ctx = {
    tokenId: '123',
    positionManagerAddress: '0x00000000000000000000000000000000000000AA',
    networkConfig: {
      chainId: 42161,
    },
  };
  const recipient = '0x00000000000000000000000000000000000000bb';

  const tx = buildV3DecreaseAndCollectTx(ctx, {
    liquidityDelta: 500n,
    recipient,
  });

  const iface = new ethers.Interface([
    'function multicall(bytes[] data) payable returns (bytes[] results)',
    'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)',
    'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint128 amount0, uint128 amount1)',
  ]);
  const multicallDecoded = iface.decodeFunctionData('multicall', tx.data);
  const subcalls = multicallDecoded[0];
  const decreaseDecoded = iface.decodeFunctionData('decreaseLiquidity', subcalls[0]);
  const collectDecoded = iface.decodeFunctionData('collect', subcalls[1]);

  assert.equal(tx.to, ctx.positionManagerAddress);
  assert.equal(tx.chainId, 42161);
  assert.equal(tx.kind, 'decrease_liquidity');
  assert.equal(tx.label, 'Decrease liquidity');
  assert.equal(tx.recipient, recipient);
  assert.deepEqual(tx.multicallActions, ['decreaseLiquidity', 'collect']);
  assert.equal(subcalls.length, 2);
  assert.equal(decreaseDecoded[0].tokenId.toString(), '123');
  assert.equal(decreaseDecoded[0].liquidity.toString(), '500');
  assert.equal(collectDecoded[0].tokenId.toString(), '123');
  assert.equal(collectDecoded[0].recipient, ethers.getAddress(recipient));
});
