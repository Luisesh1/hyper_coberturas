const db = require('../db');
const { createWsServer, loadActiveUsers } = require('../websocket/wsServer');
const hlWsClient = require('../websocket/hyperliquidWs');
const runtimeStatus = require('../runtime/status');
const logger = require('../services/logger.service');

async function bootstrapInfra(httpServer) {
  await db.ensureConnection();

  const wss = createWsServer(httpServer);

  try {
    hlWsClient.connect();
  } catch (err) {
    logger.warn('hl_ws_connect_failed', { error: err.message });
  }

  try {
    await loadActiveUsers(wss);
  } catch (err) {
    runtimeStatus.markBootstrapError(err);
    logger.error('load_active_users_failed', { error: err.message });
  }

  runtimeStatus.markBootstrapped();
  return { wss };
}

module.exports = { bootstrapInfra };
