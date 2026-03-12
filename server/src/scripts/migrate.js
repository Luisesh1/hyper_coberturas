require('dotenv').config();

const db = require('../db');
const logger = require('../services/logger.service');

async function main() {
  await db.ensureConnection();
  await db.initSchema();
  await db.pool.end();
  logger.info('migrate_completed');
}

main().catch(async (err) => {
  logger.error('migrate_failed', { error: err.message });
  await db.pool.end().catch(() => {});
  process.exit(1);
});
