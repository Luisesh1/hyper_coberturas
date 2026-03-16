/**
 * hyperliquid.registry.js
 *
 * Mantiene una instancia de HyperliquidService por usuario y cuenta.
 */

const HyperliquidService = require('./hyperliquid.service');
const hyperliquidAccountsService = require('./hyperliquid-accounts.service');
const { createRegistry } = require('./registry.factory');

const registry = createRegistry({
  name: 'HyperliquidRegistry',
  keyFn: (userId, accountId) => `${userId}:${accountId}`,
  async buildFn(userId, accountId) {
    const account = await hyperliquidAccountsService.resolveAccount(userId, accountId, {
      includePrivateKey: true,
    });
    const service = new HyperliquidService({
      privateKey: account.privateKey,
      address: account.address,
    });
    // Adjuntar metadata de cuenta para routing en WS
    service._account = account;
    return service;
  },
});

async function getOrCreate(userId, accountId) {
  const account = await hyperliquidAccountsService.resolveAccount(userId, accountId);
  return registry.getOrCreate(userId, account.id);
}

async function reload(userId, accountId) {
  if (accountId != null) {
    registry.destroy(userId, accountId);
    return getOrCreate(userId, accountId);
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

function getAllEntries() {
  const result = [];
  for (const [entryKey, service] of registry.entries()) {
    const [userId, accountId] = entryKey.split(':');
    result.push({
      userId: Number(userId),
      accountId: Number(accountId),
      address: service.address,
      service,
      account: service._account,
    });
  }
  return result;
}

module.exports = { destroy, get, getAllEntries, getOrCreate, reload };
