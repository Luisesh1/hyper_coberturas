/**
 * hyperliquidWs.js
 *
 * Conexion WebSocket al servidor de Hyperliquid.
 * Se suscribe a feeds de precios en tiempo real y los distribuye
 * a todos los clientes conectados via nuestro propio WS server.
 *
 * Documentacion: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket
 *
 * Suscripciones disponibles:
 *   { type: 'allMids' }                    -> precios mid de todos los activos
 *   { type: 'trades', coin: 'BTC' }        -> trades en tiempo real de un activo
 *   { type: 'l2Book', coin: 'BTC' }        -> order book nivel 2
 *   { type: 'user', user: '0x...' }        -> eventos de la cuenta del usuario
 */

const WebSocket = require('ws');
const config = require('../config');
const logger = require('../services/logger.service');

const RECONNECT_BASE_DELAY_MS = config.intervals.wsReconnectDelayMs;
const RECONNECT_MAX_DELAY_MS = 30_000;
// Tras recibir este umbral de mensajes sanos, reseteamos el backoff al base.
const HEALTHY_RESET_MESSAGE_COUNT = 5;
const PING_INTERVAL_MS = config.intervals.wsPingIntervalMs;
const WATCHDOG_INTERVAL_MS = config.intervals.wsWatchdogIntervalMs;
const WATCHDOG_MAX_SILENCE_MS = config.intervals.wsWatchdogMaxSilenceMs;

class HyperliquidWsClient {
  constructor() {
    this.ws = null;
    this.subscribers = new Set(); // callbacks que reciben los mensajes
    this.isConnected = false;
    this.pingInterval = null;
    this.reconnectTimeout = null;
    this.subscriptions = []; // suscripciones activas a restaurar en reconexion
    this._lastMessageAt = null;
    this._watchdogInterval = null;
    this._reconnectAttempts = 0;
    this._healthyMessagesSinceConnect = 0;
  }

  _nextReconnectDelayMs() {
    const attempt = Math.min(this._reconnectAttempts, 10);
    const exp = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt);
    const capped = Math.min(exp, RECONNECT_MAX_DELAY_MS);
    // Jitter aleatorio ±25% para evitar thundering herd contra HL.
    const jitter = capped * (Math.random() * 0.5 - 0.25);
    return Math.max(RECONNECT_BASE_DELAY_MS, Math.floor(capped + jitter));
  }

  /**
   * Conecta al WebSocket de Hyperliquid y mantiene la conexion activa.
   */
  connect() {
    logger.info('hl_ws_connecting', { url: config.hyperliquid.wsUrl });
    this.ws = new WebSocket(config.hyperliquid.wsUrl);

    this.ws.on('open', () => {
      this.isConnected = true;
      this._healthyMessagesSinceConnect = 0;
      logger.info('hl_ws_connected', { attempts: this._reconnectAttempts });
      this._startPing();
      this._restoreSubscriptions();
    });

    this.ws.on('message', (data) => {
      this._lastMessageAt = Date.now();
      this._healthyMessagesSinceConnect += 1;
      if (this._healthyMessagesSinceConnect === HEALTHY_RESET_MESSAGE_COUNT) {
        this._reconnectAttempts = 0;
      }
      try {
        const message = JSON.parse(data.toString());
        this._broadcast(message);
      } catch {
        // ignorar mensajes no-JSON (ej: pong)
      }
    });

    this.ws.on('close', (code, _reason) => {
      this.isConnected = false;
      this._stopPing();
      const delayMs = this._nextReconnectDelayMs();
      this._reconnectAttempts += 1;
      logger.warn('hl_ws_closed', { code, reconnectMs: delayMs, attempts: this._reconnectAttempts });
      this.reconnectTimeout = setTimeout(() => this.connect(), delayMs);
    });

    this.ws.on('error', (err) => {
      logger.error('hl_ws_error', { error: err.message });
      this.ws.terminate();
    });
  }

  /**
   * Suscribe a un feed especifico de Hyperliquid.
   * @param {object} subscription - Objeto de suscripcion (ej: { type: 'allMids' })
   */
  subscribe(subscription) {
    // Evitar suscripciones duplicadas
    const key = JSON.stringify(subscription);
    const alreadySubscribed = this.subscriptions.some(
      (s) => JSON.stringify(s) === key
    );

    if (!alreadySubscribed) {
      this.subscriptions.push(subscription);
    }

    if (this.isConnected) {
      this._send({ method: 'subscribe', subscription });
    }
  }

  /**
   * Desuscribe de un feed.
   * @param {object} subscription
   */
  unsubscribe(subscription) {
    const key = JSON.stringify(subscription);
    this.subscriptions = this.subscriptions.filter(
      (s) => JSON.stringify(s) !== key
    );

    if (this.isConnected) {
      this._send({ method: 'unsubscribe', subscription });
    }
  }

  /**
   * Registra un callback para recibir mensajes del WS de Hyperliquid.
   * @param {function} callback - fn(message)
   * @returns {function} - Funcion para eliminar el subscriber
   */
  addSubscriber(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  disconnect() {
    clearTimeout(this.reconnectTimeout);
    this._stopPing();
    if (this.ws) this.ws.terminate();
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  _send(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  _broadcast(message) {
    this.subscribers.forEach((cb) => {
      try {
        cb(message);
      } catch (err) {
        logger.error('hl_ws_subscriber_error', { error: err.message });
      }
    });
  }

  _startPing() {
    this.pingInterval = setInterval(() => {
      this._send({ method: 'ping' });
    }, PING_INTERVAL_MS);
    this._startWatchdog();
  }

  _stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this._stopWatchdog();
  }

  _startWatchdog() {
    this._watchdogInterval = setInterval(() => {
      if (this._lastMessageAt && (Date.now() - this._lastMessageAt) > WATCHDOG_MAX_SILENCE_MS) {
        logger.warn('hl_ws_watchdog_reconnect');
        this.ws.terminate();
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  _stopWatchdog() {
    if (this._watchdogInterval) {
      clearInterval(this._watchdogInterval);
      this._watchdogInterval = null;
    }
  }

  _restoreSubscriptions() {
    this.subscriptions.forEach((sub) => {
      this._send({ method: 'subscribe', subscription: sub });
    });
  }
}

// Singleton
const hlWsClient = new HyperliquidWsClient();
module.exports = hlWsClient;
