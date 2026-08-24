const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const { SmartContractRegistryService } = require('../src/services/smart-contract-registry.workflow.service');

test('la verificación vuelve a leer bytecode on-chain antes de aprobar un hook', async () => {
  const bytecode = '0x6001600055';
  const calls = [];
  const repository = {
    getVersionForVerification: async () => ({
      id: 4,
      status: 'verification',
      contractType: 'uniswap_v4_dynamic_fee_hook',
      deployment: {
        network: 'base-sepolia',
        address: '0x0000000000000000000000000000000000000080',
        txHash: '0xabc',
        artifactBytecodeHash: ethers.keccak256(bytecode),
        onchainBytecodeHash: 'stale-client-value',
      },
    }),
    recordDeployment: async (payload) => calls.push(['record', payload]),
    markVerified: async () => calls.push(['verified']),
  };
  const service = new SmartContractRegistryService({
    repository,
    providerForNetwork: async () => ({ getCode: async () => bytecode }),
  });

  const result = await service.verifyVersion({ userId: 1, versionId: 4, network: 'base-sepolia' });

  assert.equal(result.status, 'verified');
  assert.equal(calls[0][1].onchainBytecodeHash, ethers.keccak256(bytecode));
  assert.deepEqual(calls[1], ['verified']);
});

test('un hook sin permiso beforeSwap no llega a estado verificado', async () => {
  const repository = {
    getVersionForVerification: async () => ({
      id: 4,
      status: 'verification',
      contractType: 'uniswap_v4_dynamic_fee_hook',
      deployment: {
        network: 'base-sepolia', address: '0x0000000000000000000000000000000000001000', txHash: '0xabc',
        artifactBytecodeHash: ethers.keccak256('0x6001'),
      },
    }),
    recordDeployment: async () => assert.fail('no debe persistir un hook inválido'),
    markVerified: async () => assert.fail('no debe verificar'),
  };
  const service = new SmartContractRegistryService({
    repository,
    providerForNetwork: async () => ({ getCode: async () => '0x6001' }),
  });

  await assert.rejects(
    () => service.verifyVersion({ userId: 1, versionId: 4, network: 'base-sepolia' }),
    /beforeSwap/
  );
});
