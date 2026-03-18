const db = require('../db');
const { createWsServer, loadActiveUsers } = require('../websocket/wsServer');
const hlWsClient = require('../websocket/hyperliquidWs');
const runtimeStatus = require('../runtime/status');
const logger = require('../services/logger.service');
const protectedPoolRefreshService = require('../services/protected-pool-refresh.service');
const etherscanQueueService = require('../services/etherscan-queue.service');

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

  return {
    wss,
    async shutdown() {
      protectedPoolRefreshService.stop();
      etherscanQueueService.shutdown();
    },
  };
}

module.exports = { bootstrapInfra };
