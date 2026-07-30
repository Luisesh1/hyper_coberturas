const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProtectedPoolDeltaNeutralService,
} = require('../src/services/protected-pool-delta-neutral.service');
const config = require('../src/config');

// Set histórico de multiplicadores (center sub-cubre al 60%). Se inyecta
// explícitamente en vez de leerse de la config: los multiplicadores vigentes
// se overridean por env (DELTA_NEUTRAL_ZONE_MULT_*), asi que un test que
// asuma un valor concreto verificaria el .env de la maquina, no la lógica.
const HISTORIC_MULTIPLIERS = { center: 0.6, transition: 0.85, edge: 1 };

// Snapshot mínimo eligible (WETH/USDC) para ejercitar _buildDigitalTwin.
function buildSnapshotProtection(overrides = {}) {
  return {
    id: 77,
    userId: 1,
    targetHedgeRatio: 1,
    rangeLowerPrice: 2000,
    rangeUpperPrice: 3000,
    priceCurrent: 2500,
    poolSnapshot: {
      version: 'v3',
      network: 'arbitrum',
      identifier: '123',
      token0: { symbol: 'WETH', address: '0x' + 'C'.repeat(40), decimals: 18 },
      token1: { symbol: 'USDC', address: '0x' + 'D'.repeat(40), decimals: 6 },
      tickLower: 74000,
      tickUpper: 79000,
      liquidity: '2000000000000',
      rangeLowerPrice: 2000,
      rangeUpperPrice: 3000,
      priceCurrent: 2500,
      currentValueUsd: 2500,
      inRange: true,
    },
    ...overrides,
  };
}

test('_zoneMultiplier mapea cada zona a su multiplicador (outside cae en edge)', () => {
  const service = new ProtectedPoolDeltaNeutralService({
    zoneHedgeMultipliers: HISTORIC_MULTIPLIERS,
  });
  assert.equal(service._zoneMultiplier('center'), 0.6);
  assert.equal(service._zoneMultiplier('transition'), 0.85);
  assert.equal(service._zoneMultiplier('edge'), 1);
  // 'outside' no tiene multiplicador propio: cubre igual que 'edge' (100%).
  assert.equal(service._zoneMultiplier('outside'), 1);
});

test('sin multiplicadores inyectados, el servicio toma los de la config', () => {
  const service = new ProtectedPoolDeltaNeutralService();
  // Verifica el cableado constructor→config, NO un valor concreto: el valor
  // vigente es operativo (se ajusta por env sin tocar código).
  assert.equal(service._zoneMultiplier('center'), config.deltaNeutral.zoneHedgeMultiplierCenter);
  assert.equal(service._zoneMultiplier('transition'), config.deltaNeutral.zoneHedgeMultiplierTransition);
  assert.equal(service._zoneMultiplier('edge'), config.deltaNeutral.zoneHedgeMultiplierEdge);
});

test('_zoneMultiplier respeta multiplicadores inyectados', () => {
  const service = new ProtectedPoolDeltaNeutralService({
    zoneHedgeMultipliers: { center: 1, transition: 1, edge: 1 },
  });
  assert.equal(service._zoneMultiplier('center'), 1);
  assert.equal(service._zoneMultiplier('transition'), 1);
});

test('_zoneMultiplier acepta un set alternativo explícito (shadow)', () => {
  const service = new ProtectedPoolDeltaNeutralService();
  const shadow = { center: 1, transition: 1, edge: 1 };
  assert.equal(service._zoneMultiplier('center', shadow), 1);
  assert.equal(service._zoneMultiplier('transition', shadow), 1);
});

test('_buildDigitalTwin sin shadowMode no computa shadowTargetQty', () => {
  const service = new ProtectedPoolDeltaNeutralService({ shadowMode: false });
  const twin = service._buildDigitalTwin(buildSnapshotProtection(), { hlPrice: 2500 });
  assert.equal(twin.eligible, true);
  assert.equal(twin.shadowTargetQty, null);
});

test('shadowMode con multiplicador center=1 produce un target mayor (más cobertura) que el vigente 0.6', () => {
  const service = new ProtectedPoolDeltaNeutralService({
    shadowMode: true,
    zoneHedgeMultipliers: HISTORIC_MULTIPLIERS,
    shadowZoneHedgeMultipliers: { center: 1, transition: 1, edge: 1 },
  });
  // precio 2500 está deep-in-range (>2% del borde) → zona 'center'.
  const twin = service._buildDigitalTwin(buildSnapshotProtection(), { hlPrice: 2500 });
  assert.equal(twin.eligible, true);
  assert.equal(twin.zoneState, 'center');
  assert.ok(twin.targetQty > 0, 'targetQty vigente debe ser positivo');
  assert.ok(twin.shadowTargetQty > twin.targetQty,
    `shadowTargetQty (${twin.shadowTargetQty}) debe superar el target vigente (${twin.targetQty})`);
  // El shadow al 100% debe ser ~ target/0.6 (ratio de multiplicadores).
  const ratio = twin.shadowTargetQty / twin.targetQty;
  assert.ok(ratio > 1.6 && ratio < 1.7, `ratio esperado ~1.667, fue ${ratio}`);
});
