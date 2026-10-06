const db = require('../db');

function exec(executor) {
  return executor || db;
}

async function insert(observation, executor) {
  await exec(executor).query(
    `INSERT INTO gas_observations (
       network, kind, profile, estimated_gas, gas_used, effective_gas_price_wei,
       l1_fee_wei, wait_blocks, tx_hash, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tx_hash) DO NOTHING`,
    [
      observation.network,
      observation.kind,
      observation.profile ?? null,
      observation.estimatedGas ?? null,
      observation.gasUsed,
      observation.effectiveGasPriceWei,
      observation.l1FeeWei ?? null,
      observation.waitBlocks ?? null,
      observation.txHash,
      observation.createdAt,
    ]
  );
}

/**
 * p95 del gas usado en las últimas `lookback` txs de esa red y tipo. Con menos
 * de `minSamples` muestras devuelve null: un p95 de dos txs no calibra nada.
 */
async function getP95GasUsed({ network, kind, minSamples = 5, lookback = 200 }, executor) {
  const { rows } = await exec(executor).query(
    `SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY gas_used) AS p95, COUNT(*)::int AS n
       FROM (
         SELECT gas_used FROM gas_observations
          WHERE network = $1 AND kind = $2
          ORDER BY created_at DESC
          LIMIT $3
       ) recent`,
    [network, kind, lookback]
  );
  const row = rows[0];
  if (!row || row.p95 == null || Number(row.n) < minSamples) return null;
  return Math.ceil(Number(row.p95));
}

module.exports = { insert, getP95GasUsed };
