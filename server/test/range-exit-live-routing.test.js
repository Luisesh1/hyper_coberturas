const test = require('node:test');
const assert = require('node:assert/strict');

const { RANGE_EXIT_V1 } = require('../src/services/range-exit-policy.service');
const {
  policyOwnsFullDelta,
  FULL_DELTA_POLICIES,
  resolveProtectionLivePolicy,
  policyHonorsCenterDeadZone,
  resolveNoOpZone,
  resolveCenterDeadZone,
} = require('../src/services/protected-pool-delta-neutral.helpers');
const { resolveLivePolicy, resolveShadowPolicies, ALL_POLICIES } = require('../src/services/protected-pool-delta-neutral/shadow-policies');
const { protectionConfigSchema } = require('../src/schemas/lp-orchestrator.schema');

test('range_exit_v1 vive sobre el 100% del delta cuando ejecuta', () => {
  // ESTE es el test que importa. Si la politica corre viva sin estar en la
  // lista, `pricing.js` le aplica `zoneMultiplier` y la sub-cubre en silencio
  // —hasta un 40% en centro con los defaults historicos—: el selector diria
  // "borde de rango" y el hedge haria otra cosa.
  assert.ok(FULL_DELTA_POLICIES.includes(RANGE_EXIT_V1));
  assert.equal(policyOwnsFullDelta(RANGE_EXIT_V1, 'live'), true);
  // En sombra no ejecuta, asi que el ratio del record no se fuerza.
  assert.equal(policyOwnsFullDelta(RANGE_EXIT_V1, 'shadow'), false);
  // Legacy nunca: es justamente la que SI escalona por zona.
  assert.equal(policyOwnsFullDelta('legacy_zones_v1', 'live'), false);
});

test('declarada live, range_exit_v1 es la politica viva y deja de simularse', () => {
  assert.equal(resolveLivePolicy({ policyVersion: RANGE_EXIT_V1, executionIntent: 'live' }), RANGE_EXIT_V1);
  // Y si es la viva, no puede estar ademas entre las sombras: se estaria
  // midiendo dos veces y una de las dos con estado distinto.
  assert.ok(!resolveShadowPolicies(RANGE_EXIT_V1).includes(RANGE_EXIT_V1));
  assert.equal(resolveShadowPolicies(RANGE_EXIT_V1).length, ALL_POLICIES.length - 1);
});

test('en sombra la viva sigue siendo legacy', () => {
  assert.equal(resolveLivePolicy({ policyVersion: RANGE_EXIT_V1, executionIntent: 'shadow' }), 'legacy_zones_v1');
});

// Payload minimo valido de una proteccion habilitada. Se comparte entre los
// dos casos para que la unica variable sea la politica.
const PROTECCION_BASE = {
  enabled: true,
  accountId: 1,
  leverage: 10,
  configuredNotionalUsd: 300,
};

test('el schema acepta range_exit_v1 y sigue rechazando lo que no existe', () => {
  const ok = protectionConfigSchema.safeParse({
    ...PROTECCION_BASE, policyVersion: 'range_exit_v1', executionIntent: 'live',
  });
  assert.equal(ok.success, true, ok.success ? '' : JSON.stringify(ok.error?.issues));

  // El enum sigue siendo un enum: una politica inventada no entra.
  const malo = protectionConfigSchema.safeParse({ ...PROTECCION_BASE, policyVersion: 'range_exit_v9' });
  assert.equal(malo.success, false);
});

// `resolveProtectionLivePolicy` es lo que el encabezado del orquestador lee
// para decir que cobertura corre. Tiene que responder igual que el tick, que
// resuelve `activeProtection.policyVersion || strategyState.policyVersion`.
test('la politica viva de una proteccion se lee con la misma precedencia que el tick', () => {
  assert.equal(resolveProtectionLivePolicy({
    policyVersion: RANGE_EXIT_V1,
    strategyState: { executionIntent: 'live' },
  }), RANGE_EXIT_V1);

  // Registros anteriores a la columna: la seleccion solo vive en el estado.
  assert.equal(resolveProtectionLivePolicy({
    policyVersion: null,
    strategyState: { policyVersion: 'net_profit_v1', executionIntent: 'live' },
  }), 'net_profit_v1');

  // Declarada pero en sombra: quien rebalancea es legacy, y eso es lo que
  // tiene que mostrar la tarjeta.
  assert.equal(resolveProtectionLivePolicy({
    policyVersion: 'net_profit_v1',
    strategyState: { executionIntent: 'shadow' },
  }), 'legacy_zones_v1');

  // Proteccion vieja sin nada declarado: legacy, que es lo que corre.
  assert.equal(resolveProtectionLivePolicy({ policyVersion: null, strategyState: null }), 'legacy_zones_v1');
  assert.equal(resolveProtectionLivePolicy(null), null);
});

// La tarjeta dibuja la zona muerta a partir de esto. Si dijera que si para
// range_exit, pintaria una restriccion que esa politica no tiene: el hedge se
// quedaria quieto en el centro segun el dibujo y en realidad cruzaria el borde
// sin mirar el centro para nada.
test('range_exit_v1 no respeta la zona muerta central; las demas si', () => {
  assert.equal(policyHonorsCenterDeadZone(RANGE_EXIT_V1), false);
  assert.equal(policyHonorsCenterDeadZone('legacy_zones_v1'), true);
  assert.equal(policyHonorsCenterDeadZone('net_profit_v1'), true);
  assert.equal(policyHonorsCenterDeadZone('net_profit_v2'), true);
  // Sin politica no hay nada corriendo, asi que no hay banda que dibujar.
  assert.equal(policyHonorsCenterDeadZone(null), false);
});

test('la zona sin operacion de range_exit_v1 es el rango entero, no una banda central', () => {
  // Su zona muerta persistida es irrelevante: dentro del rango no toca el
  // hedge en ningun caso. Dibujarle el 40% central seria pintar una
  // restriccion que no tiene y esconder la que si tiene.
  assert.deepEqual(resolveNoOpZone(RANGE_EXIT_V1, 40), { kind: 'full_range', pct: 100 });
  assert.deepEqual(resolveNoOpZone('legacy_zones_v1', 40), { kind: 'center', pct: 40 });
  assert.deepEqual(resolveNoOpZone('net_profit_v2', 0), { kind: 'none', pct: 0 });
  // Se recorta al tope que la columna acepta.
  assert.deepEqual(resolveNoOpZone('legacy_zones_v1', 500), { kind: 'center', pct: 90 });
  // Sin zona resuelta todavia (proteccion recien creada) no se inventa una.
  assert.equal(resolveNoOpZone('legacy_zones_v1', null), null);
  assert.equal(resolveNoOpZone(null, 40), null);
});

// La tarjeta tiene que resolver la zona muerta con la MISMA precedencia que el
// tick: manda la columna, el estado solo cubre la columna NULL. Al reves, un
// reajuste no se veia hasta que un tick reescribiera el estado —y con la
// proteccion en cooldown, no se veia nunca.
test('la zona muerta que muestra la tarjeta prefiere la columna, igual que el motor', () => {
  const conColumna = { centerDeadZonePct: 55, rangeLowerPrice: 2000, rangeUpperPrice: 3000 };
  // El motor: la columna gana sobre el default del servicio.
  assert.equal(resolveCenterDeadZone(conColumna, 2449.5, 40).pct, 55);
  // Columna NULL: manda el default, que es lo que el tick deja en el estado.
  assert.equal(resolveCenterDeadZone({ ...conColumna, centerDeadZonePct: null }, 2449.5, 40).pct, 40);
});
