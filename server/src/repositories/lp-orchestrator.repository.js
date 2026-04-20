/**
 * lp-orchestrator.repository.js
 *
 * CRUD + queries para los orquestadores de LP. Sigue el mismo estilo que
 * `protected-uniswap-pool.repository.js`: mapRow + parseJsonSafe + executor.
 */

const db = require('../db');

function exec(executor) {
  return executor || db;
}

function parseJsonSafe(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toJson(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

const DEFAULT_ACCOUNTING = Object.freeze({
  lpFeesUsd: 0,
  gasSpentUsd: 0,
  swapSlippageUsd: 0,
  hedgeRealizedPnlUsd: 0,
  hedgeUnrealizedPnlUsd: 0,
  hedgeFundingUsd: 0,
  hedgeExecutionFeesUsd: 0,
  hedgeSlippageUsd: 0,
  priceDriftUsd: 0,
  totalNetPnlUsd: 0,
  lpCount: 0,
});

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    accountId: row.hyperliquid_account_id != null ? Number(row.hyperliquid_account_id) : null,
    name: row.name,
    network: row.network,
    version: row.version,
    walletAddress: row.wallet_address,
    token0Address: row.token0_address,
    token1Address: row.token1_address,
    token0Symbol: row.token0_symbol,
    token1Symbol: row.token1_symbol,
    inferredAsset: row.inferred_asset || null,
    feeTier: row.fee_tier != null ? Number(row.fee_tier) : null,
    phase: row.phase,
    status: row.status,
    activePositionIdentifier: row.active_position_identifier || null,
    activePoolAddress: row.active_pool_address || null,
    activeProtectedPoolId: row.active_protected_pool_id != null
      ? Number(row.active_protected_pool_id)
      : null,
    initialTotalUsd: Number(row.initial_total_usd),
    strategyConfig: parseJsonSafe(row.strategy_config_json, {}),
    protectionConfig: parseJsonSafe(row.protection_config_json, null),
    strategyState: parseJsonSafe(row.strategy_state_json, {}),
    lastEvaluation: parseJsonSafe(row.last_evaluation_json, null),
    lastEvaluationAt: row.last_evaluation_at != null ? Number(row.last_evaluation_at) : null,
    accounting: { ...DEFAULT_ACCOUNTING, ...parseJsonSafe(row.accounting_json, {}) },
    nextEligibleAttemptAt: row.next_eligible_attempt_at != null
      ? Number(row.next_eligible_attempt_at)
      : null,
    cooldownReason: row.cooldown_reason || null,
    consecutiveFailures: Number(row.consecutive_failures) || 0,
    lastError: row.last_error || null,
    lastUrgentAlertAt: row.last_urgent_alert_at != null ? Number(row.last_urgent_alert_at) : null,
    lastDecision: row.last_decision || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    stoppedAt: row.stopped_at != null ? Number(row.stopped_at) : null,
  };
}

async function create(record, executor) {
  const now = record.createdAt || Date.now();
  const accounting = record.accounting || { ...DEFAULT_ACCOUNTING };
  const { rows } = await exec(executor).query(
    `INSERT INTO lp_orchestrators (
       user_id, hyperliquid_account_id, name, network, version, wallet_address,
       token0_address, token1_address, token0_symbol, token1_symbol, inferred_asset, fee_tier,
       phase, status, initial_total_usd,
       strategy_config_json, protection_config_json,
       strategy_state_json, last_evaluation_json, last_evaluation_at,
       accounting_json,
       next_eligible_attempt_at, cooldown_reason, consecutive_failures, last_error,
       last_urgent_alert_at, last_decision,
       created_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12,
       $13, $14, $15,
       $16, $17,
       $18, $19, $20,
       $21,
       $22, $23, $24, $25,
       $26, $27,
       $28, $29
     )
     RETURNING id`,
    [
      record.userId,
      record.accountId ?? null,
      record.name,
      record.network,
      record.version,
      record.walletAddress,
      record.token0Address,
      record.token1Address,
      record.token0Symbol,
      record.token1Symbol,
      record.inferredAsset || null,
      record.feeTier ?? null,
      record.phase || 'idle',
      record.status || 'active',
      record.initialTotalUsd,
      toJson(record.strategyConfig || {}),
      toJson(record.protectionConfig || null),
      toJson(record.strategyState || {}),
      toJson(record.lastEvaluation || null),
      record.lastEvaluationAt ?? null,
      toJson(accounting),
      record.nextEligibleAttemptAt ?? null,
      record.cooldownReason || null,
      record.consecutiveFailures ?? 0,
      record.lastError || null,
      record.lastUrgentAlertAt ?? null,
      record.lastDecision || null,
      now,
      record.updatedAt || now,
    ]
  );
  return rows[0]?.id || null;
}

async function getById(userId, id, executor) {
  const { rows } = await exec(executor).query(
    `SELECT * FROM lp_orchestrators WHERE user_id = $1 AND id = $2`,
    [userId, id]
  );
  return mapRow(rows[0]);
}

async function listForUser(userId, { includeArchived = false } = {}, executor) {
  const { rows } = await exec(executor).query(
    `SELECT * FROM lp_orchestrators
       WHERE user_id = $1
         AND ($2::boolean OR status <> 'archived')
       ORDER BY updated_at DESC, id DESC`,
    [userId, includeArchived]
  );
  return rows.map(mapRow);
}

async function listActiveForLoop(executor) {
  const now = Date.now();
  const { rows } = await exec(executor).query(
    `SELECT * FROM lp_orchestrators
       WHERE status = 'active'
         AND (next_eligible_attempt_at IS NULL OR next_eligible_attempt_at <= $1)
       ORDER BY user_id, id`,
    [now]
  );
  return rows.map(mapRow);
}

/**
 * Lista orquestadores activos para captura de metricas (snapshots horarios).
 * A diferencia de `listActiveForLoop`, NO respeta el cooldown
 * (`next_eligible_attempt_at`): las metricas son observabilidad pura y deben
 * capturarse siempre, incluso cuando el orquestador este en `failed` /
 * `rate_limited` / `margin_pending`. El cooldown fue diseñado para gating
 * de operaciones de trading, no de lectura.
 */
async function listForMetricsCapture(executor) {
  const { rows } = await exec(executor).query(
    `SELECT * FROM lp_orchestrators
       WHERE status = 'active'
       ORDER BY user_id, id`
  );
  return rows.map(mapRow);
}

async function updatePhase(userId, id, {
  phase,
  lastError,
  nextEligibleAttemptAt,
  cooldownReason,
  consecutiveFailures,
  updatedAt = Date.now(),
}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE lp_orchestrators
        SET phase = COALESCE($3, phase),
            last_error = $4,
            next_eligible_attempt_at = $5,
            cooldown_reason = $6,
            consecutive_failures = COALESCE($7, consecutive_failures),
            updated_at = $8
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [
      userId,
      id,
      phase ?? null,
      lastError ?? null,
      nextEligibleAttemptAt ?? null,
      cooldownReason ?? null,
      consecutiveFailures ?? null,
      updatedAt,
    ]
  );
  return rows[0]?.id || null;
}

async function updateActiveLp(userId, id, {
  activePositionIdentifier,
  activePoolAddress,
  activeProtectedPoolId,
  phase,
  updatedAt = Date.now(),
}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE lp_orchestrators
        SET active_position_identifier = $3,
            active_pool_address = $4,
            active_protected_pool_id = $5,
            phase = COALESCE($6, phase),
            updated_at = $7
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [
      userId,
      id,
      activePositionIdentifier ?? null,
      activePoolAddress ?? null,
      activeProtectedPoolId ?? null,
      phase ?? null,
      updatedAt,
    ]
  );
  return rows[0]?.id || null;
}

async function updateStrategyState(userId, id, {
  strategyState,
  lastEvaluation,
  lastEvaluationAt,
  lastDecision,
  updatedAt = Date.now(),
}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE lp_orchestrators
        SET strategy_state_json = COALESCE($3, strategy_state_json),
            last_evaluation_json = COALESCE($4, last_evaluation_json),
            last_evaluation_at = COALESCE($5, last_evaluation_at),
            last_decision = COALESCE($6, last_decision),
            updated_at = $7
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [
      userId,
      id,
      strategyState !== undefined ? toJson(strategyState) : null,
      lastEvaluation !== undefined ? toJson(lastEvaluation) : null,
      lastEvaluationAt ?? null,
      lastDecision ?? null,
      updatedAt,
    ]
  );
  return rows[0]?.id || null;
}

async function updateAccounting(userId, id, accounting, executor) {
  const updatedAt = Date.now();
  const { rows } = await exec(executor).query(
    `UPDATE lp_orchestrators
        SET accounting_json = $3,
            updated_at = $4
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [userId, id, toJson(accounting || {}), updatedAt]
  );
  return rows[0]?.id || null;
}

async function updateConfig(userId, id, {
  strategyConfig,
  protectionConfig,
  updatedAt = Date.now(),
}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE lp_orchestrators
        SET strategy_config_json = COALESCE($3, strategy_config_json),
            protection_config_json = COALESCE($4, protection_config_json),
            updated_at = $5
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [
      userId,
      id,
      strategyConfig !== undefined ? toJson(strategyConfig) : null,
      protectionConfig !== undefined ? toJson(protectionConfig) : null,
      updatedAt,
    ]
  );
  return rows[0]?.id || null;
}

async function markUrgentAlertSent(userId, id, { at = Date.now() } = {}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE lp_orchestrators
        SET last_urgent_alert_at = $3,
            updated_at = $3
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [userId, id, at]
  );
  return rows[0]?.id || null;
}

async function clearUrgentAlert(userId, id, executor) {
  const updatedAt = Date.now();
  const { rows } = await exec(executor).query(
    `UPDATE lp_orchestrators
        SET last_urgent_alert_at = NULL,
            updated_at = $3
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [userId, id, updatedAt]
  );
  return rows[0]?.id || null;
}

async function archive(userId, id, { stoppedAt = Date.now() } = {}, executor) {
  const { rows } = await exec(executor).query(
    `UPDATE lp_orchestrators
        SET status = 'archived',
            stopped_at = $3,
            updated_at = $3
      WHERE user_id = $1 AND id = $2
        AND active_position_identifier IS NULL
      RETURNING id`,
    [userId, id, stoppedAt]
  );
  return rows[0]?.id || null;
}

// ---------- action_log -----------------------------------------------------

async function appendActionLog(entry, executor) {
  const createdAt = entry.createdAt || Date.now();
  const { rows } = await exec(executor).query(
    `INSERT INTO lp_orchestrator_action_log (
       orchestrator_id, kind, decision, reason, action, position_identifier,
       current_price, range_lower_price, range_upper_price,
       central_band_lower, central_band_upper,
       estimated_cost_usd, estimated_reward_usd, cost_to_reward_ratio,
       snapshot_hash, snapshot_freshness_ms,
       tx_hashes_json, realized_cost_usd,
       verification_status, drift_details_json,
       accounting_delta_json, payload_json,
       created_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9,
       $10, $11,
       $12, $13, $14,
       $15, $16,
       $17, $18,
       $19, $20,
       $21, $22,
       $23
     )
     RETURNING id`,
    [
      entry.orchestratorId,
      entry.kind,
      entry.decision || null,
      entry.reason || null,
      entry.action || null,
      entry.positionIdentifier != null ? String(entry.positionIdentifier) : null,
      entry.currentPrice ?? null,
      entry.rangeLowerPrice ?? null,
      entry.rangeUpperPrice ?? null,
      entry.centralBandLower ?? null,
      entry.centralBandUpper ?? null,
      entry.estimatedCostUsd ?? null,
      entry.estimatedRewardUsd ?? null,
      entry.costToRewardRatio ?? null,
      entry.snapshotHash || null,
      entry.snapshotFreshnessMs ?? null,
      toJson(entry.txHashes || null),
      entry.realizedCostUsd ?? null,
      entry.verificationStatus || null,
      toJson(entry.driftDetails || null),
      toJson(entry.accountingDelta || null),
      toJson(entry.payload || null),
      createdAt,
    ]
  );
  return rows[0]?.id || null;
}

function mapLogRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    orchestratorId: Number(row.orchestrator_id),
    kind: row.kind,
    decision: row.decision || null,
    reason: row.reason || null,
    action: row.action || null,
    positionIdentifier: row.position_identifier || null,
    currentPrice: row.current_price != null ? Number(row.current_price) : null,
    rangeLowerPrice: row.range_lower_price != null ? Number(row.range_lower_price) : null,
    rangeUpperPrice: row.range_upper_price != null ? Number(row.range_upper_price) : null,
    centralBandLower: row.central_band_lower != null ? Number(row.central_band_lower) : null,
    centralBandUpper: row.central_band_upper != null ? Number(row.central_band_upper) : null,
    estimatedCostUsd: row.estimated_cost_usd != null ? Number(row.estimated_cost_usd) : null,
    estimatedRewardUsd: row.estimated_reward_usd != null ? Number(row.estimated_reward_usd) : null,
    costToRewardRatio: row.cost_to_reward_ratio != null ? Number(row.cost_to_reward_ratio) : null,
    snapshotHash: row.snapshot_hash || null,
    snapshotFreshnessMs: row.snapshot_freshness_ms != null ? Number(row.snapshot_freshness_ms) : null,
    txHashes: parseJsonSafe(row.tx_hashes_json, null),
    realizedCostUsd: row.realized_cost_usd != null ? Number(row.realized_cost_usd) : null,
    verificationStatus: row.verification_status || null,
    driftDetails: parseJsonSafe(row.drift_details_json, null),
    accountingDelta: parseJsonSafe(row.accounting_delta_json, null),
    payload: parseJsonSafe(row.payload_json, null),
    createdAt: Number(row.created_at),
  };
}

async function listActionLog(userId, orchestratorId, { limit = 100, kinds } = {}, executor) {
  const params = [userId, orchestratorId, limit];
  let kindFilter = '';
  if (Array.isArray(kinds) && kinds.length) {
    params.push(kinds);
    kindFilter = ` AND log.kind = ANY($${params.length}::text[])`;
  }
  const { rows } = await exec(executor).query(
    `SELECT log.*
       FROM lp_orchestrator_action_log log
       JOIN lp_orchestrators o ON o.id = log.orchestrator_id
      WHERE o.user_id = $1 AND log.orchestrator_id = $2 ${kindFilter}
      ORDER BY log.created_at DESC, log.id DESC
      LIMIT $3`,
    params
  );
  return rows.map(mapLogRow);
}

async function findLastNotification(orchestratorId, executor) {
  const { rows } = await exec(executor).query(
    `SELECT * FROM lp_orchestrator_action_log
      WHERE orchestrator_id = $1 AND kind = 'notification'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [orchestratorId]
  );
  return mapLogRow(rows[0]);
}

/**
 * Busca un action_log de tipo `tx_finalized` para este orquestador cuyo
 * `tx_hashes_json` contenga al menos uno de los hashes pasados. Sirve para
 * detectar reentries idempotentes de `recordTxFinalized` (evita
 * doble-cobrar costos cuando el cliente reintenta tras un timeout).
 */
async function findFinalizedByTxHash(orchestratorId, txHashes, executor) {
  if (!Array.isArray(txHashes) || txHashes.length === 0) return null;
  const { rows } = await exec(executor).query(
    `SELECT * FROM lp_orchestrator_action_log
      WHERE orchestrator_id = $1
        AND kind = 'tx_finalized'
        AND tx_hashes_json IS NOT NULL
        AND tx_hashes_json::jsonb ?| $2::text[]
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [orchestratorId, txHashes]
  );
  return mapLogRow(rows[0]);
}

module.exports = {
  DEFAULT_ACCOUNTING,
  create,
  getById,
  listForUser,
  listActiveForLoop,
  listForMetricsCapture,
  updatePhase,
  updateActiveLp,
  updateStrategyState,
  updateConfig,
  updateAccounting,
  markUrgentAlertSent,
  clearUrgentAlert,
  findFinalizedByTxHash,
  archive,
  appendActionLog,
  listActionLog,
  findLastNotification,
};
