const test = require('node:test');
const assert = require('node:assert/strict');
const { keccak256 } = require('ethers');
const {
  expectedRuntimeBytecode, expectedRuntimeHash, buildDeploymentCalldata,
  classifyOnchainCode, CREATE2_PROXY,
} = require('../src/services/hook-catalog.service');

// Runtime de juguete: 4 bytes de relleno + un hueco de 32 bytes a ceros.
const ENTRY = {
  contractName: 'Toy',
  creationBytecode: '0xaabb',
  runtimeBytecode: `0x${'11'.repeat(4)}${'00'.repeat(32)}`,
  immutableReferences: { 7: [{ start: 4, length: 32 }] },
  networks: {
    'base-sepolia': {
      poolManager: '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408',
      salt: `0x${'00'.repeat(31)}2a`,
      initcodeHash: keccak256('0x00'),
      predictedAddress: '0x0bbA77640ac3570bf1c3D221c81b0f067C39c080',
    },
  },
};

test('expectedRuntimeBytecode rellena el hueco del immutable con el PoolManager', () => {
  const runtime = expectedRuntimeBytecode(ENTRY, 'base-sepolia');
  assert.equal(runtime.slice(0, 10), '0x11111111');
  assert.ok(runtime.toLowerCase().endsWith('05e73354cfdd6745c338b50bcfdfa3aa6fa03408'));
  assert.equal(runtime.length, ENTRY.runtimeBytecode.length);
  assert.equal(expectedRuntimeHash(ENTRY, 'base-sepolia'), keccak256(runtime));
});

test('expectedRuntimeBytecode falla en una red que el catalogo no cubre', () => {
  assert.throws(() => expectedRuntimeBytecode(ENTRY, 'solana'), /solana/);
});

test('expectedRuntimeBytecode rechaza immutables que no sean de 32 bytes', () => {
  const roto = { ...ENTRY, immutableReferences: { 7: [{ start: 4, length: 20 }] } };
  assert.throws(() => expectedRuntimeBytecode(roto, 'base-sepolia'), /32 bytes/);
});

test('buildDeploymentCalldata concatena salt e initcode', () => {
  const data = buildDeploymentCalldata(ENTRY, 'base-sepolia');
  assert.ok(data.startsWith(ENTRY.networks['base-sepolia'].salt));
  assert.ok(data.toLowerCase().includes('05e73354cfdd6745c338b50bcfdfa3aa6fa03408'));
  assert.ok(data.toLowerCase().includes('aabb'));
});

test('classifyOnchainCode distingue los tres estados', () => {
  const bueno = expectedRuntimeBytecode(ENTRY, 'base-sepolia');
  assert.equal(classifyOnchainCode(ENTRY, 'base-sepolia', bueno), 'deployed');
  assert.equal(classifyOnchainCode(ENTRY, 'base-sepolia', '0x'), 'deployable');
  assert.equal(classifyOnchainCode(ENTRY, 'base-sepolia', null), 'deployable');
  assert.equal(classifyOnchainCode(ENTRY, 'base-sepolia', '0xdeadbeef'), 'address_taken');
});

test('CREATE2_PROXY es el proxy determinista estandar', () => {
  assert.equal(CREATE2_PROXY, '0x4e59b44847b379578588920cA78FbF26c0B4956C');
});
