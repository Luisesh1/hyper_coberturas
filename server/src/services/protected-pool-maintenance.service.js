const db = require('../db');
const hedgeRepository = require('../repositories/hedge.repository');

function selectProtectedPoolIdsToDelete(records = []) {
  if (!Array.isArray(records) || records.length <= 1) {
    return [];
  }

  const activeRecords = records
    .filter((item) => item.status === 'active')
    .sort((a, b) => (Number(b.updatedAt || 0) - Number(a.updatedAt || 0)) || (Number(b.id || 0) - Number(a.id || 0)));

  if (activeRecords.length > 0) {
    const keepId = activeRecords[0].id;
    return records
      .filter((item) => item.id !== keepId)
      .map((item) => item.id);
  }

  return records.map((item) => item.id);
}

async function cleanupDuplicateProtectedPools(executor = db) {
  const summary = {
    groups: 0,
    poolsDeleted: 0,
    hedgesDeleted: 0,
  };

  const { rows: duplicateGroups } = await executor.query(
    `SELECT user_id, network, version, lower(wallet_address) AS wallet_address_key, position_identifier
       FROM protected_uniswap_pools
      GROUP BY user_id, network, version, lower(wallet_address), position_identifier
     HAVING COUNT(*) > 1`
  );

  for (const group of duplicateGroups) {
    const { rows } = await executor.query(
      `SELECT id, status, updated_at AS "updatedAt", created_at AS "createdAt"
         FROM protected_uniswap_pools
        WHERE user_id = $1
          AND network = $2
          AND version = $3
          AND lower(wallet_address) = $4
          AND position_identifier = $5
        ORDER BY updated_at DESC, created_at DESC, id DESC`,
      [
        group.user_id,
        group.network,
        group.version,
        group.wallet_address_key,
        group.position_identifier,
      ]
    );

    const idsToDelete = selectProtectedPoolIdsToDelete(rows.map((row) => ({
      id: Number(row.id),
      status: row.status,
      updatedAt: Number(row.updatedAt),
      createdAt: Number(row.createdAt),
    })));

    if (idsToDelete.length === 0) continue;

    summary.groups += 1;
    summary.hedgesDeleted += await hedgeRepository.deleteByProtectedPoolIds(idsToDelete);
    const { rowCount } = await executor.query(
      `DELETE FROM protected_uniswap_pools
        WHERE id = ANY($1::int[])`,
      [idsToDelete]
    );
    summary.poolsDeleted += rowCount || 0;
  }

  return summary;
}

// Retencion de `protection_decision_log`.
//
// La tabla llego a 6,49 M de filas / 1,79 GB contra 592 rebalanceos reales
// (~11.000 filas por rebalanceo) sin ninguna politica de retencion. La causa
// del volumen se corrige en el gate de `_tickProtection` —el lazo dejaba de
// throttlear con el precio fuera de rango—; esto se ocupa del historico
// acumulado y del estado estacionario.
//
// Se borra por lotes a proposito: un DELETE unico sobre millones de filas toma
// una transaccion larga y bloquea las escrituras del motor, que corre cada 2 s.
const DEFAULT_DECISION_LOG_RETENTION_DAYS = 30;
const DEFAULT_PRUNE_BATCH_SIZE = 50_000;

async function countDecisionLogOlderThan(cutoffMs, executor = db) {
  const { rows } = await executor.query(
    'SELECT count(*)::bigint AS total FROM protection_decision_log WHERE created_at < $1',
    [cutoffMs]
  );
  return Number(rows[0]?.total || 0);
}

async function pruneDecisionLog({
  retentionDays = DEFAULT_DECISION_LOG_RETENTION_DAYS,
  batchSize = DEFAULT_PRUNE_BATCH_SIZE,
  dryRun = true,
} = {}, executor = db) {
  const days = Number(retentionDays) > 0 ? Number(retentionDays) : DEFAULT_DECISION_LOG_RETENTION_DAYS;
  const cutoffMs = Date.now() - (days * 86_400_000);
  const candidates = await countDecisionLogOlderThan(cutoffMs, executor);

  if (dryRun) {
    return { dryRun: true, retentionDays: days, cutoffMs, candidates, deleted: 0 };
  }

  let deleted = 0;
  for (;;) {
    const { rowCount } = await executor.query(
      `DELETE FROM protection_decision_log
        WHERE id IN (
          SELECT id FROM protection_decision_log
           WHERE created_at < $1
           ORDER BY id
           LIMIT $2
        )`,
      [cutoffMs, batchSize]
    );
    deleted += rowCount;
    if (rowCount < batchSize) break;
  }

  return { dryRun: false, retentionDays: days, cutoffMs, candidates, deleted };
}


module.exports = {
  pruneDecisionLog,
  countDecisionLogOlderThan,
  DEFAULT_DECISION_LOG_RETENTION_DAYS,
  cleanupDuplicateProtectedPools,
  selectProtectedPoolIdsToDelete,
};
