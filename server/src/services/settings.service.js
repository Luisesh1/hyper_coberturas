const settingsRepository = require('../repositories/settings.repository');
const hyperliquidAccountsService = require('./hyperliquid-accounts.service');
const { decryptValue, encryptJson, ENCRYPTED_PREFIX } = require('./settings.crypto');

const SENSITIVE_KEYS = new Set(['wallet', 'telegram', 'etherscan', 'alchemy']);

async function getSetting(userId, key) {
  const row = await settingsRepository.getByKey(userId, key);
  if (!row) return null;
  return decryptValue(row.value);
}

async function setSetting(userId, key, value) {
  const serialized = SENSITIVE_KEYS.has(key)
    ? encryptJson(value)
    : JSON.stringify(value);
  await settingsRepository.upsert(userId, key, serialized);
}

async function getTelegram(userId) {
  return (await getSetting(userId, 'telegram')) || { token: '', chatId: '' };
}

async function listTelegramConfigs() {
  const rows = await settingsRepository.listByKey('telegram');

  return rows
    .map((row) => {
      try {
        const telegram = decryptValue(row.value) || {};
        const token = String(telegram.token || '').trim();
        const chatId = String(telegram.chatId || '').trim();
        return {
          userId: Number(row.user_id),
          token,
          chatId,
          enabled: !!(token && chatId),
          updatedAt: row.updated_at != null ? Number(row.updated_at) : null,
        };
      } catch {
        return null;
      }
    })
    .filter((item) => item?.enabled);
}

async function setTelegram(userId, telegram) {
  await setSetting(userId, 'telegram', telegram);
}

async function getWallet(userId) {
  const account = await hyperliquidAccountsService.getDefaultAccount(userId);
  return account
    ? {
        id: account.id,
        alias: account.alias,
        address: account.address,
        hasPrivateKey: account.hasPrivateKey,
      }
    : { address: '' };
}

async function setWallet(userId, wallet) {
  return hyperliquidAccountsService.upsertDefaultWallet(userId, wallet);
}

async function getEtherscan(userId) {
  return (await getSetting(userId, 'etherscan')) || { apiKey: '' };
}

async function setEtherscan(userId, etherscan) {
  await setSetting(userId, 'etherscan', etherscan);
}

async function getAlchemy(userId) {
  return (await getSetting(userId, 'alchemy')) || { apiKey: '' };
}

async function setAlchemy(userId, alchemy) {
  await setSetting(userId, 'alchemy', alchemy);
}

module.exports = {
  ENCRYPTED_PREFIX,
  decryptValue,
  encryptJson,
  getTelegram,
  listTelegramConfigs,
  setTelegram,
  getWallet,
  setWallet,
  getEtherscan,
  setEtherscan,
  getAlchemy,
  setAlchemy,
};
