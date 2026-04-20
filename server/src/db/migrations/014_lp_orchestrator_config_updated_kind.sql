-- Permite registrar ediciones de configuración del orquestador en el
-- action log. El CHECK original (migración 008) solo aceptaba los 10
-- kinds del ciclo de vida del LP; 'config_updated' se añade para el
-- endpoint PATCH /lp-orchestrators/:id/config.

ALTER TABLE lp_orchestrator_action_log
  DROP CONSTRAINT IF EXISTS lp_orchestrator_action_log_kind_check;

ALTER TABLE lp_orchestrator_action_log
  ADD CONSTRAINT lp_orchestrator_action_log_kind_check
  CHECK (kind IN (
    'decision',
    'tx_started',
    'tx_finalized',
    'verification',
    'recovery',
    'notification',
    'accounting_snapshot',
    'attach_lp',
    'kill_lp',
    'archive',
    'config_updated'
  ));
