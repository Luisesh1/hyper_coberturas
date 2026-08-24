-- Net Profit V2 ya se valida en aplicación; esta migración evita que una
-- creación legítima falle al persistir la nueva versión de política.
ALTER TABLE protected_uniswap_pools
  DROP CONSTRAINT IF EXISTS protected_uniswap_pools_policy_version_check;

ALTER TABLE protected_uniswap_pools
  ADD CONSTRAINT protected_uniswap_pools_policy_version_check
  CHECK (
    policy_version IS NULL
    OR policy_version IN ('legacy_zones_v1', 'net_profit_v1', 'net_profit_v2')
  );
