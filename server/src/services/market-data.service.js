const HyperliquidService = require('./hyperliquid.service');
const { ValidationError } = require('../errors/app-error');

const client = new HyperliquidService();
const cache = new Map();
const pairCache = new Map();
const CACHE_TTL_MS = 10_000;

const TIMEFRAME_TO_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
};

function normalizeTimeframe(timeframe = '15m') {
  const normalized = String(timeframe || '15m').trim();
  if (!TIMEFRAME_TO_MS[normalized]) {
    throw new ValidationError(`timeframe invalido: ${normalized}`);
  }
  return normalized;
}

function normalizeAsset(asset = 'BTC') {
  const normalized = String(asset || 'BTC').trim().toUpperCase();
  if (!normalized) throw new ValidationError('asset requerido');
  return normalized;
}

function normalizeCandle(candle = {}) {
  return {
    time: Number(candle.t),
    closeTime: Number(candle.T),
    open: Number(candle.o),
    high: Number(candle.h),
    low: Number(candle.l),
    close: Number(candle.c),
    volume: Number(candle.v || 0),
    trades: Number(candle.n || 0),
  };
}

function buildCacheKey(asset, timeframe, startTime, endTime) {
  return `${asset}:${timeframe}:${startTime}:${endTime}`;
}

function buildPairKey(asset, timeframe) {
  return `${asset}:${timeframe}`;
}

async function getCandles(asset, timeframe, {
  limit = 200,
  startTime,
  endTime = Date.now(),
  force = false,
} = {}) {
  const normalizedAsset = normalizeAsset(asset);
  const normalizedTimeframe = normalizeTimeframe(timeframe);
  const timeframeMs = TIMEFRAME_TO_MS[normalizedTimeframe];
  const normalizedLimit = Math.max(10, Math.min(1000, Number(limit) || 200));
  const normalizedEnd = Number(endTime) || Date.now();
  const normalizedStart = Number(startTime) || (normalizedEnd - (normalizedLimit * timeframeMs));
  const cacheKey = buildCacheKey(normalizedAsset, normalizedTimeframe, normalizedStart, normalizedEnd);
  const cached = cache.get(cacheKey);

  if (!force && cached && (Date.now() - cached.createdAt) < CACHE_TTL_MS) {
    return cached.value;
  }

  const rows = await client.getCandleSnapshot({
    asset: normalizedAsset,
    interval: normalizedTimeframe,
    startTime: normalizedStart,
    endTime: normalizedEnd,
  });

  const value = Array.isArray(rows) ? rows.map(normalizeCandle).sort((a, b) => a.time - b.time) : [];
  cache.set(cacheKey, { createdAt: Date.now(), value });
  pairCache.set(buildPairKey(normalizedAsset, normalizedTimeframe), {
    createdAt: Date.now(),
    value,
  });
  return value;
}

function getCachedCandles(asset, timeframe, { maxAgeMs = Infinity } = {}) {
  const normalizedAsset = normalizeAsset(asset);
  const normalizedTimeframe = normalizeTimeframe(timeframe);
  const entry = pairCache.get(buildPairKey(normalizedAsset, normalizedTimeframe));
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
  getCandles,
  getCachedCandles,
  getLatestClosedCandle,
  normalizeAsset,
  normalizeTimeframe,
};
