-- Sistema de alertas multi-regla por usuario.
--
--   alerts        : configuración (reglas, umbral, lista de activos, cooldown)
--   alert_events  : historial de disparos (uno por activo/cierre de vela)
--
-- last_triggered_at_json es JSONB para permitir UPDATE atómico vía
-- jsonb_set sobre la clave del activo (cooldown por activo, no global).

CREATE TABLE IF NOT EXISTS alerts (
  id                       SERIAL PRIMARY KEY,
  user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                     VARCHAR(255) NOT NULL,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  threshold_percent        NUMERIC NOT NULL DEFAULT 70
                           CHECK (threshold_percent >= 0 AND threshold_percent <= 100),
  asset_list_json          TEXT NOT NULL DEFAULT '["BTCUSDT"]',
  rules_json               TEXT NOT NULL DEFAULT '[]',
  telegram_enabled         BOOLEAN NOT NULL DEFAULT true,
  cooldown_seconds         INTEGER NOT NULL DEFAULT 900 CHECK (cooldown_seconds >= 0),
  last_triggered_at_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  datasource               VARCHAR(20) NOT NULL DEFAULT 'binance',
  created_at               BIGINT NOT NULL,
  updated_at               BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_user_idx   ON alerts(user_id);
CREATE INDEX IF NOT EXISTS alerts_active_idx ON alerts(is_active);

CREATE TABLE IF NOT EXISTS alert_events (
  id                  SERIAL PRIMARY KEY,
  alert_id            INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset               VARCHAR(40) NOT NULL,
  timeframe           VARCHAR(20) NOT NULL,
  candle_close_time   BIGINT NOT NULL,
  score               NUMERIC NOT NULL,
  threshold_percent   NUMERIC NOT NULL,
  matched_rules_json  TEXT NOT NULL DEFAULT '[]',
  message_text        TEXT,
  telegram_sent       BOOLEAN NOT NULL DEFAULT false,
  telegram_error      TEXT,
  created_at          BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS alert_events_alert_idx ON alert_events(alert_id, created_at DESC);
CREATE INDEX IF NOT EXISTS alert_events_user_idx  ON alert_events(user_id,  created_at DESC);
