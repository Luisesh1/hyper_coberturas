const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyExpectedState } = require('../src/services/lp-orchestrator/verifier');

test('modify-range OK cuando los rangos coinciden con tolerancia', () => {
  const result = verifyExpectedState({
    action: 'modify-range',
    expected: { rangeLowerPrice: 90, rangeUpperPrice: 110 },
    refreshedSnapshot: {
      rangeLowerPrice: 90.05,
      rangeUpperPrice: 110.1,
      liquidity: '1000000',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.severity, 'none');
});

test('modify-range con drift severo es critical', () => {
  const result = verifyExpectedState({
    action: 'modify-range',
    expected: { rangeLowerPrice: 90, rangeUpperPrice: 110 },
    refreshedSnapshot: {
      rangeLowerPrice: 80,
      rangeUpperPrice: 120,
      liquidity: '1000000',
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.drifts.length >= 2);
  assert.equal(result.severity, 'warn'); // range_mismatch sin no_liquidity → warn
});

test('modify-range sin liquidez es critical', () => {
  const result = verifyExpectedState({
    action: 'modify-range',
    expected: { rangeLowerPrice: 90, rangeUpperPrice: 110 },
    refreshedSnapshot: {
      rangeLowerPrice: 90,
      rangeUpperPrice: 110,
      liquidity: '0',
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.severity, 'critical');
});

test('close-to-usdc OK cuando la posición ya no aparece o tiene liquidez 0', () => {
  const result = verifyExpectedState({
    action: 'close-to-usdc',
    expected: {},
    refreshedSnapshot: { liquidity: '0', currentValueUsd: 0 },
  });
  assert.equal(result.ok, true);
});

test('close-to-usdc falla si la posición sigue con liquidez', () => {
  const result = verifyExpectedState({
    action: 'close-to-usdc',
    expected: {},
    refreshedSnapshot: { liquidity: '1000000', currentValueUsd: 500 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.severity, 'critical');
});

test('collect-fees OK cuando unclaimed fees ≈ 0', () => {
  const result = verifyExpectedState({
    action: 'collect-fees',
    expected: {},
    refreshedSnapshot: { unclaimedFeesUsd: 0.1, liquidity: '1000000' },
  });
  assert.equal(result.ok, true);
});

test('collect-fees con fees pendientes (>$0.5) marca drift', () => {
  const result = verifyExpectedState({
    action: 'collect-fees',
    expected: {},
    refreshedSnapshot: { unclaimedFeesUsd: 5, liquidity: '1000000' },
  });
  assert.equal(result.ok, false);
});

test('create-position falla si no hay positionIdentifier', () => {
  const result = verifyExpectedState({
    action: 'create-position',
    expected: {},
    refreshedSnapshot: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.severity, 'critical');
});

test('snapshot ausente para acción no-cierre es critical', () => {
  const result = verifyExpectedState({
    action: 'modify-range',
    expected: { rangeLowerPrice: 90, rangeUpperPrice: 110 },
    refreshedSnapshot: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.severity, 'critical');
});
