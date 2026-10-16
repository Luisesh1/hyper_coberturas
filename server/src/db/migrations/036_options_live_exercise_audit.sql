-- Evidencia durable e idempotente de ejercicio/expiración REAL.
-- Nunca marcar posiciones cerradas con precios índice sintéticos.
CREATE TABLE IF NOT EXISTS options_live_exercises (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  exercise_record_id VARCHAR(80) NOT NULL,
  symbol VARCHAR(80) NOT NULL,
  position_side VARCHAR(5) NOT NULL CHECK (position_side IN ('LONG','SHORT')),
  quantity NUMERIC(30,12) NOT NULL CHECK (quantity > 0),
  payoff_usdt NUMERIC(30,12) NOT NULL CHECK (payoff_usdt >= 0),
  fee_usdt NUMERIC(30,12) NOT NULL CHECK (fee_usdt >= 0),
  exercised_at BIGINT NOT NULL,
  reconciled_at BIGINT NOT NULL,
  UNIQUE (user_id, exercise_record_id)
);
CREATE INDEX IF NOT EXISTS options_live_exercises_symbol_idx
  ON options_live_exercises (user_id, symbol, exercised_at DESC);
