// Re-ancla `range_exit_v1` al delta actual mediante un forzado.
//
// pp28 quedo anclada donde el cap la interrumpio (ETH 2774, un maximo local
// con el delta en su minimo). El precio revirtio y la politica, que congela
// dentro del rango, no puede corregirlo hasta el proximo borde.
//
// El forzado entra por la compuerta `forced`, que lleva al delta completo y
// fija `committedTargetQty`. La politica vuelve a congelar desde ahi.
require('dotenv').config();

// Validacion de uso ANTES de cargar nada: un error de argumentos no deberia
// necesitar base de datos ni credenciales para decirte que te equivocaste.
if (!Number(process.argv[2])) {
  console.error('uso: node src/scripts/ops/reanclar.js <protectionId>');
  process.exit(1);
}

const svc = require('../../services/protected-pool-delta-neutral.service');
const repo = require('../../repositories/protected-uniswap-pool.repository');

const PP_ID = Number(process.argv[2]);
const USER_ID = 1;

(async () => {
  if (!PP_ID) throw new Error('uso: node reanclar.js <protectionId>');

  const antes = await repo.getById(USER_ID, PP_ID);
  if (!antes) throw new Error(`proteccion ${PP_ID} no encontrada`);
  if (antes.status !== 'active') throw new Error(`proteccion en estado ${antes.status}: abortado`);
  console.log(JSON.stringify({
    paso: 'antes',
    pp: PP_ID,
    hedgeSize: antes.hedgeSize,
    gate: antes.strategyState?.rangeExitPolicyGate ?? null,
    committed: antes.strategyState?.rangeExitPolicyState?.committedTargetQty ?? null,
  }));

  await svc.evaluateProtection(antes, { forceReason: 'reanchor_manual', forceRebalance: true });

  const despues = await repo.getById(USER_ID, PP_ID);
  console.log(JSON.stringify({
    paso: 'despues',
    pp: PP_ID,
    hedgeSize: despues.hedgeSize,
    gate: despues.strategyState?.rangeExitPolicyGate ?? null,
    committed: despues.strategyState?.rangeExitPolicyState?.committedTargetQty ?? null,
    zona: despues.strategyState?.rangeExitPolicyState?.zone ?? null,
  }));
  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
