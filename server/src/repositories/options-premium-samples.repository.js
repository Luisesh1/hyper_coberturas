/**
 * Recorrido de la prima: bid, ask y spot de cada posición en cada pasada del
 * muestreador. Lo consume el simulador de salidas.
 */

const defaultDb = require('../db');

const numberOrNull = (value) => (value == null ? null : Number(value));

function createOptionsPremiumSamplesRepository({ db = defaultDb } = {}) {
  /** Una fila por posición y marca de tiempo; repetir la marca no duplica. */
  async function insertSample(positionId, at, { bid = null, ask = null, spot = null } = {}) {
    const { rowCount } = await db.query(
      `INSERT INTO options_premium_samples (position_id, sampled_at, bid, ask, spot)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [positionId, at, bid, ask, spot]
    );
    return rowCount === 1;
  }

  /** Map<positionId, Array<{ at, bid, ask, spot }>> ordenado por `at`. */
  async function listPremiumSamples(positionIds) {
    const result = new Map();
    if (!Array.isArray(positionIds) || !positionIds.length) return result;
    const { rows } = await db.query(
      `SELECT position_id, sampled_at, bid, ask, spot FROM options_premium_samples
        WHERE position_id = ANY($1::bigint[])
        ORDER BY position_id, sampled_at`,
      [positionIds]
    );
    for (const row of rows) {
      const id = Number(row.position_id);
      if (!result.has(id)) result.set(id, []);
      result.get(id).push({
        at: Number(row.sampled_at),
        bid: numberOrNull(row.bid),
        ask: numberOrNull(row.ask),
        spot: numberOrNull(row.spot),
      });
    }
    return result;
  }

  async function deleteOlderThan(cutoffMs) {
    const { rowCount } = await db.query('DELETE FROM options_premium_samples WHERE sampled_at < $1', [cutoffMs]);
    return rowCount || 0;
  }

  return { insertSample, listPremiumSamples, deleteOlderThan };
}

module.exports = createOptionsPremiumSamplesRepository();
module.exports.createOptionsPremiumSamplesRepository = createOptionsPremiumSamplesRepository;
