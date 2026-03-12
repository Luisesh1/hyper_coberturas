/**
 * db/index.js — Pool PostgreSQL + migraciones automáticas
 */

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

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
  // ── Tabla de usuarios ──────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name          VARCHAR(255) NOT NULL,
      role          VARCHAR(20) NOT NULL DEFAULT 'user'
                    CHECK (role IN ('user', 'superuser')),
      active        BOOLEAN NOT NULL DEFAULT true,
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT NOT NULL
    )
  `);

  // ── Tabla de coberturas ────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hedges (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER REFERENCES users(id),
      asset          VARCHAR(20)  NOT NULL,
      direction      VARCHAR(10)  NOT NULL DEFAULT 'short',
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
      position_size  NUMERIC,
      open_price     NUMERIC,
      close_price    NUMERIC,
      unrealized_pnl NUMERIC,
      error          TEXT,
      position_key   TEXT,
      entry_fill_oid BIGINT,
      entry_fill_time BIGINT,
      entry_fee_paid NUMERIC      NOT NULL DEFAULT 0,
      funding_accum  NUMERIC      NOT NULL DEFAULT 0,
      cycle_count    INTEGER      NOT NULL DEFAULT 0,
      created_at     BIGINT       NOT NULL,
      opened_at      BIGINT,
      closed_at      BIGINT,
      closing_started_at BIGINT,
      sl_placed_at      BIGINT,
      last_fill_at      BIGINT,
      last_reconciled_at BIGINT
    )
  `);

  // user_id en hedges (migración additive para tablas existentes)
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)
  `);

  // direction en hedges (short | long)
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS direction VARCHAR(10) NOT NULL DEFAULT 'short'
  `);
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS position_key TEXT
  `);
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS position_size NUMERIC
  `);
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS entry_fill_oid BIGINT
  `);
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS entry_fill_time BIGINT
  `);
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS entry_fee_paid NUMERIC NOT NULL DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS funding_accum NUMERIC NOT NULL DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS closing_started_at BIGINT
  `);
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS sl_placed_at BIGINT
  `);
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS last_fill_at BIGINT
  `);
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS last_reconciled_at BIGINT
  `);

  // ── Tabla de ciclos ────────────────────────────────────────────────
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

  // Columnas de PnL detallado en cycles (comisiones, funding, closedPnl del exchange)
  await pool.query(`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS entry_fee    NUMERIC NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS exit_fee     NUMERIC NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS closed_pnl   NUMERIC`);
  await pool.query(`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS funding_paid NUMERIC NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS entry_fill_oid BIGINT`);
  await pool.query(`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS exit_fill_oid  BIGINT`);
  await pool.query(`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS entry_fill_time BIGINT`);
  await pool.query(`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS exit_fill_time  BIGINT`);
  await pool.query(`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS entry_slippage  NUMERIC NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS exit_slippage   NUMERIC NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS total_slippage  NUMERIC NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE cycles ADD COLUMN IF NOT EXISTS net_pnl         NUMERIC`);

  // ── Tabla de configuración ─────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key        VARCHAR(100) NOT NULL,
      user_id    INTEGER REFERENCES users(id),
      value      TEXT         NOT NULL,
      updated_at BIGINT       NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
    )
  `);

  // user_id en settings (migración additive)
  await pool.query(`
    ALTER TABLE settings ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)
  `);

  // Índice único compuesto (user_id, key)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS settings_user_key ON settings(user_id, key)
  `);

  console.log('[DB] Esquema inicializado');

  // ── Seed: admin por defecto ────────────────────────────────────────
  await seedDefaultAdmin();
}

async function seedDefaultAdmin() {
  const { rows } = await pool.query('SELECT id FROM users LIMIT 1');
  if (rows.length > 0) return; // ya hay usuarios

  const now = Date.now();
  const hash = await bcrypt.hash('admin123', 12);
  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, active, created_at, updated_at)
     VALUES ($1, $2, $3, 'superuser', true, $4, $4) RETURNING id`,
    ['admin', hash, 'Administrador', now]
  );

  console.log('[DB] Usuario admin creado (admin / admin123)');

  // Migrar datos existentes al admin
  await pool.query('UPDATE hedges SET user_id = $1 WHERE user_id IS NULL', [admin.id]);
  await pool.query('UPDATE settings SET user_id = $1 WHERE user_id IS NULL', [admin.id]);

  // Si hay wallet en env vars, guardarla en settings del admin
  const { PRIVATE_KEY, WALLET_ADDRESS } = process.env;
  if (PRIVATE_KEY && WALLET_ADDRESS) {
    await pool.query(
      `INSERT INTO settings (key, user_id, value, updated_at)
       VALUES ('wallet', $1, $2, $3)
       ON CONFLICT (user_id, key) DO NOTHING`,
      [admin.id, JSON.stringify({ privateKey: PRIVATE_KEY, address: WALLET_ADDRESS }), now]
    );
    console.log('[DB] Wallet de env vars migrada al usuario admin');
  }
}

module.exports = { query, init, pool };
