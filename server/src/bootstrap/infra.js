const db = require('../db');
const config = require('../config');
const { createWsServer, loadActiveUsers } = require('../websocket/wsServer');
const hlWsClient = require('../websocket/hyperliquidWs');
const runtimeStatus = require('../runtime/status');
const logger = require('../services/logger.service');
const protectedPoolRefreshService = require('../services/protected-pool-refresh.service');
const protectedPoolDynamicService = require('../services/protected-pool-dynamic.service');
const protectedPoolDeltaNeutralService = require('../services/protected-pool-delta-neutral.service');
const lpOrchestratorMonitorService = require('../services/lp-orchestrator-monitor.service');
const uniswapOperationService = require('../services/uniswap-operation.service');
const telegramCommandService = require('../services/telegram-command.service');
const etherscanQueueService = require('../services/etherscan-queue.service');
const backtestQueueService = require('../services/backtest-queue.service');
const hedgeRegistry = require('../services/hedge.registry');
const botRegistry = require('../services/bot.registry');

// Hooks de proceso para capturar promesas/errores no manejados. En dev
// los redirigimos al logger para que aparezcan en el DevLogPanel y dejen
// de ser invisibles. En prod siguen siendo silenciosos por defecto (no
// queremos que un crash en background tire el proceso sin control).
let _processHooksInstalled = false;
function installProcessHooksOnce() {
  if (_processHooksInstalled) return;
  if (config.server.nodeEnv !== 'development') return;
  _processHooksInstalled = true;
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('process_unhandled_rejection', {
      message: err.message,
      stack: err.stack || null,
    });
  });
  process.on('uncaughtException', (err) => {
    logger.error('process_uncaught_exception', {
      message: err?.message || String(err),
      stack: err?.stack || null,
    });
  });
}

async function bootstrapInfra(httpServer) {
  installProcessHooksOnce();
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
  protectedPoolDeltaNeutralService.start();
  lpOrchestratorMonitorService.start();
  uniswapOperationService.start();
  telegramCommandService.start();
  backtestQueueService.start();

  return {
    wss,
    async shutdown() {
      protectedPoolRefreshService.stop();
      protectedPoolDynamicService.stop();
      protectedPoolDeltaNeutralService.stop();
      lpOrchestratorMonitorService.stop();
      uniswapOperationService.stop();
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
