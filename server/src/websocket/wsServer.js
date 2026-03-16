/**
 * wsServer.js
 *
 * Servidor WebSocket con autenticación JWT por usuario.
 * - Autentica la conexión por query param ?token=...
 * - Asocia cada socket con su userId
 * - Retransmite hedge_event solo al usuario propietario
 * - Suscribe userEvents de Hyperliquid por wallet de cada usuario activo
 */

const WebSocket = require('ws');
const jwt       = require('jsonwebtoken');
const url       = require('url');
const hlWsClient   = require('./hyperliquidWs');
const hedgeRegistry = require('../services/hedge.registry');
const hlRegistry    = require('../services/hyperliquid.registry');
const botRegistry   = require('../services/bot.registry');
const db            = require('../db');
const config        = require('../config');

const CLIENT_PING_INTERVAL_MS = 20_000;
const WS_AUTH_TIMEOUT_MS = 5_000;       // tiempo máximo para autenticar tras conexión
const WS_MAX_MSG_PER_MIN = 60;          // rate limit por conexión
const attachedHedgeServices = new WeakSet();
const attachedBotRuntimes = new WeakSet();

/** Envía un mensaje JSON a todos los sockets del usuario indicado */
function broadcastToUser(wss, userId, payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.userId === userId) {
      client.send(data);
    }
  });
}

/** Adjunta los eventos de un HedgeService al WS server */
function attachHedgeEvents(wss, hedgeSvc) {
  if (attachedHedgeServices.has(hedgeSvc)) return;
  attachedHedgeServices.add(hedgeSvc);
  const userId = hedgeSvc.userId;
  hedgeSvc.on('created',      (h)         => broadcastToUser(wss, userId, { type: 'hedge_event', event: 'created',      hedge: h }));
  hedgeSvc.on('updated',      (h)         => broadcastToUser(wss, userId, { type: 'hedge_event', event: 'updated',      hedge: h }));
  hedgeSvc.on('opened',       (h)         => broadcastToUser(wss, userId, { type: 'hedge_event', event: 'opened',       hedge: h }));
  hedgeSvc.on('reconciled',   (h)         => broadcastToUser(wss, userId, { type: 'hedge_event', event: 'reconciled',   hedge: h }));
  hedgeSvc.on('protection_missing', (h)   => broadcastToUser(wss, userId, { type: 'hedge_event', event: 'protection_missing', hedge: h }));
  hedgeSvc.on('cycleComplete',(h, cycle)  => broadcastToUser(wss, userId, { type: 'hedge_event', event: 'cycleComplete', hedge: h, cycle }));
  hedgeSvc.on('cancelled',    (h)         => broadcastToUser(wss, userId, { type: 'hedge_event', event: 'cancelled',    hedge: h }));
  hedgeSvc.on('error',        (h, err)    => broadcastToUser(wss, userId, { type: 'hedge_event', event: 'error',        hedge: h, message: err.message }));
}

function attachBotEvents(wss, botRuntime) {
  if (attachedBotRuntimes.has(botRuntime)) return;
  attachedBotRuntimes.add(botRuntime);
  const userId = botRuntime.userId;
  botRuntime.on('status', (bot) => broadcastToUser(wss, userId, { type: 'bot_event', event: 'status', bot }));
  botRuntime.on('evaluated', (bot, payload) => broadcastToUser(wss, userId, { type: 'bot_event', event: 'evaluated', bot, payload }));
  botRuntime.on('run', (bot, run) => broadcastToUser(wss, userId, { type: 'bot_event', event: 'run', bot, run }));
  botRuntime.on('runtime_error', (bot, err) => broadcastToUser(wss, userId, {
    type: 'bot_event',
    event: 'error',
    bot,
    message: err.message,
  }));
  botRuntime.on('runtime_warning', (bot, payload) => broadcastToUser(wss, userId, {
    type: 'bot_event',
    event: 'runtime_warning',
    bot,
    payload,
    message: payload.message,
  }));
  botRuntime.on('runtime_retry_scheduled', (bot, payload) => broadcastToUser(wss, userId, {
    type: 'bot_event',
    event: 'runtime_retry_scheduled',
    bot,
    payload,
    message: payload.message,
  }));
  botRuntime.on('runtime_fallback_applied', (bot, payload) => broadcastToUser(wss, userId, {
    type: 'bot_event',
    event: 'runtime_fallback_applied',
    bot,
    payload,
    message: payload.message,
  }));
  botRuntime.on('runtime_recovered', (bot, payload) => broadcastToUser(wss, userId, {
    type: 'bot_event',
    event: 'runtime_recovered',
    bot,
    payload,
    message: payload.message,
  }));
  botRuntime.on('runtime_paused', (bot, payload) => broadcastToUser(wss, userId, {
    type: 'bot_event',
    event: 'runtime_paused',
    bot,
    payload,
    message: payload.message,
  }));
}

async function bootstrapUserRuntime(wss, userId) {
  const hedgeServices = await hedgeRegistry.getOrCreateAllForUser(userId);
  const botRuntimes = await botRegistry.getOrCreateActiveForUser(userId);

  for (const hedgeSvc of hedgeServices) {
    attachHedgeEvents(wss, hedgeSvc);
    const hl = hlRegistry.get(userId, hedgeSvc.accountId);
    if (hl?.address) {
      hlWsClient.subscribe({ type: 'userEvents', user: hl.address });
      console.log(`[WS] userEvents suscrito para user ${userId} account ${hedgeSvc.accountId} (${hl.address})`);
    }
  }

  for (const botRuntime of botRuntimes) {
    attachBotEvents(wss, botRuntime);
  }

  return [...hedgeServices, ...botRuntimes];
}

/**
 * Carga todos los usuarios activos, inicializa sus registries y suscribe userEvents.
 * Llamado desde index.js al arrancar.
 */
async function loadActiveUsers(wss) {
  const { rows } = await db.query(
    "SELECT id FROM users WHERE active = true"
  );

  for (const { id: userId } of rows) {
    try {
      await bootstrapUserRuntime(wss, userId);
    } catch (err) {
      console.error(`[WS] Error al inicializar user ${userId}:`, err.message);
    }
  }
}

function createWsServer(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

  hedgeRegistry.onCreate(async (hedgeSvc) => {
    attachHedgeEvents(wss, hedgeSvc);
    const hl = hlRegistry.get(hedgeSvc.userId, hedgeSvc.accountId);
    if (hl?.address) {
      hlWsClient.subscribe({ type: 'userEvents', user: hl.address });
    }
  });

  botRegistry.onCreate((botRuntime) => {
    attachBotEvents(wss, botRuntime);
  });

  // Suscribir feed global de precios
  hlWsClient.subscribe({ type: 'allMids' });

  // Distribuir mensajes HL: precios a todos, fills al hedge service correcto
  hlWsClient.addSubscriber((hlMessage) => {
    // Retransmitir precios a todos los clientes autenticados + reacción en tiempo real
    if (hlMessage?.channel === 'allMids') {
      // Notificar a cada HedgeService para que revise condiciones de entrada/salida
      const mids = hlMessage?.data?.mids || {};
      for (const svc of hedgeRegistry.getAll()) {
        for (const [asset, priceStr] of Object.entries(mids)) {
          const price = parseFloat(priceStr);
          if (price > 0) svc.onPriceUpdate(asset, price);
        }
      }

      // Retransmitir al frontend
      const data = JSON.stringify({ type: 'hl_message', data: hlMessage });
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.userId) {
          client.send(data);
        }
      });
    }

    // Enrutar fills de userEvents al HedgeService del usuario correspondiente
    if (hlMessage?.channel === 'userEvents') {
      const fills = hlMessage?.data?.fills || [];
      if (fills.length === 0) return;

      // Buscar qué usuario tiene esa wallet address
      const addresses = hlRegistry.getAllEntries();
      const fillUser  = addresses.find((a) => {
        // Los fills de HL incluyen el address del usuario
        return hlMessage?.data?.user?.toLowerCase() === a.address?.toLowerCase();
      });

      if (fillUser) {
        const hedgeSvc = hedgeRegistry.get(fillUser.userId, fillUser.accountId);
        if (hedgeSvc) fills.forEach((fill) => hedgeSvc.onFill(fill));
      } else {
        // Fallback: notificar a todos los hedge services activos
        for (const svc of hedgeRegistry.getAll()) {
          fills.forEach((fill) => svc.onFill(fill));
        }
      }
    }
  });

  // Heartbeat
  const heartbeat = setInterval(() => {
    wss.clients.forEach((client) => {
      if (client.isAlive === false) { client.terminate(); return; }
      client.isAlive = false;
      client.ping();
    });
  }, CLIENT_PING_INTERVAL_MS);

  wss.on('close', () => clearInterval(heartbeat));

  // --- Validar origen (solo acepta orígenes conocidos) ---
  function isAllowedOrigin(req) {
    if (config.server.nodeEnv !== 'production') return true;
    const origin = req.headers.origin;
    if (!origin) return true; // conexiones sin Origin (ej: server-to-server)
    const allowed = config.server.clientUrl;
    return origin === allowed;
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Validar origen en producción
    if (!isAllowedOrigin(req)) {
      ws.close(4003, 'Origin not allowed');
      return;
    }

    // Rate limiting por conexión
    ws._msgCount = 0;
    ws._msgWindowStart = Date.now();

    // Compatibilidad: aceptar token por query param O por primer mensaje (auth)
    const { query: q } = url.parse(req.url, true);
    if (q.token) {
      try {
        const decoded = jwt.verify(q.token, config.jwt.secret);
        ws.userId   = decoded.userId;
        ws.userRole = decoded.role;
        finishAuth(ws);
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Token inválido' }));
        ws.close(4001, 'Unauthorized');
        return;
      }
    } else {
      // Esperar primer mensaje tipo { type: 'auth', token: '...' }
      ws._authenticated = false;
      ws._authTimeout = setTimeout(() => {
        if (!ws._authenticated) {
          ws.send(JSON.stringify({ type: 'error', message: 'Autenticación requerida' }));
          ws.close(4001, 'Auth timeout');
        }
      }, WS_AUTH_TIMEOUT_MS);
    }

    ws.on('message', (rawData) => {
      // Rate limiting
      const now = Date.now();
      if (now - ws._msgWindowStart > 60_000) {
        ws._msgCount = 0;
        ws._msgWindowStart = now;
      }
      ws._msgCount++;
      if (ws._msgCount > WS_MAX_MSG_PER_MIN) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limit excedido' }));
        return;
      }

      try {
        const msg = JSON.parse(rawData.toString());

        // Si aún no está autenticado, solo aceptar mensajes de auth
        if (!ws.userId) {
          if (msg.type === 'auth' && msg.token) {
            try {
              const decoded = jwt.verify(msg.token, config.jwt.secret);
              ws.userId   = decoded.userId;
              ws.userRole = decoded.role;
              ws._authenticated = true;
              clearTimeout(ws._authTimeout);
              finishAuth(ws);
            } catch {
              ws.send(JSON.stringify({ type: 'error', message: 'Token inválido' }));
              ws.close(4001, 'Unauthorized');
            }
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Autenticación requerida' }));
          }
          return;
        }

        handleClientMessage(ws, msg);
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'JSON invalido' }));
      }
    });

    ws.on('close', () => {
      clearTimeout(ws._authTimeout);
      if (ws.userId) console.log(`[WS] Cliente desconectado: user ${ws.userId}`);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Error cliente user ${ws.userId || 'unauthenticated'}:`, err.message);
    });
  });

  function finishAuth(ws) {
    console.log(`[WS] Cliente conectado: user ${ws.userId}`);
    ws.send(JSON.stringify({
      type: 'connected',
      message: 'Conectado al bot de Hyperliquid',
      timestamp: Date.now(),
    }));
  }

  console.log('[WS Server] Servidor WebSocket listo en /ws');
  return wss;
}

function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;

    case 'subscribe': {
      const subscription = buildSubscription(msg);
      if (subscription) {
        hlWsClient.subscribe(subscription);
        ws.send(JSON.stringify({ type: 'subscribed', feed: msg.feed, coin: msg.coin }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: `Feed desconocido: ${msg.feed}` }));
      }
      break;
    }

    case 'unsubscribe': {
      const subscription = buildSubscription(msg);
      if (subscription) {
        hlWsClient.unsubscribe(subscription);
        ws.send(JSON.stringify({ type: 'unsubscribed', feed: msg.feed, coin: msg.coin }));
      }
      break;
    }

    default:
      ws.send(JSON.stringify({ type: 'error', message: `Tipo desconocido: ${msg.type}` }));
  }
}

function buildSubscription(msg) {
  switch (msg.feed) {
    case 'allMids':    return { type: 'allMids' };
    case 'trades':     return msg.coin ? { type: 'trades', coin: msg.coin } : null;
    case 'l2Book':     return msg.coin ? { type: 'l2Book', coin: msg.coin } : null;
    case 'userEvents': return { type: 'userEvents', user: msg.user };
    default:           return null;
  }
}

module.exports = { createWsServer, loadActiveUsers, attachHedgeEvents };
