const test = require('node:test');
const assert = require('node:assert/strict');

const { OnChainManager } = require('../src/services/onchain-manager.service');

const DUMMY_NETWORK = {
  id: 'arbitrum',
  chainId: 42161,
  rpcUrl: 'http://127.0.0.1:8545',
  fallbackRpcUrl: 'http://127.0.0.1:8546',
};

const ERC20_BALANCE_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
];

test('OnChainManager reutiliza el mismo provider por network y scope', () => {
  const manager = new OnChainManager();

  const providerA = manager.getProvider(DUMMY_NETWORK, { scope: 'test-scope' });
  const providerB = manager.getProvider(DUMMY_NETWORK, { scope: 'test-scope' });
  const providerOtherScope = manager.getProvider(DUMMY_NETWORK, { scope: 'other-scope' });

  assert.equal(providerA, providerB);
  assert.notEqual(providerA, providerOtherScope);
});

test('OnChainManager reutiliza contratos tanto por provider explicito como por network/scope', () => {
  const manager = new OnChainManager();
  const address = '0x0000000000000000000000000000000000000001';
  const provider = manager.getProvider(DUMMY_NETWORK, { scope: 'contracts' });

  const contractWithRunnerA = manager.getContract({
    runner: provider,
    address,
    abi: ERC20_BALANCE_ABI,
  });
  const contractWithRunnerB = manager.getContract({
    runner: provider,
    address,
    abi: ERC20_BALANCE_ABI,
  });
  const contractWithNetworkA = manager.getContract({
    networkConfig: DUMMY_NETWORK,
    scope: 'contracts',
    address,
    abi: ERC20_BALANCE_ABI,
  });
  const contractWithNetworkB = manager.getContract({
    networkConfig: DUMMY_NETWORK,
    scope: 'contracts',
    address,
    abi: ERC20_BALANCE_ABI,
  });

  assert.equal(contractWithRunnerA, contractWithRunnerB);
  assert.equal(contractWithNetworkA, contractWithNetworkB);
});

test('OnChainManager.clear invalida caches filtrando por scope', () => {
  const manager = new OnChainManager();

  const before = manager.getProvider(DUMMY_NETWORK, { scope: 'clear-me' });
  manager.clear({ scope: 'clear-me' });
  const after = manager.getProvider(DUMMY_NETWORK, { scope: 'clear-me' });

  assert.notEqual(before, after);
});
