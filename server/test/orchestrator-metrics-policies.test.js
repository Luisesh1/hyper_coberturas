const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPoliciesBreakdown } = require('../src/services/orchestrator-metrics.service');
const { ALL_POLICIES } = require('../src/services/protected-pool-delta-neutral/shadow-policies');

test('policies expone todas las políticas del registro, marca la viva y no inventa sombras sin medir', () => {
  const policies = buildPoliciesBreakdown({
    hedgeRealizedPnlUsd: 10,
    hedgeUnrealizedPnlUsd: 2,
    hedgeFundingUsd: -1,
    hedgeExecutionFeesUsd: 0.5,
    hedgeSlippageUsd: 0.5,
    shadowPolicies: {
      legacy_zones_v1: {
        realizedPnlUsd: 6,
        unrealizedPnlUsd: 4,
        fundingUsd: -0.5,
        executionFeesUsd: 0.2,
        slippageUsd: 0.3,
      },
    },
  }, 'net_profit_v1', 100);

  // La lista se DERIVA del registro: al dar de alta una política nueva
  // (`range_exit_v1` fue la cuarta) el breakdown tiene que crecer con ella, y
  // este test debe seguir midiendo el invariante y no un catálogo congelado.
  assert.deepEqual(Object.keys(policies).sort(), [...ALL_POLICIES].sort());
  assert.equal(policies.net_profit_v1.isLive, true);
  assert.equal(policies.net_profit_v1.hlAccountUsd, 100);
  // Real net = 10, legacy net = 9: la cuenta contrafactual sustituye sólo el hedge.
  assert.equal(policies.legacy_zones_v1.hlAccountUsd, 99);
  assert.equal(policies.legacy_zones_v1.hedgeUnrealizedPnlUsd, 4);
  assert.equal(policies.net_profit_v2.isLive, false);
  assert.equal(policies.net_profit_v2.hlAccountUsd, null);
  assert.equal(policies.net_profit_v2.hedgeRealizedPnlUsd, null);

  // El corazón del test: toda política sin medición entra como HUECO, jamás
  // como cero. Un cero se leería como "esta política no gano ni perdió nada",
  // que es una afirmación que nadie observó.
  for (const policy of ALL_POLICIES) {
    if (policy === 'net_profit_v1' || policy === 'legacy_zones_v1') continue;
    assert.equal(policies[policy].isLive, false, `${policy} no es la viva`);
    assert.equal(policies[policy].hlAccountUsd, null, `${policy} no se midió`);
    assert.equal(policies[policy].hedgeRealizedPnlUsd, null, `${policy} no se midió`);
  }
});
