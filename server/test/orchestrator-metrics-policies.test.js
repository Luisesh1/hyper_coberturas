const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPoliciesBreakdown } = require('../src/services/orchestrator-metrics.service');

test('policies expone las tres políticas, marca la viva y no inventa sombras sin medir', () => {
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

  assert.deepEqual(Object.keys(policies), ['legacy_zones_v1', 'net_profit_v1', 'net_profit_v2']);
  assert.equal(policies.net_profit_v1.isLive, true);
  assert.equal(policies.net_profit_v1.hlAccountUsd, 100);
  // Real net = 10, legacy net = 9: la cuenta contrafactual sustituye sólo el hedge.
  assert.equal(policies.legacy_zones_v1.hlAccountUsd, 99);
  assert.equal(policies.legacy_zones_v1.hedgeUnrealizedPnlUsd, 4);
  assert.equal(policies.net_profit_v2.isLive, false);
  assert.equal(policies.net_profit_v2.hlAccountUsd, null);
  assert.equal(policies.net_profit_v2.hedgeRealizedPnlUsd, null);
});
