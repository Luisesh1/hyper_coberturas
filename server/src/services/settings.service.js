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

const CHART_INDICATORS_KEY = 'chart_indicators';
const CHART_INDICATOR_TYPES = new Set([
  'sma', 'ema', 'wma', 'bollinger', 'keltner', 'vwap',
  'rsi', 'macd', 'stoch', 'atr', 'adx', 'volume', 'sqzmom',
]);
const MAX_CHART_INDICATORS = 20;

function getDefaultChartIndicators() {
  return {
    version: 1,
    indicators: [
      {
        uid: 'sqzmom-default',
        type: 'sqzmom',
        params: { length: 20, mult: 2.0, lengthKC: 20, multKC: 1.5, useTrueRange: true },
        style: {},
        visible: true,
      },
    ],
  };
}

function normalizeStyle(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  if (typeof raw.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw.color)) out.color = raw.color;
  const lineWidth = Number(raw.lineWidth);
  if (Number.isFinite(lineWidth) && lineWidth >= 1 && lineWidth <= 5) out.lineWidth = Math.floor(lineWidth);
  if (['solid', 'dashed', 'dotted'].includes(raw.lineStyle)) out.lineStyle = raw.lineStyle;
  return out;
}

function normalizeIndicatorEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').toLowerCase();
  if (!CHART_INDICATOR_TYPES.has(type)) return null;

  const params = {};
  if (raw.params && typeof raw.params === 'object') {
    for (const [k, v] of Object.entries(raw.params)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        params[k] = v;
      } else if (typeof v === 'boolean') {
        params[k] = v;
      } else if (typeof v === 'string' && v.length <= 40) {
        params[k] = v;
      }
    }
  }

  const uid = typeof raw.uid === 'string' && raw.uid.length > 0 && raw.uid.length <= 64
    ? raw.uid
    : `${type}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    uid,
    type,
    params,
    style: normalizeStyle(raw.style),
    visible: raw.visible !== false,
  };
}

function normalizeChartIndicators(value) {
  if (!value || typeof value !== 'object') return getDefaultChartIndicators();
  const raw = Array.isArray(value.indicators) ? value.indicators : [];
  const indicators = raw
    .map(normalizeIndicatorEntry)
    .filter(Boolean)
    .slice(0, MAX_CHART_INDICATORS);
  return { version: 1, indicators };
}

// ------------------------------------------------------------------
// Chart drawings (trend lines, horizontal, rectangles, fib) — per symbol
// ------------------------------------------------------------------
const CHART_DRAWINGS_KEY = 'chart_drawings';
const CHART_DRAWING_TYPES = new Set(['trendline', 'horizontal', 'rectangle', 'fib']);
const MAX_DRAWINGS_PER_SYMBOL = 50;
const MAX_SYMBOLS_PER_USER = 40;

function normalizeDrawingStyle(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw.color)) out.color = raw.color;
  const lineWidth = Number(raw.lineWidth);
  if (Number.isFinite(lineWidth) && lineWidth >= 1 && lineWidth <= 5) out.lineWidth = Math.floor(lineWidth);
  if (['solid', 'dashed', 'dotted'].includes(raw.lineStyle)) out.lineStyle = raw.lineStyle;
  const fillOpacity = Number(raw.fillOpacity);
  if (Number.isFinite(fillOpacity) && fillOpacity >= 0 && fillOpacity <= 1) out.fillOpacity = fillOpacity;
  return out;
}

function normalizeAnchor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (raw.time != null) {
    const t = Number(raw.time);
    if (!Number.isFinite(t) || t <= 0) return null;
    out.time = Math.floor(t);
  }
  if (raw.price != null) {
    const p = Number(raw.price);
    if (!Number.isFinite(p)) return null;
    out.price = p;
  }
  if (out.time == null && out.price == null) return null;
  return out;
}

function normalizeDrawingEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').toLowerCase();
  if (!CHART_DRAWING_TYPES.has(type)) return null;

  const anchors = Array.isArray(raw.anchors)
    ? raw.anchors.map(normalizeAnchor).filter(Boolean)
    : [];

  // Cada tipo requiere una forma específica
  if (type === 'horizontal' && anchors.length !== 1) return null;
  if (type === 'horizontal' && anchors[0].price == null) return null;
  if ((type === 'trendline' || type === 'rectangle' || type === 'fib')
      && (anchors.length !== 2 || anchors.some((a) => a.time == null || a.price == null))) {
    return null;
  }

  const uid = typeof raw.uid === 'string' && raw.uid.length > 0 && raw.uid.length <= 64
    ? raw.uid
    : `${type}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    uid,
    type,
    anchors,
    style: normalizeDrawingStyle(raw.style),
    visible: raw.visible !== false,
  };
}

function normalizeSymbolKey(symbol) {
  const s = String(symbol || '').trim();
  if (!s) return null;
  if (s.length > 32) return null;
  // Permite letras, números, guiones y símbolos comunes de tickers (=, ^, ., /, _)
  if (!/^[A-Za-z0-9\-=^./_]+$/.test(s)) return null;
  return s;
}

function normalizeChartDrawingsAll(value) {
  if (!value || typeof value !== 'object') return { version: 1, bySymbol: {} };
  const raw = value.bySymbol && typeof value.bySymbol === 'object' ? value.bySymbol : {};
  const bySymbol = {};
  const symbols = Object.keys(raw).slice(0, MAX_SYMBOLS_PER_USER);
  for (const sym of symbols) {
    const key = normalizeSymbolKey(sym);
    if (!key) continue;
    const list = Array.isArray(raw[sym]) ? raw[sym] : [];
    const normalized = list
      .map(normalizeDrawingEntry)
      .filter(Boolean)
      .slice(0, MAX_DRAWINGS_PER_SYMBOL);
    if (normalized.length > 0) bySymbol[key] = normalized;
  }
  return { version: 1, bySymbol };
}

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

async function getChartIndicators(userId) {
  const stored = await getSetting(userId, CHART_INDICATORS_KEY);
  if (!stored) return getDefaultChartIndicators();
  return normalizeChartIndicators(stored);
}

async function setChartIndicators(userId, config) {
  const normalized = normalizeChartIndicators(config);
  await setSetting(userId, CHART_INDICATORS_KEY, normalized);
  return normalized;
}

async function getChartDrawingsAll(userId) {
  const stored = await getSetting(userId, CHART_DRAWINGS_KEY);
  return normalizeChartDrawingsAll(stored);
}

async function getChartDrawingsForSymbol(userId, symbol) {
  const key = normalizeSymbolKey(symbol);
  if (!key) return [];
  const all = await getChartDrawingsAll(userId);
  return all.bySymbol[key] || [];
}

async function setChartDrawingsForSymbol(userId, symbol, list) {
  const key = normalizeSymbolKey(symbol);
  if (!key) throw new Error('symbol invalido');
  const all = await getChartDrawingsAll(userId);
  const next = Array.isArray(list)
    ? list.map(normalizeDrawingEntry).filter(Boolean).slice(0, MAX_DRAWINGS_PER_SYMBOL)
    : [];
  if (next.length === 0) {
    delete all.bySymbol[key];
  } else {
    all.bySymbol[key] = next;
  }
  // Aplica el cap de simbolos
  const keys = Object.keys(all.bySymbol);
  if (keys.length > MAX_SYMBOLS_PER_USER) {
    for (const k of keys.slice(MAX_SYMBOLS_PER_USER)) delete all.bySymbol[k];
  }
  await setSetting(userId, CHART_DRAWINGS_KEY, all);
  return next;
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
  getChartIndicators,
  setChartIndicators,
  getDefaultChartIndicators,
  normalizeChartIndicators,
  CHART_INDICATOR_TYPES,
  getChartDrawingsAll,
  getChartDrawingsForSymbol,
  setChartDrawingsForSymbol,
  normalizeChartDrawingsAll,
  normalizeDrawingEntry,
  CHART_DRAWING_TYPES,
};
