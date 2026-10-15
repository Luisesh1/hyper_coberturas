-- Ledger duradero para órdenes LIMIT Binance Opciones (ventana 10 minutos).
-- Las órdenes se registran ANTES del POST y los fills se concilian
-- transaccionalmente; una respuesta ACCEPTED nunca se convierte en posición.
CREATE TABLE IF NOT EXISTS options_live_batches (
  id BIGSERIAL PRIMARY KEY,
  strategy_id BIGINT NOT NULL REFERENCES options_strategies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  action_key TEXT NOT NULL,
  action VARCHAR(5) NOT NULL CHECK (action IN ('open', 'close')),
  detail TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'attention')),
  created_at BIGINT NOT NULL,
  deadline_at BIGINT NOT NULL,
  UNIQUE (strategy_id, action_key)
);

CREATE INDEX IF NOT EXISTS options_live_batches_pending_idx
 ON options_live_batches (status, deadline_at) WHERE status <> 'completed';

CREATE TABLE IF NOT EXISTS options_live_orders (
  id BIGSERIAL PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES options_live_batches(id) ON DELETE CASCADE,
  strategy_id BIGINT NOT NULL REFERENCES options_strategies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  action VARCHAR(5) NOT NULL CHECK (action IN ('open','close')),
  position_id BIGINT REFERENCES options_strategy_positions(id),
  symbol VARCHAR(80) NOT NULL,
  side VARCHAR(4) NOT NULL CHECK (side IN ('BUY','SELL')),
  requested_qty NUMERIC(30,12) NOT NULL CHECK (requested_qty > 0),
  limit_price NUMERIC(30,12) NOT NULL CHECK (limit_price > 0),
  client_order_id VARCHAR(64) NOT NULL UNIQUE,
  exchange_order_id VARCHAR(80),
  status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','active','final','attention')),
  processed_qty NUMERIC(30,12) NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  deadline_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  reconcile_lease_until BIGINT NOT NULL DEFAULT 0,
  last_error TEXT,
  CHECK (processed_qty >= 0 AND processed_qty <= requested_qty)
);

CREATE INDEX IF NOT EXISTS options_live_orders_pending_idx
 ON options_live_orders (status, deadline_at) WHERE status <> 'final';

CREATE INDEX IF NOT EXISTS options_live_orders_strategy_idx
 ON options_live_orders (strategy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS options_live_fills (
  id BIGSERIAL PRIMARY KEY,
  live_order_id BIGINT NOT NULL REFERENCES options_live_orders(id) ON DELETE CASCADE,
  trade_id VARCHAR(80) NOT NULL,
  quantity NUMERIC(30,12) NOT NULL CHECK (quantity > 0),
  price NUMERIC(30,12) NOT NULL CHECK (price > 0),
  fee_usdt NUMERIC(30,12) NOT NULL DEFAULT 0,
  traded_at BIGINT NOT NULL,
  UNIQUE (live_order_id, trade_id)
);
