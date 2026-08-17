const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NET_PROFIT_V1,
  resolveProtectionPolicy,
  decideNetProfitV1,
  createShadowState,
  simulateShadowFill,
} = require('../src/services/net-profit-policy.service');

test('un campo de política ausente mantiene legacy_zones_v1', () => {
  assert.equal(resolveProtectionPolicy({}), 'legacy_zones_v1');
  assert.equal(resolveProtectionPolicy({ policyVersion: NET_PROFIT_V1 }), NET_PROFIT_V1);
});

test('net_profit_v1 cubre el 100% del delta y escala el umbral con el semiancho', () => {
  const result = decideNetProfitV1({
    deltaQty: 2,
    actualQty: 1.8,
    currentPrice: 2_000,
    rangeLowerPrice: 1_900,
    rangeUpperPrice: 2_100,
    expectedCostUsd: 2,
    now: 1_000_000,
    state: {},
  });
  assert.equal(result.targetQty, 2);
  assert.equal(result.outerPct, 0.08);
  assert.equal(result.innerPct, 0.04);
  assert.equal(result.decision, 'rebalance');
  assert.equal(result.adjustQty, 0.1, 'solo corrige hasta inner cuando el error es menor');
});

test('net_profit_v1 mantiene dentro de outer, usa $11 o 3x coste y acota un ajuste a 50% del error', () => {
  const held = decideNetProfitV1({
    deltaQty: 1,
    actualQty: 0.98,
    currentPrice: 2_000,
    rangeLowerPrice: 1_900,
    rangeUpperPrice: 2_100,
    expectedCostUsd: 5,
    now: 1_000_000,
    state: {},
  });
  assert.equal(held.decision, 'hold');
  assert.equal(held.gate, 'inside_outer');

  const adjusted = decideNetProfitV1({
    deltaQty: 1,
    actualQty: 0.7,
    currentPrice: 100,
    rangeLowerPrice: 95,
    rangeUpperPrice: 105,
    expectedCostUsd: 5,
    now: 1_000_000,
    state: {},
  });
  assert.equal(adjusted.decision, 'rebalance');
  assert.equal(adjusted.minNotionalUsd, 15);
  assert.equal(adjusted.adjustQty, 0.15, 'max(error-inner, 50% error) limita a mitad del error');
});

test('net_profit_v1 lleva riesgo >=15% a inner pero conserva los gates operativos', () => {
  const risk = decideNetProfitV1({
    deltaQty: 1,
    actualQty: 0.7,
    currentPrice: 100,
    rangeLowerPrice: 95,
    rangeUpperPrice: 105,
    expectedCostUsd: 1,
    now: 1_000_000,
    state: { lastFillAt: 999_999, fillTimestamps: [] },
  });
  assert.equal(risk.decision, 'hold');
  assert.equal(risk.gate, 'dwell');

  const toInner = decideNetProfitV1({
    deltaQty: 1,
    actualQty: 0.7,
    currentPrice: 100,
    rangeLowerPrice: 95,
    rangeUpperPrice: 105,
    lpValueUsd: 200,
    expectedCostUsd: 1,
    now: 1_000_000,
    state: {},
  });
  assert.equal(toInner.decision, 'rebalance');
  assert.equal(toInner.adjustQty, 0.26, 'riesgo >=15% LP llega a inner');

  const capped = decideNetProfitV1({
    deltaQty: 1,
    actualQty: 0.7,
    currentPrice: 100,
    rangeLowerPrice: 95,
    rangeUpperPrice: 105,
    expectedCostUsd: 1,
    now: 1_000_000,
    state: { fillTimestamps: [999_000, 999_500] },
  });
  assert.equal(capped.decision, 'hold');
  assert.equal(capped.gate, 'fill_cap');
});

test('net_profit_v1 no cierra normalmente cuando el target es cero', () => {
  const decision = decideNetProfitV1({
    deltaQty: 0,
    actualQty: 1,
    currentPrice: 2_000,
    rangeLowerPrice: 1_900,
    rangeUpperPrice: 2_100,
    now: 1_000_000,
    state: {},
  });
  assert.equal(decision.decision, 'hold');
  assert.equal(decision.gate, 'normal_zero_target');
});

test('net_profit_v1 confirma y rearma una salida superior sin ejecutar durante la histéresis', () => {
  const base = {
    deltaQty: 1,
    actualQty: 0.5,
    currentPrice: 111.5,
    rangeLowerPrice: 90,
    rangeUpperPrice: 110,
    expectedCostUsd: 1,
    lpValueUsd: 1_000,
  };
  const first = decideNetProfitV1({ ...base, now: 1_000_000, state: {} });
  assert.equal(first.decision, 'hold');
  assert.equal(first.gate, 'upper_exit_confirming');

  const confirmed = decideNetProfitV1({ ...base, now: 1_120_000, state: first.nextState });
  assert.equal(confirmed.decision, 'hold');
  assert.equal(confirmed.gate, 'upper_exit_latched');

  const rearmStart = decideNetProfitV1({
    ...base,
    currentPrice: 108.4,
    now: 1_130_000,
    state: confirmed.nextState,
  });
  assert.equal(rearmStart.gate, 'upper_rearm_confirming');

  const rearmed = decideNetProfitV1({
    ...base,
    currentPrice: 108.4,
    now: 1_250_000,
    state: rearmStart.nextState,
  });
  assert.equal(rearmed.decision, 'rebalance');
});

test('shadow mantiene contabilidad aislada y no muta el estado live', () => {
  const state = createShadowState({ actualQty: 1, markPrice: 2_000 });
  const next = simulateShadowFill(state, {
    targetQty: 1.2,
    bid: 1_999,
    ask: 2_001,
    feeRate: 0.0005,
    now: 1_000_000,
  });
  assert.equal(state.actualQty, 1);
  assert.equal(next.actualQty, 1.2);
  assert.ok(next.executionFeesUsd > 0);
  assert.ok(next.slippageEwmaBps >= 0);
});
