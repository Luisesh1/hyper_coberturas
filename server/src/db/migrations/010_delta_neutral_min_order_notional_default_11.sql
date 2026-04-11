UPDATE protected_uniswap_pools
SET min_order_notional_usd = 11
WHERE protection_mode = 'delta_neutral'
  AND min_order_notional_usd = 25;
