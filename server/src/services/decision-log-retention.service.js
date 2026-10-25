const defaultConfig = require('../config');
const defaultLogger = require('./logger.service');
const { pruneDecisionLog } = require('./protected-pool-maintenance.service');

/**
 * Poda diaria de `protection_decision_log`. Cada ejecución está acotada
 * (batchSize * maxBatches filas, con pausa entre lotes); si queda remanente,
 * la siguiente ejecución lo continúa. Nunca lanza: un fallo se registra.
 */
function createDecisionLogRetentionService({
  prune = pruneDecisionLog,
  config = defaultConfig.decisionLogRetention,
  logger = defaultLogger,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let running = false;
  let started = false;
  let timer = null;

  async function runOnce() {
    if (running) return null;
    running = true;
    try {
      const summary = await prune({
        dryRun: false,
        retentionDays: config.retentionDays,
        batchSize: config.batchSize,
        maxBatches: config.maxBatches,
        pauseMs: config.pauseMs,
      });
      logger.info('decision_log_pruned', {
        deleted: summary.deleted,
        candidates: summary.candidates,
        capped: summary.capped,
      });
      return summary;
    } catch (err) {
      logger.warn('decision_log_prune_failed', { error: err.message });
      return null;
    } finally {
      running = false;
    }
  }

  function schedule(delayMs) {
    timer = setTimer(async () => {
      timer = null;
      await runOnce();
      // Si se detuvo mientras corría, no se reprograma.
      if (started) schedule(config.intervalMs);
    }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function start() {
    if (!config.enabled || started) return;
    started = true;
    schedule(config.initialDelayMs);
  }

  function stop() {
    started = false;
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { start, stop, runOnce };
}

module.exports = createDecisionLogRetentionService();
module.exports.createDecisionLogRetentionService = createDecisionLogRetentionService;
