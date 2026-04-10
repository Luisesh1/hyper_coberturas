/**
 * lp-orchestrator-monitor.service.js
 *
 * Loop de fondo que evalúa todos los orquestadores activos cada N segundos.
 * Mismo patrón estructural que `protected-pool-refresh.service.js`:
 *  - `start()` / `stop()` con guard `running`
 *  - errores por orquestador no abortan el loop completo
 *  - default 30 s, configurable vía `config.intervals.lpOrchestratorEvalMs`
 */

const config = require('../config');
const logger = require('./logger.service');
const lpOrchestratorService = require('./lp-orchestrator.service');

class LpOrchestratorMonitorService {
  constructor(deps = {}) {
    this.lpOrchestratorService = deps.lpOrchestratorService || lpOrchestratorService;
    this.intervalMs = deps.intervalMs || config.intervals.lpOrchestratorEvalMs;
    this.logger = deps.logger || logger;
    this.interval = null;
    this.running = false;
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.evaluateAll().catch((err) => {
        this.logger.error('lp_orchestrator_monitor_unhandled_error', { error: err.message });
      });
    }, this.intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async evaluateAll() {
    if (this.running) {
      this.logger.warn('lp_orchestrator_monitor_skipped', { reason: 'already_running' });
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      const result = await this.lpOrchestratorService.evaluateAll();
      this.logger.info('lp_orchestrator_eval_completed', {
        evaluated: result?.evaluated ?? 0,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      this.running = false;
    }
  }
}

module.exports = new LpOrchestratorMonitorService();
module.exports.LpOrchestratorMonitorService = LpOrchestratorMonitorService;
