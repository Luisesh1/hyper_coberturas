require('dotenv').config();
const http = require('http');
const app  = require('./src/app');
const config = require('./src/config');
const db   = require('./src/db');
const { createWsServer, loadActiveUsers } = require('./src/websocket/wsServer');
const hlWsClient = require('./src/websocket/hyperliquidWs');

async function start() {
  // 1. Inicializar DB: migraciones + seed admin
  await db.init();

  // 2. Crear servidor HTTP y WS
  const server = http.createServer(app);
  const wss    = createWsServer(server);

  // 3. Conectar al WS de Hyperliquid
  hlWsClient.connect();

  // 4. Cargar usuarios activos, sus services y suscribir userEvents
  await loadActiveUsers(wss);

  // 5. Arrancar el servidor HTTP
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
