/**
 * hedge.registry.js
 *
 * Mantiene una instancia de HedgeService por usuario.
 * Al crear la instancia, carga el estado desde la DB automáticamente.
 */

const HedgeService = require('./hedge.service');
const hlRegistry   = require('./hyperliquid.registry');
const tgRegistry   = require('./telegram.registry');
const hyperliquidAccountsService = require('./hyperliquid-accounts.service');

const registry = new Map(); // `${userId}:${accountId}` -> HedgeService
const createListeners = new Set();

function key(userId, accountId) {
  return `${userId}:${accountId}`;
}

async function buildService(userId, accountId) {
  const [account, hl, tg] = await Promise.all([
    hyperliquidAccountsService.resolveAccount(userId, accountId),
    hlRegistry.getOrCreate(userId, accountId),
    tgRegistry.getOrCreate(userId),
  ]);

  const service = new HedgeService(userId, account, hl, tg);
  await service.init();
  registry.set(key(userId, account.id), service);

  for (const listener of createListeners) {
    try {
      await listener(service);
    } catch (err) {
      console.error(`[HedgeRegistry] Error en onCreate para user ${userId}:`, err.message);
    }
  }

  return service;
}

async function getOrCreate(userId, accountId) {
  const account = await hyperliquidAccountsService.resolveAccount(userId, accountId);
  const entryKey = key(userId, account.id);
  if (registry.has(entryKey)) return registry.get(entryKey);
  return buildService(userId, account.id);
}

async function getOrCreateAllForUser(userId) {
  const accounts = await hyperliquidAccountsService.listAccounts(userId);
  return Promise.all(accounts.map((account) => getOrCreate(userId, account.id)));
}

async function reload(userId, accountId) {
  if (accountId != null) {
    const current = registry.get(key(userId, accountId));
    if (current) current.stopMonitor();
    registry.delete(key(userId, accountId));
    return buildService(userId, accountId);
  }

  for (const [entryKey, service] of registry.entries()) {
    if (!entryKey.startsWith(`${userId}:`)) continue;
    service.stopMonitor();
    registry.delete(entryKey);
  }
  return null;
}

function get(userId, accountId) {
  if (accountId == null) return null;
  return registry.get(key(userId, accountId)) || null;
}

function destroy(userId, accountId) {
  const current = registry.get(key(userId, accountId));
  if (current) current.stopMonitor();
  registry.delete(key(userId, accountId));
}

/** Devuelve todos los HedgeService activos (para routing de fills en WS) */
function getAll() {
  return [...registry.values()];
}

function onCreate(listener) {
  createListeners.add(listener);
  return () => createListeners.delete(listener);
}

module.exports = {
  destroy,
  get,
  getAll,
  getOrCreate,
  getOrCreateAllForUser,
  onCreate,
  reload,
};
