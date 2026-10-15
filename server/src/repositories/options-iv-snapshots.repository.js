/**
 * Snapshots horarios de la cadena de opciones (precios e IV) que alimentan la
 * fuente `recorded` del backtest.
 */

const defaultDb = require('../db');

const COLUMNS = ['underlying', 'symbol', 'expiry', 'strike', 'type', 'bid', 'ask', 'mark', 'iv', 'delta', 'spot', 'captured_at'];
// Límite de parámetros de Postgres: 65535 / 12 columnas ≈ 5400 filas; margen amplio.
const BATCH_SIZE = 1000;

const numberOrNull = (value) => (value == null ? null : Number(value));

function mapSnapshot(row) {
  return {
    underlying: row.underlying,
    symbol: row.symbol,
    expiry: row.expiry,
    strike: Number(row.strike),
    type: row.type,
    bid: numberOrNull(row.bid),
    ask: numberOrNull(row.ask),
    mark: numberOrNull(row.mark),
    iv: numberOrNull(row.iv),
    delta: numberOrNull(row.delta),
    spot: Number(row.spot),
    capturedAt: Number(row.captured_at),
  };
}

function createOptionsIvSnapshotsRepository({ db = defaultDb } = {}) {
  async function insertMany(snapshots) {
    let inserted = 0;
    for (let i = 0; i < snapshots.length; i += BATCH_SIZE) {
      const batch = snapshots.slice(i, i + BATCH_SIZE);
      const params = [];
      const tuples = batch.map((s) => {
        const values = [s.underlying, s.symbol, s.expiry, s.strike, s.type, s.bid, s.ask, s.mark, s.iv, s.delta, s.spot, s.capturedAt];
        const placeholders = values.map((v) => {
          params.push(v ?? null);
          return `$${params.length}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      await db.query(`INSERT INTO options_iv_snapshots (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`, params);
      inserted += batch.length;
    }
    return inserted;
  }

  async function listRange(underlying, from, to) {
    const { rows } = await db.query(
      `SELECT * FROM options_iv_snapshots
        WHERE underlying = $1 AND captured_at BETWEEN $2 AND $3
        ORDER BY captured_at, expiry, strike, type`,
      [underlying, from, to]
    );
    return rows.map(mapSnapshot);
  }

  async function deleteOlderThan(cutoffMs) {
    const { rowCount } = await db.query('DELETE FROM options_iv_snapshots WHERE captured_at < $1', [cutoffMs]);
    return rowCount || 0;
  }

  return { insertMany, listRange, deleteOlderThan };
}

module.exports = createOptionsIvSnapshotsRepository();
module.exports.createOptionsIvSnapshotsRepository = createOptionsIvSnapshotsRepository;
