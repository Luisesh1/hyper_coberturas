const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeProtectionSnapshot,
  validateNormalizedProtectionSnapshot,
} = require('../src/services/delta-neutral-snapshot.service');
const { HOOK_FLAGS } = require('../src/services/uniswap/v4-hook-safety');

function hookAddr(bits) {
  return '0x' + BigInt(bits).toString(16).padStart(40, '0');
}

// Snapshot v4 completo y válido salvo por el hook, que varía cada test.
function v4Snapshot(hooks) {
  return normalizeProtectionSnapshot({
    mode: 'lp_position',
    network: 'arbitrum',
    version: 'v4',
    positionIdentifier: '12345',
    poolId: '0xabc123',
    owner: '0x1111111111111111111111111111111111111111',
    token0: { symbol: 'WETH', address: '0xaaa', decimals: 18 },
    token1: { symbol: 'USDC', address: '0xbbb', decimals: 6 },
    tickLower: -100,
    tickUpper: 100,
    liquidity: 1000,
    rangeLowerPrice: 2400,
    rangeUpperPrice: 2600,
    priceCurrent: 2500,
    currentValueUsd: 120,
    hooks,
  });
}

test('v4 con hook SAFE (solo beforeSwap) → valida (ready)', () => {
  const res = validateNormalizedProtectionSnapshot(v4Snapshot(hookAddr(HOOK_FLAGS.BEFORE_SWAP)));
  assert.equal(res.valid, true, JSON.stringify(res.reasons));
  assert.equal(res.status, 'ready');
});

test('v4 sin hook (0x0) → valida', () => {
  const res = validateNormalizedProtectionSnapshot(v4Snapshot('0x0000000000000000000000000000000000000000'));
  assert.equal(res.valid, true, JSON.stringify(res.reasons));
});

test('v4 con hook returns-delta → rechazado con hook_returns_delta', () => {
  const res = validateNormalizedProtectionSnapshot(v4Snapshot(hookAddr(HOOK_FLAGS.AFTER_SWAP_RETURNS_DELTA)));
  assert.equal(res.valid, false);
  assert.equal(res.status, 'hook_returns_delta');
  assert.ok(res.reasons.includes('hook_returns_delta'));
});

test('v4 con hook allowlisted (aunque returns-delta) → valida', () => {
  const addr = hookAddr(HOOK_FLAGS.AFTER_SWAP_RETURNS_DELTA);
  process.env.DELTA_NEUTRAL_V4_HOOK_ALLOWLIST = addr;
  // el config se cachea al primer require; forzamos re-lectura del módulo config
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/services/delta-neutral-snapshot.service')];
  const svc = require('../src/services/delta-neutral-snapshot.service');
  const snap = svc.normalizeProtectionSnapshot({
    mode: 'lp_position', network: 'arbitrum', version: 'v4', positionIdentifier: '1',
    poolId: '0xabc', owner: '0x1111111111111111111111111111111111111111',
    token0: { symbol: 'WETH', address: '0xaaa', decimals: 18 },
    token1: { symbol: 'USDC', address: '0xbbb', decimals: 6 },
    tickLower: -100, tickUpper: 100, liquidity: 1000,
    rangeLowerPrice: 2400, rangeUpperPrice: 2600, priceCurrent: 2500, currentValueUsd: 120,
    hooks: addr,
  });
  const res = svc.validateNormalizedProtectionSnapshot(snap);
  delete process.env.DELTA_NEUTRAL_V4_HOOK_ALLOWLIST;
  assert.equal(res.valid, true, JSON.stringify(res.reasons));
});
