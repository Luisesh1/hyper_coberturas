-- La ausencia histórica se interpreta como legacy. La columna queda nullable
-- para distinguir los registros previos de una selección explícita nueva.
ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS policy_version TEXT NULL,
  ADD COLUMN IF NOT EXISTS half_width_pct NUMERIC NULL;

ALTER TABLE protected_uniswap_pools
  ADD CONSTRAINT protected_uniswap_pools_policy_version_check
  CHECK (policy_version IS NULL OR policy_version IN ('legacy_zones_v1', 'net_profit_v1'));
