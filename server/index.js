require('dotenv').config();
const http = require('http');
const app  = require('./src/app');
const config = require('./src/config');
const db   = require('./src/db');
const { createWsServer } = require('./src/websocket/wsServer');
const hlWsClient   = require('./src/websocket/hyperliquidWs');
const hedgeService = require('./src/services/hedge.service');
const settingsRouter = require('./src/routes/settings.routes');

async function start() {
  // Inicializar base de datos (migraciones) y restaurar estado del hedge service
  await db.init();
  await hedgeService.init();
  await settingsRouter.loadSettings();

  const server = http.createServer(app);
  createWsServer(server);
  hlWsClient.connect();

  server.listen(config.server.port, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║     Hyperliquid Trading Bot - Backend        ║
╠══════════════════════════════════════════════╣
║  Entorno : ${config.server.nodeEnv.padEnd(34)}║
║  HTTP    : http://localhost:${String(config.server.port).padEnd(17)}║
║  WS      : ws://localhost:${String(config.server.port).padEnd(18)}║
╚══════════════════════════════════════════════╝
    `);
  });

  // Apagado elegante
  function shutdown() {
    console.log('[Server] Apagando...');
    hlWsClient.disconnect();
    server.close(() => {
      db.pool.end();
      process.exit(0);
    });
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
}

start().catch((err) => {
  console.error('[Server] Error fatal al iniciar:', err);
  process.exit(1);
});
