/**
 * Deposita margen aislado en la posicion de una proteccion.
 *
 *   node src/scripts/ops/margin-topup.js <protectionId> <usd>
 *
 * ⚠️ MUEVE CAPITAL REAL. Es un deposito dentro de la misma cuenta de
 * Hyperliquid —de colateral libre a margen aislado—, no una transferencia
 * fuera, y es reversible retirandolo. Aun asi lo firma el usuario.
 *
 * Por que existe: la recarga automatica solo actua entre los umbrales
 * configurados (hoy 7% de recarga, 5% de pausa). Si una posicion nace POR
 * DEBAJO del umbral de pausa, el motor va directo a `risk_paused` y nunca
 * intenta recargar. Paso el 2026-09-22: pp28 y pp29 abiertas a 15x nacieron con
 * la liquidacion a 4.3%, quedaron pausadas desde el primer tick, y este script
 * fue lo que las saco.
 *
 * Guardas: aborta si no hay posicion corta, si no esta en isolated, o si el
 * saldo libre no cubre el deposito con holgura.
 */
require('dotenv').config();

// Validacion de uso ANTES de cargar nada: un error de argumentos no deberia
// necesitar base de datos ni credenciales para decirte que te equivocaste.
if (!Number(process.argv[2]) || !(Number(process.argv[3]) > 0)) {
  console.error('uso: node src/scripts/ops/margin-topup.js <protectionId> <usd>');
  process.exit(1);
}

const db = require('../../db');
const hlRegistry = require('../../services/hyperliquid.registry');
const repo = require('../../repositories/protected-uniswap-pool.repository');

const USER_ID = Number(process.env.OPS_USER_ID) || 1;
const HOLGURA_USD = 5;

async function snapshot(hl, asset) {
  const state = await hl.getClearinghouseState();
  const pos = (state.assetPositions || []).map((p) => p.position).find((p) => p && p.coin === asset);
  const mids = await hl.getAllMids().catch(() => null);
  return { state, pos, px: mids ? Number(mids[asset]) : null };
}

const dist = (liq, px) => (liq && px ? (((liq - px) / px) * 100).toFixed(2) : 'n/a');

async function main() {
  const protectionId = Number(process.argv[2]);
  const usd = Number(process.argv[3]);
  if (!protectionId || !(usd > 0)) {
    console.error('uso: node src/scripts/ops/margin-topup.js <protectionId> <usd>');
    process.exitCode = 1;
    return;
  }

  await db.ensureConnection();
  const protection = await repo.getById(USER_ID, protectionId);
  if (!protection) throw new Error(`proteccion ${protectionId} no encontrada`);

  const asset = protection.inferredAsset;
  const hl = await hlRegistry.getOrCreate(USER_ID, protection.accountId);
  const before = await snapshot(hl, asset);

  if (!before.pos || Number(before.pos.szi) >= 0) {
    console.log(`pp${protectionId}: ABORTADO - no hay posicion corta abierta`);
    process.exitCode = 1;
    return;
  }
  if (before.pos.leverage?.type !== 'isolated') {
    console.log(`pp${protectionId}: ABORTADO - la posicion no esta en isolated`);
    process.exitCode = 1;
    return;
  }
  if (Number(before.state.withdrawable) < usd + HOLGURA_USD) {
    console.log(`pp${protectionId}: ABORTADO - saldo libre ${before.state.withdrawable} insuficiente para ${usd}`);
    process.exitCode = 1;
    return;
  }

  const meta = await hl.getAssetMeta(asset);
  await hl.updateIsolatedMargin(meta.index, false, usd);

  const after = await snapshot(hl, asset);
  console.log(JSON.stringify({
    pp: protectionId,
    accountId: protection.accountId,
    depositadoUsd: usd,
    marginUsed: `${before.pos.marginUsed} -> ${after.pos?.marginUsed}`,
    liquidationPx: `${Number(before.pos.liquidationPx).toFixed(2)} -> ${Number(after.pos?.liquidationPx).toFixed(2)}`,
    distPct: `${dist(Number(before.pos.liquidationPx), before.px)}% -> ${dist(Number(after.pos?.liquidationPx), after.px)}%`,
    withdrawable: `${before.state.withdrawable} -> ${after.state.withdrawable}`,
  }));
}

main()
  .catch((err) => { console.error('ERROR', err.message); process.exitCode = 1; })
  .finally(async () => { await db.pool.end().catch(() => {}); });
