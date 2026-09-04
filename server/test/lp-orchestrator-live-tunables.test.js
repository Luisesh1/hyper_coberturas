const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeLiveTunables,
  MAX_CENTER_DEAD_ZONE_PCT,
} = require('../src/services/uniswap-protection.service');
const { resolveCenterDeadZone } = require('../src/services/protected-pool-delta-neutral.helpers');
const { LpOrchestratorService } = require('../src/services/lp-orchestrator.service');

const PROTECCION_VIVA = 77;

function buildService({ orchestrator, tunableWrites, configWrites = [], logs = [] }) {
  return new LpOrchestratorService({
    lpOrchestratorRepository: {
      getById: async () => orchestrator,
      updateConfig: async (userId, id, patch) => { configWrites.push(patch); },
      appendActionLog: async (entry) => { logs.push(entry); },
    },
    protectedPoolRepository: {
      updateTunables: async (userId, id, patch) => { tunableWrites.push({ id, patch }); return id; },
    },
    uniswapProtectionService: { normalizeLiveTunables },
  });
}

function orchestrator(overrides = {}) {
  return {
    id: 45,
    userId: 1,
    status: 'active',
    activeProtectedPoolId: PROTECCION_VIVA,
    strategyConfig: { rangeWidthPct: 10 },
    protectionConfig: { enabled: true, accountId: 1, centerDeadZonePct: 40 },
    ...overrides,
  };
}

// ESTE es el bug reportado: se reajusta la zona muerta en el orquestador y ni
// el hedge ni la grafica cambian. `updateConfig` reescribia el JSON del
// orquestador —la INTENCION— y no tocaba la proteccion vinculada, que es la
// que el tick relee entera en cada iteracion. Ningun error, ninguna traza.
test('reajustar la zona muerta llega a la proteccion que esta operando', async () => {
  const tunableWrites = [];
  const service = buildService({ orchestrator: orchestrator(), tunableWrites });

  await service.updateConfig({
    userId: 1,
    orchestratorId: 45,
    protectionConfig: { enabled: true, accountId: 1, centerDeadZonePct: 55 },
  });

  assert.equal(tunableWrites.length, 1);
  assert.equal(tunableWrites[0].id, PROTECCION_VIVA);
  assert.equal(tunableWrites[0].patch.centerDeadZonePct, 55);
});

// El valor escrito tiene que ser el que el motor lee, o el arreglo solo mueve
// el problema un paso mas adelante.
test('lo que se persiste es exactamente lo que el tick resuelve', () => {
  const { patch } = { patch: normalizeLiveTunables({ centerDeadZonePct: 55 }) };
  const resuelto = resolveCenterDeadZone(
    { centerDeadZonePct: patch.centerDeadZonePct, rangeLowerPrice: 2000, rangeUpperPrice: 3000 },
    2449.5,
    40
  );
  assert.equal(resuelto.pct, 55);
});

test('el resto de los parametros en caliente viajan en la misma edicion', async () => {
  const tunableWrites = [];
  const service = buildService({ orchestrator: orchestrator(), tunableWrites });

  await service.updateConfig({
    userId: 1,
    orchestratorId: 45,
    protectionConfig: {
      enabled: true,
      accountId: 1,
      centerDeadZonePct: 20,
      maxSlippageBps: 25,
      bandMode: 'fixed',
      baseRebalancePriceMovePct: 2,
      rebalanceIntervalSec: 3600,
      minRebalanceNotionalPct: 15,
    },
  });

  assert.deepEqual(tunableWrites[0].patch, {
    bandMode: 'fixed',
    baseRebalancePriceMovePct: 2,
    rebalanceIntervalSec: 3600,
    minRebalanceNotionalPct: 15,
    centerDeadZonePct: 20,
    maxSlippageBps: 25,
  });
});

// Lo que NO se puede reajustar bajo una cobertura viva no se aplica a medias:
// mueven margen, ordenes o el motor con su estado a media vida.
test('apalancamiento, notional y politica no se cuelan como reajuste en caliente', async () => {
  const tunableWrites = [];
  const service = buildService({ orchestrator: orchestrator(), tunableWrites });

  await service.updateConfig({
    userId: 1,
    orchestratorId: 45,
    protectionConfig: {
      enabled: true,
      accountId: 9,
      leverage: 20,
      configuredNotionalUsd: 900,
      policyVersion: 'range_exit_v1',
      executionIntent: 'live',
    },
  });

  assert.equal(tunableWrites.length, 0, 'nada de eso se puede aplicar en caliente');
});

test('sin cobertura vinculada no hay nada que reajustar, y no revienta', async () => {
  const tunableWrites = [];
  const service = buildService({
    orchestrator: orchestrator({ activeProtectedPoolId: null }),
    tunableWrites,
  });

  await service.updateConfig({
    userId: 1,
    orchestratorId: 45,
    protectionConfig: { enabled: true, accountId: 1, centerDeadZonePct: 55 },
  });

  assert.equal(tunableWrites.length, 0);
});

test('apagar la proteccion no reajusta la que sigue viva', async () => {
  // `enabled: false` es una baja, no una edicion de parametros: aplicarle el
  // patch dejaria la cobertura operando con valores nuevos justo cuando lo que
  // se pidio fue dejar de cubrir.
  const tunableWrites = [];
  const service = buildService({ orchestrator: orchestrator(), tunableWrites });

  await service.updateConfig({
    userId: 1,
    orchestratorId: 45,
    protectionConfig: { enabled: false },
  });

  assert.equal(tunableWrites.length, 0);
});

test('la bitacora distingue lo que cambio el comportamiento de lo que no', async () => {
  const logs = [];
  const tunableWrites = [];
  const service = buildService({ orchestrator: orchestrator(), tunableWrites, logs });

  await service.updateConfig({
    userId: 1,
    orchestratorId: 45,
    protectionConfig: { enabled: true, accountId: 1, centerDeadZonePct: 55 },
  });

  assert.deepEqual(logs[0].payload.appliedToHedge, ['centerDeadZonePct']);
  assert.equal(logs[0].payload.protectedPoolId, PROTECCION_VIVA);
});

// El tope existia pero no se aplicaba: las dos constantes se importaban de un
// modulo que no las exporta, asi que valian `undefined` y `parsed > undefined`
// es siempre false. Cualquier valor entraba.
test('el tope de la zona muerta se valida de verdad', () => {
  assert.equal(MAX_CENTER_DEAD_ZONE_PCT, 90);
  assert.throws(() => normalizeLiveTunables({ centerDeadZonePct: 500 }), /entre 0 y 90/);
  assert.throws(() => normalizeLiveTunables({ centerDeadZonePct: -1 }), /entre 0 y 90/);
  // 0 es valido y significa "sin zona muerta", que no es lo mismo que ausente.
  assert.deepEqual(normalizeLiveTunables({ centerDeadZonePct: 0 }), { centerDeadZonePct: 0 });
});
