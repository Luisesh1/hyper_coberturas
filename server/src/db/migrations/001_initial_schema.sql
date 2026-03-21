-- 001_initial_schema.sql
-- Esquema completo consolidado. Todas las sentencias son idempotentes.

-- ── Tabla de usuarios ──────────────────────────────────────────────
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
);

-- ── Cuentas Hyperliquid por usuario ───────────────────────────────
CREATE TABLE IF NOT EXISTS hyperliquid_accounts (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias                 VARCHAR(255) NOT NULL,
  address               VARCHAR(255) NOT NULL,
  private_key_encrypted TEXT,
  is_default            BOOLEAN NOT NULL DEFAULT false,
  created_at            BIGINT NOT NULL,
  updated_at            BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS hyperliquid_accounts_user_address
  ON hyperliquid_accounts(user_id, lower(address));
CREATE UNIQUE INDEX IF NOT EXISTS hyperliquid_accounts_default_once
  ON hyperliquid_accounts(user_id)
  WHERE is_default = true;

-- ── Tabla de coberturas ────────────────────────────────────────────
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
  dynamic_anchor_price NUMERIC,
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
  last_reconciled_at BIGINT,
  protected_pool_id INTEGER,
  protected_role VARCHAR(20)
);

-- ── Pools Uniswap protegidos ─────────────────────────────────────
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
  protection_mode        VARCHAR(20) NOT NULL DEFAULT 'static',
  reentry_buffer_pct     NUMERIC,
  flip_cooldown_sec      INTEGER,
  max_sequential_flips   INTEGER,
  breakout_confirm_distance_pct NUMERIC,
  breakout_confirm_duration_sec INTEGER,
  dynamic_state_json     TEXT,
  value_mode             VARCHAR(20) NOT NULL DEFAULT 'usd',
  leverage               INTEGER NOT NULL,
  margin_mode            VARCHAR(20) NOT NULL DEFAULT 'isolated',
  status                 VARCHAR(20) NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'inactive')),
  pool_snapshot_json     TEXT NOT NULL,
  created_at             BIGINT NOT NULL,
  updated_at             BIGINT NOT NULL,
  deactivated_at         BIGINT
);

-- FK de hedges a protected_uniswap_pools (debe crearse después de ambas tablas)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'hedges_protected_pool_id_fkey'
  ) THEN
    ALTER TABLE hedges ADD CONSTRAINT hedges_protected_pool_id_fkey
      FOREIGN KEY (protected_pool_id) REFERENCES protected_uniswap_pools(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Índices de hedges
CREATE INDEX IF NOT EXISTS hedges_protected_pool_idx ON hedges(protected_pool_id);
CREATE INDEX IF NOT EXISTS hedges_user_account_idx ON hedges(user_id, hyperliquid_account_id);
CREATE INDEX IF NOT EXISTS hedges_status_idx ON hedges(status);

-- Índices de protected_uniswap_pools
CREATE UNIQUE INDEX IF NOT EXISTS protected_uniswap_pools_active_identity
  ON protected_uniswap_pools(user_id, network, version, lower(wallet_address), position_identifier)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS protected_uniswap_pools_status_mode_updated_idx
  ON protected_uniswap_pools(status, protection_mode, updated_at DESC);

-- ── Tabla de ciclos ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cycles (
  id          SERIAL  PRIMARY KEY,
  hedge_id    INTEGER NOT NULL REFERENCES hedges(id) ON DELETE CASCADE,
  cycle_id    INTEGER NOT NULL,
  open_price  NUMERIC,
  close_price NUMERIC,
  opened_at   BIGINT,
  closed_at   BIGINT,
  entry_fee    NUMERIC NOT NULL DEFAULT 0,
  exit_fee     NUMERIC NOT NULL DEFAULT 0,
  closed_pnl   NUMERIC,
  funding_paid NUMERIC NOT NULL DEFAULT 0,
  entry_fill_oid BIGINT,
  exit_fill_oid  BIGINT,
  entry_fill_time BIGINT,
  exit_fill_time  BIGINT,
  entry_slippage  NUMERIC NOT NULL DEFAULT 0,
  exit_slippage   NUMERIC NOT NULL DEFAULT 0,
  total_slippage  NUMERIC NOT NULL DEFAULT 0,
  net_pnl         NUMERIC
);
CREATE INDEX IF NOT EXISTS cycles_hedge_id_idx ON cycles(hedge_id);

-- ── Tabla de configuración ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key        VARCHAR(100) NOT NULL,
  user_id    INTEGER REFERENCES users(id),
  value      TEXT         NOT NULL,
  updated_at BIGINT       NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS settings_user_key ON settings(user_id, key);

-- ── Estrategias automatizadas ─────────────────────────────────────
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
);

CREATE TABLE IF NOT EXISTS strategy_indicators (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  VARCHAR(255) NOT NULL,
  slug                  VARCHAR(120) NOT NULL,
  script_source         TEXT NOT NULL,
  parameter_schema_json TEXT NOT NULL DEFAULT '{}',
  created_at            BIGINT NOT NULL,
  updated_at            BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_indicators_user_slug
  ON strategy_indicators(user_id, slug);

CREATE TABLE IF NOT EXISTS strategy_backtests (
  id           SERIAL PRIMARY KEY,
  strategy_id  INTEGER NOT NULL UNIQUE REFERENCES strategies(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary_json TEXT NOT NULL DEFAULT '{}',
  range_start  BIGINT,
  range_end    BIGINT,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);

-- ── Bots ──────────────────────────────────────────────────────────
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
  runtime_state          VARCHAR(30) NOT NULL DEFAULT 'healthy'
                         CHECK (runtime_state IN ('healthy', 'retrying', 'degraded', 'paused_by_system')),
  consecutive_failures   INTEGER NOT NULL DEFAULT 0,
  next_retry_at          BIGINT,
  last_recovery_at       BIGINT,
  last_recovery_action   TEXT,
  system_pause_reason    TEXT,
  runtime_context_json   TEXT NOT NULL DEFAULT '{}',
  created_at             BIGINT NOT NULL,
  updated_at             BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bot_instances_active_asset_unique
  ON bot_instances(user_id, hyperliquid_account_id, asset)
  WHERE status = 'active';

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
);
