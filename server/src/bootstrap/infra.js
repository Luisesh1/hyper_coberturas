const db = require('../db');
const { createWsServer, loadActiveUsers } = require('../websocket/wsServer');
const hlWsClient = require('../websocket/hyperliquidWs');
const runtimeStatus = require('../runtime/status');
const logger = require('../services/logger.service');
const protectedPoolRefreshService = require('../services/protected-pool-refresh.service');
const protectedPoolDynamicService = require('../services/protected-pool-dynamic.service');
const telegramCommandService = require('../services/telegram-command.service');
const etherscanQueueService = require('../services/etherscan-queue.service');
const backtestQueueService = require('../services/backtest-queue.service');
const hedgeRegistry = require('../services/hedge.registry');
const botRegistry = require('../services/bot.registry');

async function bootstrapInfra(httpServer) {
  await db.ensureConnection();
  await db.initSchema();

  const wss = createWsServer(httpServer);

  try {
    hlWsClient.connect();
  } catch (err) {
    logger.warn('hl_ws_connect_failed', { error: err.message });
  }

  let bootstrapOk = true;
  try {
    await loadActiveUsers(wss);
  } catch (err) {
    bootstrapOk = false;
    runtimeStatus.markBootstrapError(err);
    logger.error('load_active_users_failed', { error: err.message });
  }

  if (bootstrapOk) runtimeStatus.markBootstrapped();
  protectedPoolRefreshService.start();
  protectedPoolDynamicService.start();
  telegramCommandService.start();
  backtestQueueService.start();

  return {
    wss,
    async shutdown() {
      protectedPoolRefreshService.stop();
      protectedPoolDynamicService.stop();
      telegramCommandService.stop();
      etherscanQueueService.shutdown();
      backtestQueueService.stop();
      await hedgeRegistry.destroyAll().catch((err) =>
        logger.warn('hedge_registry_shutdown_error', { error: err.message })
      );
      await botRegistry.destroyAll().catch((err) =>
        logger.warn('bot_registry_shutdown_error', { error: err.message })
      );
    },
  };
}

module.exports = { bootstrapInfra };
