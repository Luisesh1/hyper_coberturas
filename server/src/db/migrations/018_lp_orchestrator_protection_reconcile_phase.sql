-- Estado fail-closed usado cuando un orquestador conserva un LP activo pero
-- la protección vinculada falta, está inactiva o no es delta-neutral.

ALTER TABLE lp_orchestrators
  DROP CONSTRAINT IF EXISTS lp_orchestrators_phase_check;

ALTER TABLE lp_orchestrators
  ADD CONSTRAINT lp_orchestrators_phase_check
  CHECK (phase IN (
    'idle',
    'lp_active',
    'evaluating',
    'needs_rebalance',
    'urgent_adjust',
    'executing',
    'verifying',
    'failed',
    'complete',
    'protection_reconcile_required'
  ));
