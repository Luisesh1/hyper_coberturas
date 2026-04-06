const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GAS_PER_TX_TYPE,
  buildGasBreakdown,
  estimateTxPlanCostUsd,
} = require('../../src/services/uniswap/gas-cost-estimator');

test('GAS_PER_TX_TYPE incluye los kinds principales', () => {
  const expected = ['approval', 'swap', 'mint_position', 'wrap_native', 'collect_fees'];
  for (const key of expected) {
    assert.ok(GAS_PER_TX_TYPE[key] > 0, `falta ${key}`);
  }
});

test('buildGasBreakdown suma gas units por tipo', () => {
  const txPlan = [
    { kind: 'approval', label: 'Approve A' },
    { kind: 'swap', label: 'Swap A->B' },
    { kind: 'mint_position', label: 'Mint' },
  ];
  const result = buildGasBreakdown(txPlan);
  assert.equal(result.txCount, 3);
  assert.equal(
    result.totalGasUnits,
    GAS_PER_TX_TYPE.approval + GAS_PER_TX_TYPE.swap + GAS_PER_TX_TYPE.mint_position,
  );
  assert.equal(result.txBreakdown[0].label, 'Approve A');
  assert.equal(result.txBreakdown[0].gasUnits, GAS_PER_TX_TYPE.approval);
});

test('buildGasBreakdown ignora valores nulos', () => {
  const result = buildGasBreakdown([{ kind: 'approval' }, null, undefined, { kind: 'swap' }]);
  assert.equal(result.txCount, 2);
});

test('buildGasBreakdown usa default para kinds desconocidos', () => {
  const result = buildGasBreakdown([{ kind: 'unknown_kind' }]);
  assert.equal(result.totalGasUnits, 150_000);
});

test('estimateTxPlanCostUsd calcula costo total con provider mock', async () => {
  const provider = {
    async getFeeData() {
      return { gasPrice: 1_000_000_000n }; // 1 gwei
    },
  };
  const txPlan = [{ kind: 'mint_position' }];
  const result = await estimateTxPlanCostUsd({
    provider,
    txPlan,
    nativeUsdPrice: 2000,
  });
  // gas: 350_000 * 1 gwei = 0.00035 ETH * $2000 = $0.70
  assert.ok(result.gasCostEth > 0);
  assert.ok(result.gasCostUsd > 0);
  assert.equal(result.txCount, 1);
});

test('estimateTxPlanCostUsd suma slippageCostUsd al total', async () => {
  const provider = {
    async getFeeData() {
      return { gasPrice: 1_000_000_000n };
    },
  };
  const result = await estimateTxPlanCostUsd({
    provider,
    txPlan: [{ kind: 'approval' }],
    nativeUsdPrice: 2000,
    slippageCostUsd: 5,
  });
  assert.ok(result.totalEstimatedCostUsd >= 5);
  assert.equal(result.slippageCostUsd, 5);
});

test('estimateTxPlanCostUsd maneja gracefully fallo del provider', async () => {
  const provider = {
    async getFeeData() {
      throw new Error('RPC down');
    },
  };
  const result = await estimateTxPlanCostUsd({
    provider,
    txPlan: [{ kind: 'mint_position' }],
    nativeUsdPrice: 2000,
  });
  assert.equal(result.gasCostEth, null);
  assert.equal(result.gasCostUsd, null);
  assert.equal(result.totalEstimatedCostUsd, 0);
  assert.equal(result.txCount, 1);
});

test('estimateTxPlanCostUsd retorna null gas cuando provider es undefined', async () => {
  const result = await estimateTxPlanCostUsd({
    provider: null,
    txPlan: [{ kind: 'approval' }],
    nativeUsdPrice: 2000,
  });
  assert.equal(result.gasCostEth, null);
  assert.equal(result.gasCostUsd, null);
});

test('estimateTxPlanCostUsd retorna null gasCostUsd cuando nativeUsdPrice es inválido', async () => {
  const provider = {
    async getFeeData() {
      return { gasPrice: 1_000_000_000n };
    },
  };
  const result = await estimateTxPlanCostUsd({
    provider,
    txPlan: [{ kind: 'approval' }],
    nativeUsdPrice: null,
  });
  assert.ok(result.gasCostEth > 0);
  assert.equal(result.gasCostUsd, null);
});

test('estimateTxPlanCostUsd usa maxFeePerGas si gasPrice es null', async () => {
  const provider = {
    async getFeeData() {
      return { gasPrice: null, maxFeePerGas: 2_000_000_000n };
    },
  };
  const result = await estimateTxPlanCostUsd({
    provider,
    txPlan: [{ kind: 'mint_position' }],
    nativeUsdPrice: 2000,
  });
  assert.ok(result.gasCostEth > 0);
});
