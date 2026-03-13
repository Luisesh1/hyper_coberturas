const crypto = require('crypto');
const config = require('../config');
const settingsRepository = require('../repositories/settings.repository');
const { ValidationError } = require('../errors/app-error');

const ENCRYPTED_PREFIX = 'enc:v1:';
const SENSITIVE_KEYS = new Set(['wallet', 'telegram', 'etherscan']);

function getEncryptionKey() {
  return config.security.settingsEncryptionKey;
}

function deriveKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptJson(value) {
  const secret = getEncryptionKey();
  if (!secret) {
    throw new ValidationError('SETTINGS_ENCRYPTION_KEY no configurada');
  }

  const iv = crypto.randomBytes(12);
  const key = deriveKey(secret);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const json = JSON.stringify(value);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptValue(raw) {
  if (!raw) return null;

  if (!raw.startsWith(ENCRYPTED_PREFIX)) {
    return JSON.parse(raw);
  }

  const secret = getEncryptionKey();
  if (!secret) {
    throw new ValidationError('SETTINGS_ENCRYPTION_KEY no configurada');
  }

  const payload = raw.slice(ENCRYPTED_PREFIX.length);
  const [ivB64, tagB64, dataB64] = payload.split(':');
  const key = deriveKey(secret);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

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
  return (await getSetting(userId, 'wallet')) || { address: '' };
}

async function setWallet(userId, wallet) {
  await setSetting(userId, 'wallet', wallet);
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
