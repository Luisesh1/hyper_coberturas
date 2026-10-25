const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CROSS_CONFIRM_MS,
  MIN_TRIGGER_OFFSET_PCT,
  rangeKey,
  decideRangeExitV1,
} = require('../src/services/range-exit-policy.service');

/**
 * Reentrada con short equilibrado (2026-10-24, orquestador #57).
 *
 * Al reentrar por el borde inferior la politica iba al delta de ESE instante
 * (~96% del LP en ETH) y lo congelaba en todo el rango. Si el precio subia al
 * borde superior, el LP ya era todo USDC y el short seguia al 96%: un short
 * direccional de casi todo el valor del LP. Ahora la reentrada va al short
 * equilibrado (la secante entre bordes, ~50%), que acota el error a la mitad
 * en los dos sentidos. Salir, abrir y re-centrar siguen yendo al delta.
 */

const LOWER = 2401.9;
const UPPER = 2628.1;
const RANGE = { rangeLowerPrice: LOWER, rangeUpperPrice: UPPER };
const T0 = 1_700_000_000_000;
const BALANCED = 0.094;

function confirmReentry({ balancedQty, deltaQty = 0.1807, actualQty = 0.1877 } = {}) {
  const outside = { rangeKey: rangeKey(LOWER, UPPER), zone: 'below', committedTargetQty: 0.1877 };
  const inside = LOWER * 1.02;
  const first = decideRangeExitV1({
    ...RANGE, deltaQty, actualQty, currentPrice: inside, state: outside, now: T0, balancedQty,
  });
  assert.equal(first.gate, 'cross_confirming');
  return decideRangeExitV1({
    ...RANGE, deltaQty, actualQty, currentPrice: inside, state: first.nextState,
    now: T0 + CROSS_CONFIRM_MS + 1, balancedQty,
  });
}

test('frenos contra rebotes: confirmacion de 5 min y margen minimo de 0,4%', () => {
  assert.equal(CROSS_CONFIRM_MS, 300_000);
  assert.equal(MIN_TRIGGER_OFFSET_PCT, 0.004);
});

test('la reentrada va al short equilibrado, no al delta del borde', () => {
  const d = confirmReentry({ balancedQty: BALANCED });
  assert.equal(d.decision, 'rebalance');
  assert.equal(d.gate, 'range_reentry');
  assert.equal(d.targetQty, BALANCED);
  assert.ok(Math.abs(d.adjustQty - (BALANCED - 0.1877)) < 1e-12, 'una sola orden por la diferencia');
  assert.equal(d.nextState.committedTargetQty, BALANCED);
  assert.equal(d.nextState.committedRule, 'balanced');
});

test('sin short equilibrado valido la reentrada cae al delta', () => {
  for (const balancedQty of [undefined, null, NaN, -1, 0]) {
    const d = confirmReentry({ balancedQty });
    assert.equal(d.gate, 'range_reentry');
    assert.equal(d.targetQty, 0.1807, `balancedQty=${balancedQty}`);
    assert.equal(d.nextState.committedRule, 'delta');
  }
});

test('salir del rango sigue yendo al delta aunque haya short equilibrado', () => {
  const inside = { rangeKey: rangeKey(LOWER, UPPER), zone: 'inside', committedTargetQty: BALANCED, committedRule: 'balanced' };
  const below = LOWER * 0.99;
  const first = decideRangeExitV1({
    ...RANGE, deltaQty: 0.1878, actualQty: BALANCED, currentPrice: below, state: inside, now: T0, balancedQty: BALANCED,
  });
  const d = decideRangeExitV1({
    ...RANGE, deltaQty: 0.1878, actualQty: BALANCED, currentPrice: below, state: first.nextState,
    now: T0 + CROSS_CONFIRM_MS + 1, balancedQty: BALANCED,
  });
  assert.equal(d.gate, 'range_exit');
  assert.equal(d.targetQty, 0.1878);
  assert.equal(d.nextState.committedRule, 'delta');
});

test('abrir y re-centrar siguen yendo al delta', () => {
  const open = decideRangeExitV1({
    ...RANGE, deltaQty: 0.107, actualQty: 0, currentPrice: 2515, state: {}, now: T0, balancedQty: BALANCED,
  });
  assert.equal(open.gate, 'initial_full_hedge');
  assert.equal(open.targetQty, 0.107);

  const rebased = decideRangeExitV1({
    rangeLowerPrice: 2300, rangeUpperPrice: 2520, deltaQty: 0.1, actualQty: 0.18, currentPrice: 2410,
    state: open.nextState, now: T0 + 1, balancedQty: BALANCED,
  });
  assert.equal(rebased.gate, 'range_rebased');
  assert.equal(rebased.targetQty, 0.1);
});

test('una reentrada equilibrada que no entro se reintenta al equilibrado de ahora', () => {
  const state = { rangeKey: rangeKey(LOWER, UPPER), zone: 'inside', committedTargetQty: BALANCED, committedRule: 'balanced' };
  const d = decideRangeExitV1({
    ...RANGE, deltaQty: 0.15, actualQty: 0.1877, currentPrice: 2450, state, now: T0, balancedQty: 0.095,
  });
  assert.equal(d.gate, 'commit_incomplete');
  assert.equal(d.targetQty, 0.095, 'no persigue el delta: la regla ordenada fue la equilibrada');
  assert.equal(d.nextState.committedRule, 'balanced');
});

test('dentro del rango, con la reentrada cumplida, no hay ordenes aunque el delta se aleje', () => {
  let state = confirmReentry({ balancedQty: BALANCED }).nextState;
  for (const [price, delta] of [[2450, 0.16], [2515, 0.107], [2600, 0.02]]) {
    const d = decideRangeExitV1({
      ...RANGE, deltaQty: delta, actualQty: BALANCED, currentPrice: price, state, now: T0 + 10 * 60_000, balancedQty: BALANCED,
    });
    assert.equal(d.decision, 'hold', `precio ${price}`);
    state = d.nextState;
  }
});

// --- Motor: la reentrada llega a la orden con el short equilibrado ---------

const { PRICE, buildProtection, buildService } = require('./support/delta-neutral-harness');
const { computeInitialTerminalQty } = require('../src/services/protected-pool-delta-neutral/terminal-range');

test('motor: una reentrada confirmada ordena el short equilibrado, no el delta', async () => {
  const protection = buildProtection({
    policyVersion: 'range_exit_v1',
    strategyState: {
      policyVersion: 'range_exit_v1',
      executionIntent: 'live',
      modelConfidence: 'high',
      rangeExitPolicyState: {
        rangeKey: rangeKey(2000, 3000),
        zone: 'below',
        committedTargetQty: 0.41,
        committedRule: 'delta',
        crossPendingZone: 'inside',
        crossStartedAt: Date.now() - CROSS_CONFIRM_MS - 1,
      },
    },
  });
  // Ticks de verdad para [2000, 3000] en WETH/USDC (los del arnes caen fuera
  // de ese rango y dejan delta = equilibrado), sin fees que lo enmascaren.
  Object.assign(protection.poolSnapshot, {
    tickLower: -200340, tickUpper: -196260, liquidity: '100000000000000', unclaimedFees0: 0, unclaimedFees1: 0,
  });
  const expected = computeInitialTerminalQty(protection.poolSnapshot, { volatilePriceUsd: PRICE });
  assert.ok(expected > 0, 'el arnes produce un equilibrado valido');

  let ordered = null;
  let delta = null;
  let reason = null;
  await buildService(protection, {
    actualQty: 0.41,
    onExecute: (r, { metrics }) => {
      reason = r;
      ordered = Number(metrics.targetQty);
      delta = Number(metrics.deltaQty);
    },
  }).evaluateProtection(protection);

  assert.ok(ordered != null, 'la reentrada ejecuta');
  assert.ok(Math.abs(delta - expected) > 0.005, `el arnes debe distinguir delta (${delta}) de equilibrado (${expected})`);
  assert.ok(Math.abs(ordered - expected) < 1e-9, `ordeno ${ordered}, equilibrado ${expected}`);
  assert.equal(protection.strategyState.rangeExitPolicyState.committedRule, 'balanced');
  assert.ok(reason);
});

// --- Revision: preflight contra el objetivo y pools con la estable en token0 ---

const { computeBalancedShortQty } = require('../src/services/protected-pool-delta-neutral/terminal-range');

function wethUsdcSnapshot() {
  const s = buildProtection().poolSnapshot;
  return {
    ...s, tickLower: -200340, tickUpper: -196260, liquidity: '100000000000000',
    unclaimedFees0: 0, unclaimedFees1: 0, rangeLowerPrice: 2000, rangeUpperPrice: 3000,
  };
}

test('equilibrado: un pool USDC/WETH (estable en token0) da lo mismo que su espejo WETH/USDC', () => {
  const weth = computeBalancedShortQty(wethUsdcSnapshot());
  const s = wethUsdcSnapshot();
  const mirror = {
    ...s,
    token0: s.token1, token1: s.token0,
    token0Address: s.token1Address, token1Address: s.token0Address,
    // Mismo rango en el espacio crudo token1/token0 = WETH por USDC.
    tickLower: 196260, tickUpper: 200340,
    rangeLowerPrice: 1 / 3000, rangeUpperPrice: 1 / 2000, priceCurrent: 1 / 2500,
  };
  const usdc = computeBalancedShortQty(mirror);
  assert.ok(weth > 0.15 && weth < 0.25, `weth ${weth}`);
  assert.ok(Math.abs(usdc - weth) / weth < 0.01, `usdc ${usdc} vs weth ${weth}`);
});

test('motor: reentrada con el short pegado al delta (hueco < $11 contra el delta) igual ordena el equilibrado', async () => {
  const protection = buildProtection({
    policyVersion: 'range_exit_v1',
    strategyState: {
      policyVersion: 'range_exit_v1',
      executionIntent: 'live',
      modelConfidence: 'high',
      rangeExitPolicyState: {
        rangeKey: rangeKey(2000, 3000),
        zone: 'below',
        committedTargetQty: 0.1759,
        committedRule: 'delta',
        crossPendingZone: 'inside',
        crossStartedAt: Date.now() - CROSS_CONFIRM_MS - 1,
      },
    },
  });
  Object.assign(protection.poolSnapshot, {
    tickLower: -200340, tickUpper: -196260, liquidity: '100000000000000', unclaimedFees0: 0, unclaimedFees1: 0,
  });
  const expected = computeBalancedShortQty(protection.poolSnapshot);
  let ordered = null;
  await buildService(protection, {
    actualQty: 0.1759, // delta 0.1739 + 0.002: $5 contra el delta, ~$20 contra el equilibrado
    onExecute: (_r, { metrics }) => { ordered = Number(metrics.targetQty); },
  }).evaluateProtection(protection);
  assert.ok(ordered != null, 'el preflight no la bloquea por minimo medido contra el delta');
  assert.ok(Math.abs(ordered - expected) < 1e-9);
});

test('motor: con targetHedgeRatio 0.5 la reentrada ordena la mitad del equilibrado', async () => {
  const protection = buildProtection({
    policyVersion: 'range_exit_v1',
    targetHedgeRatio: 0.5,
    strategyState: {
      policyVersion: 'range_exit_v1',
      executionIntent: 'live',
      modelConfidence: 'high',
      rangeExitPolicyState: {
        rangeKey: rangeKey(2000, 3000),
        zone: 'below',
        committedTargetQty: 0.205,
        committedRule: 'delta',
        crossPendingZone: 'inside',
        crossStartedAt: Date.now() - CROSS_CONFIRM_MS - 1,
      },
    },
  });
  Object.assign(protection.poolSnapshot, {
    tickLower: -200340, tickUpper: -196260, liquidity: '100000000000000', unclaimedFees0: 0, unclaimedFees1: 0,
  });
  const expected = 0.5 * computeBalancedShortQty(protection.poolSnapshot);
  let ordered = null;
  await buildService(protection, {
    actualQty: 0.205,
    onExecute: (_r, { metrics }) => { ordered = Number(metrics.targetQty); },
  }).evaluateProtection(protection);
  assert.ok(ordered != null);
  assert.ok(Math.abs(ordered - expected) < 1e-9, `ordeno ${ordered}, esperado ${expected}`);
});
