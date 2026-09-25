const test = require('node:test');
const assert = require('node:assert/strict');

const { TERMINAL_RANGE_V1 } = require('../src/services/terminal-range-policy.service');
const {
  ALL_POLICIES,
  resolveShadowPolicies,
  runShadowPolicies,
} = require('../src/services/protected-pool-delta-neutral/shadow-policies');

// LP continuo ±5% alrededor de 100 (formulas de la especificacion).
function makeValuation({ lower = 95, upper = 105, capital = 10_000, spot = 100 } = {}) {
  const sa = Math.sqrt(lower);
  const sb = Math.sqrt(upper);
  const unit = (p) => {
    const u = Math.sqrt(Math.min(Math.max(p, lower), upper));
    return { x: 1 / u - 1 / sb, y: u - sa };
  };
  const u0 = unit(spot);
  const L = capital / (u0.x * spot + u0.y);
  return {
    valueAt: (p) => { const { x, y } = unit(p); return L * (x * p + y); },
    volatileAt: (p) => L * unit(p).x,
    liquidity: '1',
  };
}

const MIN = 60_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % MIN);

function tick(memory, { price, minute, livePolicy = 'legacy_zones_v1' }) {
  return runShadowPolicies({
    protectionId: 5,
    memory,
    livePolicy,
    liveActualQty: 40,
    deltaQty: 48,
    currentPrice: price,
    bid: price,
    ask: price,
    feeRate: 0.00045,
    now: T0 + minute * MIN + 1000,
    rangeLowerPrice: 95,
    rangeUpperPrice: 105,
    lpValueUsd: 10_000,
    lpValuation: makeValuation(),
    terminalConfig: { threshold: 0.4, confirmMinutes: 2 },
    minOrderNotionalUsd: 11,
  });
}

const terminalOf = (results) => results.find((r) => r.policyVersion === TERMINAL_RANGE_V1);

test('terminal entra al motor de sombra y deja de simularse cuando es la viva', () => {
  assert.ok(ALL_POLICIES.includes(TERMINAL_RANGE_V1));
  assert.ok(resolveShadowPolicies('legacy_zones_v1').includes(TERMINAL_RANGE_V1));
  assert.ok(!resolveShadowPolicies(TERMINAL_RANGE_V1).includes(TERMINAL_RANGE_V1));
});

test('en sombra abre con la secante y confirma por cierres de minuto aunque este en hold', () => {
  const memory = new Map();
  const open = terminalOf(tick(memory, { price: 100, minute: 0 }));
  assert.equal(open.gate, 'cycle_open');
  assert.equal(open.state.actualQty > 0, true, 'fill simulado de la apertura');
  assert.equal(open.policyState.side, 0, 'en sombra el fill es inmediato: la intencion se promueve');

  const gates = [];
  for (let minute = 1; minute <= 4; minute += 1) {
    gates.push(terminalOf(tick(memory, { price: 97.9, minute })).gate);
  }
  // m1: cierre m0 central; m2: candidato; m3: 1 min; m4: confirma.
  assert.deepEqual(gates, ['balanced_hold', 'terminal_confirming', 'terminal_confirming', 'terminal_adjust']);
  const last = memory.get(`5:${TERMINAL_RANGE_V1}`);
  assert.equal(last.shadowPolicyState.side, -1);
});

test('las otras sombras siguen recibiendo exactamente sus decisiones', () => {
  const memory = new Map();
  const results = tick(memory, { price: 100, minute: 0 });
  const policies = results.map((r) => r.policyVersion).sort();
  assert.deepEqual(policies, ALL_POLICIES.filter((p) => p !== 'legacy_zones_v1').sort());
  for (const r of results.filter((x) => x.policyVersion !== TERMINAL_RANGE_V1)) {
    assert.equal(r.policyState.terminalRangePolicyState, undefined);
    assert.equal(r.policyState.pendingIntent, undefined);
  }
});

test('sin valoracion del LP la sombra terminal se queda quieta', () => {
  const results = runShadowPolicies({
    protectionId: 6,
    memory: new Map(),
    livePolicy: 'legacy_zones_v1',
    liveActualQty: 1,
    deltaQty: 1,
    currentPrice: 100,
    rangeLowerPrice: 95,
    rangeUpperPrice: 105,
  });
  const t = terminalOf(results);
  assert.equal(t.decision, 'hold');
  assert.equal(t.gate, 'valuation_unavailable');
});
