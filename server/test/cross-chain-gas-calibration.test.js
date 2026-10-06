const test = require('node:test');
const assert = require('node:assert/strict');

const repository = require('../src/repositories/gas-observation.repository');
const { createGasCalibration, classifyTxInput } = require('../src/services/cross-chain/gas-calibration');

function fakeExecutor(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

test('insert guarda la observación y no duplica por tx_hash', async () => {
  const executor = fakeExecutor();
  await repository.insert({
    network: 'base',
    kind: 'approval',
    profile: 'low',
    estimatedGas: '50000',
    gasUsed: '46000',
    effectiveGasPriceWei: '1000',
    l1FeeWei: '77',
    waitBlocks: 2,
    txHash: '0xabc',
    createdAt: 123,
  }, executor);
  assert.match(executor.calls[0].sql, /INSERT INTO gas_observations/);
  assert.match(executor.calls[0].sql, /ON CONFLICT \(tx_hash\) DO NOTHING/);
  assert.deepEqual(executor.calls[0].params, ['base', 'approval', 'low', '50000', '46000', '1000', '77', 2, '0xabc', 123]);
});

test('getP95GasUsed devuelve null con pocas muestras', async () => {
  const value = await repository.getP95GasUsed({ network: 'base', kind: 'approval' }, fakeExecutor([{ p95: 50000, n: 3 }]));
  assert.equal(value, null);
});

test('getP95GasUsed redondea hacia arriba con muestras suficientes', async () => {
  const executor = fakeExecutor([{ p95: '46000.2', n: 9 }]);
  const value = await repository.getP95GasUsed({ network: 'base', kind: 'approval' }, executor);
  assert.equal(value, 46001);
  assert.deepEqual(executor.calls[0].params, ['base', 'approval', 200]);
});

test('el clasificador reconoce approve, Permit2, wrap y unwrap por selector', () => {
  assert.equal(classifyTxInput('0x095ea7b3000000'), 'approval');
  assert.equal(classifyTxInput('0x87517c45ffff'), 'permit2_approval');
  assert.equal(classifyTxInput('0xd0e30db0'), 'wrap_native');
  assert.equal(classifyTxInput('0x2e1a7d4d00'), 'unwrap_native');
  assert.equal(classifyTxInput('0xdeadbeef'), null);
  assert.equal(classifyTxInput(null), null);
});

test('getCalibratedGasUnits cachea 10 minutos por red y tipo', async () => {
  let reads = 0;
  let clock = 0;
  const calibration = createGasCalibration({
    repository: { getP95GasUsed: async () => { reads += 1; return 61000; }, insert: async () => {} },
    now: () => clock,
  });
  assert.equal(await calibration.getCalibratedGasUnits({ network: 'base', kind: 'bridge' }), 61000);
  assert.equal(await calibration.getCalibratedGasUnits({ network: 'base', kind: 'bridge' }), 61000);
  assert.equal(reads, 1);
  clock = 10 * 60_000 + 1;
  await calibration.getCalibratedGasUnits({ network: 'base', kind: 'bridge' });
  assert.equal(reads, 2);
});

function fakeProvider({ receipt, tx = null }) {
  return {
    async send(method) {
      if (method === 'eth_getTransactionReceipt') return receipt;
      if (method === 'eth_getTransactionByHash') return tx;
      throw new Error(`método inesperado ${method}`);
    },
  };
}

test('observeReceipt guarda gas real, precio efectivo y L1 fee de OP', async () => {
  const inserted = [];
  const calibration = createGasCalibration({
    repository: { insert: async (obs) => inserted.push(obs), getP95GasUsed: async () => null },
    now: () => 999,
  });
  const obs = await calibration.observeReceipt({
    network: 'base',
    provider: fakeProvider({ receipt: { status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3e8', l1Fee: '0x10', blockNumber: '0x64' } }),
    txHash: '0xfeed',
    kind: 'bridge',
    profile: 'low',
    estimatedGas: '30000',
    submittedBlock: 97,
  });
  assert.equal(obs.status, 'success');
  assert.equal(obs.gasUsed, '21000');
  assert.equal(obs.effectiveGasPriceWei, '1000');
  assert.equal(obs.l1FeeWei, '16');
  assert.equal(obs.waitBlocks, 3);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].createdAt, 999);
});

test('observeReceipt no guarda una tx revertida pero la reporta', async () => {
  const inserted = [];
  const calibration = createGasCalibration({
    repository: { insert: async (obs) => inserted.push(obs), getP95GasUsed: async () => null },
  });
  const obs = await calibration.observeReceipt({
    network: 'arbitrum',
    provider: fakeProvider({ receipt: { status: '0x0', gasUsed: '0x5208', effectiveGasPrice: '0x1', blockNumber: '0x1' } }),
    txHash: '0xdead',
    kind: 'bridge',
  });
  assert.equal(obs.status, 'reverted');
  assert.equal(inserted.length, 0);
});

test('observeReceipt sin recibo devuelve null', async () => {
  const calibration = createGasCalibration({ repository: { insert: async () => {}, getP95GasUsed: async () => null } });
  assert.equal(await calibration.observeReceipt({ network: 'base', provider: fakeProvider({ receipt: null }), txHash: '0x1', kind: 'bridge' }), null);
});

test('observeTxHashes clasifica por selector y salta las que no reconoce', async () => {
  const inserted = [];
  const calibration = createGasCalibration({
    repository: { insert: async (obs) => inserted.push(obs), getP95GasUsed: async () => null },
  });
  const receipts = {
    '0xa': { status: '0x1', gasUsed: '0xb3b0', effectiveGasPrice: '0x1', blockNumber: '0x1' },
    '0xb': { status: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', blockNumber: '0x1' },
  };
  const txs = { '0xa': { input: '0x095ea7b3aaaa' }, '0xb': { input: '0x12345678' } };
  const provider = {
    async send(method, [hash]) {
      return method === 'eth_getTransactionReceipt' ? receipts[hash] : txs[hash];
    },
  };
  await calibration.observeTxHashes({ network: 'base', provider, txHashes: ['0xa', '0xb'] });
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].kind, 'approval');
});
