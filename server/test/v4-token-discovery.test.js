const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAlchemyNftBaseUrl,
  fetchTokenIdsFromAlchemy,
  fetchTokenIdsFromLogs,
  discoverV4TokenIds,
} = require('../src/services/uniswap/v4-token-discovery');

const WALLET = '0x7A9A100D56642d70fC66A78487dfd0c8098eBEf6';
const PM = '0x7c5f5a4bbd8fd63184577525326123b519429bdc';

test('buildAlchemyNftBaseUrl deriva el endpoint NFT de un RPC de Alchemy', () => {
  assert.equal(
    buildAlchemyNftBaseUrl('https://base-mainnet.g.alchemy.com/v2/abc123'),
    'https://base-mainnet.g.alchemy.com/nft/v3/abc123'
  );
  assert.equal(buildAlchemyNftBaseUrl('https://mainnet.base.org'), null);
  assert.equal(buildAlchemyNftBaseUrl(null), null);
});

test('fetchTokenIdsFromAlchemy pagina y conserva los NFT marcados como spam', async () => {
  const calls = [];
  const http = {
    get: async (url, { params }) => {
      calls.push({ url, params });
      if (!params.pageKey) {
        return { data: { ownedNfts: [{ tokenId: '1', isSpam: true }, { tokenId: '2' }], pageKey: 'p2' } };
      }
      return { data: { ownedNfts: [{ tokenId: '3' }], pageKey: null } };
    },
  };
  const ids = await fetchTokenIdsFromAlchemy({
    rpcUrl: 'https://base-mainnet.g.alchemy.com/v2/k',
    wallet: WALLET,
    contractAddress: PM,
    http,
  });
  assert.deepEqual(ids, ['1', '2', '3']);
  assert.equal(calls[0].url, 'https://base-mainnet.g.alchemy.com/nft/v3/k/getNFTsForOwner');
  assert.deepEqual(calls[0].params['contractAddresses[]'], PM);
  assert.equal(calls[1].params.pageKey, 'p2');
});

test('fetchTokenIdsFromAlchemy falla claro si el RPC no es de Alchemy', async () => {
  await assert.rejects(
    fetchTokenIdsFromAlchemy({ rpcUrl: 'https://mainnet.base.org', wallet: WALLET, contractAddress: PM, http: {} }),
    /no es de Alchemy/
  );
});

test('discoverV4TokenIds usa Etherscan cuando responde', async () => {
  const firstInbound = new Map([['7', { txHash: '0xabc' }]]);
  const result = await discoverV4TokenIds({
    etherscanLookup: async () => ({ tokenIds: ['7'], firstInbound, truncated: false }),
    alchemyLookup: async () => { throw new Error('no debería llamarse'); },
  });
  assert.deepEqual(result.tokenIds, ['7']);
  assert.equal(result.firstInbound, firstInbound);
  assert.equal(result.source, 'etherscan');
  assert.equal(result.warning, null);
});

// Regresión: el plan gratuito de Etherscan V2 no cubre Base ("Free API access
// is not supported for this chain"). El escaneo v4 fallaba entero, el finalize
// de un mint no encontraba la posición y la saga borraba el orquestador
// dejando el LP sin cobertura.
test('discoverV4TokenIds recurre a Alchemy si Etherscan no cubre la red', async () => {
  const result = await discoverV4TokenIds({
    etherscanLookup: async () => {
      throw new Error('Free API access is not supported for this chain.');
    },
    alchemyLookup: async () => ['3110339'],
  });
  assert.deepEqual(result.tokenIds, ['3110339']);
  assert.equal(result.firstInbound.size, 0);
  assert.equal(result.source, 'alchemy_nft');
  assert.match(result.warning, /Etherscan no disponible/);
});

test('discoverV4TokenIds recurre a Alchemy si no hay API key de Etherscan', async () => {
  const result = await discoverV4TokenIds({
    etherscanLookup: null,
    alchemyLookup: async () => ['9'],
  });
  assert.deepEqual(result.tokenIds, ['9']);
  assert.equal(result.source, 'alchemy_nft');
});

test('discoverV4TokenIds propaga el error de Etherscan si Alchemy tampoco responde', async () => {
  await assert.rejects(
    discoverV4TokenIds({
      etherscanLookup: async () => { throw new Error('etherscan caído'); },
      alchemyLookup: async () => { throw new Error('alchemy caído'); },
    }),
    /etherscan caído \(respaldo Alchemy: alchemy caído\)/
  );
});

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (hex) => `0x${hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;
const OTHER = '0x1111111111111111111111111111111111111111';

function transferLog({ from, to, tokenId, blockNumber, index = 0 }) {
  return {
    topics: [TRANSFER, pad(from), pad(to), pad(BigInt(tokenId).toString(16))],
    blockNumber,
    index,
    transactionHash: `0xtx${tokenId}_${blockNumber}`,
  };
}

function fakeLogsProvider(logs, { latest = 100, maxSpan = Infinity } = {}) {
  const calls = [];
  return {
    calls,
    getBlockNumber: async () => latest,
    getBlock: async (n) => ({ timestamp: 1_000 + n }),
    getLogs: async ({ topics, fromBlock, toBlock }) => {
      calls.push({ fromBlock, toBlock });
      if (toBlock - fromBlock + 1 > maxSpan) throw new Error('query spans too many blocks; narrow the block range');
      return logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock
        && topics.every((topic, i) => topic == null || topic.toLowerCase() === log.topics[i].toLowerCase()));
    },
  };
}

test('fetchTokenIdsFromLogs reconstruye los NFT que aún tiene la wallet', async () => {
  const provider = fakeLogsProvider([
    transferLog({ from: '0x0', to: WALLET, tokenId: 5, blockNumber: 10 }),
    transferLog({ from: '0x0', to: WALLET, tokenId: 6, blockNumber: 20 }),
    transferLog({ from: WALLET, to: OTHER, tokenId: 6, blockNumber: 30 }),
    transferLog({ from: OTHER, to: WALLET, tokenId: 7, blockNumber: 40 }),
    transferLog({ from: '0x0', to: OTHER, tokenId: 8, blockNumber: 50 }),
  ]);
  const { tokenIds, firstInbound } = await fetchTokenIdsFromLogs({ provider, wallet: WALLET, contractAddress: PM });
  assert.deepEqual(tokenIds.sort(), ['5', '7']);
  assert.deepEqual(firstInbound.get('5'), { txHash: '0xtx5_10', blockNumber: 10, createdAt: 1_010 });
});

test('fetchTokenIdsFromLogs parte el rango cuando el RPC lo rechaza', async () => {
  const provider = fakeLogsProvider([
    transferLog({ from: '0x0', to: WALLET, tokenId: 1, blockNumber: 95_000 }),
  ], { latest: 120_000, maxSpan: 40_000 });
  const { tokenIds } = await fetchTokenIdsFromLogs({ provider, wallet: WALLET, contractAddress: PM, maxRange: 100_000 });
  assert.deepEqual(tokenIds, ['1']);
  assert.ok(provider.calls.every(({ fromBlock, toBlock }) => toBlock - fromBlock + 1 <= 100_000));
});

// Regresión: en Robinhood Chain ni Etherscan (plan gratuito) ni la API NFT de
// Alchemy (red no habilitada) respondían y "Adoptar LP" no listaba nada.
test('discoverV4TokenIds recurre a los eventos on-chain si fallan Etherscan y Alchemy', async () => {
  const firstInbound = new Map([['42', { txHash: '0xabc', blockNumber: 1, createdAt: 2 }]]);
  const result = await discoverV4TokenIds({
    etherscanLookup: async () => { throw new Error('Free API access is not supported for this chain.'); },
    alchemyLookup: async () => { throw new Error('Request failed with status code 403'); },
    logsLookup: async () => ({ tokenIds: ['42'], firstInbound }),
  });
  assert.deepEqual(result.tokenIds, ['42']);
  assert.equal(result.firstInbound, firstInbound);
  assert.equal(result.source, 'onchain_logs');
  assert.match(result.warning, /Free API access.*403/);
});

test('discoverV4TokenIds informa de los tres fallos si tampoco hay eventos', async () => {
  await assert.rejects(
    discoverV4TokenIds({
      etherscanLookup: async () => { throw new Error('etherscan caído'); },
      alchemyLookup: async () => { throw new Error('alchemy caído'); },
      logsLookup: async () => { throw new Error('rpc caído'); },
    }),
    /etherscan caído \(respaldo Alchemy: alchemy caído; respaldo on-chain: rpc caído\)/
  );
});
