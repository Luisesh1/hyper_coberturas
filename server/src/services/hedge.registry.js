/**
 * hedge.registry.js
 *
 * Mantiene una instancia de HedgeService por usuario.
 * Al crear la instancia, carga el estado desde la DB automáticamente.
 */

const HedgeService = require('./hedge.service');
const hlRegistry   = require('./hyperliquid.registry');
const tgRegistry   = require('./telegram.registry');

const registry = new Map(); // userId -> HedgeService

async function getOrCreate(userId) {
  if (registry.has(userId)) return registry.get(userId);

  const [hl, tg] = await Promise.all([
    hlRegistry.getOrCreate(userId),
    tgRegistry.getOrCreate(userId),
  ]);

  const service = new HedgeService(userId, hl, tg);
  await service.init();
  registry.set(userId, service);
  return service;
}

function get(userId) {
  return registry.get(userId) || null;
}

/** Devuelve todos los HedgeService activos (para routing de fills en WS) */
function getAll() {
  return [...registry.values()];
}

module.exports = { getOrCreate, get, getAll };
