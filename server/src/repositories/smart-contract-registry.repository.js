const db = require('../db');

function exec(executor) {
  return executor || db;
}

function toJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  if (value == null || typeof value === 'object') return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapVersion(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    contractId: Number(row.contract_id),
    name: row.contract_name,
    contractType: row.contract_type,
    version: row.version,
    status: row.status,
    sourceCode: row.source_code,
    sourceHash: row.source_hash,
    compilerVersion: row.compiler_version,
    abi: parseJson(row.abi_json, []),
    artifactBytecodeHash: row.artifact_bytecode_hash,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deployment: row.deployment_id == null ? null : {
      id: Number(row.deployment_id),
      network: row.network,
      address: row.address,
      txHash: row.tx_hash,
      artifactBytecodeHash: row.deployment_artifact_bytecode_hash,
      onchainBytecodeHash: row.onchain_bytecode_hash,
      hookSafety: parseJson(row.hook_safety_json, {}),
      deployedAt: row.deployed_at == null ? null : Number(row.deployed_at),
    },
  };
}

async function createContract({ userId, name, contractType, description = null }, executor) {
  const now = Date.now();
  const { rows } = await exec(executor).query(
    `INSERT INTO smart_contracts (user_id, name, contract_type, description, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
    [userId, name, contractType, description, now]
  );
  return rows[0]?.id || null;
}

async function createVersion({
  userId, contractId, version, sourceCode, sourceHash, compilerVersion = null,
  abiJson = [], artifactBytecodeHash = null,
}, executor) {
  const now = Date.now();
  const { rows } = await exec(executor).query(
    `INSERT INTO smart_contract_versions (
       contract_id, version, status, source_code, source_hash, compiler_version,
       abi_json, artifact_bytecode_hash, created_at, updated_at
     )
     SELECT $2, $3, 'verification', $4, $5, $6, $7, $8, $9, $9
      WHERE EXISTS (SELECT 1 FROM smart_contracts WHERE id = $2 AND user_id = $1)
     RETURNING id`,
    [userId, contractId, version, sourceCode, sourceHash, compilerVersion, toJson(abiJson), artifactBytecodeHash, now]
  );
  return rows[0]?.id || null;
}

async function recordDeployment({
  userId, contractVersionId, network, address, txHash, artifactBytecodeHash,
  onchainBytecodeHash, hookSafety,
}, executor) {
  const now = Date.now();
  const { rows } = await exec(executor).query(
    `INSERT INTO smart_contract_deployments (
       contract_version_id, network, address, tx_hash, artifact_bytecode_hash,
       onchain_bytecode_hash, hook_safety_json, deployed_at, updated_at
     )
     SELECT $2, $3, $4, $5, $6, $7, $8, $9, $9
      WHERE EXISTS (
        SELECT 1 FROM smart_contract_versions v
        JOIN smart_contracts c ON c.id = v.contract_id
        WHERE v.id = $2 AND c.user_id = $1
      )
     ON CONFLICT (contract_version_id, network)
     DO UPDATE SET address = EXCLUDED.address, tx_hash = EXCLUDED.tx_hash,
       artifact_bytecode_hash = EXCLUDED.artifact_bytecode_hash,
       onchain_bytecode_hash = EXCLUDED.onchain_bytecode_hash,
       hook_safety_json = EXCLUDED.hook_safety_json,
       deployed_at = EXCLUDED.deployed_at, updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [userId, contractVersionId, network, address, txHash, artifactBytecodeHash,
      onchainBytecodeHash, toJson(hookSafety || {}), now]
  );
  return rows[0]?.id || null;
}

async function listVerifiedHooks(userId, network, executor) {
  const { rows } = await exec(executor).query(
    `SELECT v.*, c.name AS contract_name, c.contract_type,
            d.id AS deployment_id, d.network, d.address, d.tx_hash,
            d.artifact_bytecode_hash AS deployment_artifact_bytecode_hash,
            d.onchain_bytecode_hash, d.hook_safety_json, d.deployed_at
       FROM smart_contract_versions v
       JOIN smart_contracts c ON c.id = v.contract_id
       JOIN smart_contract_deployments d ON d.contract_version_id = v.id
      WHERE c.user_id = $1
        AND d.network = $2
        AND c.contract_type = $3
        AND v.status = 'verified'
      ORDER BY c.name, v.created_at DESC`,
    [userId, network, 'uniswap_v4_dynamic_fee_hook']
  );
  return rows.map(mapVersion);
}

async function listContracts(userId, executor) {
  const { rows } = await exec(executor).query(
    `SELECT v.*, c.name AS contract_name, c.contract_type,
            d.id AS deployment_id, d.network, d.address, d.tx_hash,
            d.artifact_bytecode_hash AS deployment_artifact_bytecode_hash,
            d.onchain_bytecode_hash, d.hook_safety_json, d.deployed_at
       FROM smart_contracts c
       LEFT JOIN smart_contract_versions v ON v.contract_id = c.id
       LEFT JOIN smart_contract_deployments d ON d.contract_version_id = v.id
      WHERE c.user_id = $1
      ORDER BY c.updated_at DESC, v.created_at DESC, d.network`,
    [userId]
  );
  return rows.filter((row) => row.id != null).map(mapVersion);
}

async function getVersionForVerification(userId, versionId, network, executor) {
  const { rows } = await exec(executor).query(
    `SELECT v.*, c.name AS contract_name, c.contract_type,
            d.id AS deployment_id, d.network, d.address, d.tx_hash,
            d.artifact_bytecode_hash AS deployment_artifact_bytecode_hash,
            d.onchain_bytecode_hash, d.hook_safety_json, d.deployed_at
       FROM smart_contract_versions v
       JOIN smart_contracts c ON c.id = v.contract_id
       LEFT JOIN smart_contract_deployments d
         ON d.contract_version_id = v.id AND d.network = $3
      WHERE c.user_id = $1 AND v.id = $2`,
    [userId, versionId, network]
  );
  return mapVersion(rows[0]);
}

async function markVerified(userId, versionId, executor) {
  const now = Date.now();
  const { rows } = await exec(executor).query(
    `UPDATE smart_contract_versions v
        SET status = 'verified', updated_at = $3
       FROM smart_contracts c
      WHERE v.contract_id = c.id AND c.user_id = $1
        AND v.id = $2 AND v.status = 'verification'
      RETURNING v.id`,
    [userId, versionId, now]
  );
  return rows[0]?.id || null;
}

module.exports = {
  createContract,
  createVersion,
  getVersionForVerification,
  listContracts,
  listVerifiedHooks,
  mapVersion,
  markVerified,
  recordDeployment,
};
