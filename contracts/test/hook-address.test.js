const test = require('node:test');
const assert = require('node:assert/strict');
const { keccak256 } = require('ethers');
const {
  parseHookPermissions, flagsForPermissions, buildInitcode,
  predictAddress, addressFlags, mineSalt, CREATE2_PROXY,
} = require('../scripts/hook-address');

test('parseHookPermissions devuelve solo los permisos en true', () => {
  const source = `
    return Hooks.Permissions({
      beforeInitialize: false,
      beforeSwap: true,
      afterSwap: false,
      beforeSwapReturnDelta: false
    });`;
  assert.deepEqual(parseHookPermissions(source), ['beforeSwap']);
});

test('flagsForPermissions codifica beforeSwap en el bit 7', () => {
  assert.equal(flagsForPermissions(['beforeSwap']), 0x80n);
});

test('flagsForPermissions rechaza permisos desconocidos', () => {
  assert.throws(() => flagsForPermissions(['beforeTeleport']), /beforeTeleport/);
});

test('buildInitcode concatena el constructor codificado', () => {
  const initcode = buildInitcode('0xdead', '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408');
  assert.equal(initcode.slice(0, 6), '0xdead');
  assert.equal(initcode.length, 6 + 64);
  assert.ok(initcode.toLowerCase().endsWith('05e73354cfdd6745c338b50bcfdfa3aa6fa03408'));
});

test('mineSalt encuentra una direccion con los flags pedidos', () => {
  const initcodeHash = keccak256('0x60006000fd');
  const { salt, address, attempts } = mineSalt(initcodeHash, 0x80n);
  assert.equal(addressFlags(address), 0x80n);
  assert.equal(predictAddress(initcodeHash, salt), address);
  assert.ok(attempts >= 0);
});

test('mineSalt se rinde si agota los intentos', () => {
  assert.throws(
    () => mineSalt(keccak256('0x00'), 0x80n, { maxAttempts: 5 }),
    /No se encontro salt/
  );
});

test('CREATE2_PROXY es el proxy determinista estandar', () => {
  assert.equal(CREATE2_PROXY, '0x4e59b44847b379578588920cA78FbF26c0B4956C');
});
