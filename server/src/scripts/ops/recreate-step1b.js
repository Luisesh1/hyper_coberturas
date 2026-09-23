// Desvincula la proteccion inactiva del orquestador (dejando el LP vinculado)
// y fuerza la evaluacion para que `_recoverMissingProtection` cree una nueva
// leyendo protectionConfig -> leverage 10.
require('dotenv').config();
// Validacion de uso ANTES de cargar nada: un error de argumentos no deberia
// necesitar base de datos ni credenciales para decirte que te equivocaste.
if (!Number(process.argv[2])) {
  console.error('uso: node src/scripts/ops/recreate-step1b.js <orchestratorId>');
  process.exit(1);
}

const repo = require('../../repositories/lp-orchestrator.repository');
const orchSvc = require('../../services/lp-orchestrator.service');

const ORCH_ID = Number(process.argv[2]);
const USER_ID = 1;

(async () => {
  if (!ORCH_ID) throw new Error('uso: node recreate-step1b.js <orchestratorId>');
  const before = await repo.getById(USER_ID, ORCH_ID);
  if (!before) throw new Error(`orquestador ${ORCH_ID} no encontrado`);
  if (!before.activePositionIdentifier) throw new Error('el orquestador no tiene LP activo: abortado');

  await repo.updateActiveLp(USER_ID, ORCH_ID, {
    activePositionIdentifier: before.activePositionIdentifier,
    activePoolAddress: before.activePoolAddress ?? null,
    activeProtectedPoolId: null,
    phase: 'lp_active',
  });
  console.log(JSON.stringify({ paso: 'desvinculada', orq: ORCH_ID, lp: before.activePositionIdentifier, ppAnterior: before.activeProtectedPoolId }));

  const res = await orchSvc.evaluateOne(USER_ID, ORCH_ID);
  const after = await repo.getById(USER_ID, ORCH_ID);
  console.log(JSON.stringify({
    paso: 'evaluado',
    skipped: res?.skipped ?? null,
    reason: res?.reason ?? null,
    ppNueva: after.activeProtectedPoolId,
    phase: after.phase,
    lastError: after.lastError ?? null,
  }));
  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
