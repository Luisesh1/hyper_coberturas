/**
 * Utilidades puras para calcular la direccion de un hook de Uniswap v4.
 *
 * En v4 los permisos del hook van codificados en los 14 bits BAJOS de su
 * direccion, asi que un hook no se puede desplegar con CREATE normal: hay que
 * usar CREATE2 y buscar una salt cuya direccion resultante lleve exactamente
 * los bits de los callbacks que el contrato implementa.
 */
const { keccak256, getCreate2Address, AbiCoder, zeroPadValue, toBeHex } = require('ethers');

// Proxy de despliegue determinista (Arachnid), presente en las 6 redes que
// soporta el panel. Su calldata es `salt (32 bytes) + initcode`.
const CREATE2_PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

// Nombres tal cual aparecen en `Hooks.Permissions` de v4-core. Ojo: Solidity
// usa `ReturnDelta` y el clasificador del servidor `RETURNS_DELTA`.
const HOOK_PERMISSION_BITS = Object.freeze({
  beforeInitialize: 1 << 13,
  afterInitialize: 1 << 12,
  beforeAddLiquidity: 1 << 11,
  afterAddLiquidity: 1 << 10,
  beforeRemoveLiquidity: 1 << 9,
  afterRemoveLiquidity: 1 << 8,
  beforeSwap: 1 << 7,
  afterSwap: 1 << 6,
  beforeDonate: 1 << 5,
  afterDonate: 1 << 4,
  beforeSwapReturnDelta: 1 << 3,
  afterSwapReturnDelta: 1 << 2,
  afterAddLiquidityReturnDelta: 1 << 1,
  afterRemoveLiquidityReturnDelta: 1 << 0,
});

const HOOK_FLAG_MASK = (1n << 14n) - 1n;

/**
 * Lee del codigo fuente los permisos declarados en `getHookPermissions()`.
 * Se parsea la fuente en vez de duplicar la lista para que no puedan
 * divergir: si alguien anade un callback al contrato y olvida el catalogo,
 * la salt deja de cuadrar y la guardia de `npm run check` lo caza.
 */
function parseHookPermissions(source) {
  const names = [];
  const pattern = /(\w+)\s*:\s*(true|false)/g;
  let match = pattern.exec(source);
  while (match) {
    if (match[2] === 'true' && match[1] in HOOK_PERMISSION_BITS) names.push(match[1]);
    match = pattern.exec(source);
  }
  return names;
}

function flagsForPermissions(names) {
  let flags = 0n;
  for (const name of names) {
    const bit = HOOK_PERMISSION_BITS[name];
    if (bit === undefined) throw new Error(`Permiso de hook desconocido: ${name}`);
    flags |= BigInt(bit);
  }
  return flags;
}

function buildInitcode(creationBytecode, poolManager) {
  const encoded = AbiCoder.defaultAbiCoder().encode(['address'], [poolManager]);
  return creationBytecode + encoded.slice(2);
}

function predictAddress(initcodeHash, salt) {
  return getCreate2Address(CREATE2_PROXY, salt, initcodeHash);
}

function addressFlags(address) {
  return BigInt(address) & HOOK_FLAG_MASK;
}

/**
 * Busca la primera salt cuya direccion CREATE2 tenga exactamente `targetFlags`.
 * Se ejecuta en build, nunca en caliente: son ~16.384 intentos de media y
 * bloquearia el event loop del servidor durante segundos.
 */
function mineSalt(initcodeHash, targetFlags, { maxAttempts = 2_000_000 } = {}) {
  for (let attempts = 0; attempts < maxAttempts; attempts += 1) {
    const salt = zeroPadValue(toBeHex(attempts), 32);
    const address = predictAddress(initcodeHash, salt);
    if (addressFlags(address) === targetFlags) return { salt, address, attempts };
  }
  throw new Error(`No se encontro salt en ${maxAttempts} intentos para los flags 0x${targetFlags.toString(16)}`);
}

module.exports = {
  CREATE2_PROXY,
  HOOK_PERMISSION_BITS,
  HOOK_FLAG_MASK,
  keccak256,
  parseHookPermissions,
  flagsForPermissions,
  buildInitcode,
  predictAddress,
  addressFlags,
  mineSalt,
};
