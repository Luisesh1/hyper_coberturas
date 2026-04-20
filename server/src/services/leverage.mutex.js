/**
 * leverage.mutex.js
 *
 * Mutex compartido para serializar cambios de leverage / margen sobre el mismo
 * par (accountId, assetIndex). Evita que aperturas concurrentes desde la UI,
 * Telegram, hedge monitor o el orquestador delta-neutral dejen a Hyperliquid
 * en un estado de leverage distinto al esperado por cada llamador.
 *
 * Key canónica: `${accountId}:${assetIndex}` (o la coin si el index aún no se
 * ha resuelto). Mantener la misma función de key en todos los llamadores.
 */

const KeyedMutex = require('../utils/keyed-mutex');

const mutex = new KeyedMutex();

function leverageKey({ accountId, assetIndex, coin } = {}) {
  const suffix = assetIndex != null ? String(assetIndex) : String(coin || '').toUpperCase();
  return `${accountId || 'nil'}:${suffix}`;
}

function runExclusive(key, fn) {
  return mutex.runExclusive(key, fn);
}

module.exports = { runExclusive, leverageKey };
