const test = require('node:test');
const assert = require('node:assert/strict');

const accounting = require('../src/services/lp-orchestrator/accounting');

test('computeAccountingDelta: incremento de fees y deriva de precio', () => {
  const prev = { unclaimedFeesUsd: 10, currentValueUsd: 1000 };
  const curr = { unclaimedFeesUsd: 15, currentValueUsd: 1020 };
  const delta = accounting.computeAccountingDelta(prev, curr);
  assert.equal(delta.lpFeesDelta, 5);
  assert.equal(delta.priceDriftDelta, 20);
});

test('computeAccountingDelta: si las fees decrecen (collect), delta de fees = 0', () => {
  const prev = { unclaimedFeesUsd: 50, currentValueUsd: 1000 };
  const curr = { unclaimedFeesUsd: 0, currentValueUsd: 1000 };
  const delta = accounting.computeAccountingDelta(prev, curr);
  assert.equal(delta.lpFeesDelta, 0);
});

test('computeAccountingDelta: cambio de identifier (modify-range) pone priceDriftDelta = 0', () => {
  const prev = { identifier: '5442406', unclaimedFeesUsd: 0, currentValueUsd: 112 };
  const curr = { identifier: '5447463', unclaimedFeesUsd: 0, currentValueUsd: 105 };
  const delta = accounting.computeAccountingDelta(prev, curr);
  assert.equal(delta.priceDriftDelta, 0);
});

test('computeAccountingDelta: mismo identifier mantiene drift como diferencia de valor', () => {
  const prev = { identifier: '5442406', unclaimedFeesUsd: 0, currentValueUsd: 112 };
  const curr = { identifier: '5442406', unclaimedFeesUsd: 0, currentValueUsd: 110 };
  const delta = accounting.computeAccountingDelta(prev, curr);
  assert.equal(delta.priceDriftDelta, -2);
});

test('applyTxCostDelta: suma gas + slippage y registra fees cobradas', () => {
  const start = { ...accounting.DEFAULT_ACCOUNTING };
  const after = accounting.applyTxCostDelta(start, {
    gasCostUsd: 3,
    slippageCostUsd: 1,
    collectedFeesUsd: 25,
  });
  assert.equal(after.gasSpentUsd, 3);
  assert.equal(after.swapSlippageUsd, 1);
  assert.equal(after.lpFeesUsd, 25);
  // netPnl = 25 - 3 - 1 = 21
  assert.equal(after.totalNetPnlUsd, 21);
});

test('incrementLpCount aumenta el contador y recomputa netPnl', () => {
  const start = { ...accounting.DEFAULT_ACCOUNTING, lpFeesUsd: 10 };
  const after = accounting.incrementLpCount(start);
  assert.equal(after.lpCount, 1);
  assert.equal(after.totalNetPnlUsd, 10);
});

test('applyAccountingDelta acumula fees y deriva de precio del LP', () => {
  const start = { ...accounting.DEFAULT_ACCOUNTING };
  const after = accounting.applyAccountingDelta(start, {
    lpFeesDelta: 4,
    priceDriftDelta: 10,
  });
  assert.equal(after.lpFeesUsd, 4);
  assert.equal(after.priceDriftUsd, 10);
  // Los campos del hedge se manejan ahora en applyHedgeStateDelta, no aquí.
  assert.equal(after.hedgeUnrealizedPnlUsd, 0);
  // netPnl = 4 - 0 - 0 + 0 + 0 + 0 - 0 - 0 + 10 = 14
  assert.equal(after.totalNetPnlUsd, 14);
});

test('contabilidad acumulada NO se reinicia entre LPs (la decisión de producto)', () => {
  let acc = { ...accounting.DEFAULT_ACCOUNTING };
  // Primer LP gana fees y consume gas
  acc = accounting.applyTxCostDelta(acc, { gasCostUsd: 5, collectedFeesUsd: 30 });
  acc = accounting.incrementLpCount(acc);
  assert.equal(acc.lpFeesUsd, 30);
  assert.equal(acc.gasSpentUsd, 5);
  assert.equal(acc.lpCount, 1);

  // Se mata el LP y se crea otro: la contabilidad sigue acumulando
  acc = accounting.incrementLpCount(acc);
  acc = accounting.applyTxCostDelta(acc, { gasCostUsd: 4, collectedFeesUsd: 20 });
  assert.equal(acc.lpFeesUsd, 50);
  assert.equal(acc.gasSpentUsd, 9);
  assert.equal(acc.lpCount, 2);
  assert.equal(acc.totalNetPnlUsd, 41);
});

// ──────────────── Hedge state delta ────────────────

test('applyHedgeStateDelta: primer tick (sin baseline) toma snapshot como inicio', () => {
  const start = { ...accounting.DEFAULT_ACCOUNTING };
  const result = accounting.applyHedgeStateDelta(start, null, {
    fundingAccumUsd: -2.5,
    hedgeRealizedPnlUsd: 0,
    hedgeUnrealizedPnlUsd: 1.2,
    executionFeesUsd: 0.4,
    slippageUsd: 0.1,
  });
  // Acumuladores en 0 (no se aplica delta sin baseline)
  assert.equal(result.accounting.hedgeFundingUsd, 0);
  assert.equal(result.accounting.hedgeRealizedPnlUsd, 0);
  assert.equal(result.accounting.hedgeExecutionFeesUsd, 0);
  assert.equal(result.accounting.hedgeSlippageUsd, 0);
  // Unrealized siempre se asigna como mark-to-market absoluto
  assert.equal(result.accounting.hedgeUnrealizedPnlUsd, 1.2);
  // Baseline se devuelve para que el siguiente tick lo use
  assert.deepEqual(result.hedgeBaseline.fundingAccumUsd, -2.5);
});

test('applyHedgeStateDelta: segundo tick computa delta vs baseline', () => {
  const start = { ...accounting.DEFAULT_ACCOUNTING };
  const baseline = {
    fundingAccumUsd: -2.5,
    hedgeRealizedPnlUsd: 0,
    hedgeUnrealizedPnlUsd: 1.2,
    executionFeesUsd: 0.4,
    slippageUsd: 0.1,
  };
  const current = {
    fundingAccumUsd: -3.5,         // pagó otro $1
    hedgeRealizedPnlUsd: 5,        // un cycle cerrado +$5
    hedgeUnrealizedPnlUsd: 0.8,    // mark-to-market actual
    executionFeesUsd: 0.6,         // +$0.20 en taker fees
    slippageUsd: 0.15,             // +$0.05 en slippage
  };
  const result = accounting.applyHedgeStateDelta(start, baseline, current);
  assert.equal(result.accounting.hedgeFundingUsd, -1);             // -3.5 - (-2.5)
  assert.equal(result.accounting.hedgeRealizedPnlUsd, 5);          // 5 - 0
  assert.equal(result.accounting.hedgeUnrealizedPnlUsd, 0.8);      // mark-to-market
  // Tolerancia float
  assert.ok(Math.abs(result.accounting.hedgeExecutionFeesUsd - 0.2) < 1e-9);
  assert.ok(Math.abs(result.accounting.hedgeSlippageUsd - 0.05) < 1e-9);
});

test('applyHedgeStateDelta: sin hedge actual deja unrealized en 0 y conserva acumuladores', () => {
  const start = {
    ...accounting.DEFAULT_ACCOUNTING,
    hedgeRealizedPnlUsd: 10,
    hedgeUnrealizedPnlUsd: 3,    // tenía un mark-to-market viejo
    hedgeFundingUsd: -2,
    hedgeExecutionFeesUsd: 0.5,
  };
  const result = accounting.applyHedgeStateDelta(start, null, null);
  assert.equal(result.accounting.hedgeUnrealizedPnlUsd, 0);    // se zeroiza
  assert.equal(result.accounting.hedgeRealizedPnlUsd, 10);     // acumulador conservado
  assert.equal(result.accounting.hedgeFundingUsd, -2);
  assert.equal(result.hedgeBaseline, null);
});

test('recomputeNetPnl incluye costos del hedge en la fórmula', () => {
  const acc = accounting.recomputeNetPnl({
    lpFeesUsd: 30,
    gasSpentUsd: 5,
    swapSlippageUsd: 1,
    hedgeRealizedPnlUsd: 10,
    hedgeUnrealizedPnlUsd: 2,
    hedgeFundingUsd: -3,         // pagó funding
    hedgeExecutionFeesUsd: 1.5,
    hedgeSlippageUsd: 0.5,
    priceDriftUsd: 4,
  });
  // 30 - 5 - 1 + 10 + 2 + (-3) - 1.5 - 0.5 + 4 = 35
  assert.equal(acc.totalNetPnlUsd, 35);
});

test('readHedgeStateFromProtection extrae los campos del strategyState', () => {
  const protection = {
    strategyState: {
      fundingAccumUsd: -1.2,
      hedgeRealizedPnlUsd: 5,
      hedgeUnrealizedPnlUsd: 0.8,
      executionFeesUsd: 0.4,
      slippageUsd: 0.1,
      otherUnrelatedField: 'ignored',
    },
  };
  const state = accounting.readHedgeStateFromProtection(protection);
  assert.deepEqual(state, {
    fundingAccumUsd: -1.2,
    hedgeRealizedPnlUsd: 5,
    hedgeUnrealizedPnlUsd: 0.8,
    executionFeesUsd: 0.4,
    slippageUsd: 0.1,
  });
});

test('readHedgeStateFromProtection devuelve null si no hay strategyState', () => {
  assert.equal(accounting.readHedgeStateFromProtection(null), null);
  assert.equal(accounting.readHedgeStateFromProtection({}), null);
  assert.equal(accounting.readHedgeStateFromProtection({ strategyState: null }), null);
});

// ──────────────── Shadow state delta (contrafactual) ────────────────

test('applyShadowStateDelta: primer tick (sin baseline) toma snapshot como inicio', () => {
  const start = { ...accounting.DEFAULT_ACCOUNTING };
  const result = accounting.applyShadowStateDelta(start, null, {
    realizedPnlUsd: 3,
    unrealizedPnlUsd: 1.5,
    fundingUsd: -0.4,
    executionFeesUsd: 0.2,
    slippageUsd: 0.05,
  });
  assert.equal(result.accounting.shadowRealizedPnlUsd, 0);
  assert.equal(result.accounting.shadowFundingUsd, 0);
  assert.equal(result.accounting.shadowExecutionFeesUsd, 0);
  assert.equal(result.accounting.shadowSlippageUsd, 0);
  // Latente: mark-to-market absoluto, igual que la pata real.
  assert.equal(result.accounting.shadowUnrealizedPnlUsd, 1.5);
  assert.equal(result.shadowBaseline.realizedPnlUsd, 3);
});

test('applyShadowStateDelta: segundo tick computa delta vs baseline', () => {
  const start = { ...accounting.DEFAULT_ACCOUNTING };
  const baseline = {
    realizedPnlUsd: 3,
    unrealizedPnlUsd: 1.5,
    fundingUsd: -0.4,
    executionFeesUsd: 0.2,
    slippageUsd: 0.05,
  };
  const current = {
    realizedPnlUsd: 8,        // +$5 realizado
    unrealizedPnlUsd: 0.9,    // mark-to-market actual
    fundingUsd: -0.9,         // pagó otros $0.50
    executionFeesUsd: 0.5,    // +$0.30
    slippageUsd: 0.15,        // +$0.10
  };
  const result = accounting.applyShadowStateDelta(start, baseline, current);
  assert.equal(result.accounting.shadowRealizedPnlUsd, 5);
  assert.equal(result.accounting.shadowUnrealizedPnlUsd, 0.9);
  assert.ok(Math.abs(result.accounting.shadowFundingUsd - -0.5) < 1e-9);
  assert.ok(Math.abs(result.accounting.shadowExecutionFeesUsd - 0.3) < 1e-9);
  assert.ok(Math.abs(result.accounting.shadowSlippageUsd - 0.1) < 1e-9);
});

test('applyShadowStateDelta: sin sombra activa zeroiza el latente y conserva acumuladores', () => {
  const start = {
    ...accounting.DEFAULT_ACCOUNTING,
    shadowRealizedPnlUsd: 12,
    shadowUnrealizedPnlUsd: 4,
    shadowFundingUsd: -1,
    shadowExecutionFeesUsd: 0.7,
  };
  const result = accounting.applyShadowStateDelta(start, null, null);
  assert.equal(result.accounting.shadowUnrealizedPnlUsd, 0);
  assert.equal(result.accounting.shadowRealizedPnlUsd, 12);
  assert.equal(result.accounting.shadowFundingUsd, -1);
  assert.equal(result.shadowBaseline, null);
});

test('shadowNetPnlUsd usa la convención de la pata de cobertura y NO entra en el neto total', () => {
  const acc = accounting.recomputeNetPnl({
    lpFeesUsd: 30,
    gasSpentUsd: 5,
    swapSlippageUsd: 1,
    hedgeRealizedPnlUsd: 10,
    hedgeUnrealizedPnlUsd: 2,
    hedgeFundingUsd: -3,
    hedgeExecutionFeesUsd: 1.5,
    hedgeSlippageUsd: 0.5,
    priceDriftUsd: 4,
    shadowRealizedPnlUsd: 12,
    shadowUnrealizedPnlUsd: 3,
    shadowFundingUsd: -2,
    shadowExecutionFeesUsd: 1,
    shadowSlippageUsd: 0.25,
  });
  // 12 + 3 + (-2) - 1 - 0.25 = 11.75
  assert.ok(Math.abs(acc.shadowNetPnlUsd - 11.75) < 1e-9);
  // El neto total es idéntico al del caso sin sombra: es plata contrafactual.
  assert.equal(acc.totalNetPnlUsd, 35);
});

test('readShadowStateFromProtection extrae los campos del shadowSnapshot', () => {
  const protection = {
    strategyState: {
      hedgeRealizedPnlUsd: 99,
      shadowSnapshot: {
        actualQty: 0.42,
        averageEntryPrice: 3120.5,
        realizedPnlUsd: 3,
        unrealizedPnlUsd: 1.5,
        fundingUsd: -0.4,
        executionFeesUsd: 0.2,
        slippageUsd: 0.05,
        slippageEwmaBps: 1.4,
      },
    },
  };
  assert.deepEqual(accounting.readShadowStateFromProtection(protection), {
    realizedPnlUsd: 3,
    unrealizedPnlUsd: 1.5,
    fundingUsd: -0.4,
    executionFeesUsd: 0.2,
    slippageUsd: 0.05,
  });
});

test('readShadowStateFromProtection devuelve null si la política sombra no está corriendo', () => {
  assert.equal(accounting.readShadowStateFromProtection(null), null);
  assert.equal(accounting.readShadowStateFromProtection({}), null);
  assert.equal(accounting.readShadowStateFromProtection({ strategyState: null }), null);
  // Protección con hedge real pero sin sombra: no hay contrafactual que mostrar.
  assert.equal(
    accounting.readShadowStateFromProtection({ strategyState: { hedgeRealizedPnlUsd: 5 } }),
    null
  );
});

test('las sombras se contabilizan de forma independiente por política y sobreviven a un recreate', () => {
  const firstSnapshots = {
    legacy_zones_v1: {
      realizedPnlUsd: 2,
      unrealizedPnlUsd: 1,
      fundingUsd: -0.2,
      executionFeesUsd: 0.1,
      slippageUsd: 0.05,
    },
    net_profit_v2: {
      realizedPnlUsd: 7,
      unrealizedPnlUsd: -0.5,
      fundingUsd: 0.3,
      executionFeesUsd: 0.4,
      slippageUsd: 0.15,
    },
  };
  const first = accounting.applyShadowStatesDelta(
    accounting.DEFAULT_ACCOUNTING,
    null,
    firstSnapshots,
  );

  // El primer tick fija dos baselines separados y sólo expone los marks.
  assert.deepEqual(first.shadowBaselines, firstSnapshots);
  assert.equal(first.accounting.shadowPolicies.legacy_zones_v1.realizedPnlUsd, 0);
  assert.equal(first.accounting.shadowPolicies.legacy_zones_v1.unrealizedPnlUsd, 1);
  assert.equal(first.accounting.shadowPolicies.net_profit_v2.unrealizedPnlUsd, -0.5);

  const second = accounting.applyShadowStatesDelta(first.accounting, first.shadowBaselines, {
    legacy_zones_v1: {
      ...firstSnapshots.legacy_zones_v1,
      realizedPnlUsd: 5,
      unrealizedPnlUsd: 0.4,
      fundingUsd: -0.5,
      executionFeesUsd: 0.25,
      slippageUsd: 0.08,
    },
    net_profit_v2: {
      ...firstSnapshots.net_profit_v2,
      realizedPnlUsd: 8,
      unrealizedPnlUsd: 1.2,
      fundingUsd: 0.1,
      executionFeesUsd: 0.6,
      slippageUsd: 0.2,
    },
  });

  const legacy = second.accounting.shadowPolicies.legacy_zones_v1;
  const v2 = second.accounting.shadowPolicies.net_profit_v2;
  assert.equal(legacy.realizedPnlUsd, 3);
  assert.equal(legacy.unrealizedPnlUsd, 0.4);
  assert.ok(Math.abs(legacy.fundingUsd + 0.3) < 1e-9);
  assert.equal(v2.realizedPnlUsd, 1);
  assert.equal(v2.unrealizedPnlUsd, 1.2);
  assert.ok(Math.abs(v2.fundingUsd + 0.2) < 1e-9);

  // Al matar el LP desaparece el mark, pero los acumuladores no se reinician.
  const afterKill = accounting.applyShadowStatesDelta(second.accounting, second.shadowBaselines, {});
  assert.equal(afterKill.accounting.shadowPolicies.legacy_zones_v1.unrealizedPnlUsd, 0);
  assert.equal(afterKill.accounting.shadowPolicies.legacy_zones_v1.realizedPnlUsd, 3);
  assert.deepEqual(afterKill.shadowBaselines, {});

  // El primer tick del LP recreado vuelve a ser baseline: no duplica P&L previo.
  const recreated = accounting.applyShadowStatesDelta(afterKill.accounting, null, {
    legacy_zones_v1: { ...firstSnapshots.legacy_zones_v1, realizedPnlUsd: 99, unrealizedPnlUsd: 2 },
  });
  assert.equal(recreated.accounting.shadowPolicies.legacy_zones_v1.realizedPnlUsd, 3);
  assert.equal(recreated.accounting.shadowPolicies.legacy_zones_v1.unrealizedPnlUsd, 2);
});

test('readShadowStatesFromProtection lee cada snapshot sin inferir la política viva', () => {
  const states = accounting.readShadowStatesFromProtection({
    strategyState: {
      shadowSnapshots: {
        legacy_zones_v1: { realizedPnlUsd: 1, unrealizedPnlUsd: 2 },
        net_profit_v1: { realizedPnlUsd: 3, fundingUsd: -1 },
      },
    },
  });
  assert.deepEqual(states, {
    legacy_zones_v1: {
      realizedPnlUsd: 1, unrealizedPnlUsd: 2, fundingUsd: 0, executionFeesUsd: 0, slippageUsd: 0,
    },
    net_profit_v1: {
      realizedPnlUsd: 3, unrealizedPnlUsd: 0, fundingUsd: -1, executionFeesUsd: 0, slippageUsd: 0,
    },
  });
});
