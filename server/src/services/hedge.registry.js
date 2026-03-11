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
const createListeners = new Set();

async function buildService(userId) {
  const [hl, tg] = await Promise.all([
    hlRegistry.getOrCreate(userId),
    tgRegistry.getOrCreate(userId),
  ]);

  const service = new HedgeService(userId, hl, tg);
  await service.init();
  registry.set(userId, service);

  for (const listener of createListeners) {
    try {
      await listener(service);
    } catch (err) {
      console.error(`[HedgeRegistry] Error en onCreate para user ${userId}:`, err.message);
    }
  }

  return service;
}

async function getOrCreate(userId) {
  if (registry.has(userId)) return registry.get(userId);
  return buildService(userId);
}

async function reload(userId) {
  const current = registry.get(userId);
  if (current) current.stopMonitor();
  registry.delete(userId);
  return buildService(userId);
}

function get(userId) {
  return registry.get(userId) || null;
}

/** Devuelve todos los HedgeService activos (para routing de fills en WS) */
function getAll() {
  return [...registry.values()];
}

function onCreate(listener) {
  createListeners.add(listener);
  return () => createListeners.delete(listener);
}

module.exports = { getOrCreate, reload, get, getAll, onCreate };
