ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS last_onchain_action VARCHAR(40);

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS last_tx_hash VARCHAR(255);

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS last_tx_at BIGINT;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS replaced_by_position_identifier VARCHAR(255);

CREATE INDEX IF NOT EXISTS protected_uniswap_pools_last_tx_at_idx
  ON protected_uniswap_pools(last_tx_at DESC);
