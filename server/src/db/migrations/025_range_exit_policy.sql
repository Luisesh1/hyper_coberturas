-- `range_exit_v1` ya se podia elegir en el wizard y ya estaba cableada en el
-- tick, pero la restriccion de la columna la habria rechazado al persistir.
-- Sin esta migracion la seleccion se degradaba a legacy en silencio.
ALTER TABLE protected_uniswap_pools
  DROP CONSTRAINT IF EXISTS protected_uniswap_pools_policy_version_check;

ALTER TABLE protected_uniswap_pools
  ADD CONSTRAINT protected_uniswap_pools_policy_version_check
  CHECK (
    policy_version IS NULL
    OR policy_version IN ('legacy_zones_v1', 'net_profit_v1', 'net_profit_v2', 'range_exit_v1')
  );
