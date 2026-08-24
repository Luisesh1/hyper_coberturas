const test = require('node:test');
const assert = require('node:assert/strict');

const repository = require('../src/repositories/smart-contract-registry.repository');

test('el repositorio persiste versiones inmutables y despliegues por red', async () => {
  const calls = [];
  const executor = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: calls.length }] };
    },
  };

  await repository.createContract({ userId: 7, name: 'Volatility Shield', contractType: 'uniswap_v4_dynamic_fee_hook' }, executor);
  await repository.createVersion({
    userId: 7, contractId: 1, version: '1.0.0', sourceCode: 'contract Hook {}', sourceHash: 'source-hash',
    compilerVersion: '0.8.26', abiJson: [], artifactBytecodeHash: 'artifact-hash',
  }, executor);
  await repository.recordDeployment({
    userId: 7, contractVersionId: 2, network: 'base-sepolia', address: '0x0000000000000000000000000000000000000080',
    txHash: '0xabc', onchainBytecodeHash: 'artifact-hash', hookSafety: { safe: true, dynamicFee: true },
  }, executor);

  assert.match(calls[1].sql, /INSERT INTO smart_contract_versions/);
  assert.match(calls[2].sql, /INSERT INTO smart_contract_deployments/);
  assert.equal(calls[1].params[2], '1.0.0');
  assert.equal(calls[2].params[2], 'base-sepolia');
  assert.equal(calls[2].params[6], 'artifact-hash');
});

test('las versiones verificadas se consultan por usuario y red', async () => {
  let captured;
  await repository.listVerifiedHooks(7, 'arbitrum', {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    },
  });

  assert.match(captured.sql, /v\.status = 'verified'/);
  assert.match(captured.sql, /d\.network = \$2/);
  assert.deepEqual(captured.params, [7, 'arbitrum', 'uniswap_v4_dynamic_fee_hook']);
});

test('el gestor lista las versiones del usuario junto con sus despliegues', async () => {
  let captured;
  await repository.listContracts(7, {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    },
  });

  assert.match(captured.sql, /LEFT JOIN smart_contract_versions/);
  assert.match(captured.sql, /LEFT JOIN smart_contract_deployments/);
  assert.deepEqual(captured.params, [7]);
});
