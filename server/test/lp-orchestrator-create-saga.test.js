const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LpCreateSaga,
  buildOrchestratorPayload,
} = require('../src/services/lp-orchestrator/create-saga');

const BASE_PLAN = {
  name: 'WETH/USDC 0.05% · Arbitrum',
  network: 'arbitrum',
  version: 'v3',
  walletAddress: '0xwallet',
  token0Address: '0xt0',
  token1Address: '0xt1',
  token0Symbol: 'WETH',
  token1Symbol: 'USDC',
  feeTier: 500,
  capitalUsd: 1000,
  rangeLowerPrice: 1755.7,
  rangeUpperPrice: 1956.1,
  priceCurrent: 1855.9,
  strategy: { edgeMarginPct: 40 },
  protection: {
    enabled: true,
    accountId: 2,
    leverage: 3,
    configuredNotionalUsd: 1000,
  },
};

const FINALIZE = {
  positionChanges: { newPositionIdentifier: '48213' },
  refreshedSnapshot: { poolAddress: '0xpool', identifier: '48213', currentValueUsd: 998.4 },
  txHashes: ['0xaaa', '0xbbb'],
};

function makeSaga({
  createOrchestrator,
  attachLp,
  findProtection = async () => null,
  deactivateProtection = async () => ({ ok: true }),
  removeOrchestrator = async () => 1,
} = {}) {
  const calls = { created: [], attached: [], deactivated: [], removed: [] };

  const saga = new LpCreateSaga({
    logger: { info() {}, warn() {}, error() {} },
    orchestratorService: {
      async createOrchestrator(input) {
        calls.created.push(input);
        if (createOrchestrator) return createOrchestrator(input);
        return { id: 7, ...input };
      },
      async attachLp(input) {
        calls.attached.push(input);
        if (attachLp) return attachLp(input);
        return { id: 7, phase: 'lp_active', activeProtectedPoolId: 55 };
      },
    },
    protectionService: {
      async deactivateProtectedPool(userId, id) {
        calls.deactivated.push({ userId, id });
        return deactivateProtection(userId, id);
      },
    },
    protectedPoolRepository: {
      async findReusableByIdentity(userId, identity) {
        return findProtection(userId, identity);
      },
    },
    repo: {
      async remove(userId, id) {
        calls.removed.push({ userId, id });
        return removeOrchestrator(userId, id);
      },
    },
  });

  return { saga, calls };
}

// ── payload ───────────────────────────────────────────────────────────────

test('payload: deriva rangeWidthPct del rango elegido', () => {
  const payload = buildOrchestratorPayload(BASE_PLAN);

  // (1956.1 - 1755.7) / 2 / 1855.9 = 5.4%
  assert.ok(Math.abs(payload.strategyConfig.rangeWidthPct - 5.4) < 0.05);
  assert.equal(payload.strategyConfig.edgeMarginPct, 40);
});

test('payload: respeta un rangeWidthPct desacoplado explícitamente', () => {
  const plan = { ...BASE_PLAN, strategy: { edgeMarginPct: 40, rangeWidthPct: 12, rangeWidthDecoupled: true } };
  const payload = buildOrchestratorPayload(plan);

  assert.equal(payload.strategyConfig.rangeWidthPct, 12);
});

test('payload: usa un solo capital para el LP y para el orquestador', () => {
  const payload = buildOrchestratorPayload(BASE_PLAN);

  assert.equal(payload.initialTotalUsd, 1000);
  assert.equal(payload.protectionConfig.configuredNotionalUsd, 1000);
});

// ── camino feliz ──────────────────────────────────────────────────────────

test('saga: crea el orquestador y vincula el LP en modo strict', async () => {
  const { saga, calls } = makeSaga();

  const result = await saga.commit({ userId: 1, plan: BASE_PLAN, finalizeResult: FINALIZE });

  assert.equal(result.status, 'completed');
  assert.equal(result.orchestrator.id, 7);
  assert.equal(calls.attached[0].protectionFailureMode, 'strict');
  assert.equal(calls.attached[0].orchestratorId, 7);
  assert.equal(calls.removed.length, 0);
  assert.equal(calls.deactivated.length, 0);
});

// ── fallo de la cobertura (paso 5) ────────────────────────────────────────

test('saga: si la cobertura falla, borra el orquestador y reporta el LP superviviente', async () => {
  const { saga, calls } = makeSaga({
    attachLp: async () => {
      const err = new Error('No se pudo crear la protección: margen insuficiente');
      err.code = 'PROTECTION_CREATION_FAILED';
      throw err;
    },
  });

  const result = await saga.commit({ userId: 1, plan: BASE_PLAN, finalizeResult: FINALIZE });

  assert.equal(result.status, 'compensated');
  assert.match(result.reason, /margen insuficiente/);
  assert.equal(calls.removed.length, 1);
  assert.equal(calls.removed[0].id, 7);
  assert.equal(result.survivingLp.positionIdentifier, '48213');
  assert.equal(result.survivingLp.valueUsd, 998.4);
  assert.deepEqual(result.survivingLp.txHashes, ['0xaaa', '0xbbb']);
});

test('saga: cierra el hedge si la protección llegó a crearse antes de fallar', async () => {
  const { saga, calls } = makeSaga({
    attachLp: async () => { throw new Error('fallo tras abrir el hedge'); },
    findProtection: async () => ({ id: 99, status: 'active' }),
  });

  const result = await saga.commit({ userId: 1, plan: BASE_PLAN, finalizeResult: FINALIZE });

  assert.equal(result.status, 'compensated');
  assert.equal(calls.deactivated.length, 1);
  assert.equal(calls.deactivated[0].id, 99);
  const hedgeStep = result.compensations.find((c) => c.id === 'hedge');
  assert.equal(hedgeStep.ok, true);
});

test('saga: busca la protección a compensar por la identidad del LP recién minado', async () => {
  const seen = [];
  const { saga } = makeSaga({
    attachLp: async () => { throw new Error('boom'); },
    findProtection: async (userId, identity) => { seen.push(identity); return null; },
  });

  await saga.commit({ userId: 1, plan: BASE_PLAN, finalizeResult: FINALIZE });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].positionIdentifier, '48213');
  assert.equal(seen[0].network, 'arbitrum');
  assert.equal(seen[0].walletAddress, '0xwallet');
});

test('saga: una protección ya inactiva no se intenta cerrar dos veces', async () => {
  const { saga, calls } = makeSaga({
    attachLp: async () => { throw new Error('boom'); },
    findProtection: async () => ({ id: 99, status: 'inactive' }),
  });

  await saga.commit({ userId: 1, plan: BASE_PLAN, finalizeResult: FINALIZE });

  assert.equal(calls.deactivated.length, 0);
});

test('saga: si la compensación del hedge falla, lo reporta en vez de ocultarlo', async () => {
  const { saga } = makeSaga({
    attachLp: async () => { throw new Error('boom'); },
    findProtection: async () => ({ id: 99, status: 'active' }),
    deactivateProtection: async () => { throw new Error('hyperliquid caído'); },
  });

  const result = await saga.commit({ userId: 1, plan: BASE_PLAN, finalizeResult: FINALIZE });

  assert.equal(result.status, 'compensated');
  const hedgeStep = result.compensations.find((c) => c.id === 'hedge');
  assert.equal(hedgeStep.ok, false);
  assert.match(hedgeStep.detail, /hyperliquid caído/);
  // El aviso tiene que llegar al usuario: puede quedarle un short abierto.
  assert.equal(result.needsManualReview, true);
});

// ── fallo al crear el orquestador (paso 6) ────────────────────────────────

test('saga: si el orquestador no se puede crear, no hay nada que borrar pero el LP se reporta', async () => {
  const { saga, calls } = makeSaga({
    createOrchestrator: async () => { throw new Error('nombre duplicado'); },
  });

  const result = await saga.commit({ userId: 1, plan: BASE_PLAN, finalizeResult: FINALIZE });

  assert.equal(result.status, 'compensated');
  assert.match(result.reason, /nombre duplicado/);
  assert.equal(calls.removed.length, 0);
  assert.equal(result.survivingLp.positionIdentifier, '48213');
});

// ── contrato de entrada ───────────────────────────────────────────────────

test('saga: un finalizeResult sin identificador de posición no se da por bueno', async () => {
  const { saga, calls } = makeSaga();

  const result = await saga.commit({ userId: 1, plan: BASE_PLAN, finalizeResult: { txHashes: ['0xaaa'] } });

  assert.equal(result.status, 'compensated');
  assert.match(result.reason, /identificador/i);
  assert.equal(calls.created.length, 0, 'no debe crear nada sin saber qué vincular');
  assert.equal(result.survivingLp.positionIdentifier, null);
  assert.deepEqual(result.survivingLp.txHashes, ['0xaaa']);
});

test('saga: en modo standalone no crea orquestador ni cobertura', async () => {
  const { saga, calls } = makeSaga();
  const plan = { ...BASE_PLAN, mode: 'standalone' };

  const result = await saga.commit({ userId: 1, plan, finalizeResult: FINALIZE });

  assert.equal(result.status, 'completed');
  assert.equal(result.orchestrator, null);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.attached.length, 0);
});

// ── intención persistida e idempotencia ───────────────────────────────────

function makeSagaWithOperations({ attachLp } = {}) {
  const operations = new Map();
  let seq = 0;

  const { saga } = makeSaga({ attachLp });
  saga.newOperationKey = () => 'key-fija';
  saga.operationRepo = {
    async createOrReuse(record) {
      seq += 1;
      const existing = [...operations.values()].find((o) => o.operationKey === record.operationKey);
      if (existing) return existing;
      const op = { id: seq, ...record };
      operations.set(op.id, op);
      return op;
    },
    async getByOperationKey(userId, operationKey) {
      return [...operations.values()].find(
        (o) => o.operationKey === operationKey && o.userId === userId
      ) || null;
    },
    async updateState(id, patch) {
      const op = operations.get(id);
      Object.assign(op, patch);
      return op;
    },
  };

  return { saga, operations };
}

test('intención: se registra con el plan antes de firmar y sin txHashes', async () => {
  const { saga, operations } = makeSagaWithOperations();

  const { operationKey, operationId } = await saga.beginIntent({ userId: 1, plan: BASE_PLAN });

  assert.equal(operationKey, 'key-fija');
  const op = operations.get(operationId);
  assert.equal(op.kind, 'orchestrated_lp_create');
  assert.equal(op.status, 'awaiting_signature');
  assert.deepEqual(op.txHashes, []);
  assert.equal(op.plan.name, BASE_PLAN.name);
});

test('intención: el commit guarda el resultado y marca la operación como done', async () => {
  const { saga, operations } = makeSagaWithOperations();
  const { operationKey, operationId } = await saga.beginIntent({ userId: 1, plan: BASE_PLAN });

  const result = await saga.commitIntent({ userId: 1, operationKey, finalizeResult: FINALIZE });

  assert.equal(result.status, 'completed');
  const op = operations.get(operationId);
  assert.equal(op.status, 'done');
  assert.equal(op.positionIdentifier, '48213');
  assert.deepEqual(op.txHashes, ['0xaaa', '0xbbb']);
});

test('intención: un commit repetido devuelve el resultado guardado sin re-ejecutar', async () => {
  const { saga } = makeSagaWithOperations();
  const { operationKey } = await saga.beginIntent({ userId: 1, plan: BASE_PLAN });
  await saga.commitIntent({ userId: 1, operationKey, finalizeResult: FINALIZE });

  let reran = false;
  saga.commit = async () => { reran = true; return { status: 'completed' }; };

  const again = await saga.commitIntent({ userId: 1, operationKey, finalizeResult: FINALIZE });

  assert.equal(reran, false, 'no debe crear un segundo orquestador ni un segundo hedge');
  assert.equal(again.status, 'completed');
});

test('intención: una compensación también es terminal e idempotente', async () => {
  const { saga, operations } = makeSagaWithOperations({
    attachLp: async () => { throw new Error('margen insuficiente'); },
  });
  const { operationKey, operationId } = await saga.beginIntent({ userId: 1, plan: BASE_PLAN });

  const result = await saga.commitIntent({ userId: 1, operationKey, finalizeResult: FINALIZE });

  assert.equal(result.status, 'compensated');
  assert.equal(operations.get(operationId).status, 'compensated');

  let reran = false;
  saga.commit = async () => { reran = true; return { status: 'completed' }; };
  const again = await saga.commitIntent({ userId: 1, operationKey, finalizeResult: FINALIZE });
  assert.equal(reran, false);
  assert.equal(again.status, 'compensated');
});

test('intención: commit sobre una clave inexistente falla en vez de crear a ciegas', async () => {
  const { saga } = makeSagaWithOperations();

  await assert.rejects(
    () => saga.commitIntent({ userId: 1, operationKey: 'no-existe', finalizeResult: FINALIZE }),
    /No existe la intención/
  );
});

test('intención: HTTP y worker no pueden ejecutar el mismo commit en paralelo', async () => {
  let unblockAttach;
  let attachStarted;
  const attachGate = new Promise((resolve) => { unblockAttach = resolve; });
  const enteredAttach = new Promise((resolve) => { attachStarted = resolve; });
  const { saga, calls } = makeSaga({
    attachLp: async () => {
      attachStarted();
      await attachGate;
      return { id: 7, phase: 'lp_active', activeProtectedPoolId: 55 };
    },
  });
  const operation = {
    id: 31,
    userId: 1,
    operationKey: 'lease-key',
    kind: 'orchestrated_lp_create',
    status: 'awaiting_signature',
    step: 'awaiting_signature',
    plan: BASE_PLAN,
    result: null,
    claimToken: null,
    claimOwner: null,
    claimLeaseUntil: null,
  };
  const updates = [];
  saga.operationRepo = {
    async getByOperationKey() { return { ...operation }; },
    async claimByOperationKey(_userId, _key, claim) {
      const now = Date.now();
      if (operation.claimLeaseUntil > now && operation.claimToken !== claim.claimToken) return null;
      Object.assign(operation, {
        claimToken: claim.claimToken,
        claimOwner: claim.claimOwner,
        claimLeaseUntil: now + claim.leaseMs,
      });
      return { ...operation };
    },
    async renewClaim() { return { ...operation }; },
    async releaseClaim(_id, token) {
      if (operation.claimToken === token) {
        operation.claimToken = null;
        operation.claimOwner = null;
        operation.claimLeaseUntil = null;
      }
      return { ...operation };
    },
    async updateState(_id, patch) {
      updates.push(patch);
      Object.assign(operation, patch);
      return { ...operation };
    },
  };

  const first = saga.commitIntent({
    userId: 1,
    operationKey: operation.operationKey,
    finalizeResult: FINALIZE,
  });
  await enteredAttach;

  await assert.rejects(
    () => saga.commitIntent({
      userId: 1,
      operationKey: operation.operationKey,
      finalizeResult: FINALIZE,
    }),
    (err) => err.code === 'OPERATION_IN_PROGRESS' && err.statusCode === 409
  );
  unblockAttach();
  const result = await first;

  assert.equal(result.status, 'completed');
  assert.equal(calls.created.length, 1);
  assert.equal(calls.attached.length, 1);
  const committing = updates.find((patch) => patch.status === 'committing');
  assert.deepEqual(committing.result.finalizeResult, FINALIZE);
});

test('compensación: nunca desactiva una protección perteneciente a otra operación', async () => {
  const { saga, calls } = makeSaga();
  saga.protectedPoolRepository.findByCreationOperationId = async () => ({
    id: 99,
    status: 'active',
    creationOperationId: 30,
  });

  const steps = await saga._compensate({
    userId: 1,
    plan: BASE_PLAN,
    orchestrator: null,
    operationId: 31,
    positionIdentifier: '48213',
  });

  assert.equal(calls.deactivated.length, 0);
  assert.match(steps.find((step) => step.id === 'hedge').detail, /ajena preservada/i);
});

test('compensación: preserva una protección que ya referencia un orquestador activo', async () => {
  const { saga, calls } = makeSaga();
  saga.protectedPoolRepository.findByCreationOperationId = async () => ({
    id: 99,
    status: 'active',
    creationOperationId: 31,
  });
  saga.repo.findActiveByProtectedPoolId = async () => ({ id: 7 });

  const steps = await saga._compensate({
    userId: 1,
    plan: BASE_PLAN,
    orchestrator: null,
    operationId: 31,
    positionIdentifier: '48213',
  });

  assert.equal(calls.deactivated.length, 0);
  assert.match(steps.find((step) => step.id === 'hedge').detail, /orquestador #7/i);
});

// ── identidad v4 y flags de UI ────────────────────────────────────────────

test('payload v4: conserva el tickSpacing como parte de la identidad del pool', () => {
  const plan = {
    ...BASE_PLAN,
    version: 'v4',
    strategy: { edgeMarginPct: 40, v4TickSpacing: 30 },
  };
  const payload = buildOrchestratorPayload(plan);

  assert.equal(payload.version, 'v4');
  assert.equal(payload.strategyConfig.v4TickSpacing, 30);
});

test('payload v3: descarta el tickSpacing, que ahí no significa nada', () => {
  const plan = {
    ...BASE_PLAN,
    version: 'v3',
    strategy: { edgeMarginPct: 40, v4TickSpacing: 30 },
  };
  const payload = buildOrchestratorPayload(plan);

  assert.equal(payload.strategyConfig.v4TickSpacing, undefined);
});

test('payload: rangeWidthDecoupled es un flag de UI y no se persiste', () => {
  const plan = {
    ...BASE_PLAN,
    strategy: { edgeMarginPct: 40, rangeWidthPct: 12, rangeWidthDecoupled: true },
  };
  const payload = buildOrchestratorPayload(plan);

  assert.equal(payload.strategyConfig.rangeWidthPct, 12, 'el ancho desacoplado sí manda');
  assert.equal('rangeWidthDecoupled' in payload.strategyConfig, false);
});
