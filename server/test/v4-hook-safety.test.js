const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyHook,
  isDeltaReturning,
  isDynamicFee,
  isZeroHook,
  HOOK_FLAGS,
  DYNAMIC_FEE_FLAG,
} = require('../src/services/uniswap/v4-hook-safety');

// Construye un address de hook con los flags dados (BigInt de bits en los 14 bajos).
function hookAddr(bits) {
  return '0x' + BigInt(bits).toString(16).padStart(40, '0');
}

test('hook cero (sin hook) → safe, isHook false', () => {
  const c = classifyHook('0x0000000000000000000000000000000000000000');
  assert.equal(c.safe, true);
  assert.equal(c.isHook, false);
  assert.equal(c.reason, null);
  assert.equal(isZeroHook('0x0000000000000000000000000000000000000000'), true);
});

test('hook con solo BEFORE_SWAP → safe (mantiene CLAMM)', () => {
  const addr = hookAddr(HOOK_FLAGS.BEFORE_SWAP);
  const c = classifyHook(addr);
  assert.equal(c.safe, true);
  assert.equal(c.isHook, true);
  assert.equal(c.flags.BEFORE_SWAP, true);
  assert.equal(c.flags.AFTER_SWAP_RETURNS_DELTA, false);
  assert.equal(isDeltaReturning(addr), false);
});

test('hook con AFTER_SWAP_RETURNS_DELTA → unsafe (custom accounting)', () => {
  const addr = hookAddr(HOOK_FLAGS.AFTER_SWAP_RETURNS_DELTA);
  const c = classifyHook(addr);
  assert.equal(c.safe, false);
  assert.equal(c.reason, 'hook_returns_delta');
  assert.equal(isDeltaReturning(addr), true);
});

test('hook con BEFORE_SWAP_RETURNS_DELTA → unsafe', () => {
  assert.equal(isDeltaReturning(hookAddr(HOOK_FLAGS.BEFORE_SWAP_RETURNS_DELTA)), true);
});

test('hook con AFTER_ADD/REMOVE_LIQUIDITY_RETURNS_DELTA → unsafe', () => {
  assert.equal(isDeltaReturning(hookAddr(HOOK_FLAGS.AFTER_ADD_LIQUIDITY_RETURNS_DELTA)), true);
  assert.equal(isDeltaReturning(hookAddr(HOOK_FLAGS.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA)), true);
});

test('hook combinado swap+liquidity gating SIN returns-delta → safe', () => {
  const bits = HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.AFTER_SWAP
    | HOOK_FLAGS.BEFORE_ADD_LIQUIDITY | HOOK_FLAGS.AFTER_INITIALIZE;
  const c = classifyHook(hookAddr(bits));
  assert.equal(c.safe, true);
  assert.equal(c.flags.BEFORE_SWAP, true);
  assert.equal(c.flags.BEFORE_ADD_LIQUIDITY, true);
});

test('hook safe pero con un bit returns-delta mezclado → unsafe (fail-closed)', () => {
  const bits = HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.AFTER_ADD_LIQUIDITY_RETURNS_DELTA;
  assert.equal(classifyHook(hookAddr(bits)).safe, false);
});

test('address inválido → unsafe (fail-safe)', () => {
  const c = classifyHook('no-es-un-address');
  assert.equal(c.safe, false);
  assert.equal(c.reason, 'hook_address_invalid');
  assert.equal(isDeltaReturning('no-es-un-address'), true);
});

test('fee dinámica: sentinel 0x800000 detectado', () => {
  assert.equal(isDynamicFee(DYNAMIC_FEE_FLAG), true);
  assert.equal(isDynamicFee(0x800000), true);
  assert.equal(isDynamicFee(3000), false);
  assert.equal(isDynamicFee(500), false);
});
