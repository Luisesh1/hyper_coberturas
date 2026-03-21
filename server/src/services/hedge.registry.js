/**
 * hedge.registry.js
 *
 * Mantiene una instancia de HedgeService por usuario y cuenta.
 * Al crear la instancia, carga el estado desde la DB automáticamente.
 */

const HedgeService = require('./hedge.service');
const hlRegistry   = require('./hyperliquid.registry');
const tgRegistry   = require('./telegram.registry');
const hyperliquidAccountsService = require('./hyperliquid-accounts.service');
const { createRegistry } = require('./registry.factory');

const registry = createRegistry({
  name: 'HedgeRegistry',
  keyFn: (userId, accountId) => `${userId}:${accountId}`,
  async buildFn(userId, accountId) {
    const [account, hl, tg] = await Promise.all([
      hyperliquidAccountsService.resolveAccount(userId, accountId),
      hlRegistry.getOrCreate(userId, accountId),
      tgRegistry.getOrCreate(userId),
    ]);
    const service = new HedgeService(userId, account, hl, tg);
    await service.init();
    return service;
  },
  destroyFn(service) {
    service.stopMonitor();
  },
});

async function getOrCreate(userId, accountId) {
  const account = await hyperliquidAccountsService.resolveAccount(userId, accountId);
  return registry.getOrCreate(userId, account.id);
}

async function getOrCreateAllForUser(userId) {
  const accounts = await hyperliquidAccountsService.listAccounts(userId);
  return Promise.all(accounts.map((account) => getOrCreate(userId, account.id)));
}

async function reload(userId, accountId) {
  if (accountId != null) {
    registry.destroy(userId, accountId);
    return registry.getOrCreate(userId, accountId);
  }
  registry.destroyByPrefix(`${userId}:`);
  return null;
}

function get(userId, accountId) {
  if (accountId == null) return null;
  return registry.get(userId, accountId);
}

function destroy(userId, accountId) {
  registry.destroy(userId, accountId);
}

module.exports = {
  destroy,
  destroyAll: registry.destroyAll,
  get,
  getAll: registry.getAll,
  getOrCreate,
  getOrCreateAllForUser,
  onCreate: registry.onCreate,
  reload,
};
