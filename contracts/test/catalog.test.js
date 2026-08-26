const test = require('node:test');
const assert = require('node:assert/strict');
const artifact = require('../artifacts/VolatilityShieldV1.json');
const { POOL_MANAGERS } = require('../scripts/pool-managers');
const {
  buildInitcode, predictAddress, addressFlags, flagsForPermissions, keccak256,
} = require('../scripts/hook-address');

test('el artefacto declara los permisos que implementa el contrato', () => {
  assert.deepEqual(artifact.permissions, ['beforeSwap']);
  assert.equal(artifact.hookFlags, '0x80');
});

test('el artefacto trae fuente, immutables y una entrada por red', () => {
  assert.ok(artifact.sourceCode.includes('contract VolatilityShieldV1'));
  assert.equal(artifact.sourceHash, keccak256(Buffer.from(artifact.sourceCode, 'utf8')));
  assert.ok(Object.keys(artifact.immutableReferences).length > 0);
  assert.deepEqual(Object.keys(artifact.networks).sort(), Object.keys(POOL_MANAGERS).sort());
});

test('cada red predice una direccion con los flags correctos', () => {
  const target = flagsForPermissions(artifact.permissions);
  for (const [network, entry] of Object.entries(artifact.networks)) {
    const initcode = buildInitcode(artifact.creationBytecode, entry.poolManager);
    assert.equal(entry.initcodeHash, keccak256(initcode), `initcodeHash de ${network}`);
    assert.equal(entry.predictedAddress, predictAddress(entry.initcodeHash, entry.salt), `direccion de ${network}`);
    assert.equal(addressFlags(entry.predictedAddress), target, `flags de ${network}`);
    assert.equal(entry.poolManager, POOL_MANAGERS[network], `poolManager de ${network}`);
  }
});
