const defaultDb = require('../db');
const { AppError } = require('../errors/app-error');

const TERMINAL_STEP_STATUSES = new Set(['delivered', 'failed', 'refunded', 'skipped']);

const STEP_COLUMNS = {
  status: 'status',
  amountRaw: 'amount_raw',
  provider: 'provider',
  quote: 'quote_json',
  approvalTxHash: 'approval_tx_hash',
  txHash: 'tx_hash',
  nonce: 'nonce',
  sentFees: 'sent_fees_json',
  estCostUsd: 'est_cost_usd',
  realCostUsd: 'real_cost_usd',
  receivedRaw: 'received_raw',
  etaSec: 'eta_sec',
  errorMessage: 'error_message',
  walletOverrodeFees: 'wallet_overrode_fees',
  signedAt: 'signed_at',
};
const JSON_COLUMNS = new Set(['quote_json', 'sent_fees_json']);

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function numberOrNull(value) {
  return value == null ? null : Number(value);
}

function mapStep(row) {
  return {
    order: Number(row.step_order),
    sourceNetwork: row.source_network,
    token: {
      address: row.token_address,
      symbol: row.token_symbol,
      decimals: Number(row.token_decimals),
      isNative: row.is_native === true,
    },
    deliveryTokenAddress: row.delivery_token_address,
    amountRaw: String(row.amount_raw),
    provider: row.provider,
    carriesDestinationGas: row.carries_destination_gas === true,
    status: row.status,
    quote: parseJson(row.quote_json, {}),
    approvalTxHash: row.approval_tx_hash || null,
    txHash: row.tx_hash || null,
    nonce: numberOrNull(row.nonce),
    sentFees: parseJson(row.sent_fees_json, null),
    estCostUsd: Number(row.est_cost_usd),
    realCostUsd: numberOrNull(row.real_cost_usd),
    receivedRaw: row.received_raw != null ? String(row.received_raw) : null,
    etaSec: numberOrNull(row.eta_sec),
    errorMessage: row.error_message || null,
    walletOverrodeFees: row.wallet_overrode_fees === true,
    signedAt: numberOrNull(row.signed_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapPlan(row, steps = []) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    walletAddress: row.wallet_address,
    destinationNetwork: row.destination_network,
    profile: row.profile,
    thresholdPct: Number(row.threshold_pct),
    status: row.status,
    request: parseJson(row.request_json, {}),
    analysis: parseJson(row.analysis_json, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    finishedAt: numberOrNull(row.finished_at),
    steps,
  };
}

function createCrossChainPlanRepository({ db = defaultDb, now = Date.now } = {}) {
  async function loadSteps(planId, executor = db) {
    const { rows } = await executor.query(
      'SELECT * FROM cross_chain_steps WHERE plan_id = $1 ORDER BY step_order',
      [planId]
    );
    return rows.map(mapStep);
  }

  async function createPlan({ userId, walletAddress, destinationNetwork, profile, thresholdPct, request, analysis, steps }) {
    const at = now();
    try {
      const planId = await db.transaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO cross_chain_plans (
             user_id, wallet_address, destination_network, profile, threshold_pct,
             status, request_json, analysis_json, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 'executing', $6, $7, $8, $8)
           RETURNING id`,
          [userId, walletAddress, destinationNetwork, profile, thresholdPct, JSON.stringify(request), JSON.stringify(analysis), at]
        );
        const id = rows[0].id;
        for (const step of steps) {
          await client.query(
            `INSERT INTO cross_chain_steps (
               plan_id, step_order, source_network, token_address, token_symbol, token_decimals,
               is_native, delivery_token_address, amount_raw, provider, carries_destination_gas,
               status, quote_json, est_cost_usd, eta_sec, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12, $13, $14, $15, $15)`,
            [
              id,
              step.order,
              step.sourceNetwork,
              step.token.address,
              step.token.symbol,
              step.token.decimals,
              step.token.isNative === true,
              step.deliveryToken.address,
              step.amountRaw,
              step.provider,
              step.carriesDestinationGas === true,
              JSON.stringify(step.quoteSnapshot),
              step.costs.expectedUsd,
              step.etaSec ?? null,
              at,
            ]
          );
        }
        return id;
      });
      return getPlanById(planId);
    } catch (err) {
      if (err?.code === '23505') {
        throw new AppError('Ya hay un plan de fondeo en curso para esta wallet.', { status: 409, code: 'ACTIVE_PLAN_EXISTS' });
      }
      throw err;
    }
  }

  async function getPlanById(planId) {
    const { rows } = await db.query('SELECT * FROM cross_chain_plans WHERE id = $1', [planId]);
    if (!rows[0]) return null;
    return mapPlan(rows[0], await loadSteps(planId));
  }

  async function getPlan(userId, planId) {
    const { rows } = await db.query('SELECT * FROM cross_chain_plans WHERE id = $1 AND user_id = $2', [planId, userId]);
    if (!rows[0]) return null;
    return mapPlan(rows[0], await loadSteps(planId));
  }

  async function findActivePlan(userId, walletAddress) {
    const { rows } = await db.query(
      `SELECT * FROM cross_chain_plans
        WHERE user_id = $1 AND lower(wallet_address) = lower($2) AND status = 'executing'
        ORDER BY id DESC LIMIT 1`,
      [userId, walletAddress]
    );
    if (!rows[0]) return null;
    return mapPlan(rows[0], await loadSteps(rows[0].id));
  }

  async function updateStep(planId, order, patch) {
    const sets = [];
    const params = [planId, order];
    for (const [key, value] of Object.entries(patch)) {
      const column = STEP_COLUMNS[key];
      if (!column) throw new Error(`Campo de paso desconocido: ${key}`);
      params.push(JSON_COLUMNS.has(column) && value != null ? JSON.stringify(value) : value);
      sets.push(`${column} = $${params.length}`);
    }
    params.push(now());
    sets.push(`updated_at = $${params.length}`);
    const { rows } = await db.query(
      `UPDATE cross_chain_steps SET ${sets.join(', ')} WHERE plan_id = $1 AND step_order = $2 RETURNING *`,
      params
    );
    return rows[0] ? mapStep(rows[0]) : null;
  }

  async function updatePlan(planId, { status, analysis }) {
    const at = now();
    const finished = status && status !== 'executing' ? at : null;
    const { rows } = await db.query(
      `UPDATE cross_chain_plans
          SET status = COALESCE($2, status),
              analysis_json = COALESCE($3, analysis_json),
              finished_at = COALESCE($4, finished_at),
              updated_at = $5
        WHERE id = $1
        RETURNING *`,
      [planId, status || null, analysis ? JSON.stringify(analysis) : null, finished, at]
    );
    return rows[0] ? mapPlan(rows[0], await loadSteps(planId)) : null;
  }

  async function listInFlightSteps() {
    const { rows } = await db.query(
      `SELECT s.*, p.user_id, p.destination_network, p.profile AS plan_profile, p.wallet_address
         FROM cross_chain_steps s
         JOIN cross_chain_plans p ON p.id = s.plan_id
        WHERE s.status IN ('signed', 'source_confirmed')
        ORDER BY s.plan_id, s.step_order`
    );
    return rows.map((row) => ({
      ...mapStep(row),
      planId: Number(row.plan_id),
      userId: Number(row.user_id),
      destinationNetwork: row.destination_network,
      profile: row.plan_profile,
      walletAddress: row.wallet_address,
    }));
  }

  /**
   * Cierra el plan cuando todos sus pasos terminaron: `delivered` si todos
   * llegaron, `partial` si alguno falló, se reembolsó o se saltó.
   */
  async function recomputePlanStatus(planId) {
    const plan = await getPlanById(planId);
    if (!plan || plan.status !== 'executing') return plan;
    if (!plan.steps.every((step) => TERMINAL_STEP_STATUSES.has(step.status))) return plan;
    const status = plan.steps.every((step) => step.status === 'delivered') ? 'delivered' : 'partial';
    return updatePlan(planId, { status });
  }

  return {
    createPlan,
    getPlan,
    getPlanById,
    findActivePlan,
    updateStep,
    updatePlan,
    listInFlightSteps,
    recomputePlanStatus,
  };
}

module.exports = createCrossChainPlanRepository();
module.exports.createCrossChainPlanRepository = createCrossChainPlanRepository;
module.exports.TERMINAL_STEP_STATUSES = TERMINAL_STEP_STATUSES;
