const settingsRepository = require('../repositories/settings.repository');
const hyperliquidAccountsService = require('./hyperliquid-accounts.service');
const { decryptValue, encryptJson, ENCRYPTED_PREFIX } = require('./settings.crypto');

const SENSITIVE_KEYS = new Set(['wallet', 'telegram', 'etherscan']);

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

module.exports = {
  ENCRYPTED_PREFIX,
  decryptValue,
  encryptJson,
  getSetting,
  setSetting,
  getTelegram,
  setTelegram,
  getWallet,
  setWallet,
  getEtherscan,
  setEtherscan,
};
