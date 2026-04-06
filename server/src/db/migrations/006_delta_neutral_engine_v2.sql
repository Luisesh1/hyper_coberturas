ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS strategy_engine_version VARCHAR(20) NOT NULL DEFAULT 'v1';

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS snapshot_status VARCHAR(40) NOT NULL DEFAULT 'ready';

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS snapshot_fresh_at BIGINT;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS snapshot_hash VARCHAR(64);

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS next_eligible_attempt_at BIGINT;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS cooldown_reason TEXT;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS last_decision VARCHAR(40);

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS last_decision_reason TEXT;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS tracking_error_qty NUMERIC;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS tracking_error_usd NUMERIC;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(20);

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS max_spread_bps INTEGER;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS max_execution_fee_usd NUMERIC;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS min_order_notional_usd NUMERIC;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS twap_slices INTEGER;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS twap_duration_sec INTEGER;

UPDATE protected_uniswap_pools
   SET strategy_engine_version = 'v2'
 WHERE protection_mode = 'delta_neutral'
   AND COALESCE(strategy_engine_version, 'v1') <> 'v2';

CREATE INDEX IF NOT EXISTS protected_uniswap_pools_delta_engine_idx
  ON protected_uniswap_pools(status, protection_mode, snapshot_status, next_eligible_attempt_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS protection_decision_log (
  id SERIAL PRIMARY KEY,
  protected_pool_id INTEGER NOT NULL REFERENCES protected_uniswap_pools(id) ON DELETE CASCADE,
  decision VARCHAR(40) NOT NULL,
  reason TEXT,
  strategy_status VARCHAR(40),
  spot_source VARCHAR(40),
  snapshot_status VARCHAR(40),
  snapshot_freshness_ms BIGINT,
  execution_skipped_because TEXT,
  execution_mode VARCHAR(20),
  estimated_cost_usd NUMERIC,
  realized_cost_usd NUMERIC,
  target_qty NUMERIC,
  actual_qty NUMERIC,
  tracking_error_qty NUMERIC,
  tracking_error_usd NUMERIC,
  current_price NUMERIC,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS protection_decision_log_pool_created_idx
  ON protection_decision_log(protected_pool_id, created_at DESC);
