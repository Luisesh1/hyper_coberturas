const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveCenterDeadZone,
  rangePositionFraction,
  DEFAULT_CENTER_DEAD_ZONE_PCT,
  MAX_CENTER_DEAD_ZONE_PCT,
} = require('../src/services/protected-pool-delta-neutral.helpers');

// Rango simetrico en espacio log alrededor de 100.
const RANGE = { rangeLowerPrice: 90, rangeUpperPrice: 110 };

test('la posicion en el rango se mide en espacio logaritmico', () => {
  // El centro real de un rango de ticks es el medio GEOMETRICO, no el
  // aritmetico: con 90-110 son 99.4987..., no 100.
  const geometricMid = Math.sqrt(90 * 110);
  assert.ok(Math.abs(rangePositionFraction(RANGE, geometricMid) - 0.5) < 1e-12);
  assert.equal(rangePositionFraction(RANGE, 90), 0);
  assert.equal(rangePositionFraction(RANGE, 110), 1);
  // Fuera de rango no hay fraccion que reportar.
  assert.equal(rangePositionFraction(RANGE, 89.9), null);
  assert.equal(rangePositionFraction(RANGE, 110.1), null);
});

test('el default congela el 40% central del rango', () => {
  const mid = Math.sqrt(90 * 110);
  const zone = resolveCenterDeadZone(RANGE, mid, undefined);
  assert.equal(zone.pct, DEFAULT_CENTER_DEAD_ZONE_PCT);
  assert.equal(zone.active, true);

  // Justo dentro del borde de la zona (30% del rango) sigue congelado.
  const lower = Math.min(RANGE.rangeLowerPrice, RANGE.rangeUpperPrice);
  const upper = Math.max(RANGE.rangeLowerPrice, RANGE.rangeUpperPrice);
  const priceAt = (fraction) => lower * ((upper / lower) ** fraction);
  assert.equal(resolveCenterDeadZone(RANGE, priceAt(0.31), undefined).active, true);
  assert.equal(resolveCenterDeadZone(RANGE, priceAt(0.69), undefined).active, true);
  // Y fuera de ella se vuelve a operar.
  assert.equal(resolveCenterDeadZone(RANGE, priceAt(0.29), undefined).active, false);
  assert.equal(resolveCenterDeadZone(RANGE, priceAt(0.71), undefined).active, false);
});

test('fuera de rango nunca es zona muerta: ahi el LP esta 100% de un lado', () => {
  assert.equal(resolveCenterDeadZone(RANGE, 80, 40).active, false);
  assert.equal(resolveCenterDeadZone(RANGE, 130, 40).active, false);
});

// El 0 tiene que ser un valor de PRIMERA CLASE, no "ausente": es como el
// usuario apaga la zona muerta. Con un `|| DEFAULT` se le colaria el 40%.
test('cero desactiva la zona; el valor de la proteccion pisa al default', () => {
  const mid = Math.sqrt(90 * 110);
  assert.equal(resolveCenterDeadZone({ ...RANGE, centerDeadZonePct: 0 }, mid, 40).active, false);
  assert.equal(resolveCenterDeadZone({ ...RANGE, centerDeadZonePct: 80 }, mid, 0).active, true);
  // Sin valor propio manda el default del servicio.
  assert.equal(resolveCenterDeadZone(RANGE, mid, 0).active, false);
});

test('el ancho se clampea al techo y nunca es negativo', () => {
  const mid = Math.sqrt(90 * 110);
  assert.equal(resolveCenterDeadZone({ ...RANGE, centerDeadZonePct: 200 }, mid, 40).pct, MAX_CENTER_DEAD_ZONE_PCT);
  assert.equal(resolveCenterDeadZone({ ...RANGE, centerDeadZonePct: -5 }, mid, 40).pct, 0);
});

test('un rango invalido no congela la cobertura', () => {
  assert.equal(resolveCenterDeadZone({ rangeLowerPrice: 0, rangeUpperPrice: 0 }, 100, 40).active, false);
  assert.equal(resolveCenterDeadZone({}, 100, 40).active, false);
  assert.equal(resolveCenterDeadZone(RANGE, null, 40).active, false);
});


// ── Integracion: el gate dentro del motor ──────────────────────────────────
// Los tests de arriba miden la funcion pura; estos comprueban que
// `shouldRebalance` la respeta y, sobre todo, que las rutas de seguridad se la
// saltan. Una zona muerta que tape un hedge huerfano o un cierre seria mucho
// peor que el churn que viene a evitar.

const {
  ProtectedPoolDeltaNeutralService,
} = require('../src/services/protected-pool-delta-neutral.service');

const PRICE = 2500;

// Rango 2000-3000 con el precio en 2500: fraccion logaritmica 0.55, o sea
// dentro del 40% central (0.30-0.70).
function buildProtection(overrides = {}) {
  return {
    id: 77,
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
    snapshotFreshAt: Date.now(),
    minOrderNotionalUsd: 11,
    strategyState: {
      lastRebalanceAt: Date.now() - (13 * 60 * 60_000),
      lastSnapshotPrice: PRICE,
      modelConfidence: 'high',
    },
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
      snapshotFreshAt: Date.now(),
    },
    ...overrides,
  };
}

function buildService(protection, { onExecute, actualQty = 0.0001, centerDeadZonePct } = {}) {
  const service = new ProtectedPoolDeltaNeutralService({
    ...(centerDeadZonePct != null ? { centerDeadZonePct } : {}),
    protectedPoolRepository: {
      getById: async () => protection,
      updateStrategyState: async (_userId, _id, payload) => {
        protection.strategyState = payload.strategyState;
      },
    },
    protectionDecisionLogRepository: { create: async () => {} },
    hlRegistry: {
      getOrCreate: async () => ({
        getPosition: async () => (actualQty == null
          ? null
          : { coin: 'ETH', szi: String(-actualQty), leverage: { type: 'isolated', value: 7 } }),
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
  service._executeRebalance = async ({ strategyState, reason }) => {
    onExecute?.(reason);
    return { ...strategyState, lastRebalanceReason: reason, executed: true };
  };
  return service;
}

test('con el precio en el centro del rango, el brazo por temporizador no ejecuta', async () => {
  const protection = buildProtection();
  let ejecutado = null;
  const service = buildService(protection, { onExecute: (reason) => { ejecutado = reason; } });

  await service.evaluateProtection(protection);

  assert.equal(ejecutado, null, 'la zona central por defecto tiene que frenar el rebalanceo');
});

test('el mismo caso con la zona desactivada si rebalancea', async () => {
  const protection = buildProtection();
  let ejecutado = null;
  const service = buildService(protection, {
    onExecute: (reason) => { ejecutado = reason; },
    centerDeadZonePct: 0,
  });

  await service.evaluateProtection(protection);

  assert.equal(ejecutado, 'timer_and_drift');
});

// La zona muerta es una preferencia de COSTO. Nunca puede dejar capital
// descubierto ni bloquear una salida: si lo hiciera seria un bug de riesgo,
// no de churn.
test('un forzado (cambio de liquidez, cierre) atraviesa la zona muerta', async () => {
  const protection = buildProtection();
  let ejecutado = null;
  const service = buildService(protection, { onExecute: (reason) => { ejecutado = reason; } });

  await service.evaluateProtection(protection, {
    forceReason: 'lp_liquidity_changed',
    forceRebalance: true,
  });

  assert.equal(ejecutado, 'lp_liquidity_changed');
});

test('un hedge huerfano se re-abre aunque el precio este en la zona muerta', async () => {
  const protection = buildProtection();
  let ejecutado = null;
  // Sin posicion en Hyperliquid pero con target > 0: capital descubierto.
  const service = buildService(protection, {
    actualQty: null,
    onExecute: (reason) => { ejecutado = reason; },
  });

  await service.evaluateProtection(protection);

  assert.equal(ejecutado, 'restart_reconcile');
});

test('fuera del centro (cerca del borde) la cobertura vuelve a operar', async () => {
  // 2100 sobre 2000-3000 es fraccion 0.12: fuera del 40% central.
  const protection = buildProtection({
    priceCurrent: 2100,
    poolSnapshot: { ...buildProtection().poolSnapshot, priceCurrent: 2100 },
  });
  let ejecutado = null;
  const service = buildService(protection, { onExecute: (reason) => { ejecutado = reason; } });
  service._fetchSpot = async () => ({ priceCurrent: 2100 });

  await service.evaluateProtection(protection);

  assert.ok(ejecutado, 'cerca del borde el gate no debe aplicar');
});
