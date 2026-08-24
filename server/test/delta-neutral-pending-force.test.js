const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProtectedPoolDeltaNeutralService,
} = require('../src/services/protected-pool-delta-neutral.service');

/**
 * Regresion del caso real (proteccion 22, 2026-08-06):
 *
 *   07:44:52  un decrease de liquidez rebalancea el hedge -> min-dwell 60 s
 *   07:45:34  el usuario aumenta liquidez
 *   07:45:41  el orquestador fuerza el re-hedge (`lp_liquidity_changed`)
 *             ... 11 s ANTES de que venza el dwell -> bloqueado
 *   despues   nada: el brazo por temporizador no vencia hasta 12 h mas tarde
 *
 * La senal forzada es one-shot y se lanza desde el orquestador sin cola ni
 * reintento, asi que se perdio y la cobertura se quedo 11 h al 50%.
 */

const NOW = 1_800_000_000_000;
const PRICE = 2500;

function buildProtection(overrides = {}) {
  return {
    id: 55,
    userId: 1,
    accountId: 8,
    status: 'active',
    protectionMode: 'delta_neutral',
    inferredAsset: 'ETH',
    network: 'arbitrum',
    version: 'v3',
    positionIdentifier: '123',
    walletAddress: '0x00000000000000000000000000000000000000AA',
    poolAddress: '0x00000000000000000000000000000000000000BB',
    leverage: 7,
    rangeLowerPrice: 2000,
    rangeUpperPrice: 3000,
    priceCurrent: PRICE,
    snapshotStatus: 'ready',
    snapshotFreshAt: NOW,
    minOrderNotionalUsd: 11,
    poolSnapshot: {
      mode: 'lp_position',
      version: 'v3',
      network: 'arbitrum',
      identifier: '123',
      positionIdentifier: '123',
      owner: '0x00000000000000000000000000000000000000AA',
      creator: '0x00000000000000000000000000000000000000AA',
      poolAddress: '0x00000000000000000000000000000000000000BB',
      token0Address: '0x00000000000000000000000000000000000000CC',
      token1Address: '0x00000000000000000000000000000000000000DD',
      token0: { symbol: 'WETH', address: '0x00000000000000000000000000000000000000CC', decimals: 18 },
      token1: { symbol: 'USDC', address: '0x00000000000000000000000000000000000000DD', decimals: 6 },
      tickLower: 74000,
      tickUpper: 79000,
      liquidity: '2000000000000',
      rangeLowerPrice: 2000,
      rangeUpperPrice: 3000,
      priceCurrent: PRICE,
      currentValueUsd: 2500,
      inRange: true,
      unclaimedFees0: 0.01,
      unclaimedFees1: 12,
      snapshotFreshAt: NOW,
    },
    ...overrides,
  };
}

function buildService(protection, { onExecute, actualQty = 0.25, centerDeadZonePct } = {}) {
  const service = new ProtectedPoolDeltaNeutralService({
    ...(centerDeadZonePct != null ? { centerDeadZonePct } : {}),
    protectedPoolRepository: {
      getById: async () => protection,
      updateStrategyState: async (_userId, _id, payload) => {
        protection.strategyState = payload.strategyState;
        protection.nextEligibleAttemptAt = payload.nextEligibleAttemptAt;
        protection.cooldownReason = payload.cooldownReason;
      },
    },
    protectionDecisionLogRepository: { create: async () => {} },
    hlRegistry: {
      getOrCreate: async () => ({
        getPosition: async () => ({ coin: 'ETH', szi: String(-actualQty), leverage: { type: 'isolated', value: 7 } }),
        getClearinghouseState: async () => ({ withdrawable: '1000' }),
        getCandleSnapshot: async () => [],
      }),
    },
    getTradingService: async () => ({}),
    marketService: { getAssetContexts: async () => [] },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    hyperliquidStreamService: {
      trackProtection: () => {},
      start: () => {},
      stop: () => {},
      getMidPrice: async () => null,
      getBbo: async () => null,
      getActiveAssetCtx: async () => null,
      getClearinghouseState: async () => null,
      getDiagnostics: () => ({ enabled: false }),
    },
    rpcBudgetManager: {
      canSpend: () => ({ allowed: true, snapshot: null }),
      getSnapshot: () => null,
      record: () => {},
    },
  });
  service._fetchSpot = async () => ({ priceCurrent: PRICE });
  // Aisla la ejecucion: aqui interesa SI se decide ejecutar, no el envio real.
  service._executeRebalance = async ({ strategyState, reason, metrics }) => {
    onExecute?.(reason, { metrics, strategyState });
    return { ...strategyState, lastRebalanceReason: reason, executed: true };
  };
  return service;
}

const dwellActiveState = () => ({
  minDwellUntil: Date.now() + 30_000,
  lastRebalanceAt: Date.now() - 30_000,
  lastSnapshotPrice: PRICE,
  modelConfidence: 'high',
});

test('una senal forzada bloqueada por el min-dwell queda pendiente, no se pierde', async () => {
  const protection = buildProtection({ strategyState: dwellActiveState() });
  let ejecutado = null;
  const service = buildService(protection, { onExecute: (reason) => { ejecutado = reason; } });

  const state = await service.evaluateProtection(protection, {
    forceReason: 'lp_liquidity_changed',
    forceRebalance: true,
  });

  assert.equal(ejecutado, null, 'el min-dwell sigue bloqueando la ejecucion inmediata');
  assert.equal(state.lastDecisionReason, 'min_dwell_active');
  assert.equal(state.pendingForceReason, 'lp_liquidity_changed', 'la senal tiene que sobrevivir al dwell');
  assert.equal(
    Number(state.nextEligibleAttemptAt),
    Number(protection.strategyState.minDwellUntil),
    'el reintento se agenda para cuando venza el dwell'
  );
});

test('al vencer el dwell la senal pendiente se cobra sola, sin que nadie la reenvie', async () => {
  const protection = buildProtection({
    strategyState: {
      ...dwellActiveState(),
      minDwellUntil: Date.now() - 1,
      pendingForceReason: 'lp_liquidity_changed',
    },
  });
  let ejecutado = null;
  const service = buildService(protection, { onExecute: (reason) => { ejecutado = reason; } });

  // Tick normal: nadie vuelve a pasar forceRebalance.
  const state = await service.evaluateProtection(protection);

  assert.equal(ejecutado, 'lp_liquidity_changed', 'el tick siguiente tiene que recoger la senal');
  assert.equal(state.pendingForceReason, null, 'la senal se consume al ejecutarla');
});

test('un rebalanceo que si se ejecuta no deja senales pendientes', async () => {
  const protection = buildProtection({
    strategyState: { ...dwellActiveState(), minDwellUntil: null },
  });
  let ejecutado = null;
  const service = buildService(protection, { onExecute: (reason) => { ejecutado = reason; } });

  const state = await service.evaluateProtection(protection, {
    forceReason: 'lp_liquidity_changed',
    forceRebalance: true,
  });

  assert.equal(ejecutado, 'lp_liquidity_changed');
  assert.equal(state.pendingForceReason ?? null, null);
});

// Un trigger por deriva/precio se vuelve a evaluar solo en el tick siguiente:
// marcarlo como pendiente lo convertiria en un forzado permanente que se salta
// las bandas de coste.
test('un trigger no forzado bloqueado por el dwell no deja nada pendiente', async () => {
  const protection = buildProtection({ strategyState: dwellActiveState() });
  const service = buildService(protection);

  const state = await service.evaluateProtection(protection);

  assert.equal(state.pendingForceReason ?? null, null);
});

test('un minimo de orden migrado nulo no restaura el viejo piso de $50', async () => {
  const protection = buildProtection({
    minOrderNotionalUsd: null,
    strategyState: {
      lastRebalanceAt: Date.now() - (13 * 60 * 60_000),
      lastSnapshotPrice: PRICE,
      modelConfidence: 'high',
    },
  });
  let ejecutado = null;
  // El modelo da un target de ~$15 y el short observado vale $0.25: el drift
  // supera $11, pero sigue claramente por debajo del viejo piso de $50.
  const service = buildService(protection, {
    actualQty: 0.0001,
    onExecute: (reason) => { ejecutado = reason; },
    // Este caso mide el PISO de notional, no la zona muerta: con el precio en
    // 2500 sobre un rango 2000-3000 el LP esta en el centro, y la zona central
    // por defecto congelaria el brazo por temporizador antes de llegar a el.
    centerDeadZonePct: 0,
  });

  const state = await service.evaluateProtection(protection);

  assert.equal(ejecutado, 'timer_and_drift');
  assert.equal(state.lastDecision, 'rebalance_full');
  assert.equal(state.executed, true);
});

test('net_profit_v1 live ejecuta su ajuste parcial, no el target por zonas legacy', async () => {
  const protection = buildProtection({
    policyVersion: 'net_profit_v1',
    targetHedgeRatio: 0.6,
    strategyState: {
      lastRebalanceAt: Date.now() - (13 * 60 * 60_000),
      lastSnapshotPrice: PRICE,
      modelConfidence: 'high',
      executionIntent: 'live',
      policyVersion: 'net_profit_v1',
    },
  });
  let execution = null;
  const service = buildService(protection, {
    actualQty: 0.0001,
    onExecute: (reason, context) => { execution = { reason, ...context }; },
    // Idem: aqui se mide el tamano del ajuste de net_profit_v1, no el gate de
    // la zona central (que tambien aplica a esta politica).
    centerDeadZonePct: 0,
  });

  const state = await service.evaluateProtection(protection);

  assert.equal(execution.reason, 'net_profit_v1');
  assert.ok(execution.metrics.targetQty > 0.0001);
  assert.ok(execution.metrics.targetQty < execution.metrics.deltaQty,
    'la orden debe ser el ajuste parcial y no el delta completo');
  assert.equal(state.executed, true);
});

test('net_profit_v2 live ejecuta el ajuste parcial y conserva su identidad', async () => {
  const protection = buildProtection({
    policyVersion: 'net_profit_v2',
    targetHedgeRatio: 0.6,
    strategyState: {
      lastRebalanceAt: Date.now() - (13 * 60 * 60_000),
      lastSnapshotPrice: PRICE,
      modelConfidence: 'high',
      executionIntent: 'live',
      policyVersion: 'net_profit_v2',
    },
  });
  let execution = null;
  const service = buildService(protection, {
    actualQty: 0.0001,
    onExecute: (reason, context) => { execution = { reason, ...context }; },
    centerDeadZonePct: 0,
  });

  const state = await service.evaluateProtection(protection);

  assert.equal(execution.reason, 'net_profit_v2');
  assert.ok(execution.metrics.targetQty > 0.0001);
  assert.ok(execution.metrics.targetQty < execution.metrics.deltaQty);
  assert.equal(state.executed, true);
});
