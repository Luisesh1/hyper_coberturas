const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROFILE_IDS,
  getChainFamily,
  computeProfileFees,
  applyGasLimitBuffer,
  nextProfile,
  bumpReplacementFees,
} = require('../src/services/cross-chain/fee-profiles');

const gwei = (n) => BigInt(Math.round(n * 1e9));
const hex = (v) => `0x${BigInt(v).toString(16)}`;

// 3 bloques de historia + el base fee del bloque siguiente (último elemento).
function history({ bases, rewards }) {
  return {
    baseFeePerGas: bases.map(hex),
    reward: rewards.map((row) => row.map(hex)),
  };
}

const ETH_HISTORY = history({
  bases: [gwei(10), gwei(11), gwei(12), gwei(12)],
  rewards: [
    [gwei(1), gwei(2), gwei(5)],
    [gwei(3), gwei(4), gwei(9)],
    [gwei(2), gwei(3), gwei(7)],
  ],
});

test('los perfiles son bajo, medio y alto, en ese orden', () => {
  assert.deepEqual(PROFILE_IDS, ['low', 'medium', 'high']);
});

test('la familia de red decide cómo se cobra la L1', () => {
  assert.equal(getChainFamily('arbitrum'), 'orbit');
  assert.equal(getChainFamily('robinhood'), 'orbit');
  assert.equal(getChainFamily('base'), 'op');
  assert.equal(getChainFamily('optimism'), 'op');
  assert.equal(getChainFamily('polygon'), 'polygon');
  assert.equal(getChainFamily('ethereum'), 'l1');
});

test('bajo usa la mediana del p10 y un tope de dos bloques de subida', () => {
  const fees = computeProfileFees({ network: 'ethereum', profile: 'low', feeHistory: ETH_HISTORY });
  assert.equal(fees.baseFeeNextWei, gwei(12));
  assert.equal(fees.maxPriorityFeePerGas, gwei(2));
  assert.equal(fees.maxFeePerGas, (gwei(12) * 81n) / 64n + gwei(2));
  assert.equal(fees.expectedGasPriceWei, gwei(14));
});

test('medio usa p50 y base x2; alto usa p90 y base x3', () => {
  const medium = computeProfileFees({ network: 'ethereum', profile: 'medium', feeHistory: ETH_HISTORY });
  const high = computeProfileFees({ network: 'ethereum', profile: 'high', feeHistory: ETH_HISTORY });
  assert.equal(medium.maxPriorityFeePerGas, gwei(3));
  assert.equal(medium.maxFeePerGas, gwei(24) + gwei(3));
  assert.equal(high.maxPriorityFeePerGas, gwei(7));
  assert.equal(high.maxFeePerGas, gwei(36) + gwei(7));
  const low = computeProfileFees({ network: 'ethereum', profile: 'low', feeHistory: ETH_HISTORY });
  assert.ok(low.maxFeePerGas < medium.maxFeePerGas && medium.maxFeePerGas < high.maxFeePerGas);
});

test('en Orbit la priority fee es 0 en todos los perfiles', () => {
  for (const profile of PROFILE_IDS) {
    const fees = computeProfileFees({ network: 'arbitrum', profile, feeHistory: ETH_HISTORY });
    assert.equal(fees.maxPriorityFeePerGas, 0n);
    assert.equal(fees.family, 'orbit');
  }
});

test('Polygon nunca baja de su priority fee mínima', () => {
  const fees = computeProfileFees({ network: 'polygon', profile: 'low', feeHistory: ETH_HISTORY });
  assert.equal(fees.maxPriorityFeePerGas, gwei(25));
});

test('un perfil desconocido se rechaza', () => {
  assert.throws(
    () => computeProfileFees({ network: 'ethereum', profile: 'turbo', feeHistory: ETH_HISTORY }),
    /Perfil de gas desconocido/
  );
});

test('sin base fee en la historia no se inventa un precio', () => {
  assert.throws(
    () => computeProfileFees({ network: 'ethereum', profile: 'low', feeHistory: { baseFeePerGas: [], reward: [] } }),
    /baseFeePerGas/
  );
});

test('el margen de gasLimit redondea hacia arriba', () => {
  assert.equal(applyGasLimitBuffer(100_001n, 'low'), 110_002n);
  assert.equal(applyGasLimitBuffer(100_000n, 'medium'), 120_000n);
  assert.equal(applyGasLimitBuffer(100_000n, 'high'), 130_000n);
});

test('acelerar sube un perfil y al menos un 12,5 % ambas fees', () => {
  assert.equal(nextProfile('low'), 'medium');
  assert.equal(nextProfile('medium'), 'high');
  assert.equal(nextProfile('high'), 'high');
  const bumped = bumpReplacementFees(
    { maxFeePerGas: gwei(20), maxPriorityFeePerGas: gwei(2) },
    { maxFeePerGas: gwei(21), maxPriorityFeePerGas: gwei(1) }
  );
  assert.equal(bumped.maxFeePerGas, gwei(22.5));
  assert.equal(bumped.maxPriorityFeePerGas, gwei(2.25));
  const higher = bumpReplacementFees(
    { maxFeePerGas: gwei(20), maxPriorityFeePerGas: gwei(2) },
    { maxFeePerGas: gwei(40), maxPriorityFeePerGas: gwei(5) }
  );
  assert.equal(higher.maxFeePerGas, gwei(40));
  assert.equal(higher.maxPriorityFeePerGas, gwei(5));
});
