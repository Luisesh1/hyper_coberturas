const config = require('../config');
const db = require('../db');
const logger = require('./logger.service');
const hlRegistry = require('./hyperliquid.registry');
const orchestratorRepository = require('../repositories/lp-orchestrator.repository');
const protectedPoolRepository = require('../repositories/protected-uniswap-pool.repository');

class DeltaNeutralIntegrityService {
  constructor(deps = {}) {
    this.db = deps.db || db;
    this.logger = deps.logger || logger;
    this.hlRegistry = deps.hlRegistry || hlRegistry;
    this.orchestratorRepo = deps.orchestratorRepository || orchestratorRepository;
    this.protectedPoolRepo = deps.protectedPoolRepository || protectedPoolRepository;
    this.intervalMs = deps.intervalMs || config.intervals.deltaNeutralIntegrityMs || 30_000;
    this.interval = null;
    this.running = false;
    this.lastAudit = null;
    this.incidentLogLastAt = new Map();
    this.incidentLogRepeatMs = deps.incidentLogRepeatMs || 15 * 60_000;
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.audit().catch((err) => this.logger.error('delta_neutral_integrity_audit_failed', {
        error: err.message,
      }));
    }, this.intervalMs);
    this.interval.unref?.();
    setTimeout(() => {
      this.audit().catch((err) => this.logger.error('delta_neutral_integrity_startup_failed', {
        error: err.message,
      }));
    }, 0).unref?.();
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  async listIssues() {
    const { rows } = await this.db.query(
      `SELECT
         o.id AS orchestrator_id,
         o.user_id,
         o.active_position_identifier,
         o.active_protected_pool_id,
         p.id AS protection_id,
         p.status AS protection_status,
         p.protection_mode,
         p.hyperliquid_account_id,
         p.inferred_asset,
         p.strategy_state_json
       FROM lp_orchestrators o
       LEFT JOIN protected_uniswap_pools p ON p.id = o.active_protected_pool_id
       WHERE o.status = 'active'
         AND o.active_position_identifier IS NOT NULL
         AND o.protection_config_json IS NOT NULL
         AND COALESCE(o.protection_config_json::jsonb ->> 'enabled', 'true') <> 'false'
         AND (
           p.id IS NULL
           OR p.status <> 'active'
           OR p.protection_mode <> 'delta_neutral'
         )
       ORDER BY o.id ASC`
    );
    return rows;
  }

  async audit() {
    if (this.running) return this.lastAudit;
    this.running = true;
    const startedAt = Date.now();
    try {
      const issues = await this.listIssues();
      const incidents = [];
      for (const issue of issues) {
        incidents.push(await this._recordIssue(issue));
      }
      this.lastAudit = {
        checkedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        issueCount: incidents.length,
        incidents,
      };
      return this.lastAudit;
    } finally {
      this.running = false;
    }
  }

  async _recordIssue(issue) {
    let actualQty = null;
    let positionReadError = null;
    if (issue.protection_id && issue.hyperliquid_account_id && issue.inferred_asset) {
      try {
        const hl = await this.hlRegistry.getOrCreate(
          Number(issue.user_id),
          Number(issue.hyperliquid_account_id)
        );
        const position = await hl.getPosition(issue.inferred_asset);
        actualQty = position && Number(position.szi) < 0 ? Math.abs(Number(position.szi)) : 0;
      } catch (err) {
        positionReadError = err.message;
      }
    }

    const reason = issue.protection_id
      ? `Protección #${issue.protection_id} en estado ${issue.protection_status}; requiere reconciliación.`
      : 'El orquestador tiene LP activo pero la protección vinculada no existe.';

    await this.orchestratorRepo.updatePhase(Number(issue.user_id), Number(issue.orchestrator_id), {
      phase: 'protection_reconcile_required',
      lastError: reason,
    });

    if (issue.protection_id) {
      const protection = await this.protectedPoolRepo.getById(
        Number(issue.user_id),
        Number(issue.protection_id)
      ).catch(() => null);
      if (protection) {
        await this.protectedPoolRepo.updateStrategyState(
          Number(issue.user_id),
          Number(issue.protection_id),
          {
            strategyState: {
              ...(protection.strategyState || {}),
              status: 'needs_reconciliation',
              lastError: reason,
              integrityIssueAt: Date.now(),
              lastActualQty: actualQty ?? protection.strategyState?.lastActualQty ?? null,
              positionReadError,
            },
            hedgeSize: actualQty ?? protection.hedgeSize,
          }
        );
      }
    }

    const incident = {
      orchestratorId: Number(issue.orchestrator_id),
      protectionId: issue.protection_id != null ? Number(issue.protection_id) : null,
      protectionStatus: issue.protection_status || 'missing',
      asset: issue.inferred_asset || null,
      actualQty,
      positionReadError,
      reason,
    };
    const incidentKey = `${incident.orchestratorId}:${incident.protectionId || 'missing'}:${incident.protectionStatus}`;
    const lastLoggedAt = Number(this.incidentLogLastAt.get(incidentKey) || 0);
    if ((Date.now() - lastLoggedAt) >= this.incidentLogRepeatMs) {
      this.incidentLogLastAt.set(incidentKey, Date.now());
      this.logger.error('delta_neutral_integrity_incident', incident);
    }
    return incident;
  }
}

module.exports = new DeltaNeutralIntegrityService();
module.exports.DeltaNeutralIntegrityService = DeltaNeutralIntegrityService;
