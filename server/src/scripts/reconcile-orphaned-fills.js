/**
 * Script one-shot: reconcilia fills huérfanos de protecciones delta-neutral
 * inactivas cuyos hedgeRealizedPnlUsd y executionFeesUsd quedaron en 0.
 *
 * Usage:  node src/scripts/reconcile-orphaned-fills.js [--dry-run]
 *
 * El script:
 *  1. Busca protecciones delta_neutral inactivas con hedgeRealized = 0
 *  2. Obtiene los fills de Hyperliquid para cada wallet
 *  3. Asigna fills por rango de tiempo (createdAt → deactivatedAt)
 *  4. Actualiza strategy_state_json con los fills reconciliados
 *  5. Si hay un orquestador vinculado, actualiza su contabilidad también
 */

const db = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

async function fetchHlFills(walletAddress) {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'userFills', user: walletAddress }),
  });
  return res.json();
}

async function main() {
  console.log(`=== Reconcile Orphaned Fills ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'} ===\n`);

  // 1. Find inactive delta_neutral protections with hedgeRealized = 0
  const { rows: protections } = await db.query(`
    SELECT id, user_id, status, inferred_asset, wallet_address,
           created_at, deactivated_at, strategy_state_json
    FROM protected_uniswap_pools
    WHERE protection_mode = 'delta_neutral'
      AND status = 'inactive'
    ORDER BY created_at ASC
  `);

  console.log(`Found ${protections.length} inactive delta_neutral protections\n`);

  // Group by wallet to avoid redundant API calls
  const walletFillsCache = new Map();

  let totalReconciled = 0;
  let totalPnl = 0;
  let totalFees = 0;

  for (const p of protections) {
    const state = typeof p.strategy_state_json === 'string'
      ? JSON.parse(p.strategy_state_json)
      : p.strategy_state_json || {};

    const currentRealized = Number(state.hedgeRealizedPnlUsd || 0);
    const currentFees = Number(state.executionFeesUsd || 0);

    // Skip if already has realized PnL (already reconciled)
    if (currentRealized !== 0 || currentFees !== 0) {
      console.log(`  [SKIP] Protection ${p.id}: already has realized=$${currentRealized.toFixed(4)}, fees=$${currentFees.toFixed(4)}`);
      continue;
    }

    // Fetch fills for this wallet (cached)
    if (!walletFillsCache.has(p.wallet_address)) {
      console.log(`  Fetching fills for wallet ${p.wallet_address.slice(0, 10)}...`);
      walletFillsCache.set(p.wallet_address, await fetchHlFills(p.wallet_address));
    }
    const allFills = walletFillsCache.get(p.wallet_address);

    // Filter fills for this protection's time window
    const asset = String(p.inferred_asset || '').toUpperCase();
    const createdAt = Number(p.created_at || 0);
    const deactivatedAt = Number(p.deactivated_at || Date.now());

    let realizedDelta = 0;
    let feeDelta = 0;
    let matchedFills = 0;

    for (const fill of allFills) {
      const t = Number(fill?.time || 0);
      if (t <= createdAt || t > deactivatedAt) continue;
      if (String(fill?.coin || '').toUpperCase() !== asset) continue;

      const closedPnl = Number(fill.closedPnl || 0);
      const fee = Number(fill.fee || 0);
      if (Number.isFinite(closedPnl)) realizedDelta += closedPnl;
      if (Number.isFinite(fee)) feeDelta += fee;
      matchedFills++;
    }

    if (matchedFills === 0) {
      console.log(`  [SKIP] Protection ${p.id}: no fills in window ${new Date(createdAt).toISOString()} → ${new Date(deactivatedAt).toISOString()}`);
      continue;
    }

    console.log(`  [MATCH] Protection ${p.id}: ${matchedFills} fills, realized=$${realizedDelta.toFixed(4)}, fees=$${feeDelta.toFixed(4)}`);

    if (!DRY_RUN) {
      const updatedState = {
        ...state,
        hedgeRealizedPnlUsd: realizedDelta,
        executionFeesUsd: feeDelta,
        hedgeUnrealizedPnlUsd: 0,
        lastReconciledFillsAt: deactivatedAt,
      };
      await db.query(
        `UPDATE protected_uniswap_pools SET strategy_state_json = $1 WHERE id = $2`,
        [JSON.stringify(updatedState), p.id]
      );
      console.log(`         → Updated strategy_state_json for protection ${p.id}`);
    }

    totalReconciled++;
    totalPnl += realizedDelta;
    totalFees += feeDelta;
  }

  console.log(`\n=== Summary ===`);
  console.log(`Protections reconciled: ${totalReconciled}`);
  console.log(`Total realized PnL: $${totalPnl.toFixed(4)}`);
  console.log(`Total execution fees: $${totalFees.toFixed(4)}`);
  if (DRY_RUN) console.log(`\n(DRY RUN — no changes written. Remove --dry-run to apply.)`);

  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
