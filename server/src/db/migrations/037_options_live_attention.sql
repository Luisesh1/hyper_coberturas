-- Alertas persistentes y con rate-limit para posiciones/órdenes sin conciliar.
-- El timestamp se actualiza atómicamente entre réplicas.
ALTER TABLE options_live_orders
  ADD COLUMN IF NOT EXISTS attention_notified_at BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS options_live_attention_idx
  ON options_live_orders(attention_notified_at, created_at)
  WHERE status='attention';
