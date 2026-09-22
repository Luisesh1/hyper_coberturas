const test = require('node:test');
const assert = require('node:assert/strict');

const { LpOrchestratorService } = require('../src/services/lp-orchestrator.service');

/**
 * Una incidencia resuelta tiene que apagarse sola.
 *
 * Cuando la compuerta de integridad ve una proteccion vinculada que no esta
 * `active`, escribe `phase = protection_reconcile_required` y un `lastError`.
 * `_recoverMissingProtection` arreglaba el vinculo —creando o reutilizando la
 * proteccion— pero NO borraba ese texto, y la caratula levanta incidencia con
 * la sola presencia de `lastError` (`orchestratorIssueState.js:162`).
 *
 * Resultado observado el 2026-09-22: los orquestadores #55 y #56, con sus
 * protecciones #28 y #29 activas a 10x y con hedge vivo, seguian pidiendo
 * "reconciliacion" en la interfaz. Un aviso que no se apaga cuando el problema
 * se va entrena a ignorar los avisos.
 */

function makeService({ createdPoolId = 77, reusable = null } = {}) {
  const calls = { updateActiveLp: [], updatePhase: [], actionLog: [] };

  const service = new LpOrchestratorService({
    db: { transaction: async (fn) => fn(undefined) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    lpOrchestratorRepository: {
      updateActiveLp: async (userId, id, patch) => { calls.updateActiveLp.push({ id, patch }); },
      updatePhase: async (userId, id, patch) => { calls.updatePhase.push({ id, patch }); },
      updateStrategyState: async () => {},
      appendActionLog: async (entry) => { calls.actionLog.push(entry); },
    },
    protectedPoolRepository: {
      findReusableByIdentity: async () => reusable,
    },
    uniswapProtectionService: {
      createProtectedPool: async () => ({ id: createdPoolId }),
    },
    protectionRecovery: {
      shouldAttemptNow: () => true,
      readRetryState: () => ({ attempts: 1 }),
      nextRetryState: () => ({ attempts: 0 }),
    },
  });

  // `_loadProtectionSnapshot` sale a la red; aqui solo hace falta que devuelva algo.
  service._loadProtectionSnapshot = async () => ({ identifier: '209700' });

  return { service, calls };
}

function makeOrch() {
  return {
    id: 55,
    userId: 1,
    status: 'active',
    phase: 'protection_reconcile_required',
    lastError: 'Protección #28 en estado inactive; requiere reconciliación.',
    network: 'arbitrum',
    version: 'v3',
    walletAddress: '0xwallet',
    activePositionIdentifier: '209700',
    activePoolAddress: null,
    activeProtectedPoolId: null,
    protectionConfig: { enabled: true, accountId: 5, leverage: 10, policyVersion: 'range_exit_v1' },
    strategyState: {},
  };
}

test('al recuperar la proteccion se borra el error que la denunciaba', async () => {
  const { service, calls } = makeService();

  await service._recoverMissingProtection(makeOrch());

  assert.equal(calls.updateActiveLp.length, 1, 'se revincula la proteccion');
  assert.equal(calls.updatePhase.length, 1, 'y se cierra la incidencia');
  assert.equal(calls.updatePhase[0].patch.lastError, null);
});

test('la fase vuelve a un estado sano, no se queda en reconcile_required', async () => {
  const { service, calls } = makeService();

  await service._recoverMissingProtection(makeOrch());

  assert.equal(calls.updatePhase[0].patch.phase, 'lp_active');
});

test('reutilizar una proteccion existente tambien cierra la incidencia', async () => {
  // Si un intento anterior llego a crear la proteccion, se reutiliza en vez de
  // crear otra. Ese camino tenia el mismo olvido.
  const { service, calls } = makeService({
    reusable: { id: 28, status: 'active', protectionMode: 'delta_neutral', accountId: 5 },
  });

  await service._recoverMissingProtection(makeOrch());

  assert.equal(calls.updateActiveLp[0].patch.activeProtectedPoolId, 28);
  assert.equal(calls.updatePhase[0].patch.lastError, null);
});

test('si la recuperacion falla, el error NO se borra', async () => {
  // Lo contrario seria peor que el bug: silenciar una incidencia viva.
  const { service, calls } = makeService();
  service.uniswapProtectionService.createProtectedPool = async () => {
    throw new Error('sin margen para abrir el hedge');
  };

  await service._recoverMissingProtection(makeOrch());

  assert.equal(calls.updateActiveLp.length, 0, 'no hay proteccion que vincular');
  assert.equal(calls.updatePhase.length, 0, 'y la incidencia sigue en pie');
});
