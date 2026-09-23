/**
 * SOLO LECTURA: estado del margen aislado de las protecciones indicadas.
 *
 *   node src/scripts/ops/margin-probe.js 28 29
 *
 * No envia ninguna accion a Hyperliquid: solo `getClearinghouseState` y mids.
 * Es la herramienta con la que se diagnostico la inanicion de margen del
 * 2026-09-22, cuando pp28 y pp29 nacieron a 15x con la liquidacion a 4.3% y el
 * umbral de pausa en 5% — dos ajustes mutuamente incompatibles.
 *
 * `distPct` es la distancia a liquidacion, que es el numero que importa:
 * los umbrales configurados viven en `settings.delta_neutral_risk_controls`
 * (pausa 5%, recarga 7%), NO en los defaults del codigo.
 */
require('dotenv').config();

// Validacion de uso ANTES de cargar nada: un error de argumentos no deberia
// necesitar base de datos ni credenciales para decirte que te equivocaste.
const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (!ids.length) {
  console.error('uso: node src/scripts/ops/margin-probe.js <protectionId> [protectionId...]');
  process.exit(1);
}

const db = require('../../db');
const hlRegistry = require('../../services/hyperliquid.registry');
const repo = require('../../repositories/protected-uniswap-pool.repository');

const USER_ID = Number(process.env.OPS_USER_ID) || 1;

async function probe(protectionId) {
  const protection = await repo.getById(USER_ID, protectionId);
  if (!protection) return { pp: protectionId, error: 'proteccion no encontrada' };

  const hl = await hlRegistry.getOrCreate(USER_ID, protection.accountId);
  const state = await hl.getClearinghouseState();
  const asset = protection.inferredAsset;
  const pos = (state.assetPositions || [])
    .map((p) => p.position)
    .find((p) => p && p.coin === asset);
  const mids = await hl.getAllMids().catch(() => null);
  const px = mids ? Number(mids[asset]) : null;
  const liq = pos ? Number(pos.liquidationPx) : null;

  return {
    pp: protectionId,
    accountId: protection.accountId,
    asset,
    status: protection.status,
    leverageConfigurado: protection.leverage,
    leverageReal: pos?.leverage?.value ?? null,
    szi: pos ? Number(pos.szi) : 0,
    marginUsed: pos ? Number(pos.marginUsed) : null,
    positionValue: pos ? Number(pos.positionValue) : null,
    withdrawable: Number(state.withdrawable),
    liquidationPx: liq,
    px,
    distPct: liq && px ? Number((((liq - px) / px) * 100).toFixed(2)) : null,
  };
}

async function main() {
  await db.ensureConnection();
  for (const id of ids.map(Number)) {
    console.log(JSON.stringify(await probe(id)));
  }
}

main()
  .catch((err) => { console.error('ERROR', err.message); process.exitCode = 1; })
  .finally(async () => { await db.pool.end().catch(() => {}); });
