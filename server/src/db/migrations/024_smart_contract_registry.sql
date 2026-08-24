-- Versiones inmutables de contratos que pueden ser seleccionados por la UI.
-- Una versión empieza en verification y sólo pasa a verified después de que
-- su despliegue y bytecode hayan sido contrastados.
CREATE TABLE IF NOT EXISTS smart_contracts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  contract_type VARCHAR(80) NOT NULL,
  description TEXT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS smart_contract_versions (
  id SERIAL PRIMARY KEY,
  contract_id INTEGER NOT NULL REFERENCES smart_contracts(id) ON DELETE CASCADE,
  version VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'verification'
    CHECK (status IN ('verification', 'verified')),
  source_code TEXT NOT NULL,
  source_hash VARCHAR(128) NOT NULL,
  compiler_version VARCHAR(80) NULL,
  abi_json TEXT NULL,
  artifact_bytecode_hash VARCHAR(128) NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (contract_id, version)
);

CREATE TABLE IF NOT EXISTS smart_contract_deployments (
  id SERIAL PRIMARY KEY,
  contract_version_id INTEGER NOT NULL REFERENCES smart_contract_versions(id) ON DELETE CASCADE,
  network VARCHAR(80) NOT NULL,
  address VARCHAR(128) NOT NULL,
  tx_hash VARCHAR(128) NOT NULL,
  artifact_bytecode_hash VARCHAR(128) NULL,
  onchain_bytecode_hash VARCHAR(128) NULL,
  hook_safety_json TEXT NULL,
  deployed_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (contract_version_id, network)
);

CREATE INDEX IF NOT EXISTS idx_smart_contracts_user ON smart_contracts(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_smart_contract_versions_status ON smart_contract_versions(status, contract_id);
