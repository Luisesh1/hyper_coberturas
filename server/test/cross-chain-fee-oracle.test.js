const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const { createFeeOracle, rpcSender } = require('../src/services/cross-chain/fee-oracle');

const gwei = (n) => BigInt(Math.round(n * 1e9));
const hex = (v) => `0x${BigInt(v).toString(16)}`;

const OP_IFACE = new ethers.Interface([
  'function getL1Fee(bytes) view returns (uint256)',
  'function getL1FeeUpperBound(uint256) view returns (uint256)',
]);
const NODE_IFACE = new ethers.Interface([
  'function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)',
]);

const HISTORY = {
  baseFeePerGas: [gwei(1), gwei(1), gwei(1)].map(hex),
  reward: [[gwei(0.1), gwei(0.2), gwei(0.5)], [gwei(0.1), gwei(0.2), gwei(0.5)]].map((r) => r.map(hex)),
};

function fakeProvider({ estimateGas = null, l1Fee = 0n, l1Upper = 0n, l1Gas = 0n, onSend } = {}) {
  const calls = { feeHistory: 0, call: [] };
  return {
    calls,
    async send(method, params) {
      if (onSend) onSend(method, params);
      if (method === 'eth_feeHistory') {
        calls.feeHistory += 1;
        return HISTORY;
      }
      throw new Error(`send inesperado: ${method}`);
    },
    async estimateGas(tx) {
      if (!estimateGas) throw new Error('execution reverted: allowance');
      return estimateGas(tx);
    },
    async call(tx) {
      calls.call.push(tx);
      if (tx.data.startsWith(OP_IFACE.getFunction('getL1Fee').selector)) {
        return OP_IFACE.encodeFunctionResult('getL1Fee', [l1Fee]);
      }
      if (tx.data.startsWith(OP_IFACE.getFunction('getL1FeeUpperBound').selector)) {
        return OP_IFACE.encodeFunctionResult('getL1FeeUpperBound', [l1Upper]);
      }
      return NODE_IFACE.encodeFunctionResult('gasEstimateL1Component', [l1Gas, gwei(0.01), 0n]);
    },
  };
}

const TX = { kind: 'bridge', to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', data: '0x1234', value: '0' };
const FROM = '0x1ecC8f8db20cEc65749200F711279FA2aeFC9fde';

test('rpcSender usa el provider directo si tiene send', async () => {
  const direct = { send: async () => 'ok' };
  assert.equal(rpcSender(direct), direct);
});

test('rpcSender recorre los RPC de un FallbackProvider hasta que uno responde', async () => {
  const calls = [];
  const failing = { send: async (method) => { calls.push(`a:${method}`); throw new Error('403 network not enabled'); } };
  const working = { send: async (method) => { calls.push(`b:${method}`); return 'ok'; } };
  const sender = rpcSender({ providerConfigs: [{ provider: failing }, { provider: working }] });
  assert.equal(await sender.send('eth_feeHistory', []), 'ok');
  assert.deepEqual(calls, ['a:eth_feeHistory', 'b:eth_feeHistory']);
});

test('rpcSender propaga el primer error si ningún RPC responde', async () => {
  const sender = rpcSender({ providerConfigs: [
    { provider: { send: async () => { throw new Error('primero'); } } },
    { provider: { send: async () => { throw new Error('segundo'); } } },
  ] });
  await assert.rejects(sender.send('eth_chainId', []), /primero/);
});

test('feeHistory se cachea 15 s por red', async () => {
  let clock = 0;
  const provider = fakeProvider();
  const oracle = createFeeOracle({ getProvider: () => provider, getCalibratedGasUnits: async () => null, now: () => clock });
  await oracle.getProfileFees({ network: 'ethereum', profile: 'low' });
  await oracle.getProfileFees({ network: 'ethereum', profile: 'high' });
  assert.equal(provider.calls.feeHistory, 1);
  clock = 15_001;
  await oracle.getProfileFees({ network: 'ethereum', profile: 'low' });
  assert.equal(provider.calls.feeHistory, 2);
});

test('pide 20 bloques con percentiles 10/50/90', async () => {
  let seen;
  const provider = fakeProvider({ onSend: (method, params) => { if (method === 'eth_feeHistory') seen = params; } });
  const oracle = createFeeOracle({ getProvider: () => provider, getCalibratedGasUnits: async () => null });
  await oracle.getFeeHistory('ethereum');
  assert.deepEqual(seen, ['0x14', 'latest', [10, 50, 90]]);
});

test('en OP la L1 se suma al esperado y con +20 % al máximo', async () => {
  const provider = fakeProvider({ estimateGas: async () => 100_000n, l1Fee: 5_000_000_000_000n });
  const oracle = createFeeOracle({ getProvider: () => provider, getCalibratedGasUnits: async () => null });
  const result = await oracle.estimateTxCosts({ network: 'base', profile: 'low', txs: [TX], from: FROM, nativeUsdPrice: 2000 });
  const [item] = result.txs;
  assert.equal(item.source, 'estimated');
  assert.equal(item.l1Mode, 'additive');
  // esperado = 100k × (1 gwei + 0,1 gwei) + L1
  assert.equal(BigInt(item.expectedWei), 100_000n * gwei(1.1) + 5_000_000_000_000n);
  // máximo = gasLimit(110k) × (1 × 81/64 + 0,1 gwei) + L1 × 1,2
  const maxFee = (gwei(1) * 81n) / 64n + gwei(0.1);
  assert.equal(BigInt(item.maxWei), 110_000n * maxFee + 6_000_000_000_000n);
  assert.ok(Math.abs(item.l1Usd - 0.01) < 1e-9);
  assert.equal(result.profilesMatter, true);
});

test('en Orbit la L1 solo se informa: estimateGas ya la incluye', async () => {
  const provider = fakeProvider({ estimateGas: async () => 300_000n, l1Gas: 50_000n });
  const oracle = createFeeOracle({ getProvider: () => provider, getCalibratedGasUnits: async () => null });
  const result = await oracle.estimateTxCosts({ network: 'arbitrum', profile: 'low', txs: [TX], from: FROM, nativeUsdPrice: 2000 });
  const [item] = result.txs;
  assert.equal(item.l1Mode, 'included');
  assert.equal(BigInt(item.l1FeeWei), 50_000n * gwei(0.01));
  // prio 0 en Orbit: esperado = gas × base
  assert.equal(BigInt(item.expectedWei), 300_000n * gwei(1));
  assert.equal(result.profilesMatter, false);
});

test('si estimateGas falla (falta el approve) usa el gas del proveedor del bridge', async () => {
  const provider = fakeProvider();
  const oracle = createFeeOracle({ getProvider: () => provider, getCalibratedGasUnits: async () => 99 });
  const result = await oracle.estimateTxCosts({
    network: 'ethereum', profile: 'medium', txs: [{ ...TX, providerGasLimit: '420000' }], from: FROM,
  });
  assert.equal(result.txs[0].source, 'provider');
  assert.equal(result.txs[0].gasUnits, '420000');
  assert.equal(result.txs[0].gasLimit, '504000');
  assert.equal(result.txs[0].expectedUsd, null);
});

test('sin datos de la tx usa la calibración y, sin ella, la tabla', async () => {
  const provider = fakeProvider();
  const calibrated = createFeeOracle({ getProvider: () => provider, getCalibratedGasUnits: async () => 47_000 });
  const a = await calibrated.estimateTxCosts({ network: 'ethereum', profile: 'low', txs: [{ kind: 'approval' }] });
  assert.equal(a.txs[0].source, 'calibrated');
  assert.equal(a.txs[0].gasUnits, '47000');

  const table = createFeeOracle({ getProvider: () => provider, getCalibratedGasUnits: async () => null });
  const b = await table.estimateTxCosts({ network: 'ethereum', profile: 'low', txs: [{ kind: 'approval' }, { kind: 'bridge' }] });
  assert.equal(b.txs[0].source, 'table');
  assert.equal(b.txs[0].gasUnits, '50000');
  assert.equal(b.txs[1].gasUnits, '300000');
  assert.equal(BigInt(b.totalExpectedWei), BigInt(b.txs[0].expectedWei) + BigInt(b.txs[1].expectedWei));
});

test('en OP sin calldata se usa la cota superior de la L1 por tamaño', async () => {
  const provider = fakeProvider({ l1Upper: 1234n });
  const oracle = createFeeOracle({ getProvider: () => provider, getCalibratedGasUnits: async () => null });
  const result = await oracle.estimateTxCosts({ network: 'optimism', profile: 'low', txs: [{ kind: 'approval' }] });
  assert.equal(result.txs[0].l1FeeWei, '1234');
});

test('si la lectura de L1 falla no tumba la estimación', async () => {
  const provider = fakeProvider({ estimateGas: async () => 21_000n });
  provider.call = async () => { throw new Error('rpc caido'); };
  const oracle = createFeeOracle({ getProvider: () => provider, getCalibratedGasUnits: async () => null });
  const result = await oracle.estimateTxCosts({ network: 'base', profile: 'low', txs: [TX], from: FROM });
  assert.equal(result.txs[0].l1Mode, 'unknown');
  assert.equal(result.txs[0].l1FeeWei, '0');
});

test('compareProfiles devuelve los tres perfiles y el bajo es el más barato en L1 clásica', async () => {
  const provider = fakeProvider({ estimateGas: async () => 100_000n });
  const oracle = createFeeOracle({ getProvider: () => provider, getCalibratedGasUnits: async () => null });
  const all = await oracle.compareProfiles({ network: 'ethereum', txs: [TX], from: FROM, nativeUsdPrice: 2000 });
  assert.deepEqual(Object.keys(all), ['low', 'medium', 'high']);
  assert.ok(all.low.totalExpectedUsd < all.medium.totalExpectedUsd);
  assert.ok(all.medium.totalMaxUsd < all.high.totalMaxUsd);
});
