#!/usr/bin/env node

/**
 * Validation and recovery script for delta-neutral protections.
 * Verifies that all delta-neutral protections are properly configured
 * and recovers any that are in a degraded state.
 */

const db = require('../db');
const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');
const protectedPoolDeltaNeutralService = require('../services/protected-pool-delta-neutral.service');

async function validateDeltaNeutral() {
  console.log('🔍 Starting delta-neutral validation...\n');

  const rows = await db.query(
    `SELECT id, user_id, inferred_asset, protection_mode, status, strategy_state_json, hedge_size, hedge_notional_usd, pool_snapshot_json
     FROM protected_uniswap_pools
     WHERE protection_mode = 'delta_neutral'
     ORDER BY created_at DESC`
  );

  if (rows.length === 0) {
    console.log('✅ No delta-neutral protections found.');
    process.exit(0);
  }

  console.log(`Found ${rows.length} delta-neutral protection(s)\n`);

  let healthy = 0;
  let degraded = 0;
  let recovered = 0;

  for (const row of rows) {
    const id = row.id;
    const userId = row.user_id;
    const asset = row.inferred_asset;
    const status = row.status;
    const strategyState = JSON.parse(row.strategy_state_json || '{}');
    const poolSnapshot = JSON.parse(row.pool_snapshot_json || '{}');

    console.log(`\n📋 Protection #${id} (${asset})`);
    console.log(`   Status: ${status}`);
    console.log(`   Strategy: ${strategyState.status || 'unknown'}`);
    console.log(`   Hedge: ${Number(row.hedge_size || 0).toFixed(6)} ${asset} (${Number(row.hedge_notional_usd || 0).toFixed(2)} USD)`);

    // Check 1: Status
    if (status !== 'active') {
      console.log(`   ⚠️  Not active: ${status}`);
      degraded++;
      continue;
    }

    // Check 2: Pool snapshot
    if (!poolSnapshot || !poolSnapshot.token0 || !poolSnapshot.token1) {
      console.log(`   ❌ Invalid pool snapshot`);
      degraded++;
      continue;
    }

    // Check 3: Price available
    if (!Number.isFinite(Number(poolSnapshot.priceCurrent))) {
      console.log(`   ❌ No valid price`);
      degraded++;
      continue;
    }

    // Check 4: Strategy state
    if (!strategyState.status) {
      console.log(`   ⚠️  No strategy state, attempting recovery...`);
      try {
        const protection = await protectedPoolRepository.getById(userId, id);
        if (protection) {
          await protectedPoolDeltaNeutralService.bootstrapProtection(protection);
          console.log(`   ✅ Recovery initiated`);
          recovered++;
        }
      } catch (err) {
        console.log(`   ❌ Recovery failed: ${err.message}`);
        degraded++;
      }
      continue;
    }

    if (strategyState.status === 'healthy') {
      console.log(`   ✅ Healthy`);
      healthy++;
    } else if (strategyState.status === 'risk_paused') {
      console.log(`   ⚠️  Risk paused: ${strategyState.lastError}`);
      degraded++;
    } else if (strategyState.status === 'degraded_partial') {
      console.log(`   ❌ Degraded: ${strategyState.lastError}`);
      degraded++;
    } else {
      console.log(`   ⚠️  State: ${strategyState.status}`);
      if (strategyState.status === 'boundary_watch' || strategyState.status === 'partial_hedge_warning') {
        healthy++;
      } else {
        degraded++;
      }
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 Summary:`);
  console.log(`   ✅ Healthy: ${healthy}`);
  console.log(`   ⚠️  Degraded: ${degraded}`);
  console.log(`   🔄 Recovered: ${recovered}`);
  console.log(`${'='.repeat(50)}\n`);

  if (degraded > 0) {
    console.log(`⚠️  ${degraded} protection(s) need attention.`);
    console.log(`   Use GET /uniswap/protected-pools/:id/diagnose to inspect details.\n`);
  }

  process.exit(degraded > 0 ? 1 : 0);
}

validateDeltaNeutral().catch((err) => {
  console.error('❌ Validation error:', err.message);
  process.exit(1);
});
