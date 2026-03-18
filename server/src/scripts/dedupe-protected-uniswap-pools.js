require('dotenv').config();

const db = require('../db');
const logger = require('../services/logger.service');
const { cleanupDuplicateProtectedPools } = require('../services/protected-pool-maintenance.service');

async function main() {
  await db.ensureConnection();
  await db.initSchema();

  const summary = await cleanupDuplicateProtectedPools(db);
  logger.info('protected_pool_dedupe_completed', summary);
}

main()
  .catch((err) => {
    logger.error('protected_pool_dedupe_failed', { error: err.message, stack: err.stack });
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end().catch(() => {});
  });
