const test = require('node:test');
const assert = require('node:assert/strict');

const {
  UniswapOperationService,
  buildOperationKey,
} = require('../src/services/uniswap-operation.service');

function makeRepo(initial = {}) {
  const state = {
    row: {
      id: 1,
      userId: 1,
      kind: 'position_action',
      action: 'modify-range',
      network: 'arbitrum',
      version: 'v3',
      walletAddress: '0x00000000000000000000000000000000000000aa',
      positionIdentifier: '123',
      txHashes: ['0xbbb', '0xaaa'],
      status: 'queued',
      step: 'queued',
      result: null,
      errorCode: null,
      errorMessage: null,
      replacementMap: {},
      createdAt: 1,
      updatedAt: 1,
      finishedAt: null,
      ...initial,
    },
    updates: [],
  };

  return {
    state,
    async createOrReuse(record) {
      state.row = { ...state.row, ...record };
      return state.row;
    },
    async getById() {
      return state.row;
    },
    async listPending() {
      return [state.row];
    },
    async updateState(id, patch) {
      state.updates.push({ id, patch });
      state.row = { ...state.row, ...patch };
      return state.row;
    },
  };
}

test('buildOperationKey es idempotente sin importar el orden de txHashes', () => {
  const a = buildOperationKey({
    kind: 'position_action',
    userId: 7,
    action: 'modify-range',
    txHashes: ['0xbbb', '0xaaa'],
  });
  const b = buildOperationKey({
    kind: 'position_action',
    userId: 7,
    action: 'modify-range',
    txHashes: ['0xaaa', '0xbbb'],
  });

  assert.equal(a, b);
});

test('processOne marca failed cuando falla la espera de receipts', async () => {
  const repo = makeRepo();
  const service = new UniswapOperationService({
    operationRepo: repo,
    positionActionsService: {
      async collectFinalizeReceipts() {
        const err = new Error('Timeout esperando receipt');
        err.code = 'EXTERNAL_SERVICE_ERROR';
        throw err;
      },
      async finalizePositionActionAfterReceipts() {
        throw new Error('should not run');
      },
    },
    claimFeesService: {},
    logger: { info() {}, warn() {}, error() {} },
  });

  await service.processOne(repo.state.row);

  assert.equal(repo.state.row.status, 'failed');
  assert.equal(repo.state.row.errorCode, 'EXTERNAL_SERVICE_ERROR');
});

test('processOne marca needs_reconcile cuando falla después de receipts confirmados', async () => {
  const repo = makeRepo();
  const service = new UniswapOperationService({
    operationRepo: repo,
    positionActionsService: {
      async collectFinalizeReceipts({ onProgress }) {
        onProgress?.('waiting_receipts');
        return { receipts: [{ hash: '0xaaa', status: 1 }] };
      },
      async finalizePositionActionAfterReceipts({ onProgress }) {
        onProgress?.('refreshing_snapshot');
        const err = new Error('snapshot refresh failed');
        err.code = 'SNAPSHOT_REFRESH_FAILED';
        throw err;
      },
    },
    claimFeesService: {},
    logger: { info() {}, warn() {}, error() {} },
  });

  await service.processOne(repo.state.row);

  assert.equal(repo.state.row.status, 'needs_reconcile');
  assert.equal(repo.state.row.errorCode, 'SNAPSHOT_REFRESH_FAILED');
});

test('processOne termina en done cuando el finalize backend completa', async () => {
  const repo = makeRepo();
  const service = new UniswapOperationService({
    operationRepo: repo,
    positionActionsService: {
      async collectFinalizeReceipts({ onProgress }) {
        onProgress?.('waiting_receipts');
        return { receipts: [{ hash: '0xaaa', status: 1 }] };
      },
      async finalizePositionActionAfterReceipts({ onProgress }) {
        onProgress?.('refreshing_snapshot');
        onProgress?.('migrating_protection');
        return {
          txHashes: ['0xaaa'],
          refreshedSnapshot: { identifier: '456' },
          positionChanges: {
            oldPositionIdentifier: '123',
            newPositionIdentifier: '456',
          },
        };
      },
    },
    claimFeesService: {},
    logger: { info() {}, warn() {}, error() {} },
  });

  await service.processOne(repo.state.row);

  assert.equal(repo.state.row.status, 'done');
  assert.equal(repo.state.row.result.positionChanges.newPositionIdentifier, '456');
});

test('processPending entrega el lease persistido a la saga y lo libera al terminar', async () => {
  const claimed = {
    id: 31,
    userId: 1,
    operationKey: 'op-31',
    kind: 'orchestrated_lp_create',
    status: 'committing',
    claimToken: 'claim-31',
    claimOwner: 'worker-test',
    result: { finalizeResult: { positionIdentifier: '48213', txHashes: ['0xaaa'] } },
  };
  const seen = { claim: null, saga: null, released: null, transactions: 0 };
  const repo = {
    async claimPending(limit, claim, executor) {
      seen.claim = { limit, claim, executor };
      return [claimed];
    },
    async expireStaleIntents() { return 0; },
    async renewClaim() { return claimed; },
    async releaseClaim(id, token) {
      seen.released = { id, token };
      return claimed;
    },
    async getById() { return { ...claimed, status: 'done' }; },
    async updateState() { return claimed; },
  };
  const transactionClient = { query() {} };
  const service = new UniswapOperationService({
    db: {
      transaction: async (fn) => {
        seen.transactions += 1;
        return fn(transactionClient);
      },
    },
    operationRepo: repo,
    workerId: 'worker-test',
    logger: { info() {}, warn() {}, error() {} },
  });
  service.lpCreateSaga = {
    async commitIntent(input) {
      seen.saga = input;
      return { status: 'completed' };
    },
  };

  await service.processPending();

  assert.equal(seen.transactions, 1);
  assert.equal(seen.claim.limit, 1);
  assert.equal(seen.claim.claim.claimOwner, 'worker-test');
  assert.equal(seen.claim.executor, transactionClient);
  assert.equal(seen.saga.claimToken, 'claim-31');
  assert.equal(seen.saga.claimOwner, 'worker-test');
  assert.deepEqual(seen.saga.finalizeResult, claimed.result.finalizeResult);
  assert.deepEqual(seen.released, { id: 31, token: 'claim-31' });
});
