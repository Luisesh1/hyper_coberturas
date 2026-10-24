-- Entradas de los bots por alertas como LIMIT GTC al precio medio.
-- Spec: docs/superpowers/specs/2026-10-23-options-mid-gtc-entries-design.md

-- Modo sombra: la entrada simulada espera los mismos diez minutos que la
-- real. Se llena si la cotización alcanza el límite; si no, caduca.
CREATE TABLE IF NOT EXISTS options_shadow_entries (
  id BIGSERIAL PRIMARY KEY,
  strategy_id BIGINT NOT NULL REFERENCES options_strategies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  -- Señal que originó la entrada (NULL si no la hay).
  auto_signal_id BIGINT,
  alert_event_id BIGINT,
  symbol VARCHAR(80) NOT NULL,
  side VARCHAR(4) NOT NULL CHECK (side IN ('BUY','SELL')),
  option_type VARCHAR(10) NOT NULL,
  quantity NUMERIC(30,12) NOT NULL CHECK (quantity > 0),
  limit_price NUMERIC(30,12) NOT NULL CHECK (limit_price > 0),
  -- Spot del subyacente al crear la entrada (informativo).
  spot NUMERIC,
  deadline_at BIGINT NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','filled','expired','canceled')),
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);
CREATE INDEX IF NOT EXISTS options_shadow_entries_pending_idx
  ON options_shadow_entries (strategy_id, deadline_at) WHERE status='pending';

-- Comisión de cada señal: real (fills conciliados) o estimada (sombra o
-- mientras la orden está pendiente).
ALTER TABLE options_auto_signals ADD COLUMN IF NOT EXISTS fees_usdt NUMERIC NULL;
ALTER TABLE options_auto_signals
  ADD COLUMN IF NOT EXISTS fees_estimated BOOLEAN NOT NULL DEFAULT FALSE;

-- El lote real de entrada sabe qué señal resolver al terminar.
ALTER TABLE options_live_batches ADD COLUMN IF NOT EXISTS auto_signal_id BIGINT NULL;

-- Cola durable: 'reentry' (giro tras cerrar posiciones, como hasta ahora) o
-- 'reevaluate' (señal contraria que espera a que las entradas canceladas
-- queden finales antes de volver a evaluarse).
ALTER TABLE options_live_reentries
  ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'reentry'
    CHECK (kind IN ('reentry','reevaluate'));
ALTER TABLE options_live_reentries
  ADD COLUMN IF NOT EXISTS wait_order_ids BIGINT[] NOT NULL DEFAULT '{}';
