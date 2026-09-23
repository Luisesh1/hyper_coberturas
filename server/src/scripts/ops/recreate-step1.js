// Paso 1: solicitar desactivacion de una proteccion delta-neutral.
// El cierre del short lo completa el lazo (_continueDeactivation), no esto.
require('dotenv').config();
// Validacion de uso ANTES de cargar nada: un error de argumentos no deberia
// necesitar base de datos ni credenciales para decirte que te equivocaste.
if (!Number(process.argv[2])) {
  console.error('uso: node src/scripts/ops/recreate-step1.js <protectionId>');
  process.exit(1);
}

const svc = require('../../services/uniswap-protection.service');

const PP_ID = Number(process.argv[2]);
const USER_ID = 1;

(async () => {
  if (!PP_ID) throw new Error('uso: node recreate-step1.js <protectionId>');
  const res = await svc.deactivateProtectedPool(USER_ID, PP_ID);
  console.log(JSON.stringify({
    pp: PP_ID,
    status: res?.status,
    strategyStatus: res?.strategyState?.status ?? null,
  }));
  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
