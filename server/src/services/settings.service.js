const settingsRepository = require('../repositories/settings.repository');
const hyperliquidAccountsService = require('./hyperliquid-accounts.service');
const { decryptValue, encryptJson, ENCRYPTED_PREFIX } = require('./settings.crypto');
const {
  DEFAULT_RISK_PAUSE_LIQ_DISTANCE_PCT,
  DEFAULT_MARGIN_TOP_UP_LIQ_DISTANCE_PCT,
} = require('./protected-pool-delta-neutral.helpers');

const SENSITIVE_KEYS = new Set(['wallet', 'telegram', 'etherscan', 'alchemy']);
const DELTA_NEUTRAL_RISK_KEY = 'delta_neutral_risk_controls';
const deltaNeutralRiskCache = new Map();

function getDefaultDeltaNeutralRiskControls() {
  return {
    riskPauseLiqDistancePct: DEFAULT_RISK_PAUSE_LIQ_DISTANCE_PCT,
    marginTopUpLiqDistancePct: DEFAULT_MARGIN_TOP_UP_LIQ_DISTANCE_PCT,
  };
}

function normalizeDeltaNeutralRiskControls(value = {}) {
  const defaults = getDefaultDeltaNeutralRiskControls();
  const parsedRiskPauseLiqDistancePct = Number(value?.riskPauseLiqDistancePct);
  const parsedMarginTopUpLiqDistancePct = Number(value?.marginTopUpLiqDistancePct);
  const riskPauseLiqDistancePct = Number.isFinite(parsedRiskPauseLiqDistancePct) && parsedRiskPauseLiqDistancePct > 0
    ? parsedRiskPauseLiqDistancePct
    : defaults.riskPauseLiqDistancePct;
  let marginTopUpLiqDistancePct = Number.isFinite(parsedMarginTopUpLiqDistancePct) && parsedMarginTopUpLiqDistancePct > 0
    ? parsedMarginTopUpLiqDistancePct
    : defaults.marginTopUpLiqDistancePct;

  if (marginTopUpLiqDistancePct <= riskPauseLiqDistancePct) {
    marginTopUpLiqDistancePct = Math.max(defaults.marginTopUpLiqDistancePct, riskPauseLiqDistancePct + 1);
  }

  return {
    riskPauseLiqDistancePct,
    marginTopUpLiqDistancePct,
  };
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

async function getDeltaNeutralRiskControls(userId) {
  if (deltaNeutralRiskCache.has(userId)) {
    return deltaNeutralRiskCache.get(userId);
  }

  const stored = await getSetting(userId, DELTA_NEUTRAL_RISK_KEY);
  const normalized = normalizeDeltaNeutralRiskControls(stored);
  if (!stored) {
    await setSetting(userId, DELTA_NEUTRAL_RISK_KEY, normalized);
  }
  deltaNeutralRiskCache.set(userId, normalized);
  return normalized;
}

async function setDeltaNeutralRiskControls(userId, controls) {
  const normalized = normalizeDeltaNeutralRiskControls(controls);
  await setSetting(userId, DELTA_NEUTRAL_RISK_KEY, normalized);
  deltaNeutralRiskCache.set(userId, normalized);
  return normalized;
}

module.exports = {
  ENCRYPTED_PREFIX,
  decryptValue,
  encryptJson,
  getDefaultDeltaNeutralRiskControls,
  normalizeDeltaNeutralRiskControls,
  getTelegram,
  listTelegramConfigs,
  setTelegram,
  getWallet,
  setWallet,
  getEtherscan,
  setEtherscan,
  getAlchemy,
  setAlchemy,
  getDeltaNeutralRiskControls,
  setDeltaNeutralRiskControls,
};
