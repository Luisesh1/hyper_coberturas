/**
 * v4-hook-safety.js — Clasificador de seguridad de hooks de Uniswap v4.
 *
 * En v4 los permisos de un hook están codificados en los 14 bits BAJOS del
 * address del hook (ver v4-core Hooks.sol). Eso permite saber, sólo del address,
 * qué callbacks implementa un hook SIN conocer su código.
 *
 * Para la cobertura delta-neutral lo único que rompe la matemática es que el
 * hook devuelva deltas (custom accounting): altera los montos de token que
 * entran/salen en swaps o en add/remove de liquidez, así que el valor y el
 * delta de la posición dejan de seguir la matemática de liquidez concentrada
 * (CLAMM) estándar sobre la que calculamos el hedge. Esos hooks son UNSAFE.
 *
 * El resto de los hooks (informativos, control de acceso, oráculos, fee
 * dinámica, gating de liquidez) mantienen la matemática CLAMM intacta → SAFE.
 * Un hook que sólo bloquea operaciones puede hacer fallar un rebalanceo, pero
 * eso lo maneja el flujo de tx existente; no corrompe el cálculo del delta.
 */

// Flags de permisos (bit index dentro de los 14 bits bajos del address).
// Idéntico a v4-core Hooks.sol.
const HOOK_FLAGS = {
  BEFORE_INITIALIZE: 1 << 13,
  AFTER_INITIALIZE: 1 << 12,
  BEFORE_ADD_LIQUIDITY: 1 << 11,
  AFTER_ADD_LIQUIDITY: 1 << 10,
  BEFORE_REMOVE_LIQUIDITY: 1 << 9,
  AFTER_REMOVE_LIQUIDITY: 1 << 8,
  BEFORE_SWAP: 1 << 7,
  AFTER_SWAP: 1 << 6,
  BEFORE_DONATE: 1 << 5,
  AFTER_DONATE: 1 << 4,
  BEFORE_SWAP_RETURNS_DELTA: 1 << 3,
  AFTER_SWAP_RETURNS_DELTA: 1 << 2,
  AFTER_ADD_LIQUIDITY_RETURNS_DELTA: 1 << 1,
  AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA: 1 << 0,
};

// Los flags que rompen la matemática CLAMM: el hook puede devolver deltas y
// alterar el accounting de la posición.
const DELTA_RETURNING_MASK = BigInt(
  HOOK_FLAGS.BEFORE_SWAP_RETURNS_DELTA
  | HOOK_FLAGS.AFTER_SWAP_RETURNS_DELTA
  | HOOK_FLAGS.AFTER_ADD_LIQUIDITY_RETURNS_DELTA
  | HOOK_FLAGS.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA
);

const ALL_HOOK_MASK = (1n << 14n) - 1n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Sentinela de fee dinámica a nivel de POOL (no es un bit de hook): un pool con
// `fee === 0x800000` deja que el hook fije la fee viva. No hace al hook unsafe,
// pero avisa que hay que leer la lpFee de StateView.getSlot0 en vez de la fija.
const DYNAMIC_FEE_FLAG = 0x800000;

function hookAddressToBigInt(hooksAddress) {
  if (!hooksAddress) return 0n;
  const raw = String(hooksAddress).trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,40}$/.test(raw)) return null; // address inválido
  return BigInt(raw);
}

function isZeroHook(hooksAddress) {
  const n = hookAddressToBigInt(hooksAddress);
  return n === 0n;
}

/**
 * ¿El hook puede devolver deltas (custom accounting)? Sólo mira los 14 bits
 * bajos del address. Devuelve true también si el address es inválido (fail-safe:
 * lo tratamos como no modelable).
 */
function isDeltaReturning(hooksAddress) {
  const n = hookAddressToBigInt(hooksAddress);
  if (n === null) return true; // address inválido → fail-safe: unsafe
  const permissions = n & ALL_HOOK_MASK;
  return (permissions & DELTA_RETURNING_MASK) !== 0n;
}

function isDynamicFee(fee) {
  return Number(fee) === DYNAMIC_FEE_FLAG;
}

/**
 * Clasifica un hook para cobertura delta-neutral.
 * @returns {{ safe: boolean, isHook: boolean, flags: object, reason: string|null }}
 */
function classifyHook(hooksAddress) {
  const n = hookAddressToBigInt(hooksAddress);
  if (n === null) {
    return { safe: false, isHook: true, flags: {}, reason: 'hook_address_invalid' };
  }
  if (n === 0n) {
    return { safe: true, isHook: false, flags: {}, reason: null };
  }

  const permissions = n & ALL_HOOK_MASK;
  const flags = {};
  for (const [name, bit] of Object.entries(HOOK_FLAGS)) {
    flags[name] = (permissions & BigInt(bit)) !== 0n;
  }

  const deltaReturning = (permissions & DELTA_RETURNING_MASK) !== 0n;
  return {
    safe: !deltaReturning,
    isHook: true,
    flags,
    reason: deltaReturning ? 'hook_returns_delta' : null,
  };
}

module.exports = {
  HOOK_FLAGS,
  DYNAMIC_FEE_FLAG,
  ZERO_ADDRESS,
  classifyHook,
  isDeltaReturning,
  isDynamicFee,
  isZeroHook,
};
