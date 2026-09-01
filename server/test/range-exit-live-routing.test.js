const test = require('node:test');
const assert = require('node:assert/strict');

const { RANGE_EXIT_V1 } = require('../src/services/range-exit-policy.service');
const { policyOwnsFullDelta, FULL_DELTA_POLICIES } = require('../src/services/protected-pool-delta-neutral.helpers');
const { resolveLivePolicy, resolveShadowPolicies, ALL_POLICIES } = require('../src/services/protected-pool-delta-neutral/shadow-policies');
const { protectionConfigSchema } = require('../src/schemas/lp-orchestrator.schema');

test('range_exit_v1 vive sobre el 100% del delta cuando ejecuta', () => {
  // ESTE es el test que importa. Si la politica corre viva sin estar en la
  // lista, `pricing.js` le aplica `zoneMultiplier` y la sub-cubre en silencio
  // —hasta un 40% en centro con los defaults historicos—: el selector diria
  // "borde de rango" y el hedge haria otra cosa.
  assert.ok(FULL_DELTA_POLICIES.includes(RANGE_EXIT_V1));
  assert.equal(policyOwnsFullDelta(RANGE_EXIT_V1, 'live'), true);
  // En sombra no ejecuta, asi que el ratio del record no se fuerza.
  assert.equal(policyOwnsFullDelta(RANGE_EXIT_V1, 'shadow'), false);
  // Legacy nunca: es justamente la que SI escalona por zona.
  assert.equal(policyOwnsFullDelta('legacy_zones_v1', 'live'), false);
});

test('declarada live, range_exit_v1 es la politica viva y deja de simularse', () => {
  assert.equal(resolveLivePolicy({ policyVersion: RANGE_EXIT_V1, executionIntent: 'live' }), RANGE_EXIT_V1);
  // Y si es la viva, no puede estar ademas entre las sombras: se estaria
  // midiendo dos veces y una de las dos con estado distinto.
  assert.ok(!resolveShadowPolicies(RANGE_EXIT_V1).includes(RANGE_EXIT_V1));
  assert.equal(resolveShadowPolicies(RANGE_EXIT_V1).length, ALL_POLICIES.length - 1);
});

test('en sombra la viva sigue siendo legacy', () => {
  assert.equal(resolveLivePolicy({ policyVersion: RANGE_EXIT_V1, executionIntent: 'shadow' }), 'legacy_zones_v1');
});

// Payload minimo valido de una proteccion habilitada. Se comparte entre los
// dos casos para que la unica variable sea la politica.
const PROTECCION_BASE = {
  enabled: true,
  accountId: 1,
  leverage: 10,
  configuredNotionalUsd: 300,
};

test('el schema acepta range_exit_v1 y sigue rechazando lo que no existe', () => {
  const ok = protectionConfigSchema.safeParse({
    ...PROTECCION_BASE, policyVersion: 'range_exit_v1', executionIntent: 'live',
  });
  assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error?.issues));

  // El enum sigue siendo un enum: una politica inventada no entra.
  const malo = protectionConfigSchema.safeParse({ ...PROTECCION_BASE, policyVersion: 'range_exit_v9' });
  assert.equal(malo.success, false);
});
