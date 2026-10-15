-- Módulo de opciones (Binance European Options): estrategias paramétricas con
-- modo sombra/real, sus posiciones y eventos, snapshots horarios de la cadena
-- (IV) para backtests y las tareas de backtesting.
-- Spec: docs/superpowers/specs/2026-10-14-options-module-design.md

CREATE TABLE IF NOT EXISTS options_strategies (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  name        VARCHAR(120) NOT NULL,
  template    VARCHAR(40) NOT NULL
    CHECK (template IN ('short_strangle', 'covered_call', 'protective_put')),
  underlying  VARCHAR(20) NOT NULL,
  params      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Límites propios de la estrategia (margen, pérdida diaria, Δ neto, órdenes/día).
  limits      JSONB NOT NULL DEFAULT '{}'::jsonb,
  mode        VARCHAR(10) NOT NULL DEFAULT 'paused'
    CHECK (mode IN ('paused', 'shadow', 'live')),
  -- Estado interno del runner (último motivo registrado por modo, etc.).
  state       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS options_strategies_user_idx
  ON options_strategies (user_id, id);

CREATE INDEX IF NOT EXISTS options_strategies_active_idx
  ON options_strategies (mode)
  WHERE mode IN ('shadow', 'live');

CREATE TABLE IF NOT EXISTS options_strategy_positions (
  id           BIGSERIAL PRIMARY KEY,
  strategy_id  BIGINT NOT NULL REFERENCES options_strategies(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL,
  mode         VARCHAR(10) NOT NULL CHECK (mode IN ('shadow', 'live')),
  symbol       VARCHAR(40) NOT NULL,
  side         VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity     NUMERIC(24, 8) NOT NULL CHECK (quantity > 0),
  entry_price  NUMERIC(24, 8) NOT NULL,
  exit_price   NUMERIC(24, 8),
  opened_at    BIGINT NOT NULL,
  closed_at    BIGINT,
  -- PnL neto de comisiones (entrada + salida) al cerrar.
  pnl_usdt     NUMERIC(24, 8),
  fees_usdt    NUMERIC(24, 8) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS options_strategy_positions_open_idx
  ON options_strategy_positions (strategy_id, mode)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS options_strategy_positions_user_idx
  ON options_strategy_positions (user_id, mode, closed_at);

CREATE TABLE IF NOT EXISTS options_strategy_events (
  id            BIGSERIAL PRIMARY KEY,
  strategy_id   BIGINT NOT NULL REFERENCES options_strategies(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL,
  mode          VARCHAR(10) NOT NULL CHECK (mode IN ('shadow', 'live')),
  action        VARCHAR(10) NOT NULL CHECK (action IN ('open', 'close', 'hold', 'skip', 'error')),
  detail        TEXT,
  legs          JSONB,
  -- Prima neta del evento: positiva si se cobra, negativa si se paga.
  premium_usdt  NUMERIC(24, 8),
  created_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS options_strategy_events_strategy_idx
  ON options_strategy_events (strategy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS options_iv_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  underlying   VARCHAR(20) NOT NULL,
  symbol       VARCHAR(40) NOT NULL,
  expiry       VARCHAR(6) NOT NULL,
  strike       NUMERIC(24, 8) NOT NULL,
  type         CHAR(1) NOT NULL CHECK (type IN ('C', 'P')),
  bid          NUMERIC(24, 8),
  ask          NUMERIC(24, 8),
  mark         NUMERIC(24, 8),
  iv           NUMERIC(12, 6),
  delta        NUMERIC(12, 6),
  spot         NUMERIC(24, 8) NOT NULL,
  captured_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS options_iv_snapshots_underlying_idx
  ON options_iv_snapshots (underlying, captured_at);

CREATE INDEX IF NOT EXISTS options_iv_snapshots_captured_idx
  ON options_iv_snapshots (captured_at);

CREATE TABLE IF NOT EXISTS options_backtests (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  strategy_id  BIGINT REFERENCES options_strategies(id) ON DELETE SET NULL,
  config       JSONB NOT NULL,
  status       VARCHAR(10) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed')),
  result       JSONB,
  error        TEXT,
  created_at   BIGINT NOT NULL,
  finished_at  BIGINT
);

CREATE INDEX IF NOT EXISTS options_backtests_user_idx
  ON options_backtests (user_id, created_at DESC);
