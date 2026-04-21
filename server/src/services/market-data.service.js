const { ValidationError } = require('../errors/app-error');
const hyperliquidProvider = require('./marketdata-providers/hyperliquid.provider');
const binanceProvider = require('./marketdata-providers/binance.provider');
const yahooProvider = require('./marketdata-providers/yahoo.provider');

const PROVIDERS = {
  hyperliquid: hyperliquidProvider,
  binance: binanceProvider,
  yahoo: yahooProvider,
};
const DEFAULT_DATASOURCE = 'hyperliquid';

const cache = new Map();
const pairCache = new Map();
const CACHE_TTL_MS = 10_000;

const TIMEFRAME_TO_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
  '1M': 30 * 24 * 60 * 60_000, // aproximacion; Hyperliquid devuelve candles de mes real
};

function normalizeTimeframe(timeframe = '15m') {
  const normalized = String(timeframe || '15m').trim();
  if (!TIMEFRAME_TO_MS[normalized]) {
    throw new ValidationError(`timeframe invalido: ${normalized}`);
  }
  return normalized;
}

function normalizeAsset(asset = 'BTC') {
  const normalized = String(asset || 'BTC').trim();
  if (!normalized) throw new ValidationError('asset requerido');
  // hyperliquid/binance usan mayusculas; yahoo distingue mayus/minus (no forzar).
  return normalized;
}

function normalizeDatasource(ds) {
  const normalized = String(ds || DEFAULT_DATASOURCE).trim().toLowerCase();
  if (!PROVIDERS[normalized]) {
    throw new ValidationError(`datasource invalido: ${normalized}`);
  }
  return normalized;
}

function buildCacheKey(datasource, asset, timeframe, startTime, endTime) {
  return `${datasource}:${asset}:${timeframe}:${startTime}:${endTime}`;
}

function buildPairKey(datasource, asset, timeframe) {
  return `${datasource}:${asset}:${timeframe}`;
}

async function getCandles(asset, timeframe, {
  datasource,
  limit = 200,
  startTime,
  endTime = Date.now(),
  force = false,
} = {}) {
  const normalizedDs = normalizeDatasource(datasource);
  const normalizedAsset = normalizeAsset(asset);
  const normalizedTimeframe = normalizeTimeframe(timeframe);
  const timeframeMs = TIMEFRAME_TO_MS[normalizedTimeframe];
  const normalizedLimit = Math.max(10, Math.min(1000, Number(limit) || 200));
  const normalizedEnd = Number(endTime) || Date.now();
  const normalizedStart = Number(startTime) || (normalizedEnd - (normalizedLimit * timeframeMs));
  const cacheKey = buildCacheKey(normalizedDs, normalizedAsset, normalizedTimeframe, normalizedStart, normalizedEnd);
  const cached = cache.get(cacheKey);

  if (!force && cached && (Date.now() - cached.createdAt) < CACHE_TTL_MS) {
    return cached.value;
  }

  const provider = PROVIDERS[normalizedDs];
  const rows = await provider.fetchCandles({
    symbol: normalizedAsset,
    timeframe: normalizedTimeframe,
    startTime: normalizedStart,
    endTime: normalizedEnd,
  });

  const value = Array.isArray(rows) ? rows.slice().sort((a, b) => a.time - b.time) : [];
  cache.set(cacheKey, { createdAt: Date.now(), value });
  pairCache.set(buildPairKey(normalizedDs, normalizedAsset, normalizedTimeframe), {
    createdAt: Date.now(),
    value,
  });
  return value;
}

function getCachedCandles(asset, timeframe, { datasource, maxAgeMs = Infinity } = {}) {
  const normalizedDs = normalizeDatasource(datasource);
  const normalizedAsset = normalizeAsset(asset);
  const normalizedTimeframe = normalizeTimeframe(timeframe);
  const entry = pairCache.get(buildPairKey(normalizedDs, normalizedAsset, normalizedTimeframe));
  if (!entry) return null;
  if ((Date.now() - entry.createdAt) > maxAgeMs) return null;
  return entry.value;
}

async function getLatestClosedCandle(asset, timeframe, options = {}) {
  const candles = await getCandles(asset, timeframe, { limit: 5, ...options });
  const now = Date.now();
  const closed = candles.filter((candle) => candle.closeTime < now);
  return closed[closed.length - 1] || null;
}

module.exports = {
  TIMEFRAME_TO_MS,
  PROVIDERS,
  DEFAULT_DATASOURCE,
  getCandles,
  getCachedCandles,
  getLatestClosedCandle,
  normalizeAsset,
  normalizeTimeframe,
  normalizeDatasource,
};
