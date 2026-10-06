const test = require('node:test');
const assert = require('node:assert/strict');

const { usdPriceForSymbol } = require('../src/services/cross-chain/pricing');
const {
  MAINNET_NETWORKS,
  createMultichainBalances,
} = require('../src/services/cross-chain/multichain-balances');

const WALLET = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';

test('precios: estables a 1, envueltos como su nativo, sin precio → null', () => {
  const prices = { ETH: '2620', POL: '0.23' };
  assert.equal(usdPriceForSymbol('USDG', prices), 1);
  assert.equal(usdPriceForSymbol('usdc', prices), 1);
  assert.equal(usdPriceForSymbol('WETH', prices), 2620);
  assert.equal(usdPriceForSymbol('ETH', prices), 2620);
  assert.equal(usdPriceForSymbol('WPOL', prices), 0.23);
  assert.equal(usdPriceForSymbol('MATIC', { MATIC: '0.3' }), 0.3);
  assert.equal(usdPriceForSymbol('PEPE', prices), null);
  assert.equal(usdPriceForSymbol(null, prices), null);
});

test('las redes de mainnet excluyen la testnet', () => {
  assert.ok(MAINNET_NETWORKS.includes('arbitrum'));
  assert.ok(MAINNET_NETWORKS.includes('robinhood'));
  assert.ok(!MAINNET_NETWORKS.includes('base-sepolia'));
});

function assetsFor(network) {
  return {
    network,
    walletAddress: WALLET,
    gasReserve: { nativeBalanceRaw: '1000' },
    assets: [{ id: 'usdc', symbol: 'USDC', usdValue: network === 'base' ? 100 : 50 }],
  };
}

test('una red que falla queda marcada y el resto sigue', async () => {
  const service = createMultichainBalances({
    networks: ['base', 'arbitrum'],
    getWalletAssets: async ({ network }) => {
      if (network === 'arbitrum') throw new Error('rpc caido');
      return assetsFor(network);
    },
  });
  const result = await service.getMultichainBalances({ walletAddress: WALLET });
  const base = result.networks.find((n) => n.network === 'base');
  const arb = result.networks.find((n) => n.network === 'arbitrum');
  assert.equal(base.status, 'ok');
  assert.equal(base.nativeBalanceRaw, '1000');
  assert.equal(base.chainId, 8453);
  assert.equal(arb.status, 'error');
  assert.equal(arb.error, 'rpc caido');
  assert.deepEqual(arb.assets, []);
  assert.equal(result.totalUsd, 100);
});

test('una red lenta se corta por timeout sin colgar el análisis', async () => {
  const service = createMultichainBalances({
    networks: ['base', 'ethereum'],
    timeoutMs: 20,
    getWalletAssets: async ({ network }) => {
      if (network === 'ethereum') return new Promise(() => {});
      return assetsFor(network);
    },
  });
  const result = await service.getMultichainBalances({ walletAddress: WALLET });
  const eth = result.networks.find((n) => n.network === 'ethereum');
  assert.equal(eth.status, 'error');
  assert.match(eth.error, /tardó más de/);
});

test('suma el total en USD de todas las redes leídas', async () => {
  const service = createMultichainBalances({
    networks: ['base', 'arbitrum', 'optimism'],
    getWalletAssets: async ({ network }) => assetsFor(network),
  });
  const result = await service.getMultichainBalances({ walletAddress: WALLET });
  assert.equal(result.totalUsd, 200);
  assert.equal(result.networks.length, 3);
});

test('se puede limitar a un subconjunto de redes', async () => {
  const seen = [];
  const service = createMultichainBalances({
    getWalletAssets: async ({ network }) => { seen.push(network); return assetsFor(network); },
  });
  await service.getMultichainBalances({ walletAddress: WALLET, networks: ['polygon'] });
  assert.deepEqual(seen, ['polygon']);
});
