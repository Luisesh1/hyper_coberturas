require('dotenv').config();

const segmentRepo = require('../repositories/lp-orchestrator-segment.repository');
const {
  buildHistoricalSegments,
  resolveHistoricalSegment,
} = require('../services/lp-orchestrator/segment-backfill');

/**
 * Reconstruye los tramos historicos de los orquestadores LP a partir del
 * action log y del log de rebalanceos de cobertura.
 *
 * Uso:
 *   node src/scripts/backfill-orchestrator-segments.js [--orchestrator <id>]           # dry-run
 *   node src/scripts/backfill-orchestrator-segments.js [--orchestrator <id>] --apply   # escribe
 *
 * DRY-RUN por defecto. Idempotente: re-ejecutarlo da el mismo resultado
 * (el historico efectivo es el sembrado o, si ya hubo backfill, su suma).
 */

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function loadActionLog(q, orchestratorId, before) {
  const { rows } = await q.query(
    `SELECT id, kind, action, position_identifier, tx_hashes_json, accounting_delta_json, created_at
       FROM lp_orchestrator_action_log
      WHERE orchestrator_id = $1
        AND kind IN ('decision','tx_finalized','attach_lp','kill_lp')
        AND created_at < $2
      ORDER BY created_at ASC, id ASC`,
    [orchestratorId, before]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    action: r.action || null,
    positionIdentifier: r.position_identifier || null,
    txHashes: parseJson(r.tx_hashes_json),
    accountingDelta: parseJson(r.accounting_delta_json),
    createdAt: Number(r.created_at),
  }));
}

async function loadRebalances(q, protectedPoolId, before) {
  if (protectedPoolId == null) return [];
  const { rows } = await q.query(
    `SELECT created_at, actual_qty_after, target_qty_after
       FROM protected_pool_delta_rebalance_log
      WHERE protected_pool_id = $1 AND created_at < $2
      ORDER BY created_at ASC, id ASC`,
    [protectedPoolId, before]
  );
  return rows.map((r) => ({
    createdAt: Number(r.created_at),
    actualQtyAfter: r.actual_qty_after != null ? Number(r.actual_qty_after) : null,
    targetQtyAfter: r.target_qty_after != null ? Number(r.target_qty_after) : null,
  }));
}

/**
 * Calcula (y con `apply` escribe) los tramos historicos de un orquestador.
 * `database` necesita `query` y, con apply, `connect` (pool).
 */
async function backfillOrchestrator(database, orch, { apply = false } = {}) {
  const existing = await segmentRepo.listByOrchestrator(orch.id, database);
  const historicalSegment = resolveHistoricalSegment(existing);
  if (!historicalSegment) return { orchestratorId: orch.id, skipped: true, segments: [], differenceUsd: 0 };

  const [actionLog, rebalances] = await Promise.all([
    loadActionLog(database, orch.id, historicalSegment.closedAt),
    loadRebalances(database, orch.active_protected_pool_id != null ? Number(orch.active_protected_pool_id) : null, historicalSegment.closedAt),
  ]);
  const result = buildHistoricalSegments({
    orchestrator: orch, actionLog, rebalances, historicalSegment,
  });

  if (apply) {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await segmentRepo.replaceHistorical(orch.id, result.segments, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return {
    orchestratorId: orch.id,
    skipped: false,
    historicalTotalUsd: Number(historicalSegment.accounting?.totalNetPnlUsd) || 0,
    ...result,
  };
}

async function runBackfill(database, { orchestratorId = null, apply = false } = {}) {
  const { rows } = await database.query(
    `SELECT id, active_protected_pool_id FROM lp_orchestrators
      WHERE ($1::int IS NULL OR id = $1) ORDER BY id`,
    [orchestratorId]
  );
  const results = [];
  for (const orch of rows) {
    results.push(await backfillOrchestrator(database, { ...orch, id: Number(orch.id) }, { apply }));
  }
  return results;
}

function fmt(n) {
  return Number(n).toFixed(4);
}

function printResults(results, apply) {
  for (const r of results) {
    if (r.skipped) {
      console.log(`#${r.orchestratorId}: sin tramo historico, omitido`);
      continue;
    }
    console.log(`#${r.orchestratorId}: ${r.segments.length} tramos, diferencia ${fmt(r.differenceUsd)} USD`);
    for (const s of r.segments) {
      const label = s.label ? ` (${s.label})` : '';
      console.log(
        `   ${new Date(s.openedAt).toISOString()} -> ${new Date(s.closedAt).toISOString()} `
        + `${s.closeReason} neto ${fmt(s.accounting.totalNetPnlUsd)}${label}`
      );
    }
  }
  console.log(apply ? 'Aplicado.' : 'Dry-run: volver a ejecutar con --apply para escribir.');
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const idx = args.indexOf('--orchestrator');
  const orchestratorId = idx >= 0 ? Number(args[idx + 1]) : null;
  if (idx >= 0 && !Number.isInteger(orchestratorId)) throw new Error('--orchestrator requiere un id numerico');

  const db = require('../db');
  try {
    await db.ensureConnection();
    printResults(await runBackfill(db.pool, { orchestratorId, apply }), apply);
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('backfill_failed', err.message);
    process.exitCode = 1;
  });
}

module.exports = { backfillOrchestrator, runBackfill };
