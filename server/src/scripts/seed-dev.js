require('dotenv').config();

const db = require('../db');
const logger = require('../services/logger.service');
const settingsService = require('../services/settings.service');

async function main() {
  await db.ensureConnection();
  await db.initSchema();

  const admin = await db.seedDevAdmin({
    username: process.env.DEV_ADMIN_USERNAME || 'admin',
    password: process.env.DEV_ADMIN_PASSWORD || 'admin123',
    name: process.env.DEV_ADMIN_NAME || 'Administrador',
  });

  if (admin && process.env.PRIVATE_KEY && process.env.WALLET_ADDRESS) {
    await settingsService.setWallet(admin.id, {
      privateKey: process.env.PRIVATE_KEY,
      address: process.env.WALLET_ADDRESS,
    });
    logger.info('dev_admin_wallet_seeded', { userId: admin.id });
  }

  await db.pool.end();
  logger.info('seed_dev_completed');
}

main().catch(async (err) => {
  logger.error('seed_dev_failed', { error: err.message });
  await db.pool.end().catch(() => {});
  process.exit(1);
});
