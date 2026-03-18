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

module.exports = {
  cleanupDuplicateProtectedPools,
  selectProtectedPoolIdsToDelete,
};
