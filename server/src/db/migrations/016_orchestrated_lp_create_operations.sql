-- La saga de creación de un LP orquestado reusa la cola de operaciones:
-- registra la intención ANTES de la primera firma, para que el worker pueda
-- terminar el commit (o compensarlo) si el cliente desaparece entre la firma
-- del mint y la confirmación.
--
-- Hacen falta tres cosas: un `kind` nuevo, sitio donde guardar el plan
-- completo del wizard, y los estados terminales de la compensación.

ALTER TABLE position_action_operations
  ADD COLUMN IF NOT EXISTS plan_json TEXT;

ALTER TABLE position_action_operations
  DROP CONSTRAINT IF EXISTS position_action_operations_kind_check;

ALTER TABLE position_action_operations
  ADD CONSTRAINT position_action_operations_kind_check
  CHECK (kind IN ('position_action', 'claim_fees', 'orchestrated_lp_create'));

ALTER TABLE position_action_operations
  DROP CONSTRAINT IF EXISTS position_action_operations_status_check;

ALTER TABLE position_action_operations
  ADD CONSTRAINT position_action_operations_status_check
  CHECK (
    status IN (
      'queued',
      'waiting_receipts',
      'refreshing_snapshot',
      'migrating_protection',
      -- Estados propios de la saga de creación orquestada.
      'awaiting_signature',
      'committing',
      'compensating',
      'compensated',
      'done',
      'failed',
      'needs_reconcile'
    )
  );

-- El worker busca intenciones firmadas pero sin commit; el índice evita
-- escanear la tabla entera en cada tick.
CREATE INDEX IF NOT EXISTS idx_position_action_operations_pending_kind
  ON position_action_operations(kind, status)
  WHERE status IN ('queued', 'awaiting_signature', 'committing');
