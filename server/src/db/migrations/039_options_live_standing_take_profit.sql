-- TP LIMIT residente: toda orden tiene identidad durable antes del POST.
-- No modifica flags de trading. No reenvía POST ambiguos.
ALTER TABLE options_live_orders
  ADD COLUMN IF NOT EXISTS purpose VARCHAR(20) NOT NULL DEFAULT 'standard'
    CHECK (purpose IN ('standard','take_profit'));
ALTER TABLE options_live_orders
  ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS options_live_single_active_tp_per_position
  ON options_live_orders(position_id)
  WHERE purpose='take_profit' AND status <> 'final';

CREATE INDEX IF NOT EXISTS options_live_tp_queue_idx
  ON options_live_orders(purpose,status,id)
  WHERE purpose='take_profit' AND status='queued';

-- El stop, cierre por señal o salida temporal sobreviven al reinicio y
-- deben consumarse después de cancelar y conciliar el TP resting.
CREATE TABLE IF NOT EXISTS options_live_exit_requests (
  id BIGSERIAL PRIMARY KEY,
  position_id BIGINT NOT NULL UNIQUE
    REFERENCES options_strategy_positions(id) ON DELETE RESTRICT,
  strategy_id BIGINT NOT NULL REFERENCES options_strategies(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL,
  reason VARCHAR(80) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS options_live_exit_requests_strategy_idx
  ON options_live_exit_requests(strategy_id,created_at);

COMMENT ON TABLE options_live_exit_requests IS
  'Solicitud durable de cierre mientras se cancela y concilia un take-profit LIMIT; no implica ejecución.';
