CREATE TABLE IF NOT EXISTS position_action_operations (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL UNIQUE,
  kind VARCHAR(32) NOT NULL CHECK (kind IN ('position_action', 'claim_fees')),
  action VARCHAR(64) NOT NULL,
  network VARCHAR(64) NOT NULL,
  version VARCHAR(8) NOT NULL,
  wallet_address VARCHAR(255) NOT NULL,
  position_identifier VARCHAR(255),
  tx_hashes_json TEXT NOT NULL,
  status VARCHAR(64) NOT NULL CHECK (
    status IN (
      'queued',
      'waiting_receipts',
      'refreshing_snapshot',
      'migrating_protection',
      'done',
      'failed',
      'needs_reconcile'
    )
  ),
  step VARCHAR(64) NOT NULL,
  result_json TEXT,
  error_code VARCHAR(128),
  error_message TEXT,
  replacement_map_json TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  finished_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_position_action_operations_user_id
  ON position_action_operations(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_position_action_operations_status
  ON position_action_operations(status, updated_at ASC);

