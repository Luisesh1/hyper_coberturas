-- Track cumulative time-in-range for protected pools.
-- Each refresh cycle increments in_range_checks by 1.
-- If the pool is in range at that check, in_range_hits also increments by 1.
-- Percentage = (in_range_hits / in_range_checks) * 100.

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS in_range_checks INTEGER NOT NULL DEFAULT 0;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS in_range_hits INTEGER NOT NULL DEFAULT 0;
