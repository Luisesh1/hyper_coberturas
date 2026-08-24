const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTRACT_STATUS,
  canVerifyContractVersion,
  selectVerifiedHookVersions,
} = require('../src/services/smart-contract-registry.service');

test('una versión solo pasa a verificada cuando el bytecode desplegado coincide', () => {
  const result = canVerifyContractVersion({
    status: CONTRACT_STATUS.VERIFICATION,
    contractType: 'uniswap_v4_dynamic_fee_hook',
    deployment: {
      network: 'base-sepolia',
      address: '0x0000000000000000000000000000000000000080',
      txHash: '0xabc',
      artifactBytecodeHash: 'artifact-hash',
      onchainBytecodeHash: 'artifact-hash',
      hookSafety: { safe: true, dynamicFee: true },
    },
  });

  assert.deepEqual(result, { ok: true });
});

test('una versión con bytecode distinto no puede quedar verificada', () => {
  const result = canVerifyContractVersion({
    status: CONTRACT_STATUS.VERIFICATION,
    contractType: 'uniswap_v4_dynamic_fee_hook',
    deployment: {
      network: 'base-sepolia',
      address: '0x0000000000000000000000000000000000000080',
      txHash: '0xabc',
      artifactBytecodeHash: 'artifact-hash',
      onchainBytecodeHash: 'other-hash',
      hookSafety: { safe: true, dynamicFee: true },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bytecode_mismatch');
});

test('el selector del orquestador solo recibe hooks verificados de su red', () => {
  const selected = selectVerifiedHookVersions([
    { id: 1, status: CONTRACT_STATUS.VERIFIED, contractType: 'uniswap_v4_dynamic_fee_hook', deployment: { network: 'arbitrum', hookSafety: { safe: true, dynamicFee: true } } },
    { id: 2, status: CONTRACT_STATUS.VERIFICATION, contractType: 'uniswap_v4_dynamic_fee_hook', deployment: { network: 'arbitrum', hookSafety: { safe: true, dynamicFee: true } } },
    { id: 3, status: CONTRACT_STATUS.VERIFIED, contractType: 'uniswap_v4_dynamic_fee_hook', deployment: { network: 'base-sepolia', hookSafety: { safe: true, dynamicFee: true } } },
    { id: 4, status: CONTRACT_STATUS.VERIFIED, contractType: 'uniswap_v4_dynamic_fee_hook', deployment: { network: 'arbitrum', hookSafety: { safe: false, dynamicFee: true } } },
  ], { network: 'arbitrum' });

  assert.deepEqual(selected.map((item) => item.id), [1]);
});
