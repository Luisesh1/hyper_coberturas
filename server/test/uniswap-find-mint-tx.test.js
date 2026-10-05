const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const { findMintTxFromLogs } = require('../src/services/uniswap/scan-helpers');

const V3_PM = '0x00000000000000000000000000000000000000a3';
const V4_PM = '0x00000000000000000000000000000000000000a4';
const networkConfig = { deployments: { v3: { positionManager: V3_PM }, v4: { positionManager: V4_PM } } };

function fakeProvider(mintLog) {
  const queried = [];
  return {
    queried,
    getBlockNumber: async () => 50_000,
    getLogs: async (filter) => {
      queried.push(filter.address);
      const inRange = filter.fromBlock <= mintLog.blockNumber && mintLog.blockNumber <= filter.toBlock;
      const sameToken = filter.topics[3] === ethers.zeroPadValue(ethers.toBeHex(mintLog.tokenId), 32);
      return filter.address === mintLog.address && inRange && sameToken
        ? [{ transactionHash: mintLog.txHash, blockNumber: mintLog.blockNumber }]
        : [];
    },
  };
}

// Regresion del orquestador #64 (v4 en Base): los IDs v4 que salen de la API
// NFT de Alchemy no traen tx de mint, y solo se buscaba en los logs para v3,
// asi que el precio de apertura quedaba vacio.
test('encuentra el mint v4 en los logs del PositionManager v4', async () => {
  const provider = fakeProvider({ address: V4_PM, tokenId: 3110339n, blockNumber: 31_234, txHash: '0xabc' });
  const found = await findMintTxFromLogs({ provider, networkConfig, version: 'v4', tokenId: '3110339' });
  assert.deepEqual(found, { txHash: '0xabc', blockNumber: 31_234 });
  assert.ok(provider.queried.every((address) => address === V4_PM));
});

test('v3 sigue buscando en su propio PositionManager', async () => {
  const provider = fakeProvider({ address: V3_PM, tokenId: 42n, blockNumber: 49_000, txHash: '0xdef' });
  const found = await findMintTxFromLogs({ provider, networkConfig, tokenId: '42' });
  assert.equal(found.txHash, '0xdef');
});

test('sin PositionManager para la version no consulta logs', async () => {
  const provider = fakeProvider({ address: V4_PM, tokenId: 1n, blockNumber: 1, txHash: '0x1' });
  const found = await findMintTxFromLogs({ provider, networkConfig: { deployments: {} }, version: 'v4', tokenId: '1' });
  assert.equal(found, null);
  assert.equal(provider.queried.length, 0);
});
