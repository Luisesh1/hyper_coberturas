require('dotenv').config();
const http = require('http');
const app = require('./src/app');
const config = require('./src/config');
const { createWsServer } = require('./src/websocket/wsServer');
const hlWsClient = require('./src/websocket/hyperliquidWs');

const server = http.createServer(app);

// Inicializar servidor WebSocket sobre el mismo servidor HTTP
createWsServer(server);

// Conectar al WebSocket de Hyperliquid
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
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM recibido. Cerrando...');
  hlWsClient.disconnect();
  server.close(() => {
    console.log('[Server] Servidor cerrado.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT recibido. Cerrando...');
  hlWsClient.disconnect();
  server.close(() => process.exit(0));
});
