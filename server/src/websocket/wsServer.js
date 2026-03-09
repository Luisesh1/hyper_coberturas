/**
 * wsServer.js
 *
 * Servidor WebSocket propio para los clientes del frontend.
 * Actua como proxy inteligente entre Hyperliquid y el navegador:
 *   - Los clientes se conectan aqui y piden suscripciones
 *   - Este servidor se suscribe a Hyperliquid y retransmite los datos
 *   - Maneja mensajes de control (subscribe, unsubscribe, ping)
 *
 * Protocolo de mensajes cliente -> servidor:
 *   { type: 'subscribe',   feed: 'allMids' }
 *   { type: 'subscribe',   feed: 'trades',  coin: 'BTC' }
 *   { type: 'unsubscribe', feed: 'allMids' }
 *   { type: 'ping' }
 *
 * Protocolo de mensajes servidor -> cliente:
 *   { type: 'pong' }
 *   { type: 'hl_message', data: <mensaje de Hyperliquid> }
 *   { type: 'error', message: '...' }
 */

const WebSocket = require('ws');
const hlWsClient = require('./hyperliquidWs');
const hedgeService = require('../services/hedge.service');
const telegram = require('../services/telegram.service');
const config = require('../config');

const CLIENT_PING_INTERVAL_MS = 20_000;

/** Envia un mensaje JSON a todos los clientes WS conectados */
function broadcast(wss, payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

function createWsServer(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

  // Suscribirse al feed de precios globales y a los eventos del usuario
  hlWsClient.subscribe({ type: 'allMids' });
  if (config.wallet.address) {
    hlWsClient.subscribe({ type: 'userEvents', user: config.wallet.address });
    console.log(`[WS Server] Suscrito a userEvents para ${config.wallet.address}`);
  }

  // Distribuir todos los mensajes de HL a los clientes y al motor de coberturas
  hlWsClient.addSubscriber((hlMessage) => {
    // Retransmitir al frontend
    broadcast(wss, { type: 'hl_message', data: hlMessage });

    // Enrutar fills de userEvents al motor de coberturas
    if (hlMessage?.channel === 'userEvents') {
      const fills = hlMessage?.data?.fills || [];
      fills.forEach((fill) => {
        hedgeService.onFill(fill);
      });
    }
  });

  // Propagar eventos del motor de coberturas al frontend y a Telegram
  hedgeService.on('created',   (h) => {
    broadcast(wss, { type: 'hedge_event', event: 'created',   hedge: h });
    telegram.notifyHedgeCreated(h);
  });
  hedgeService.on('updated',   (h) => {
    broadcast(wss, { type: 'hedge_event', event: 'updated',   hedge: h });
  });
  hedgeService.on('opened',    (h) => {
    broadcast(wss, { type: 'hedge_event', event: 'opened',    hedge: h });
    telegram.notifyHedgeOpened(h);
  });
  hedgeService.on('cycleComplete', (h, cycle) => {
    broadcast(wss, { type: 'hedge_event', event: 'cycleComplete', hedge: h, cycle });
    telegram.notifyHedgeClosed({ ...h, ...cycle });
  });
  hedgeService.on('cancelled', (h) => {
    broadcast(wss, { type: 'hedge_event', event: 'cancelled', hedge: h });
    telegram.notifyHedgeCancelled(h);
  });
  hedgeService.on('error',     (h, err) => {
    broadcast(wss, { type: 'hedge_event', event: 'error', hedge: h, message: err.message });
    telegram.notifyHedgeError(h, err);
  });

  // Heartbeat: detectar clientes muertos con ping nativo cada 20s
  const heartbeat = setInterval(() => {
    wss.clients.forEach((client) => {
      if (client.isAlive === false) { client.terminate(); return; }
      client.isAlive = false;
      client.ping();
    });
  }, CLIENT_PING_INTERVAL_MS);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    console.log(`[WS Server] Cliente conectado: ${clientIp}`);

    ws.send(
      JSON.stringify({
        type: 'connected',
        message: 'Conectado al bot de Hyperliquid',
        timestamp: Date.now(),
      })
    );

    ws.on('message', (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());
        handleClientMessage(ws, msg);
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'JSON invalido' }));
      }
    });

    ws.on('close', () => {
      console.log(`[WS Server] Cliente desconectado: ${clientIp}`);
    });

    ws.on('error', (err) => {
      console.error(`[WS Server] Error de cliente (${clientIp}):`, err.message);
    });
  });

  console.log('[WS Server] Servidor WebSocket listo en /ws');
  return wss;
}

/**
 * Procesa los mensajes de control enviados por los clientes.
 */
function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;

    case 'subscribe': {
      const subscription = buildSubscription(msg);
      if (subscription) {
        hlWsClient.subscribe(subscription);
        ws.send(
          JSON.stringify({ type: 'subscribed', feed: msg.feed, coin: msg.coin })
        );
      } else {
        ws.send(JSON.stringify({ type: 'error', message: `Feed desconocido: ${msg.feed}` }));
      }
      break;
    }

    case 'unsubscribe': {
      const subscription = buildSubscription(msg);
      if (subscription) {
        hlWsClient.unsubscribe(subscription);
        ws.send(
          JSON.stringify({ type: 'unsubscribed', feed: msg.feed, coin: msg.coin })
        );
      }
      break;
    }

    default:
      ws.send(JSON.stringify({ type: 'error', message: `Tipo desconocido: ${msg.type}` }));
  }
}

/**
 * Convierte un mensaje de cliente al formato de suscripcion de Hyperliquid.
 */
function buildSubscription(msg) {
  switch (msg.feed) {
    case 'allMids':
      return { type: 'allMids' };
    case 'trades':
      if (!msg.coin) return null;
      return { type: 'trades', coin: msg.coin };
    case 'l2Book':
      if (!msg.coin) return null;
      return { type: 'l2Book', coin: msg.coin };
    case 'userEvents':
      return { type: 'userEvents', user: msg.user };
    default:
      return null;
  }
}

module.exports = { createWsServer };
