ALTER TABLE protected_uniswap_pools ADD COLUMN IF NOT EXISTS initial_configured_hedge_notional_usd NUMERIC;
ALTER TABLE protected_uniswap_pools ADD COLUMN IF NOT EXISTS band_mode VARCHAR(20);
ALTER TABLE protected_uniswap_pools ADD COLUMN IF NOT EXISTS base_rebalance_price_move_pct NUMERIC;
ALTER TABLE protected_uniswap_pools ADD COLUMN IF NOT EXISTS rebalance_interval_sec INTEGER;
ALTER TABLE protected_uniswap_pools ADD COLUMN IF NOT EXISTS target_hedge_ratio NUMERIC;
ALTER TABLE protected_uniswap_pools ADD COLUMN IF NOT EXISTS min_rebalance_notional_usd NUMERIC;
ALTER TABLE protected_uniswap_pools ADD COLUMN IF NOT EXISTS max_slippage_bps INTEGER;
ALTER TABLE protected_uniswap_pools ADD COLUMN IF NOT EXISTS twap_min_notional_usd NUMERIC;
ALTER TABLE protected_uniswap_pools ADD COLUMN IF NOT EXISTS strategy_state_json TEXT;

UPDATE protected_uniswap_pools
   SET initial_configured_hedge_notional_usd = configured_hedge_notional_usd
 WHERE initial_configured_hedge_notional_usd IS NULL;

CREATE TABLE IF NOT EXISTS protected_pool_delta_rebalance_log (
  id                     SERIAL PRIMARY KEY,
  protected_pool_id      INTEGER NOT NULL REFERENCES protected_uniswap_pools(id) ON DELETE CASCADE,
  reason                 VARCHAR(40) NOT NULL,
  execution_mode         VARCHAR(10) NOT NULL,
  twap_slices_planned    INTEGER,
  twap_slices_completed  INTEGER,
  price                  NUMERIC,
  rv4h_pct               NUMERIC,
  rv24h_pct              NUMERIC,
  effective_band_pct     NUMERIC,
  delta_qty_before       NUMERIC,
  gamma_before           NUMERIC,
  target_qty_before      NUMERIC,
  actual_qty_before      NUMERIC,
  target_qty_after       NUMERIC,
  actual_qty_after       NUMERIC,
  drift_usd              NUMERIC,
  execution_fee_usd      NUMERIC,
  slippage_usd           NUMERIC,
  funding_snapshot_usd   NUMERIC,
  distance_to_liq_pct    NUMERIC,
  created_at             BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS protected_pool_delta_rebalance_log_pool_created_idx
  ON protected_pool_delta_rebalance_log(protected_pool_id, created_at DESC);
