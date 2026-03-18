require('dotenv').config();
const http = require('http');
const app  = require('./src/app');
const { bootstrapConfig } = require('./src/bootstrap/config');
const { startHttpServer } = require('./src/bootstrap/server');
const { bootstrapInfra } = require('./src/bootstrap/infra');
const config = require('./src/config');
const db   = require('./src/db');
const hlWsClient = require('./src/websocket/hyperliquidWs');
const logger = require('./src/services/logger.service');

async function start() {
  bootstrapConfig();
  const server = http.createServer(app);
  const infra = await bootstrapInfra(server);

  await startHttpServer({
    server,
    port: config.server.port,
    async onShutdown() {
      logger.info('server_shutdown_started');
      hlWsClient.disconnect();
      await infra?.shutdown?.().catch((err) => {
        logger.warn('infra_shutdown_failed', { error: err.message });
      });
      await db.pool.end().catch((err) => {
        logger.warn('db_pool_end_failed', { error: err.message });
      });
    },
  });

  logger.info('server_started', {
    nodeEnv: config.server.nodeEnv,
    port: config.server.port,
    clientUrl: config.server.clientUrl,
  });
  console.log(`
╔══════════════════════════════════════════════╗
║     Hyperliquid Trading Bot - Backend        ║
╠══════════════════════════════════════════════╣
║  Entorno : ${config.server.nodeEnv.padEnd(34)}║
║  HTTP    : http://localhost:${String(config.server.port).padEnd(17)}║
║  WS      : ws://localhost:${String(config.server.port).padEnd(18)}║
╚══════════════════════════════════════════════╝
    `);
}

start().catch((err) => {
  logger.error('server_start_failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
