const test = require('node:test');
const assert = require('node:assert/strict');

const { recomputeNetPnl } = require('../src/services/lp-orchestrator/accounting');
const {
  SEGMENT_OPENING_ACTIONS,
  SEGMENT_CLOSING_ACTIONS,
  subtractAccounting,
  classifyCloseReason,
  estimateSigningDriftUsd,
  summarizeCoverage,
} = require('../src/services/lp-orchestrator/segments');

test('conjuntos de acciones que abren y cierran tramo', () => {
  assert.deepEqual(
    [...SEGMENT_OPENING_ACTIONS].sort(),
    ['decrease-liquidity', 'increase-liquidity', 'modify-range', 'rebalance', 'reinvest-fees'],
  );
  assert.deepEqual([...SEGMENT_CLOSING_ACTIONS].sort(), ['close-keep-assets', 'close-to-usdc']);
  assert.equal(SEGMENT_OPENING_ACTIONS.has('collect-fees'), false);
});

test('subtractAccounting: tramo = acumulado - baseline y el neto se recalcula', () => {
  const base = { lpFeesUsd: 10, gasSpentUsd: 1, hedgeRealizedPnlUsd: 5, priceDriftUsd: -2, lpCount: 1 };
  const cur = { lpFeesUsd: 14, gasSpentUsd: 1.5, hedgeRealizedPnlUsd: 3, priceDriftUsd: -6, lpCount: 2 };
  const seg = subtractAccounting(cur, base);
  assert.equal(seg.lpFeesUsd, 4);
  assert.equal(seg.hedgeRealizedPnlUsd, -2);
  assert.equal(seg.lpCount, 1);
  assert.equal(seg.totalNetPnlUsd, recomputeNetPnl(seg).totalNetPnlUsd);
  // 4 - 0.5 - 2 - 4 = -2.5
  assert.equal(seg.totalNetPnlUsd, -2.5);
});

test('subtractAccounting: la suma de tramos telescopica es el total', () => {
  const a0 = {}, a1 = { lpFeesUsd: 3, priceDriftUsd: 1 }, a2 = { lpFeesUsd: 7, priceDriftUsd: -4 };
  const s1 = subtractAccounting(a1, a0), s2 = subtractAccounting(a2, a1);
  assert.equal(s1.lpFeesUsd + s2.lpFeesUsd, 7);
  assert.equal(s1.priceDriftUsd + s2.priceDriftUsd, -4);
});

test('subtractAccounting: sin baseline devuelve el acumulado normalizado', () => {
  const seg = subtractAccounting({ lpFeesUsd: 4, lpCount: 1 }, null);
  assert.equal(seg.lpFeesUsd, 4);
  assert.equal(seg.lpCount, 1);
  assert.equal(seg.gasSpentUsd, 0);
});

test('subtractAccounting: resta shadowPolicies por politica', () => {
  const cur = { shadowPolicies: {
    a: { realizedPnlUsd: 5, fundingUsd: 2, executionFeesUsd: 1 },
    b: { realizedPnlUsd: 9 },
  } };
  const base = { shadowPolicies: { a: { realizedPnlUsd: 2, fundingUsd: 2, executionFeesUsd: 0.5 } } };
  const seg = subtractAccounting(cur, base);
  assert.equal(seg.shadowPolicies.a.realizedPnlUsd, 3);
  assert.equal(seg.shadowPolicies.a.fundingUsd, 0);
  assert.equal(seg.shadowPolicies.a.executionFeesUsd, 0.5);
  assert.equal(seg.shadowPolicies.a.netPnlUsd, 3 - 0.5);
  assert.equal(seg.shadowPolicies.b.realizedPnlUsd, 9);
});

test('classifyCloseReason por lado del precio y por accion', () => {
  const r = { rangeLowerPrice: 2401.9, rangeUpperPrice: 2628.1 };
  assert.equal(classifyCloseReason({ action: 'modify-range', price: 2377.5, ...r }), 'range_exit_below');
  assert.equal(classifyCloseReason({ action: 'rebalance', price: 2700, ...r }), 'range_exit_above');
  assert.equal(classifyCloseReason({ action: 'modify-range', price: 2500, ...r }), 'manual_rerange');
  assert.equal(classifyCloseReason({ action: 'increase-liquidity', price: 2500, ...r }), 'capital_change');
  assert.equal(classifyCloseReason({ action: 'close-keep-assets', price: 2500, ...r }), 'lp_closed');
  assert.equal(classifyCloseReason({ action: 'collect-fees', price: 2500, ...r }), 'unknown');
});

test('estimateSigningDriftUsd es 0 sin valoracion posible', () => {
  assert.equal(estimateSigningDriftUsd({ liquidity: '0' }, 2500), 0);
  assert.equal(estimateSigningDriftUsd(null, 2500), 0);
});

test('estimateSigningDriftUsd: snapshot ETH/USDC, signo segun el precio', () => {
  // Rango 2401.9 - 2628.1 (ticks sobre WETH 18 dec / USDC 6 dec).
  const snap = {
    token0: { symbol: 'WETH', decimals: 18 },
    token1: { symbol: 'USDC', decimals: 6 },
    tickLower: -198480,
    tickUpper: -197580,
    liquidity: '1000000000000000',
    rangeLowerPrice: 2401.9,
    rangeUpperPrice: 2628.1,
  };
  const { buildLpValuation } = require('../src/services/protected-pool-delta-neutral/terminal-range');
  const v = buildLpValuation(snap);
  assert.ok(v, 'el snapshot debe ser valorable');
  const value = v.valueAt(2500);
  assert.ok(value > 0);
  const withValue = { ...snap, currentValueUsd: value };
  assert.ok(estimateSigningDriftUsd(withValue, 2450) < 0, 'si el precio baja, el LP con ETH pierde');
  assert.ok(estimateSigningDriftUsd(withValue, 2550) > 0);
  assert.equal(estimateSigningDriftUsd(withValue, NaN), 0);
});

test('summarizeCoverage pondera por tiempo', () => {
  const rows = [
    { createdAt: 0, actualQtyAfter: 0.1, targetQtyAfter: 0.1 }, // 100 % durante 30
    { createdAt: 30, actualQtyAfter: 0.05, targetQtyAfter: 0.1 }, // 50 % durante 70
  ];
  const s = summarizeCoverage(rows, { openedAt: 0, closedAt: 100 });
  assert.equal(s.adjustments, 2);
  assert.equal(s.minPct, 50);
  assert.equal(s.maxPct, 100);
  assert.equal(s.openQty, 0.1);
  assert.equal(s.lastQty, 0.05);
  assert.equal(Math.round(s.avgPct), 65);
});

test('summarizeCoverage: sin filas devuelve ceros/null y tramo abierto usa now', () => {
  const empty = summarizeCoverage([], { openedAt: 0, closedAt: 100 });
  assert.equal(empty.adjustments, 0);
  assert.equal(empty.avgPct, null);
  const open = summarizeCoverage(
    [{ createdAt: 0, actualQtyAfter: 1, targetQtyAfter: 1 }],
    { openedAt: 0, closedAt: null, now: 50 },
  );
  assert.equal(open.avgPct, 100);
});
