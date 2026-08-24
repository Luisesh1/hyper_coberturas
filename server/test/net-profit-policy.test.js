const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NET_PROFIT_V1,
  NET_PROFIT_V2,
  resolveProtectionPolicy,
  decideNetProfitV1,
  createShadowState,
  simulateShadowFill,
} = require('../src/services/net-profit-policy.service');

test('net_profit_v2 corrige 75% fuera de banda y fuerza la correccion ante riesgo duro', () => {
  const partial = decideNetProfitV1({
    policyVersion: NET_PROFIT_V2, deltaQty: 1, actualQty: 0.7, currentPrice: 100,
    rangeLowerPrice: 95, rangeUpperPrice: 105, lpValueUsd: 1_000, now: 1_000_000, state: {},
  });
  assert.equal(partial.decision, 'rebalance');
  assert.equal(partial.adjustQty, 0.225);
  const emergency = decideNetProfitV1({
    policyVersion: NET_PROFIT_V2, deltaQty: 2, actualQty: 0, currentPrice: 100,
    rangeLowerPrice: 95, rangeUpperPrice: 105, lpValueUsd: 1_000, now: 1_000_000, state: {},
  });
  assert.equal(emergency.adjustQty, 1.92);
  assert.equal(emergency.riskToInner, true);
});

test('net_profit_v2 respeta el presupuesto diario salvo riesgo duro', () => {
  const base = { policyVersion: NET_PROFIT_V2, deltaQty: 1, actualQty: 0.7, currentPrice: 100, rangeLowerPrice: 95, rangeUpperPrice: 105, lpValueUsd: 1_000, now: 1_000_000 };
  const held = decideNetProfitV1({ ...base, state: { rotationBudgetDay: 0, rotationBudgetCount: 4, rotationBudgetNotionalUsd: 100 } });
  assert.equal(held.gate, 'daily_rotation_budget');
  const emergency = decideNetProfitV1({ ...base, deltaQty: 2, actualQty: 0, state: { rotationBudgetDay: 0, rotationBudgetCount: 4, rotationBudgetNotionalUsd: 100 } });
  assert.equal(emergency.decision, 'rebalance');
});

test('un campo de política ausente mantiene legacy_zones_v1', () => {
  assert.equal(resolveProtectionPolicy({}), 'legacy_zones_v1');
  assert.equal(resolveProtectionPolicy({ policyVersion: NET_PROFIT_V1 }), NET_PROFIT_V1);
  assert.equal(resolveProtectionPolicy({ policyVersion: NET_PROFIT_V2 }), NET_PROFIT_V2);
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

test('shadow acumula costes y funding a lo largo de varios ticks', () => {
  // El contrafactual solo sirve si suma desde la apertura: un snapshot que
  // solo refleja el ultimo tick no puede sostener una decision de promocion.
  let state = createShadowState({ actualQty: 0, markPrice: 2_000 });
  state = simulateShadowFill(state, {
    targetQty: 1, bid: 1_999, ask: 2_001, feeRate: 0.0005, fundingUsd: 1,
  });
  const feesTrasAbrir = state.executionFeesUsd;
  const slippageTrasAbrir = state.slippageUsd;
  assert.ok(feesTrasAbrir > 0);

  // Tick sin cambio de tamano: no anade fee, pero tampoco puede borrar lo ya
  // acumulado ni el precio medio de entrada.
  state = simulateShadowFill(state, {
    targetQty: 1, bid: 2_049, ask: 2_051, feeRate: 0.0005, fundingUsd: 1,
  });
  assert.equal(state.executionFeesUsd, feesTrasAbrir);
  assert.equal(state.slippageUsd, slippageTrasAbrir);
  assert.equal(state.averageEntryPrice, 2_001);
  assert.equal(state.fundingUsd, 2);

  // Cierre parcial en beneficio: entro a 2001 y vende media unidad a 2099.
  state = simulateShadowFill(state, {
    targetQty: 0.5, bid: 2_099, ask: 2_101, feeRate: 0.0005, fundingUsd: 1,
  });
  assert.ok(state.executionFeesUsd > feesTrasAbrir);
  assert.equal(state.fundingUsd, 3);
  assert.ok(
    Math.abs(state.realizedPnlUsd - ((2_001 - 2_099) * 0.5)) < 1e-6,
    `realizedPnlUsd deberia reflejar el cierre parcial, fue ${state.realizedPnlUsd}`
  );
});

test('shadow se rehidrata desde un snapshot persistido sin perder acumulados', () => {
  // Es el caso del reinicio del server: el Map en memoria se vacia y el unico
  // estado que sobrevive es el snapshot guardado en strategy_state_json.
  const persistido = {
    actualQty: 0.8,
    averageEntryPrice: 1_950,
    realizedPnlUsd: -12.5,
    unrealizedPnlUsd: 0,
    executionFeesUsd: 7.25,
    slippageUsd: 3.1,
    slippageEwmaBps: 4.2,
    fundingUsd: -2.75,
    lastSnapshotAt: 1_000_000,
  };
  const rehidratado = createShadowState(persistido);
  assert.equal(rehidratado.actualQty, 0.8);
  assert.equal(rehidratado.averageEntryPrice, 1_950);
  assert.equal(rehidratado.realizedPnlUsd, -12.5);
  assert.equal(rehidratado.executionFeesUsd, 7.25);
  assert.equal(rehidratado.slippageUsd, 3.1);
  assert.equal(rehidratado.fundingUsd, -2.75);

  const next = simulateShadowFill(rehidratado, {
    targetQty: 0.8, bid: 2_000, ask: 2_002, feeRate: 0.0005, fundingUsd: 0.5,
  });
  assert.equal(next.executionFeesUsd, 7.25);
  assert.equal(next.fundingUsd, -2.25);
});

test('shadow valora a mercado la posicion abierta como hace el motor legacy', () => {
  // Sin esta pata la comparacion contra legacy esta sesgada: legacy suma
  // `hedgeUnrealizedPnlUsd` y la sombra reportaba siempre 0, o sea toda la
  // ganancia latente del short contrafactual se perdia.
  let state = createShadowState({ actualQty: 0, markPrice: 2_000 });
  state = simulateShadowFill(state, {
    targetQty: 1, bid: 1_999, ask: 2_001, feeRate: 0.0005,
  });
  assert.equal(state.averageEntryPrice, 2_001);

  // El precio baja: un short de 1 unidad entrada a 2001 gana ~101 USD.
  state = simulateShadowFill(state, {
    targetQty: 1, bid: 1_899, ask: 1_901, feeRate: 0.0005,
  });
  assert.ok(
    Math.abs(state.unrealizedPnlUsd - (2_001 - 1_900)) < 1e-6,
    `unrealizedPnlUsd deberia ser ~101, fue ${state.unrealizedPnlUsd}`
  );

  // Sin posicion abierta no hay latente que valorar.
  state = simulateShadowFill(state, {
    targetQty: 0, bid: 1_899, ask: 1_901, feeRate: 0.0005,
  });
  assert.equal(state.unrealizedPnlUsd, 0);
});
