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

const RECONNECT_DELAY_MS = 5000;
const PING_INTERVAL_MS = 30000;
const WATCHDOG_INTERVAL_MS = 60_000;    // verificar cada 60s
const WATCHDOG_MAX_SILENCE_MS = 90_000; // forzar reconexión tras 90s sin datos

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
  }

  /**
   * Conecta al WebSocket de Hyperliquid y mantiene la conexion activa.
   */
  connect() {
    console.log(`[HL WS] Conectando a ${config.hyperliquid.wsUrl}...`);
    this.ws = new WebSocket(config.hyperliquid.wsUrl);

    this.ws.on('open', () => {
      this.isConnected = true;
      console.log('[HL WS] Conexion establecida.');
      this._startPing();
      this._restoreSubscriptions();
    });

    this.ws.on('message', (data) => {
      this._lastMessageAt = Date.now();
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
      console.warn(`[HL WS] Conexion cerrada (${code}). Reconectando en ${RECONNECT_DELAY_MS}ms...`);
      this.reconnectTimeout = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });

    this.ws.on('error', (err) => {
      console.error('[HL WS] Error:', err.message);
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
        console.error('[HL WS] Error en subscriber:', err.message);
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
        console.warn('[HL WS] Watchdog: sin datos por 90s, forzando reconexión...');
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
