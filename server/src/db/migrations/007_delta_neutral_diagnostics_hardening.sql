ALTER TABLE protection_decision_log
  ADD COLUMN IF NOT EXISTS final_strategy_status VARCHAR(40);

ALTER TABLE protection_decision_log
  ADD COLUMN IF NOT EXISTS risk_gate_triggered BOOLEAN;

ALTER TABLE protection_decision_log
  ADD COLUMN IF NOT EXISTS liquidation_distance_pct NUMERIC;
