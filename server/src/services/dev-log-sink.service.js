/**
 * dev-log-sink.service.js
 *
 * Sink in-memory para el modo de desarrollo: recibe entries (logs del
 * server, errores no manejados, errores del cliente vía POST batch) y los
 * mantiene en un ring buffer + emite un evento `entry` para que
 * suscriptores (típicamente el wsServer) los retransmitan al frontend en
 * tiempo real.
 *
 * Cuando NODE_ENV !== 'development' es un no-op completo: publish/snapshot
 * son funciones vacías y no se reserva memoria. Cero costo en producción.
 */

const { EventEmitter } = require('events');
const config = require('../config');

const RING_CAPACITY = 500;
const isEnabledNow = () => config.server.nodeEnv === 'development';

const emitter = new EventEmitter();
// Aumentamos el max listeners porque cada conexión WS suscribe uno y un
// dev típico abre varias pestañas. 50 es un margen amplio.
emitter.setMaxListeners(50);

const ring = [];
let nextId = 1;

function publish(entry) {
  if (!isEnabledNow()) return null;
  if (!entry || typeof entry !== 'object') return null;

  const enriched = {
    id: nextId++,
    ts: entry.ts || new Date().toISOString(),
    level: entry.level || 'info',
    source: entry.source || 'server',
    message: entry.message || '',
    ...entry,
  };
  // Re-aplicamos los campos canónicos al final por si el spread del entry
  // los pisó (ej. el caller pasa { ts, level } dentro de meta).
  enriched.ts = entry.ts || enriched.ts;
  enriched.level = entry.level || enriched.level;

  ring.push(enriched);
  if (ring.length > RING_CAPACITY) {
    ring.shift();
  }
  emitter.emit('entry', enriched);
  return enriched;
}

function publishMany(entries, { source } = {}) {
  if (!isEnabledNow()) return 0;
  if (!Array.isArray(entries)) return 0;
  let count = 0;
  for (const entry of entries) {
    const result = publish({ source: source || entry?.source || 'client', ...entry });
    if (result) count += 1;
  }
  return count;
}

function snapshot({ limit = RING_CAPACITY } = {}) {
  if (!isEnabledNow()) return [];
  if (limit >= ring.length) return ring.slice();
  return ring.slice(ring.length - limit);
}

function clear() {
  if (!isEnabledNow()) return;
  ring.length = 0;
}

function on(event, listener) {
  if (!isEnabledNow()) return () => {};
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

function off(event, listener) {
  emitter.off(event, listener);
}

module.exports = {
  isEnabled: isEnabledNow,
  publish,
  publishMany,
  snapshot,
  clear,
  on,
  off,
  RING_CAPACITY,
};
