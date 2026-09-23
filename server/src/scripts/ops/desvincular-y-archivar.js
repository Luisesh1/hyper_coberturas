/**
 * Desvincula el LP de un orquestador SIN cerrarlo on-chain, y lo archiva.
 *
 *   node src/scripts/ops/desvincular-y-archivar.js <orchestratorId>
 *
 * Para cuando el usuario va a cerrar el LP el mismo desde Uniswap. `kill-lp`
 * no sirve aqui: intenta cerrarlo on-chain, y `archive` se niega mientras haya
 * un LP vinculado ("Cierra el LP activo antes de archivar").
 *
 * ⚠️ Exige que la proteccion ya este cerrada. Archivar con una cobertura viva
 * dejaria un short abierto en Hyperliquid sin nada que lo gestione — el modo de
 * fallo que este proyecto existe para eliminar.
 *
 * NO toca la posicion de Uniswap: el NFT sigue en la wallet, con su liquidez,
 * y queda a cargo del usuario.
 */
require('dotenv').config();

// Validacion de uso ANTES de cargar nada: un error de argumentos no deberia
// necesitar base de datos ni credenciales para decirte que te equivocaste.
if (!Number(process.argv[2])) {
  console.error('uso: node src/scripts/ops/desvincular-y-archivar.js <orchestratorId>');
  process.exit(1);
}

const db = require('../../db');
const repo = require('../../repositories/lp-orchestrator.repository');
const hlRegistry = require('../../services/hyperliquid.registry');
const protectedPoolRepo = require('../../repositories/protected-uniswap-pool.repository');

const USER_ID = Number(process.env.OPS_USER_ID) || 1;

async function main() {
  const orchestratorId = Number(process.argv[2]);
  await db.ensureConnection();

  const orch = await repo.getById(USER_ID, orchestratorId);
  if (!orch) throw new Error(`orquestador ${orchestratorId} no encontrado`);
  if (orch.status === 'archived') {
    console.log(JSON.stringify({ orq: orchestratorId, resultado: 'ya estaba archivado' }));
    return;
  }

  // Guarda: ninguna proteccion viva puede quedar huerfana.
  if (orch.activeProtectedPoolId) {
    const p = await protectedPoolRepo.getById(USER_ID, orch.activeProtectedPoolId);
    if (p && p.status === 'active') {
      console.error(`ABORTADO: la proteccion #${p.id} sigue activa. Cierrala antes.`);
      process.exitCode = 1;
      return;
    }
    // El short se verifica contra el EXCHANGE, no contra la columna.
    //
    // `hedge_size` se queda rancia al cerrar: el 2026-09-23 decia 0.1398 con la
    // posicion real en cero y el colateral entero liberado. Es la misma
    // columna que mentia en la caratula. Aqui la mentira seria en la direccion
    // segura —abortar de mas— pero un guard que salta por un dato falso deja de
    // creerse, y entonces se ignora el dia que tiene razon.
    if (p) {
      const hl = await hlRegistry.getOrCreate(USER_ID, p.accountId);
      const state = await hl.getClearinghouseState();
      const pos = (state.assetPositions || [])
        .map((x) => x.position)
        .find((x) => x && x.coin === p.inferredAsset);
      const szi = pos ? Math.abs(Number(pos.szi) || 0) : 0;
      if (szi > 1e-8) {
        console.error(`ABORTADO: la cuenta ${p.accountId} conserva un short real de ${szi} ${p.inferredAsset}.`);
        process.exitCode = 1;
        return;
      }
    }
  }

  const lpConservado = orch.activePositionIdentifier;

  await repo.updateActiveLp(USER_ID, orchestratorId, {
    activePositionIdentifier: null,
    activePoolAddress: null,
    activeProtectedPoolId: null,
    phase: 'idle',
  });
  await repo.archive(USER_ID, orchestratorId);

  const despues = await repo.getById(USER_ID, orchestratorId);
  console.log(JSON.stringify({
    orq: orchestratorId,
    status: despues.status,
    lpDesvinculado: lpConservado,
    nota: 'el LP sigue en la wallet y en Uniswap: no se ha tocado on-chain',
  }));
}

main()
  .catch((err) => { console.error('ERROR', err.message); process.exitCode = 1; })
  .finally(async () => { await db.pool.end().catch(() => {}); });
