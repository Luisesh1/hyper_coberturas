/**
 * db/index.js — Pool PostgreSQL + helpers de conexión / migración
 */

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const logger = require('../services/logger.service');

const IS_PROD = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ...(IS_PROD && { ssl: { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } }),
});

pool.on('error', (err) => logger.error('db_pool_error', { error: err.message }));

function query(text, params) {
  return pool.query(text, params);
}

async function ensureConnection() {
  await pool.query('SELECT 1');
}

async function initSchema() {
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

  // ── Cuentas Hyperliquid por usuario ───────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hyperliquid_accounts (
      id                    SERIAL PRIMARY KEY,
      user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      alias                 VARCHAR(255) NOT NULL,
      address               VARCHAR(255) NOT NULL,
      private_key_encrypted TEXT,
      is_default            BOOLEAN NOT NULL DEFAULT false,
      created_at            BIGINT NOT NULL,
      updated_at            BIGINT NOT NULL
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS hyperliquid_accounts_user_address
      ON hyperliquid_accounts(user_id, lower(address))
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS hyperliquid_accounts_default_once
      ON hyperliquid_accounts(user_id)
      WHERE is_default = true
  `);

  // ── Tabla de coberturas ────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hedges (
      id             SERIAL PRIMARY KEY,
      user_id        INTEGER REFERENCES users(id),
      hyperliquid_account_id INTEGER REFERENCES hyperliquid_accounts(id),
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

  // ── Pools Uniswap protegidos ─────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS protected_uniswap_pools (
      id                     SERIAL PRIMARY KEY,
      user_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hyperliquid_account_id INTEGER NOT NULL REFERENCES hyperliquid_accounts(id) ON DELETE CASCADE,
      network                VARCHAR(40) NOT NULL,
      version                VARCHAR(10) NOT NULL,
      wallet_address         VARCHAR(255) NOT NULL,
      pool_address           VARCHAR(255),
      position_identifier    VARCHAR(255) NOT NULL,
      token0_symbol          VARCHAR(50) NOT NULL,
      token1_symbol          VARCHAR(50) NOT NULL,
      token0_address         VARCHAR(255),
      token1_address         VARCHAR(255),
      range_lower_price      NUMERIC NOT NULL,
      range_upper_price      NUMERIC NOT NULL,
      price_current          NUMERIC,
      inferred_asset         VARCHAR(20) NOT NULL,
      hedge_size             NUMERIC NOT NULL,
      hedge_notional_usd     NUMERIC NOT NULL,
      configured_hedge_notional_usd NUMERIC NOT NULL,
      value_multiplier       NUMERIC,
      stop_loss_difference_pct NUMERIC NOT NULL DEFAULT 0.05,
      value_mode             VARCHAR(20) NOT NULL DEFAULT 'usd',
      leverage               INTEGER NOT NULL,
      margin_mode            VARCHAR(20) NOT NULL DEFAULT 'isolated',
      status                 VARCHAR(20) NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'inactive')),
      pool_snapshot_json     TEXT NOT NULL,
      created_at             BIGINT NOT NULL,
      updated_at             BIGINT NOT NULL,
      deactivated_at         BIGINT
    )
  `);

  // user_id en hedges (migración additive para tablas existentes)
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)
  `);
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS hyperliquid_account_id INTEGER REFERENCES hyperliquid_accounts(id)
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
  await pool.query(`
    ALTER TABLE protected_uniswap_pools ADD COLUMN IF NOT EXISTS configured_hedge_notional_usd NUMERIC
  `);
  await pool.query(`
    ALTER TABLE protected_uniswap_pools ADD COLUMN IF NOT EXISTS value_multiplier NUMERIC
  `);
  await pool.query(`
    ALTER TABLE protected_uniswap_pools ADD COLUMN IF NOT EXISTS value_mode VARCHAR(20) NOT NULL DEFAULT 'usd'
  `);
  await pool.query(`
    ALTER TABLE protected_uniswap_pools ADD COLUMN IF NOT EXISTS stop_loss_difference_pct NUMERIC NOT NULL DEFAULT 0.05
  `);
  await pool.query(`
    UPDATE protected_uniswap_pools
       SET configured_hedge_notional_usd = hedge_notional_usd
     WHERE configured_hedge_notional_usd IS NULL
  `);
  await pool.query(`
    UPDATE protected_uniswap_pools
       SET stop_loss_difference_pct = 0.05
     WHERE stop_loss_difference_pct IS NULL
  `);
  await pool.query(`
    UPDATE protected_uniswap_pools
       SET value_mode = 'usd'
     WHERE value_mode IS NULL OR value_mode = ''
  `);
  await pool.query(`
    ALTER TABLE protected_uniswap_pools
      ALTER COLUMN configured_hedge_notional_usd SET NOT NULL
  `);
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS protected_pool_id INTEGER REFERENCES protected_uniswap_pools(id) ON DELETE SET NULL
  `);
  await pool.query(`
    ALTER TABLE hedges ADD COLUMN IF NOT EXISTS protected_role VARCHAR(20)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS hedges_protected_pool_idx
      ON hedges(protected_pool_id)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS protected_uniswap_pools_active_identity
      ON protected_uniswap_pools(user_id, network, version, lower(wallet_address), position_identifier)
      WHERE status = 'active'
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

  // ── Estrategias automatizadas ─────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS strategies (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name                VARCHAR(255) NOT NULL,
      description         TEXT,
      asset_universe_json TEXT NOT NULL DEFAULT '["BTC"]',
      timeframe           VARCHAR(20) NOT NULL DEFAULT '15m',
      script_source       TEXT NOT NULL,
      default_params_json TEXT NOT NULL DEFAULT '{}',
      is_active_draft     BOOLEAN NOT NULL DEFAULT true,
      created_at          BIGINT NOT NULL,
      updated_at          BIGINT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS strategy_indicators (
      id                    SERIAL PRIMARY KEY,
      user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name                  VARCHAR(255) NOT NULL,
      slug                  VARCHAR(120) NOT NULL,
      script_source         TEXT NOT NULL,
      parameter_schema_json TEXT NOT NULL DEFAULT '{}',
      created_at            BIGINT NOT NULL,
      updated_at            BIGINT NOT NULL
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS strategy_indicators_user_slug
      ON strategy_indicators(user_id, slug)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS strategy_backtests (
      id           SERIAL PRIMARY KEY,
      strategy_id  INTEGER NOT NULL UNIQUE REFERENCES strategies(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      summary_json TEXT NOT NULL DEFAULT '{}',
      range_start  BIGINT,
      range_end    BIGINT,
      created_at   BIGINT NOT NULL,
      updated_at   BIGINT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_instances (
      id                     SERIAL PRIMARY KEY,
      user_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      strategy_id            INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
      hyperliquid_account_id INTEGER NOT NULL REFERENCES hyperliquid_accounts(id) ON DELETE CASCADE,
      asset                  VARCHAR(20) NOT NULL,
      timeframe              VARCHAR(20) NOT NULL DEFAULT '15m',
      params_json            TEXT NOT NULL DEFAULT '{}',
      leverage               INTEGER NOT NULL DEFAULT 10,
      margin_mode            VARCHAR(20) NOT NULL DEFAULT 'cross',
      size                   NUMERIC NOT NULL DEFAULT 0,
      stop_loss_pct          NUMERIC,
      take_profit_pct        NUMERIC,
      status                 VARCHAR(20) NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'active', 'paused', 'stopped', 'error')),
      last_candle_at         BIGINT,
      last_signal_hash       TEXT,
      last_error             TEXT,
      last_evaluated_at      BIGINT,
      last_signal_json       TEXT,
      created_at             BIGINT NOT NULL,
      updated_at             BIGINT NOT NULL
    )
  `);

  await pool.query(`
    ALTER TABLE bot_instances
      ADD COLUMN IF NOT EXISTS runtime_state VARCHAR(30) NOT NULL DEFAULT 'healthy'
        CHECK (runtime_state IN ('healthy', 'retrying', 'degraded', 'paused_by_system'))
  `);
  await pool.query('ALTER TABLE bot_instances ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE bot_instances ADD COLUMN IF NOT EXISTS next_retry_at BIGINT');
  await pool.query('ALTER TABLE bot_instances ADD COLUMN IF NOT EXISTS last_recovery_at BIGINT');
  await pool.query('ALTER TABLE bot_instances ADD COLUMN IF NOT EXISTS last_recovery_action TEXT');
  await pool.query('ALTER TABLE bot_instances ADD COLUMN IF NOT EXISTS system_pause_reason TEXT');
  await pool.query(`ALTER TABLE bot_instances ADD COLUMN IF NOT EXISTS runtime_context_json TEXT NOT NULL DEFAULT '{}'`);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS bot_instances_active_asset_unique
      ON bot_instances(user_id, hyperliquid_account_id, asset)
      WHERE status = 'active'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_runs (
      id              SERIAL PRIMARY KEY,
      bot_instance_id INTEGER NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status          VARCHAR(20) NOT NULL,
      action          VARCHAR(50) NOT NULL,
      signal_json     TEXT,
      candle_time     BIGINT,
      price           NUMERIC,
      details_json    TEXT NOT NULL DEFAULT '{}',
      created_at      BIGINT NOT NULL
    )
  `);

  await migrateLegacyData();
  logger.info('db_schema_initialized');
}

async function migrateLegacyData() {
  const { rows } = await pool.query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
  const admin = rows[0];
  if (!admin) return;

  await pool.query('UPDATE hedges SET user_id = $1 WHERE user_id IS NULL', [admin.id]);
  await pool.query('UPDATE settings SET user_id = $1 WHERE user_id IS NULL', [admin.id]);
}

async function seedDevAdmin({
  username = 'admin',
  password = 'admin123',
  name = 'Administrador',
} = {}) {
  const { rows } = await pool.query('SELECT id FROM users LIMIT 1');
  if (rows.length > 0) return; // ya hay usuarios

  const now = Date.now();
  const hash = await bcrypt.hash(password, 12);
  const { rows: [admin] } = await pool.query(
    `INSERT INTO users (username, password_hash, name, role, active, created_at, updated_at)
     VALUES ($1, $2, $3, 'superuser', true, $4, $4) RETURNING id`,
    [username, hash, name, now]
  );

  await migrateLegacyData();
  logger.info('dev_admin_seeded', { userId: admin.id, username });
  return admin;
}

module.exports = {
  query,
  ensureConnection,
  initSchema,
  migrateLegacyData,
  seedDevAdmin,
  pool,
};
