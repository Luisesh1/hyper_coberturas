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
