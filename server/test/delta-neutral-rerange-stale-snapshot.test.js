const test = require('node:test');
const assert = require('node:assert/strict');

const timeInRangeService = require('../src/services/time-in-range.service');
const { ProtectedPoolRefreshService } = require('../src/services/protected-pool-refresh.service');
const {
  ProtectedPoolDeltaNeutralService,
} = require('../src/services/protected-pool-delta-neutral.service');

/**
 * Regresion del re-range erratico: un modify-range migra la proteccion del
 * tokenId viejo (123) al nuevo (999) mientras un refresco que arranco con el
 * viejo sigue leyendo on-chain. Antes, ese refresco escribia al final el
 * rango y la liquidez del LP viejo sobre la fila ya migrada: liquidez 0 (el
 * hedge se cerraba y el LP quedaba descubierto) o el rango anterior fuera de
 * precio (100% volatil: el hedge se sobredimensionaba).
 */

const OLD_ID = '123';
const NEW_ID = '999';

const silentLogger = () => {
  const warns = [];
  return {
    warns,
    info: () => {},
    error: () => {},
    warn: (event, payload) => warns.push({ event, payload }),
  };
};

function oldPositionPool() {
  return {
    identifier: OLD_ID,
    poolAddress: '0xpool',
    token0: { symbol: 'WETH' },
    token1: { symbol: 'USDC' },
    rangeLowerPrice: 2000,
    rangeUpperPrice: 2400,
    priceCurrent: 2600,
    liquidity: '0',
    inRange: false,
  };
}

// Repo en memoria con la misma guarda que el SQL: la escritura solo aplica si
// la fila sigue apuntando a la posicion de la que salio el snapshot.
function makeGuardedRepo(row) {
  const calls = { updateSnapshot: [], updateStrategyState: [] };
  return {
    row,
    calls,
    getById: async () => ({ ...row }),
    updateSnapshot: async (_userId, _id, record) => {
      calls.updateSnapshot.push(record);
      if (record.expectedPositionIdentifier != null
          && String(record.expectedPositionIdentifier) !== String(row.positionIdentifier)) {
        return null;
      }
      Object.assign(row, {
        rangeLowerPrice: record.rangeLowerPrice,
        rangeUpperPrice: record.rangeUpperPrice,
        poolSnapshot: record.poolSnapshot,
      });
      return row.id;
    },
    updateStrategyState: async (_userId, _id, payload) => {
      calls.updateStrategyState.push(payload);
      row.strategyState = payload.strategyState;
      return row.id;
    },
  };
}

function migratedRow() {
  return {
    id: 7,
    userId: 1,
    status: 'active',
    network: 'arbitrum',
    version: 'v3',
    walletAddress: '0xabc',
    positionIdentifier: NEW_ID,
    rangeLowerPrice: 2500,
    rangeUpperPrice: 2700,
    poolSnapshot: { identifier: NEW_ID, liquidity: '5000', rangeLowerPrice: 2500, rangeUpperPrice: 2700 },
    strategyState: { status: 'tracking', lastTruthAt: 1 },
  };
}

function staleView(row) {
  return {
    ...row,
    positionIdentifier: OLD_ID,
    rangeLowerPrice: 2000,
    rangeUpperPrice: 2400,
    poolSnapshot: { identifier: OLD_ID, liquidity: '4000', rangeLowerPrice: 2000, rangeUpperPrice: 2400 },
  };
}

test('refresco periodico no pisa una proteccion migrada a otro tokenId', async () => {
  const row = migratedRow();
  const repo = makeGuardedRepo(row);
  const logger = silentLogger();
  const service = new ProtectedPoolRefreshService({
    refreshIntervalMs: 600000,
    logger,
    protectedPoolRepository: repo,
    timeInRangeService: {
      computeIncrementalRangeMetrics: async () => null,
      applyRangeMetricsToSnapshot: (snapshot) => snapshot,
    },
    uniswapService: {
      scanPoolsCreatedByWallet: async () => ({ pools: [oldPositionPool()] }),
    },
  });

  // La lista de activos se leyo ANTES de la migracion: trae el tokenId viejo.
  await service.refreshGroup({
    userId: 1, walletAddress: '0xabc', network: 'arbitrum', version: 'v3',
    items: [staleView(row)],
  });

  assert.equal(repo.calls.updateSnapshot.length, 1);
  assert.equal(repo.calls.updateSnapshot[0].expectedPositionIdentifier, OLD_ID);
  assert.equal(row.rangeLowerPrice, 2500, 'el rango del LP nuevo se conserva');
  assert.equal(row.poolSnapshot.liquidity, '5000', 'la liquidez del LP nuevo se conserva');
  assert.ok(logger.warns.some((w) => w.event === 'protected_pool_refresh_stale_identity_skipped'));
});

test('verdad on-chain de un tokenId ya migrado devuelve la fila vigente sin tocar el estado', async (t) => {
  t.mock.method(timeInRangeService, 'computeIncrementalRangeMetrics', async () => null);
  const row = migratedRow();
  const repo = makeGuardedRepo(row);
  const logger = silentLogger();
  const service = new ProtectedPoolDeltaNeutralService({
    protectedPoolRepository: repo,
    logger,
    rpcBudgetManager: { canSpend: () => ({ allowed: true }), record: () => {}, getSnapshot: () => null },
    uniswapService: {
      inspectPositionByIdentifier: async ({ positionIdentifier }) => {
        assert.equal(positionIdentifier, OLD_ID);
        return oldPositionPool();
      },
    },
  });

  const result = await service._refreshProtectionTruth(staleView(row), { reason: 'normal_truth_refresh' });

  assert.equal(result.staleIdentity, true);
  assert.equal(result.refreshed, false);
  assert.equal(result.protection.positionIdentifier, NEW_ID, 'la evaluacion sigue con el LP nuevo');
  assert.equal(row.poolSnapshot.liquidity, '5000');
  assert.equal(repo.calls.updateStrategyState.length, 0,
    'no se persiste estado con el strategyState leido antes de la migracion');
  assert.ok(logger.warns.some((w) => w.event === 'protected_pool_truth_stale_identity'));
});

test('verdad on-chain por full scan tambien respeta la migracion', async (t) => {
  t.mock.method(timeInRangeService, 'computeIncrementalRangeMetrics', async () => null);
  const row = migratedRow();
  const repo = makeGuardedRepo(row);
  const service = new ProtectedPoolDeltaNeutralService({
    protectedPoolRepository: repo,
    logger: silentLogger(),
    rpcBudgetManager: { canSpend: () => ({ allowed: true }), record: () => {}, getSnapshot: () => null },
    uniswapService: {
      scanPoolsCreatedByWallet: async () => ({ pools: [oldPositionPool()] }),
    },
  });

  const result = await service._refreshProtectionTruth(staleView(row), {
    reason: 'maintenance_full_scan',
    useFullScan: true,
  });

  assert.equal(result.staleIdentity, true);
  assert.equal(result.protection.positionIdentifier, NEW_ID);
  assert.equal(row.rangeUpperPrice, 2700);
  assert.equal(repo.calls.updateStrategyState.length, 0);
});

test('un forzado no se absorbe en la evaluacion en curso: corre despues', async () => {
  const service = new ProtectedPoolDeltaNeutralService({
    protectedPoolRepository: { getById: async () => null },
    logger: silentLogger(),
  });
  const runs = [];
  let releaseFirst;
  service._withProtectionEvaluationLock = (_protection, options) => {
    runs.push(options);
    if (runs.length === 1) return new Promise((resolve) => { releaseFirst = resolve; });
    return Promise.resolve('forced-done');
  };

  const protection = { id: 7 };
  const inFlight = service.evaluateProtection(protection, { forceReason: 'boundary_watch' });
  const sameTick = service.evaluateProtection(protection, {});
  const forced = service.evaluateProtection(protection, {
    forceReason: 'lp_range_changed',
    forceRebalance: true,
  });

  assert.equal(runs.length, 1, 'el forzado espera a que termine la evaluacion en curso');

  releaseFirst('first-done');
  assert.equal(await inFlight, 'first-done');
  assert.equal(await sameTick, 'first-done', 'un tick normal sigue reusando la evaluacion en curso');
  assert.equal(await forced, 'forced-done');
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1], { forceReason: 'lp_range_changed', forceRebalance: true });
});

// --- Migracion sin foto del LP nuevo -----------------------------------------
//
// Si `finalize` no consigue leer la posicion nueva (RPC caido, indexado lento),
// la migracion conserva el `poolSnapshot` del LP viejo bajo el tokenId nuevo.
// El validador no compara identificadores, asi que esa fila pasaba como
// `ready` y el hedge se dimensionaba contra el LP que ya no existe.

const protectedPoolRepo = require('../src/repositories/protected-uniswap-pool.repository');
const protectedPoolRefreshService = require('../src/services/protected-pool-refresh.service');
const { updateProtectionRecords } = require('../src/services/uniswap/actions/finalize');

async function migrateWith(t, refreshedSnapshot) {
  const migrations = [];
  t.mock.method(protectedPoolRepo, 'findByPositionIdentifier', async () => [{ id: 7, userId: 1 }]);
  t.mock.method(protectedPoolRepo, 'updateOnchainOperation', async () => 7);
  t.mock.method(protectedPoolRepo, 'migratePositionIdentity', async (_userId, _id, record) => {
    migrations.push(record);
    return 7;
  });
  t.mock.method(protectedPoolRefreshService, 'refreshUser', async () => {});
  await updateProtectionRecords({
    userId: 1,
    action: 'modify-range',
    network: 'arbitrum',
    version: 'v3',
    walletAddress: '0xabc',
    oldPositionIdentifier: OLD_ID,
    newPositionIdentifier: NEW_ID,
    txHashes: ['0x1'],
    refreshedSnapshot,
  });
  assert.equal(migrations.length, 1);
  return migrations[0];
}

test('migrar sin snapshot del LP nuevo deja la fila pendiente de relectura', async (t) => {
  const record = await migrateWith(t, null);
  assert.equal(record.positionIdentifier, NEW_ID);
  assert.equal(record.snapshotStatus, 'refresh_pending');
});

test('migrar con snapshot del LP nuevo no toca el estado del snapshot', async (t) => {
  const record = await migrateWith(t, { identifier: NEW_ID, rangeLowerPrice: 2500, rangeUpperPrice: 2700 });
  assert.equal(record.snapshotStatus, null);
  assert.equal(record.rangeLowerPrice, 2500);
});

function pendingRefreshService(row, { refreshResult }) {
  const decisions = [];
  const service = new ProtectedPoolDeltaNeutralService({
    protectedPoolRepository: { getById: async () => ({ ...row }) },
    logger: silentLogger(),
  });
  service._persistDecision = async (_protection, decision) => { decisions.push(decision); };
  service._refreshProtectionTruth = async (protection) => refreshResult(protection);
  service.getTradingService = async () => {
    throw new Error('no debe llegar a operar con la foto del LP viejo');
  };
  return { service, decisions };
}

test('el motor no opera con una fila migrada pendiente si la relectura falla', async () => {
  const row = {
    ...migratedRow(),
    protectionMode: 'delta_neutral',
    snapshotStatus: 'refresh_pending',
    // La foto heredada del LP viejo, completa y valida en apariencia.
    poolSnapshot: staleView(migratedRow()).poolSnapshot,
  };
  const { service, decisions } = pendingRefreshService(row, {
    refreshResult: (protection) => ({ protection, refreshed: false, failed: true }),
  });

  const result = await service._evaluateProtectionUnlocked(row, {
    forceReason: 'lp_range_changed',
    forceRebalance: true,
  });

  assert.equal(result, null);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].reason, 'snapshot_refresh_pending');
  assert.equal(decisions[0].executionSkippedBecause, 'snapshot_refresh_pending');
});

test('con la relectura del LP nuevo exitosa el motor sigue evaluando', async () => {
  const row = {
    ...migratedRow(),
    protectionMode: 'delta_neutral',
    snapshotStatus: 'refresh_pending',
    poolSnapshot: staleView(migratedRow()).poolSnapshot,
  };
  const { service, decisions } = pendingRefreshService(row, {
    refreshResult: (protection) => ({ protection: { ...protection, snapshotStatus: 'ready' }, refreshed: true }),
  });
  // El primer paso tras la compuerta es pedir la cuenta de Hyperliquid: llegar
  // ahi prueba que la fila ya no se retiene.
  service._normalizeSnapshot = () => ({ validation: { valid: true, status: 'ready', reasons: [] } });
  service.hlRegistry = { getOrCreate: async () => { throw new Error('paso_la_compuerta'); } };

  await assert.rejects(
    service._evaluateProtectionUnlocked(row, { forceReason: 'lp_range_changed', forceRebalance: true }),
    /paso_la_compuerta/,
  );
  assert.equal(decisions.length, 0);
});
