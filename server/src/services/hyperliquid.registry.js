/**
 * hyperliquid.registry.js
 *
 * Mantiene una instancia de HyperliquidService por usuario y cuenta.
 */

const HyperliquidService = require('./hyperliquid.service');
const hyperliquidAccountsService = require('./hyperliquid-accounts.service');

const registry = new Map(); // `${userId}:${accountId}` -> { service, account }

function key(userId, accountId) {
  return `${userId}:${accountId}`;
}

async function buildEntry(userId, accountId) {
  const account = await hyperliquidAccountsService.resolveAccount(userId, accountId, {
    includePrivateKey: true,
  });
  const service = new HyperliquidService({
    privateKey: account.privateKey,
    address: account.address,
  });
  registry.set(key(userId, account.id), { service, account });
  return service;
}

async function getOrCreate(userId, accountId) {
  const account = await hyperliquidAccountsService.resolveAccount(userId, accountId);
  const entryKey = key(userId, account.id);
  if (registry.has(entryKey)) return registry.get(entryKey).service;
  return buildEntry(userId, account.id);
}

async function reload(userId, accountId) {
  if (accountId != null) {
    registry.delete(key(userId, accountId));
    return getOrCreate(userId, accountId);
  }

  for (const entryKey of registry.keys()) {
    if (entryKey.startsWith(`${userId}:`)) {
      registry.delete(entryKey);
    }
  }
  return null;
}

function get(userId, accountId) {
  if (accountId == null) return null;
  return registry.get(key(userId, accountId))?.service || null;
}

function destroy(userId, accountId) {
  registry.delete(key(userId, accountId));
}

function getAllEntries() {
  const result = [];
  for (const [entryKey, entry] of registry.entries()) {
    const [userId, accountId] = entryKey.split(':');
    result.push({
      userId: Number(userId),
      accountId: Number(accountId),
      address: entry.service.address,
      service: entry.service,
      account: entry.account,
    });
  }
  return result;
}

module.exports = {
  destroy,
  get,
  getAllEntries,
  getOrCreate,
  reload,
};
