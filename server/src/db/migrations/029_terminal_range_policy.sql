-- `terminal_range_v1`: cobertura por borde con objetivo terminal (secante al
-- abrir, solver g(q)=0 tras desplazamiento confirmado). Migracion nueva y no
-- edicion de la 025: las bases ya migradas no vuelven a correr la historica.
-- Conserva todos los valores anteriores y NULL.
ALTER TABLE protected_uniswap_pools
  DROP CONSTRAINT IF EXISTS protected_uniswap_pools_policy_version_check;

ALTER TABLE protected_uniswap_pools
  ADD CONSTRAINT protected_uniswap_pools_policy_version_check
  CHECK (
    policy_version IS NULL
    OR policy_version IN (
      'legacy_zones_v1',
      'net_profit_v1',
      'net_profit_v2',
      'range_exit_v1',
      'terminal_range_v1'
    )
  );
