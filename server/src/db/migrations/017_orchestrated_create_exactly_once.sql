-- Exclusión mutua persistente para operaciones largas y propiedad de los
-- recursos creados por la saga. Los row locks de FOR UPDATE no sobreviven al
-- COMMIT; el lease sí, por lo que HTTP y worker no pueden ejecutar la misma
-- intención al mismo tiempo.

ALTER TABLE position_action_operations
  ADD COLUMN IF NOT EXISTS claim_token TEXT;

ALTER TABLE position_action_operations
  ADD COLUMN IF NOT EXISTS claim_owner TEXT;

ALTER TABLE position_action_operations
  ADD COLUMN IF NOT EXISTS claim_lease_until BIGINT;

ALTER TABLE position_action_operations
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_position_action_operations_claimable
  ON position_action_operations(status, claim_lease_until, updated_at, id)
  WHERE status IN (
    'queued', 'waiting_receipts', 'refreshing_snapshot',
    'migrating_protection', 'committing'
  );

ALTER TABLE lp_orchestrators
  ADD COLUMN IF NOT EXISTS creation_operation_id BIGINT
  REFERENCES position_action_operations(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS lp_orchestrators_creation_operation_unique
  ON lp_orchestrators(creation_operation_id)
  WHERE creation_operation_id IS NOT NULL;

ALTER TABLE protected_uniswap_pools
  ADD COLUMN IF NOT EXISTS creation_operation_id BIGINT
  REFERENCES position_action_operations(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS protected_pools_creation_operation_unique
  ON protected_uniswap_pools(creation_operation_id)
  WHERE creation_operation_id IS NOT NULL;
