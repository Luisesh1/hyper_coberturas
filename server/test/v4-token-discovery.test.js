const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAlchemyNftBaseUrl,
  fetchTokenIdsFromAlchemy,
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
