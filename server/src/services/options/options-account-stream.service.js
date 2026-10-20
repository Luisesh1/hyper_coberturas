/**
 * options-account-stream.service.js
 *
 * Cuenta de Binance Opciones en tiempo real, compartida por usuario.
 *
 * Antes cada pestaña abierta consultaba por REST cuenta + posiciones +
 * órdenes cada 10 s, y con varias pestañas (más el runner) se agotaba el
 * peso por IP de `eapi` → 429 y «límite de peticiones, consulta aplazada».
 *
 * Ahora, mientras haya alguien mirando (sockets suscritos a `/ws`):
 *   - Se abre UN user data stream de Binance por usuario (listenKey).
 *     Sus eventos solo se usan como disparador: ante una orden o un cambio
 *     de saldo/posición se relee el snapshot por REST y se reenvía a todos
 *     los sockets del usuario. No dependemos del esquema de cada evento.
 *   - Los eventos periódicos (ACCOUNT_UPDATE / GREEK_UPDATE cada ~10 s con
 *     posiciones abiertas) se limitan a una relectura cada `periodicMinMs`.
 *   - Un refresco de seguridad cada `streamPollMs` (stream vivo) o
 *     `fallbackPollMs` (stream caído) cubre eventos perdidos.
 *   - Si Binance limita (429), se conserva el último snapshot marcado
 *     `stale` en lugar de vaciar la pantalla.
 */

const WebSocket = require('ws');
const logger = require('../logger.service');

const DEFAULT_WS_BASE_URL = process.env.BINANCE_OPTIONS_USER_WS_URL || 'wss://fstream.binance.com/private';
// Eventos que implican un cambio real: se relee enseguida.
const IMMEDIATE_EVENTS = new Set(['ORDER_TRADE_UPDATE', 'BALANCE_POSITION_UPDATE', 'RISK_LEVEL_CHANGE']);

function eventName(message) {
  const payload = message?.data && typeof message.data === 'object' ? message.data : message;
  return payload?.e || null;
}

function createOptionsAccountStream({
  getClient,
  loadSnapshot,
  WebSocketImpl = WebSocket,
  wsBaseUrl = DEFAULT_WS_BASE_URL,
  now = () => Date.now(),
  debounceMs = 300,
  periodicMinMs = 15_000,
  streamPollMs = 60_000,
  fallbackPollMs = 20_000,
  keepAliveMs = 30 * 60_000,
  idleCloseMs = 60_000,
  reconnectBaseMs = 5_000,
  reconnectMaxMs = 5 * 60_000,
} = {}) {
  const users = new Map();

  function stateFor(userId) {
    let st = users.get(userId);
    if (!st) {
      st = {
        userId,
        watchers: new Set(),
        snapshot: null,
        updatedAt: null,
        error: null,
        stale: false,
        inFlight: null,
        lastRefreshAt: 0,
        refreshTimer: null,
        pollTimer: null,
        keepAliveTimer: null,
        reconnectTimer: null,
        idleTimer: null,
        reconnectAttempt: 0,
        ws: null,
        listenKey: null,
        client: null,
        streamLive: false,
        active: false,
      };
      users.set(userId, st);
    }
    return st;
  }

  function payloadOf(st) {
    return {
      ...(st.snapshot || { account: null, positions: [], openOrders: [] }),
      updatedAt: st.updatedAt,
      stale: st.stale,
      live: st.streamLive,
      error: st.error,
    };
  }

  function emit(st) {
    const payload = payloadOf(st);
    for (const fn of st.watchers) {
      try { fn(payload); } catch (err) {
        logger.warn('options_account_stream_watcher_failed', { userId: st.userId, error: err.message });
      }
    }
  }

  function refresh(userId) {
    const st = stateFor(userId);
    if (st.inFlight) return st.inFlight;
    st.lastRefreshAt = now();
    st.inFlight = (async () => {
      try {
        const client = await getClient(userId);
        st.snapshot = await loadSnapshot(client, userId);
        st.updatedAt = now();
        st.stale = false;
        st.error = null;
      } catch (err) {
        st.stale = Boolean(st.snapshot);
        st.error = { message: err.message, code: err.code || null };
      } finally {
        st.inFlight = null;
      }
      emit(st);
      return payloadOf(st);
    })();
    return st.inFlight;
  }

  // Agrupa ráfagas de eventos en una sola relectura.
  function invalidate(userId, { periodic = false } = {}) {
    const st = users.get(userId);
    if (!st?.active) return;
    if (periodic && now() - st.lastRefreshAt < periodicMinMs) return;
    clearTimeout(st.refreshTimer);
    st.refreshTimer = setTimeout(() => { void refresh(userId); }, debounceMs);
  }

  function schedulePoll(st) {
    clearTimeout(st.pollTimer);
    if (!st.active) return;
    st.pollTimer = setTimeout(async () => {
      if (!st.active) return;
      if (now() - st.lastRefreshAt >= (st.streamLive ? streamPollMs : fallbackPollMs) - 50) {
        await refresh(st.userId);
      }
      schedulePoll(st);
    }, st.streamLive ? streamPollMs : fallbackPollMs);
  }

  function scheduleReconnect(st) {
    clearTimeout(st.reconnectTimer);
    if (!st.active) return;
    const delay = Math.min(reconnectBaseMs * 2 ** st.reconnectAttempt, reconnectMaxMs);
    st.reconnectAttempt += 1;
    st.reconnectTimer = setTimeout(() => { void connectStream(st); }, delay);
  }

  function closeSocket(st) {
    clearInterval(st.keepAliveTimer);
    st.keepAliveTimer = null;
    const ws = st.ws;
    st.ws = null;
    st.streamLive = false;
    if (ws) {
      ws.removeAllListeners?.();
      ws.on?.('error', () => {});
      try { ws.close(); } catch { /* noop */ }
    }
  }

  async function connectStream(st) {
    if (!st.active || st.ws) return;
    let listenKey;
    try {
      st.client = await getClient(st.userId);
      const res = await st.client.createListenKey();
      listenKey = res?.listenKey;
      if (!listenKey) throw new Error('Binance no devolvió listenKey');
    } catch (err) {
      logger.warn('options_account_stream_listenkey_failed', { userId: st.userId, error: err.message });
      scheduleReconnect(st);
      return;
    }
    if (!st.active) {
      st.client.closeListenKey().catch(() => {});
      return;
    }
    st.listenKey = listenKey;
    const ws = new WebSocketImpl(`${wsBaseUrl}/ws/${listenKey}`);
    st.ws = ws;

    ws.on('open', () => {
      if (st.ws !== ws) return;
      st.streamLive = true;
      st.reconnectAttempt = 0;
      logger.info('options_account_stream_open', { userId: st.userId });
      schedulePoll(st);
      // Al conectar pudo haberse perdido algo: releer.
      invalidate(st.userId);
    });
    ws.on('message', (raw) => {
      if (st.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const e = eventName(msg);
      if (!e) return;
      if (e === 'listenKeyExpired') {
        closeSocket(st);
        scheduleReconnect(st);
        return;
      }
      invalidate(st.userId, { periodic: !IMMEDIATE_EVENTS.has(e) });
    });
    ws.on('close', () => {
      if (st.ws !== ws) return;
      closeSocket(st);
      schedulePoll(st);
      scheduleReconnect(st);
    });
    ws.on('error', (err) => {
      logger.warn('options_account_stream_error', { userId: st.userId, error: err.message });
    });

    clearInterval(st.keepAliveTimer);
    st.keepAliveTimer = setInterval(() => {
      st.client?.keepAliveListenKey().catch((err) => {
        logger.warn('options_account_stream_keepalive_failed', { userId: st.userId, error: err.message });
      });
    }, keepAliveMs);
  }

  function start(st) {
    st.active = true;
    st.reconnectAttempt = 0;
    void refresh(st.userId);
    schedulePoll(st);
    void connectStream(st);
  }

  function stop(st) {
    st.active = false;
    clearTimeout(st.refreshTimer);
    clearTimeout(st.pollTimer);
    clearTimeout(st.reconnectTimer);
    const client = st.client;
    const hadKey = Boolean(st.listenKey);
    closeSocket(st);
    st.listenKey = null;
    if (hadKey && client) client.closeListenKey().catch(() => {});
    users.delete(st.userId);
  }

  /**
   * Registra `onUpdate(payload)` para el usuario. Entrega el último snapshot
   * conocido de inmediato (si hay) y arranca el stream con el primer
   * suscriptor. Devuelve la función para desuscribirse.
   */
  function subscribe(userId, onUpdate) {
    const st = stateFor(userId);
    clearTimeout(st.idleTimer);
    st.idleTimer = null;
    st.watchers.add(onUpdate);
    if (!st.active) start(st);
    else if (st.snapshot || st.error) onUpdate(payloadOf(st));
    return () => {
      st.watchers.delete(onUpdate);
      if (st.watchers.size || !st.active) return;
      // Margen para recargas de página sin cerrar/reabrir el listenKey.
      clearTimeout(st.idleTimer);
      st.idleTimer = setTimeout(() => {
        if (!st.watchers.size) stop(st);
      }, idleCloseMs);
    };
  }

  /** Último snapshot bueno (para servir datos ante un 429 en REST). */
  function getLast(userId) {
    const st = users.get(userId);
    return st?.snapshot ? payloadOf(st) : null;
  }

  function shutdown() {
    for (const st of [...users.values()]) {
      clearTimeout(st.idleTimer);
      stop(st);
    }
  }

  return { subscribe, invalidate, refresh, getLast, shutdown, _users: users };
}

let defaultStream = null;
function getDefault() {
  if (!defaultStream) {
    const optionsCredentials = require('./options-credentials.service');
    const optionsAccount = require('./options-account.service');
    defaultStream = createOptionsAccountStream({
      getClient: (userId) => optionsCredentials.getClientForUser(userId),
      loadSnapshot: (client, userId) => optionsAccount.loadSnapshot(client, userId),
    });
  }
  return defaultStream;
}

module.exports = {
  createOptionsAccountStream,
  eventName,
  subscribe: (...args) => getDefault().subscribe(...args),
  invalidate: (...args) => getDefault().invalidate(...args),
  getLast: (...args) => getDefault().getLast(...args),
  shutdown: () => defaultStream?.shutdown(),
};
