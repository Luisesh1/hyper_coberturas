const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DeltaNeutralIntegrityService,
} = require('../src/services/delta-neutral-integrity.service');

test('marca reconciliación y conserva la exposición sin enviar órdenes', async () => {
  const phases = [];
  const states = [];
  const logs = [];
  const protection = {
    id: 20,
    userId: 1,
    status: 'inactive',
    hedgeSize: 0.0212,
    strategyState: { status: 'healthy', lastActualQty: 0.0212 },
  };
  const service = new DeltaNeutralIntegrityService({
    db: {
      query: async () => ({ rows: [{
        orchestrator_id: '28',
        user_id: '1',
        active_position_identifier: '192295',
        active_protected_pool_id: '20',
        protection_id: '20',
        protection_status: 'inactive',
        protection_mode: 'delta_neutral',
        hyperliquid_account_id: '3',
        inferred_asset: 'ETH',
      }] }),
    },
    hlRegistry: {
      getOrCreate: async () => ({
        getPosition: async () => ({ szi: '-0.0424' }),
      }),
    },
    orchestratorRepository: {
      updatePhase: async (...args) => phases.push(args),
    },
    protectedPoolRepository: {
      getById: async () => protection,
      updateStrategyState: async (...args) => states.push(args),
    },
    logger: {
      error: (...args) => logs.push(args),
    },
  });

  const result = await service.audit();
  const repeated = await service.audit();

  assert.equal(result.issueCount, 1);
  assert.equal(repeated.issueCount, 1);
  assert.equal(result.incidents[0].actualQty, 0.0424);
  assert.equal(phases[0][2].phase, 'protection_reconcile_required');
  assert.equal(states[0][2].strategyState.status, 'needs_reconciliation');
  assert.equal(states[0][2].strategyState.lastActualQty, 0.0424);
  assert.equal(logs.length, 1, 'la misma alerta crítica se deduplica');
  assert.equal(logs[0][0], 'delta_neutral_integrity_incident');
});
