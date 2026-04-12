INSERT INTO settings (user_id, key, value, updated_at)
SELECT
  users.id,
  'delta_neutral_risk_controls',
  '{"riskPauseLiqDistancePct":7,"marginTopUpLiqDistancePct":10}',
  (EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
FROM users
ON CONFLICT (user_id, key) DO NOTHING;
