/**
 * db/index.js — Pool PostgreSQL + migraciones automáticas
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => console.error('[DB] Error en pool:', err.message));

function query(text, params) {
  return pool.query(text, params);
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hedges (
      id             SERIAL PRIMARY KEY,
      asset          VARCHAR(20)  NOT NULL,
      entry_price    NUMERIC      NOT NULL,
      exit_price     NUMERIC      NOT NULL,
      size           NUMERIC      NOT NULL,
      leverage       INTEGER      NOT NULL DEFAULT 10,
      label          VARCHAR(255),
      margin_mode    VARCHAR(20)  NOT NULL DEFAULT 'isolated',
      status         VARCHAR(50)  NOT NULL DEFAULT 'entry_pending',
      entry_oid      BIGINT,
      sl_oid         BIGINT,
      asset_index    INTEGER,
      sz_decimals    INTEGER,
      open_price     NUMERIC,
      close_price    NUMERIC,
      unrealized_pnl NUMERIC,
      error          TEXT,
      cycle_count    INTEGER      NOT NULL DEFAULT 0,
      created_at     BIGINT       NOT NULL,
      opened_at      BIGINT,
      closed_at      BIGINT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cycles (
      id          SERIAL  PRIMARY KEY,
      hedge_id    INTEGER NOT NULL REFERENCES hedges(id) ON DELETE CASCADE,
      cycle_id    INTEGER NOT NULL,
      open_price  NUMERIC,
      close_price NUMERIC,
      opened_at   BIGINT,
      closed_at   BIGINT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key        VARCHAR(100) PRIMARY KEY,
      value      TEXT         NOT NULL,
      updated_at BIGINT       NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
    )
  `);

  console.log('[DB] Esquema inicializado');
}

module.exports = { query, init, pool };
