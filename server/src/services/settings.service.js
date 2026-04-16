const settingsRepository = require('../repositories/settings.repository');
const hyperliquidAccountsService = require('./hyperliquid-accounts.service');
const { decryptValue, encryptJson, ENCRYPTED_PREFIX } = require('./settings.crypto');
const {
  DEFAULT_RISK_PAUSE_LIQ_DISTANCE_PCT,
  DEFAULT_MARGIN_TOP_UP_LIQ_DISTANCE_PCT,
  DEFAULT_MAX_AUTO_TOPUPS_PER_24H,
  DEFAULT_MIN_AUTO_TOPUP_CAP_USD,
  DEFAULT_AUTO_TOPUP_CAP_PCT_OF_INITIAL,
  DEFAULT_MIN_AUTO_TOPUP_FLOOR_USD,
} = require('./protected-pool-delta-neutral.helpers');

const SENSITIVE_KEYS = new Set(['wallet', 'telegram', 'etherscan', 'alchemy']);
const DELTA_NEUTRAL_RISK_KEY = 'delta_neutral_risk_controls';
const deltaNeutralRiskCache = new Map();

const NOTIFICATION_CATEGORIES = ['hedge', 'trade', 'runtime', 'deltaNeutralBlock'];

function getDefaultNotificationPrefs() {
  return {
    silencedUntil: null,
    quietHours: null,
    categories: { hedge: true, trade: true, runtime: true, deltaNeutralBlock: true },
    digest: { enabled: true, windowMs: 30_000, minEvents: 3 },
    lastAccountId: null,
  };
}

function normalizeNotificationPrefs(value) {
  const defaults = getDefaultNotificationPrefs();
  if (!value || typeof value !== 'object') return defaults;

  const silencedUntilRaw = Number(value.silencedUntil);
  const silencedUntil = Number.isFinite(silencedUntilRaw) && silencedUntilRaw > Date.now()
    ? silencedUntilRaw
    : null;

  let quietHours = null;
  if (value.quietHours && typeof value.quietHours === 'object') {
    const { start, end, tz } = value.quietHours;
    if (/^\d{2}:\d{2}$/.test(String(start)) && /^\d{2}:\d{2}$/.test(String(end))) {
      quietHours = {
        start: String(start),
        end: String(end),
        tz: typeof tz === 'string' && tz ? tz : 'America/Mexico_City',
      };
    }
  }

  const rawCategories = value.categories && typeof value.categories === 'object' ? value.categories : {};
  const categories = {};
  for (const cat of NOTIFICATION_CATEGORIES) {
    categories[cat] = rawCategories[cat] !== false;
  }

  const rawDigest = value.digest && typeof value.digest === 'object' ? value.digest : {};
  const windowMs = Number(rawDigest.windowMs);
  const minEvents = Number(rawDigest.minEvents);
  const digest = {
    enabled: rawDigest.enabled !== false,
    windowMs: Number.isFinite(windowMs) && windowMs >= 1000 ? windowMs : defaults.digest.windowMs,
    minEvents: Number.isFinite(minEvents) && minEvents >= 2 ? Math.floor(minEvents) : defaults.digest.minEvents,
  };

  const lastAccountIdRaw = Number(value.lastAccountId);
  const lastAccountId = Number.isFinite(lastAccountIdRaw) && lastAccountIdRaw > 0
    ? Math.floor(lastAccountIdRaw)
    : null;

  return { silencedUntil, quietHours, categories, digest, lastAccountId };
}

function getDefaultDeltaNeutralRiskControls() {
  return {
    riskPauseLiqDistancePct: DEFAULT_RISK_PAUSE_LIQ_DISTANCE_PCT,
    marginTopUpLiqDistancePct: DEFAULT_MARGIN_TOP_UP_LIQ_DISTANCE_PCT,
    maxAutoTopUpsPer24h: DEFAULT_MAX_AUTO_TOPUPS_PER_24H,
    minAutoTopUpCapUsd: DEFAULT_MIN_AUTO_TOPUP_CAP_USD,
    autoTopUpCapPctOfInitial: DEFAULT_AUTO_TOPUP_CAP_PCT_OF_INITIAL,
    minAutoTopUpFloorUsd: DEFAULT_MIN_AUTO_TOPUP_FLOOR_USD,
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
  const parsedMaxAutoTopUpsPer24h = Number(value?.maxAutoTopUpsPer24h);
  const parsedMinAutoTopUpCapUsd = Number(value?.minAutoTopUpCapUsd);
  const parsedAutoTopUpCapPctOfInitial = Number(value?.autoTopUpCapPctOfInitial);
  const parsedMinAutoTopUpFloorUsd = Number(value?.minAutoTopUpFloorUsd);
  const maxAutoTopUpsPer24h = Number.isFinite(parsedMaxAutoTopUpsPer24h) && parsedMaxAutoTopUpsPer24h > 0
    ? Math.floor(parsedMaxAutoTopUpsPer24h)
    : defaults.maxAutoTopUpsPer24h;
  const minAutoTopUpCapUsd = Number.isFinite(parsedMinAutoTopUpCapUsd) && parsedMinAutoTopUpCapUsd > 0
    ? parsedMinAutoTopUpCapUsd
    : defaults.minAutoTopUpCapUsd;
  const autoTopUpCapPctOfInitial = Number.isFinite(parsedAutoTopUpCapPctOfInitial) && parsedAutoTopUpCapPctOfInitial > 0
    ? parsedAutoTopUpCapPctOfInitial
    : defaults.autoTopUpCapPctOfInitial;
  const minAutoTopUpFloorUsd = Number.isFinite(parsedMinAutoTopUpFloorUsd) && parsedMinAutoTopUpFloorUsd >= 0
    ? parsedMinAutoTopUpFloorUsd
    : defaults.minAutoTopUpFloorUsd;

  if (marginTopUpLiqDistancePct <= riskPauseLiqDistancePct) {
    marginTopUpLiqDistancePct = Math.max(defaults.marginTopUpLiqDistancePct, riskPauseLiqDistancePct + 1);
  }

  return {
    riskPauseLiqDistancePct,
    marginTopUpLiqDistancePct,
    maxAutoTopUpsPer24h,
    minAutoTopUpCapUsd,
    autoTopUpCapPctOfInitial,
    minAutoTopUpFloorUsd,
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
  const stored = (await getSetting(userId, 'telegram')) || { token: '', chatId: '' };
  return {
    ...stored,
    notificationPrefs: normalizeNotificationPrefs(stored.notificationPrefs),
  };
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
          notificationPrefs: normalizeNotificationPrefs(telegram.notificationPrefs),
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

async function getTelegramNotificationPrefs(userId) {
  const current = await getTelegram(userId);
  return current.notificationPrefs;
}

async function setTelegramNotificationPrefs(userId, patch) {
  const current = (await getSetting(userId, 'telegram')) || { token: '', chatId: '' };
  const currentPrefs = normalizeNotificationPrefs(current.notificationPrefs);
  const merged = normalizeNotificationPrefs({ ...currentPrefs, ...patch });
  await setSetting(userId, 'telegram', { ...current, notificationPrefs: merged });
  return merged;
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
  getTelegramNotificationPrefs,
  setTelegramNotificationPrefs,
  getDefaultNotificationPrefs,
  normalizeNotificationPrefs,
  NOTIFICATION_CATEGORIES,
  getWallet,
  setWallet,
  getEtherscan,
  setEtherscan,
  getAlchemy,
  setAlchemy,
  getDeltaNeutralRiskControls,
  setDeltaNeutralRiskControls,
};
