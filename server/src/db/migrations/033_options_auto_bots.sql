-- Trading automatizado por alertas: bots de opciones (template `alert_signal`)
-- y el registro de señales recibidas con la decisión que tomó cada bot.
-- Spec: docs/superpowers/specs/2026-10-15-alert-auto-trading-design.md

ALTER TABLE options_strategies
  DROP CONSTRAINT IF EXISTS options_strategies_template_check;

ALTER TABLE options_strategies
  ADD CONSTRAINT options_strategies_template_check
  CHECK (template IN ('short_strangle', 'covered_call', 'protective_put', 'alert_signal'));

CREATE TABLE IF NOT EXISTS options_auto_signals (
  id              BIGSERIAL PRIMARY KEY,
  strategy_id     BIGINT NOT NULL REFERENCES options_strategies(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL,
  alert_id        INTEGER,
  -- Id del disparo (alert_events.id): un mismo disparo no se procesa dos veces.
  alert_event_id  BIGINT,
  alert_name      VARCHAR(255),
  direction       VARCHAR(10),
  asset           VARCHAR(40),
  score           NUMERIC,
  decision        VARCHAR(12) NOT NULL
    CHECK (decision IN ('opened', 'closed', 'reversed', 'ignored', 'error')),
  detail          TEXT,
  created_at      BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS options_auto_signals_strategy_idx
  ON options_auto_signals (strategy_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS options_auto_signals_event_uidx
  ON options_auto_signals (strategy_id, alert_event_id);
