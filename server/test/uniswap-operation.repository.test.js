const test = require('node:test');
const assert = require('node:assert/strict');

const repository = require('../src/repositories/uniswap-operation.repository');

function operationRow(overrides = {}) {
  return {
    id: '31',
    user_id: '1',
    operation_key: 'op-31',
    kind: 'orchestrated_lp_create',
    action: 'create-position',
    network: 'arbitrum',
    version: 'v3',
    wallet_address: '0xwallet',
    position_identifier: '48213',
    tx_hashes_json: '[]',
    status: 'committing',
    step: 'committing',
    result_json: null,
    plan_json: '{}',
    replacement_map_json: '{}',
    claim_token: 'claim-31',
    claim_owner: 'worker-test',
    claim_lease_until: '130000',
    attempt_count: '2',
    created_at: '1',
    updated_at: '2',
    finished_at: null,
    ...overrides,
  };
}

test('claimPending persiste token, owner y vencimiento en el mismo UPDATE', async () => {
  let capturedSql;
  let capturedParams;
  const executor = {
    query: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [operationRow()] };
    },
  };

  const rows = await repository.claimPending(1, {
    claimToken: 'claim-31',
    claimOwner: 'worker-test',
    leaseMs: 30_000,
    now: 100_000,
  }, executor);

  assert.match(capturedSql, /FOR UPDATE SKIP LOCKED/);
  assert.match(capturedSql, /SET claim_token = \$3/);
  assert.match(capturedSql, /claim_lease_until = \$5/);
  assert.deepEqual(capturedParams, [1, 100_000, 'claim-31', 'worker-test', 130_000]);
  assert.equal(rows[0].claimToken, 'claim-31');
  assert.equal(rows[0].attemptCount, 2);
});

test('claimByOperationKey no reclama un lease ajeno todavía vigente', async () => {
  let capturedSql;
  const result = await repository.claimByOperationKey(1, 'op-31', {
    claimToken: 'claim-new',
    claimOwner: 'http',
    leaseMs: 30_000,
    now: 100_000,
  }, {
    query: async (sql) => {
      capturedSql = sql;
      return { rows: [] };
    },
  });

  assert.match(capturedSql, /claim_lease_until IS NULL OR claim_lease_until <= \$6 OR claim_token = \$3/);
  assert.equal(result, null);
});
