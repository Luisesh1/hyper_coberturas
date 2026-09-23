-- Quien goberno cada tick.
--
-- Una politica anulada en el 100% de los ticks se leia igual que una que manda:
-- el registro guardaba QUE se decidio, nunca QUIEN lo decidio.
--
-- Medido en pp28 el 2026-09-23: de 37 ejecuciones de una proteccion
-- `range_exit_v1`, CERO llevaban una compuerta suya como motivo. Todas venian
-- del cap, de las compuertas de riesgo o de strings legacy. La politica
-- decidia y otro se atribuia el porque, asi que la pregunta "¿que fraccion de
-- las ordenes las decidio su politica?" no tenia respuesta posible.
--
-- Valores: policy · force · naked_cap · risk_gate · min_dwell · confidence_gate
ALTER TABLE protection_decision_log
  ADD COLUMN IF NOT EXISTS decision_owner VARCHAR(24);

-- Para responder la pregunta por proteccion y ventana sin escanear la tabla
-- entera, que es la mas grande del esquema.
CREATE INDEX IF NOT EXISTS protection_decision_log_owner_idx
  ON protection_decision_log (protected_pool_id, decision_owner, created_at DESC);
