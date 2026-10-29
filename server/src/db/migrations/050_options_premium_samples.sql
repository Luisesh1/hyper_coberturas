-- Recorrido de la prima de cada posición: una fila por pasada del muestreador
-- (cada minuto) con el bid, el ask y el índice del subyacente. Alimenta el
-- simulador de salidas. Se purga a los 120 días.
CREATE TABLE IF NOT EXISTS options_premium_samples (
  position_id BIGINT NOT NULL REFERENCES options_strategy_positions(id) ON DELETE CASCADE,
  sampled_at BIGINT NOT NULL,
  bid NUMERIC(24, 8) NULL,
  ask NUMERIC(24, 8) NULL,
  spot NUMERIC(24, 8) NULL,
  PRIMARY KEY (position_id, sampled_at)
);
CREATE INDEX IF NOT EXISTS idx_options_premium_samples_sampled_at ON options_premium_samples (sampled_at);
