require('dotenv').config();

const db = require('../db');
const logger = require('../services/logger.service');
const {
  pruneDecisionLog,
  DEFAULT_DECISION_LOG_RETENTION_DAYS,
} = require('../services/protected-pool-maintenance.service');

/**
 * Poda de `protection_decision_log`.
 *
 * Uso:
 *   node src/scripts/prune-decision-log.js [dias]            # dry-run
 *   node src/scripts/prune-decision-log.js [dias] --apply    # borra
 *
 * Es DRY-RUN por defecto a proposito: borra historico de produccion y el
 * numero de filas candidatas conviene mirarlo antes de ejecutarlo. Sin
 * `--apply` solo cuenta.
 *
 * La tabla llego a 6,49 M de filas / 1,79 GB contra 592 rebalanceos reales por
 * no tener retencion. El volumen en si ya se ataja en el gate de
 * `_tickProtection`; esto limpia el acumulado.
 */
async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const retentionDays = Number(args.find((a) => /^\d+$/.test(a))) || DEFAULT_DECISION_LOG_RETENTION_DAYS;

  await db.ensureConnection();

  const summary = await pruneDecisionLog({ retentionDays, dryRun: !apply }, db);

  if (summary.dryRun) {
    logger.info('decision_log_prune_dry_run', {
      ...summary,
      hint: 'volver a ejecutar con --apply para borrar',
    });
  } else {
    logger.info('decision_log_prune_completed', summary);
  }
}

main()
  .catch((err) => {
    logger.error('decision_log_prune_failed', { error: err.message, stack: err.stack });
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end().catch(() => {});
  });
