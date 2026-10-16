-- Las reversiones tras una señal contraria solo pueden abrir cuando el
-- cierre y la cancelación del TP han sido confirmados. Durable al reiniciar.
CREATE TABLE IF NOT EXISTS options_live_reentries (
  id BIGSERIAL PRIMARY KEY,
  strategy_id BIGINT NOT NULL REFERENCES options_strategies(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL,
  alert_event_id BIGINT NOT NULL,
  signal JSONB NOT NULL,
  wait_position_ids BIGINT[] NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','submitted','expired')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(strategy_id, alert_event_id)
);
CREATE INDEX IF NOT EXISTS options_live_reentries_pending_idx
  ON options_live_reentries(status,created_at) WHERE status='pending';
