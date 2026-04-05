ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS time_in_range_ms BIGINT NOT NULL DEFAULT 0;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS time_tracked_ms BIGINT NOT NULL DEFAULT 0;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS time_in_range_pct NUMERIC;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS range_last_state_in_range BOOLEAN;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS range_last_state_at BIGINT;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS range_computed_at BIGINT;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS range_frozen_at BIGINT;
