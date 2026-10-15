/**
 * alert-events.js
 *
 * Emisor en proceso de los disparos reales de alertas. Lo consume, por
 * ejemplo, el trading automatizado de Opciones (bots que abren/cierran
 * según la dirección de la alerta).
 *
 * - `onAlertTriggered(listener)` → función para cancelar la suscripción.
 * - `emitAlertTriggered(payload)` notifica a cada listener de forma
 *   asíncrona y aislada: un listener que lanza (sync o async) solo deja un
 *   warning en el log; no rompe la evaluación de la alerta ni a los demás.
 *
 * payload = { userId, alertId, alertName, direction, asset, score,
 *             thresholdPercent, eventId, candleCloseTime, triggeredAt }
 */

const logger = require('../logger.service');

const listeners = new Set();

function onAlertTriggered(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('onAlertTriggered: el listener debe ser una función');
  }
  // Envoltorio propio: la misma función puede suscribirse dos veces y cada
  // unsubscribe quita solo la suya.
  const entry = { listener };
  listeners.add(entry);
  return function unsubscribe() {
    listeners.delete(entry);
  };
}

function emitAlertTriggered(payload) {
  // Copia congelada: un listener no puede alterar lo que ven los demás.
  const snapshot = Object.freeze({ ...payload });
  const targets = Array.from(listeners);
  for (const { listener } of targets) {
    setImmediate(() => {
      Promise.resolve()
        .then(() => listener(snapshot))
        .catch((err) => {
          logger.warn('alert_event_listener_failed', {
            alertId: snapshot.alertId,
            eventId: snapshot.eventId,
            asset: snapshot.asset,
            error: err?.message || String(err),
          });
        });
    });
  }
  return targets.length;
}

function listenerCount() {
  return listeners.size;
}

module.exports = {
  emitAlertTriggered,
  listenerCount,
  onAlertTriggered,
};
