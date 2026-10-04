const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LpAdoptionService,
  evaluateAdoptionCandidate,
  deriveRangeWidthPct,
} = require('../src/services/lp-orchestrator/adoption');

// AFTER_SWAP (0x40) + BEFORE_SWAP (0x80) + AFTER_SWAP_RETURNS_DELTA (0x4):
// mismo perfil de permisos que EVPLUSAI.
const SWAP_DELTA_HOOK = '0x00000000000000000000000000000000000000c4';
// AFTER_ADD_LIQUIDITY (0x400) + AFTER_ADD_LIQUIDITY_RETURNS_DELTA (0x2).
const LIQUIDITY_DELTA_HOOK = '0x0000000000000000000000000000000000000402';
const WALLET = '0x9f3C000000000000000000000000000000041aB0';

function v4Pool(overrides = {}) {
  return {
    mode: 'lp_position',
    version: 'v4',
    network: 'robinhood',
    identifier: '3571232',
    owner: WALLET,
    creator: WALLET,
    token0: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 },
    token1: { address: '0x00000000000000000000000000000000000000d6', symbol: 'USDG', decimals: 6 },
    token0Address: '0x0000000000000000000000000000000000000000',
    token1Address: '0x00000000000000000000000000000000000000d6',
    fee: 0x800000,
    tickSpacing: 60,
    hooks: SWAP_DELTA_HOOK,
    poolId: '0xpoolid',
    poolAddress: null,
    liquidity: '123456789',
    rangeLowerPrice: 3952,
    rangeUpperPrice: 4027,
    priceCurrent: 3988,
    inRange: true,
    currentValueUsd: 501.84,
    unclaimedFeesUsd: 0.62,
    openedAt: 1_790_000_000,
    protection: null,
    protectionCandidate: {
      eligible: true,
      inferredAsset: 'ETH',
      defaultLeverage: 3,
      maxLeverage: 25,
      hedgeNotionalUsd: 250,
    },
    ...overrides,
  };
}

test('deriveRangeWidthPct mide el ancho desde el centro geométrico del rango', () => {
  // √(3952·4027) ≈ 3989.32 → (75/2)/3989.32 = 0.94 %
  assert.equal(deriveRangeWidthPct(3952, 4027), 0.94);
  assert.equal(deriveRangeWidthPct(0, 10), null);
  assert.equal(deriveRangeWidthPct(10, 5), null);
});

test('precarga un v4 con hook de deltas en swaps: identidad, rango y políticas restringidas', () => {
  const result = evaluateAdoptionCandidate(v4Pool());

  assert.equal(result.eligible, true);
  assert.equal(result.blockedReason, null);
  const p = result.prefill;
  assert.equal(p.network, 'robinhood');
  assert.equal(p.version, 'v4');
  assert.equal(p.walletAddress, WALLET);
  assert.equal(p.token0Symbol, 'ETH');
  assert.equal(p.token1Symbol, 'USDG');
  assert.equal(p.feeTier, 0x800000);
  assert.equal(p.inferredAsset, 'ETH');
  assert.equal(p.initialTotalUsd, 501.84);
  assert.equal(p.name, 'ETH/USDG dinámica #3571232');
  assert.equal(p.strategyConfig.rangeWidthPct, 0.94);
  assert.equal(p.strategyConfig.v4TickSpacing, 60);
  assert.equal(p.strategyConfig.v4Hooks, SWAP_DELTA_HOOK);
  assert.equal(p.strategyConfig.v4DynamicFeeHookVersionId, undefined);
  // El ancho del LP queda por debajo del mínimo por defecto (1 %): la cota se
  // amplía para que el recomendador no proponga otro rango de entrada.
  assert.equal(p.strategyConfig.minRangeWidthPct, 0.94);
  assert.equal(p.strategyConfig.maxRangeWidthPct, 30);

  assert.equal(result.provenance.feeTier, 'chain');
  assert.equal(result.provenance.rangeWidthPct, 'derived');
  assert.equal(result.provenance.edgeMarginPct, 'default');

  assert.deepEqual(result.protection.modes, ['new', 'none']);
  assert.equal(result.protection.defaultMode, 'new');
  assert.deepEqual(result.protection.allowedPolicies, ['terminal_range_v1', 'range_exit_v1']);
  assert.equal(result.hook.swapReturnsDelta, true);
});

test('enlaza la versión verificada cuando el hook está en el registro', () => {
  const result = evaluateAdoptionCandidate(v4Pool({ hooks: '0x0000000000000000000000000000000000000080' }), {
    verifiedHooks: [{ id: 12, deployment: { address: '0x0000000000000000000000000000000000000080' } }],
  });
  assert.equal(result.prefill.strategyConfig.v4DynamicFeeHookVersionId, 12);
  assert.equal(result.protection.allowedPolicies, null);
});

test('una posición ya gestionada por un orquestador activo no se puede adoptar', () => {
  const result = evaluateAdoptionCandidate(v4Pool(), {
    activeOrchestrators: [{
      id: 4, name: 'ETH/USDG Fables', status: 'active', network: 'robinhood', version: 'v4',
      walletAddress: WALLET.toLowerCase(), activePositionIdentifier: '3571232',
    }],
  });
  assert.equal(result.eligible, false);
  assert.equal(result.blockedCode, 'already_orchestrated');
  assert.match(result.blockedReason, /ETH\/USDG Fables/);
});

test('un orquestador archivado no bloquea la adopción', () => {
  const result = evaluateAdoptionCandidate(v4Pool(), {
    activeOrchestrators: [{
      id: 4, status: 'archived', network: 'robinhood', version: 'v4',
      walletAddress: WALLET, activePositionIdentifier: '3571232',
    }],
  });
  assert.equal(result.eligible, true);
});

test('bloquea hooks que devuelven deltas en la liquidez', () => {
  const result = evaluateAdoptionCandidate(v4Pool({ hooks: LIQUIDITY_DELTA_HOOK }));
  assert.equal(result.eligible, false);
  assert.equal(result.blockedCode, 'hook_liquidity_delta');
});

test('bloquea posiciones sin valoración en USD', () => {
  const result = evaluateAdoptionCandidate(v4Pool({ currentValueUsd: null }));
  assert.equal(result.eligible, false);
  assert.equal(result.blockedCode, 'no_valuation');
});

test('una cobertura delta-neutral activa solo admite conservarla', () => {
  const result = evaluateAdoptionCandidate(v4Pool({
    protection: { id: 31, status: 'active', protectionMode: 'delta_neutral', accountId: 4, leverage: 3 },
  }));
  assert.deepEqual(result.protection.modes, ['reuse']);
  assert.equal(result.protection.defaultMode, 'reuse');
  assert.equal(result.protection.existing.id, 31);
});

test('una cobertura activa de otro tipo solo deja adoptar sin cobertura y lo avisa', () => {
  const result = evaluateAdoptionCandidate(v4Pool({
    protection: { id: 32, status: 'active', protectionMode: 'static', accountId: 4, leverage: 3 },
  }));
  assert.deepEqual(result.protection.modes, ['none']);
  assert.match(result.protection.warning, /desact/i);
});

test('sin activo cubrible en Hyperliquid solo se ofrece adoptar sin cobertura', () => {
  const result = evaluateAdoptionCandidate(v4Pool({
    protectionCandidate: { eligible: false, reason: 'Activo no listado' },
  }));
  assert.deepEqual(result.protection.modes, ['none']);
  assert.match(result.protection.warning, /Activo no listado/);
});

test('v3 usa el fee del pool y no persiste identidad v4', () => {
  const result = evaluateAdoptionCandidate(v4Pool({
    version: 'v3', fee: 500, hooks: null, poolId: null, tickSpacing: 10, poolAddress: '0xpool',
  }));
  assert.equal(result.prefill.feeTier, 500);
  assert.equal(result.prefill.name, 'ETH/USDG 0.05% #3571232');
  assert.equal(result.prefill.strategyConfig.v4TickSpacing, undefined);
  assert.equal(result.prefill.strategyConfig.v4Hooks, undefined);
});

// ── Servicio ──────────────────────────────────────────────────────────────

const NEW_PROTECTION = {
  enabled: true,
  accountId: 4,
  leverage: 3,
  configuredNotionalUsd: 500,
  policyVersion: 'range_exit_v1',
  executionIntent: 'live',
  activationConfirmed: true,
};

function makeService({
  pool = v4Pool(),
  attachLp,
  activeProtection = null,
  orchestrators = [],
} = {}) {
  const calls = {
    created: [], attached: [], removed: [], deactivated: [], strategyStates: [], evaluated: [],
  };
  const service = new LpAdoptionService({
    logger: { info() {}, warn() {}, error() {} },
    loadWalletPoolSnapshot: async () => pool,
    uniswapService: {
      getSupportMatrix: () => ({ networks: [{ id: 'robinhood', versions: ['v4'] }] }),
      scanPoolsCreatedByWallet: async () => ({ pools: [pool] }),
    },
    repo: {
      listForUser: async () => orchestrators,
      remove: async (userId, id) => { calls.removed.push(id); return id; },
      updateStrategyState: async (userId, id, patch) => { calls.strategyStates.push({ id, ...patch }); return id; },
      findActiveByProtectedPoolId: async () => null,
    },
    protectedPoolRepo: {
      findReusableByIdentity: async () => activeProtection,
      getById: async (userId, id) => ({
        id,
        status: 'active',
        protectionMode: 'delta_neutral',
        accountId: 4,
        leverage: 3,
        configuredHedgeNotionalUsd: 480,
        policyVersion: 'range_exit_v1',
        stopLossDifferencePct: 0.05,
        strategyState: { executionIntent: 'live' },
      }),
    },
    verifiedHooksRepository: { listVerifiedHooks: async () => [] },
    protectionService: {
      deactivateProtectedPool: async (userId, id) => { calls.deactivated.push(id); },
    },
    orchestratorService: {
      async createOrchestrator(input) { calls.created.push(input); return { id: 9, ...input }; },
      async attachLp(input) {
        calls.attached.push(input);
        if (attachLp) return attachLp(input);
        return { id: 9, phase: 'lp_active', activePositionIdentifier: '3571232' };
      },
      async evaluateOne(userId, id) { calls.evaluated.push(id); },
    },
  });
  return { service, calls };
}

const ADOPT_INPUT = {
  userId: 1,
  network: 'robinhood',
  version: 'v4',
  walletAddress: WALLET,
  positionIdentifier: '3571232',
};

test('adopt crea el orquestador desde la cadena, cubre en estricto y siembra la contabilidad', async () => {
  const { service, calls } = makeService();
  const result = await service.adopt({
    ...ADOPT_INPUT,
    name: 'Mi LP',
    strategyConfig: { edgeMarginPct: 25 },
    protection: { mode: 'new', config: NEW_PROTECTION },
  });

  assert.equal(result.orchestrator.id, 9);
  const created = calls.created[0];
  assert.equal(created.name, 'Mi LP');
  assert.equal(created.feeTier, 0x800000);
  assert.equal(created.initialTotalUsd, 501.84);
  assert.equal(created.strategyConfig.edgeMarginPct, 25);
  assert.equal(created.strategyConfig.rangeWidthPct, 0.94);
  assert.equal(created.strategyConfig.v4Hooks, SWAP_DELTA_HOOK);
  // Defaults del schema rellenados.
  assert.equal(created.strategyConfig.maxSlippageBps, 100);
  assert.equal(created.protectionConfig.policyVersion, 'range_exit_v1');

  const attached = calls.attached[0];
  assert.equal(attached.protectionFailureMode, 'strict');
  assert.equal(attached.finalizeResult.positionChanges.newPositionIdentifier, '3571232');
  assert.equal(attached.finalizeResult.refreshedSnapshot.identifier, '3571232');

  // La primera evaluación diferencia contra el snapshot de adopción: las
  // fees sin cobrar previas no cuentan como ganancia del orquestador.
  assert.equal(calls.strategyStates[0].lastEvaluation.poolSnapshot.unclaimedFeesUsd, 0.62);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.evaluated, [9]);
});

test('adopt rechaza una política que el hook no admite', async () => {
  const { service, calls } = makeService();
  await assert.rejects(
    service.adopt({ ...ADOPT_INPUT, protection: { mode: 'new', config: { ...NEW_PROTECTION, policyVersion: 'legacy_zones_v1' } } }),
    /política/
  );
  assert.equal(calls.created.length, 0);
});

test('adopt rechaza un modo de cobertura no permitido para la posición', async () => {
  const { service } = makeService({
    pool: v4Pool({ protection: { id: 31, status: 'active', protectionMode: 'delta_neutral', accountId: 4 } }),
  });
  await assert.rejects(
    service.adopt({ ...ADOPT_INPUT, protection: { mode: 'new', config: NEW_PROTECTION } }),
    /cobertura/
  );
});

test('adopt rechaza una posición ya orquestada', async () => {
  const { service } = makeService({
    orchestrators: [{
      id: 4, name: 'Otro', status: 'active', network: 'robinhood', version: 'v4',
      walletAddress: WALLET, activePositionIdentifier: '3571232',
    }],
  });
  await assert.rejects(
    service.adopt({ ...ADOPT_INPUT, protection: { mode: 'none' } }),
    /Otro/
  );
});

test('si la cobertura falla, borra el orquestador, desactiva lo creado y deja el LP', async () => {
  const { service, calls } = makeService({
    attachLp: async () => { throw new Error('margen insuficiente'); },
    activeProtection: { id: 77, status: 'active' },
  });
  await assert.rejects(
    service.adopt({ ...ADOPT_INPUT, protection: { mode: 'new', config: NEW_PROTECTION } }),
    (err) => {
      assert.equal(err.code, 'ADOPTION_FAILED');
      assert.match(err.message, /margen insuficiente/);
      return true;
    }
  );
  assert.deepEqual(calls.removed, [9]);
  assert.deepEqual(calls.deactivated, [77]);
  assert.equal(calls.evaluated.length, 0);
});

test('reuse vincula la cobertura existente sin abrir otra', async () => {
  const { service, calls } = makeService({
    pool: v4Pool({ protection: { id: 31, status: 'active', protectionMode: 'delta_neutral', accountId: 4 } }),
  });
  await service.adopt({ ...ADOPT_INPUT, protection: { mode: 'reuse' } });

  const created = calls.created[0];
  assert.equal(created.protectionConfig.enabled, true);
  assert.equal(created.protectionConfig.accountId, 4);
  assert.equal(created.protectionConfig.configuredNotionalUsd, 480);
  assert.equal(created.protectionConfig.policyVersion, 'range_exit_v1');
  assert.equal(calls.attached[0].existingProtectedPoolId, 31);
});

test('listCandidates filtra posiciones sin liquidez y pone primero las adoptables', async () => {
  const { service } = makeService();
  service.uniswapService.scanPoolsCreatedByWallet = async () => ({
    pools: [
      v4Pool({ identifier: '1', liquidity: '0' }),
      v4Pool({ identifier: '2', hooks: LIQUIDITY_DELTA_HOOK, currentValueUsd: 900 }),
      v4Pool({ identifier: '3', currentValueUsd: 100 }),
    ],
  });
  const result = await service.listCandidates({ userId: 1, network: 'robinhood', walletAddress: WALLET });
  assert.deepEqual(result.candidates.map((c) => c.position.identifier), ['3', '2']);
  assert.deepEqual(result.warnings, []);
});

test('adoptLpSchema no acepta identidad del pool y exige cobertura habilitada en modo new', () => {
  const { adoptLpSchema } = require('../src/schemas/lp-orchestrator.schema');
  const base = { network: 'robinhood', version: 'v4', walletAddress: WALLET.toLowerCase(), positionIdentifier: 3571232 };

  const parsed = adoptLpSchema.parse({ ...base, feeTier: 500, protection: { mode: 'none' } });
  assert.equal(parsed.positionIdentifier, '3571232');
  assert.equal(parsed.feeTier, undefined);

  assert.equal(adoptLpSchema.safeParse({ ...base, protection: { mode: 'new', config: { enabled: false } } }).success, false);
  assert.equal(adoptLpSchema.safeParse({ ...base, protection: { mode: 'new', config: NEW_PROTECTION } }).success, true);
  assert.equal(adoptLpSchema.safeParse({ ...base, protection: { mode: 'other' } }).success, false);
});
