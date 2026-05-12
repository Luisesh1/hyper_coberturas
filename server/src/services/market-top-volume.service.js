/**
 * market-top-volume.service.js
 *
 * Devuelve los N activos con mayor volumen para un datasource y ventana
 * temporal (1d / 1w / 1M). Usado por el picker de activos en /alertas.
 *
 * - Binance: 1d → ticker/24hr; 1w/1M → top 80 candidatos por 1d, expandidos
 *   con klines daily (volumen quote sumado).
 * - Hyperliquid: 1d → metaAndAssetCtxs (dayNtlVlm). 1w/1M no soportado por
 *   ahora (requiere candleSnapshot por activo, costoso).
 * - Yahoo: no soportado (no aplica para acciones/índices/forex).
 *
 * Cache en memoria con TTL 5min por (datasource, window, limit).
 */

const httpClient = require('../shared/platform/http/http-client');
const marketData = require('./market-data.service');
const logger = require('./logger.service');

const SUPPORTED_DATASOURCES = new Set(['binance', 'hyperliquid']);
const SUPPORTED_WINDOWS = new Set(['1d', '1w', '1M']);
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE = new Map();

function cacheKey(datasource, window, limit) {
  return `${datasource}:${window}:${limit}`;
}

async function getTopByVolume({ datasource, window = '1d', limit = 20 } = {}) {
  const ds = String(datasource || '').toLowerCase();
  const w = String(window || '1d');
  const n = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));

  if (!SUPPORTED_DATASOURCES.has(ds)) {
    throw new Error(`datasource '${ds}' no soporta top-volumen`);
  }
  if (!SUPPORTED_WINDOWS.has(w)) {
    throw new Error(`window '${w}' inválida (usar 1d|1w|1M)`);
  }

  const key = cacheKey(ds, w, n);
  const cached = CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  let data;
  if (ds === 'binance')         data = await topBinance(w, n);
  else if (ds === 'hyperliquid') data = await topHyperliquid(w, n);
  else                           data = [];

  CACHE.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

// ------------------------------------------------------------------
// Binance
// ------------------------------------------------------------------

async function topBinance(window, limit) {
  // ticker/24hr trae TODO el spot. Filtramos pares USDT "limpios".
  const resp = await httpClient.request({
    method: 'GET',
    url: 'https://api.binance.com/api/v3/ticker/24hr',
    timeout: 15_000,
  });
  const tickers = Array.isArray(resp?.data) ? resp.data : [];

  const cleanUsdt = tickers
    .filter((t) =>
      typeof t.symbol === 'string' &&
      t.symbol.endsWith('USDT') &&
      !t.symbol.includes('UPUSDT') &&
      !t.symbol.includes('DOWNUSDT') &&
      !t.symbol.includes('BULLUSDT') &&
      !t.symbol.includes('BEARUSDT')
    )
    .map((t) => ({
      symbol: t.symbol,
      datasource: 'binance',
      price: Number(t.lastPrice) || 0,
      volumeUsd: Number(t.quoteVolume) || 0,   // volumen 24h en USDT
      change24hPct: Number(t.priceChangePercent) || 0,
    }))
    .sort((a, b) => b.volumeUsd - a.volumeUsd);

  if (window === '1d') {
    return cleanUsdt.slice(0, limit);
  }

  // 1w/1M: top 80 candidatos por 1d, expandidos con klines daily
  const days = window === '1w' ? 7 : 30;
  const candidates = cleanUsdt.slice(0, Math.max(limit * 3, 60));
  const enriched = await Promise.all(candidates.map(async (c) => {
    try {
      const candles = await marketData.getCandles(c.symbol, '1d', {
        datasource: 'binance',
        limit: days,
      });
      const totalQuote = candles.reduce((acc, k) => acc + (Number(k.volume) || 0) * (Number(k.close) || 0), 0);
      return { ...c, volumeUsd: totalQuote };
    } catch (err) {
      logger.warn?.('top_volume_kline_fetch_failed', { symbol: c.symbol, error: err.message });
      return null;
    }
  }));
  return enriched
    .filter(Boolean)
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .slice(0, limit);
}

// ------------------------------------------------------------------
// Hyperliquid
// ------------------------------------------------------------------

async function topHyperliquid(window, limit) {
  // Solo soportamos 1d sin más llamadas. Para 1w/1M caemos a 1d.
  const usedWindow = window === '1d' ? '1d' : '1d';

  const resp = await httpClient.request({
    method: 'POST',
    url: 'https://api.hyperliquid.xyz/info',
    body: { type: 'metaAndAssetCtxs' },
    timeout: 10_000,
  });
  const data = resp?.data;
  const universe = Array.isArray(data?.[0]?.universe) ? data[0].universe : [];
  const ctxs = Array.isArray(data?.[1]) ? data[1] : [];

  const rows = universe.map((u, i) => ({
    symbol: u.name,
    datasource: 'hyperliquid',
    price: Number(ctxs[i]?.markPx) || 0,
    volumeUsd: Number(ctxs[i]?.dayNtlVlm) || 0,
    change24hPct: 0,
    _window: usedWindow,
  })).sort((a, b) => b.volumeUsd - a.volumeUsd);

  return rows.slice(0, limit);
}

// Útil para testing/debug y para que el caller pueda invalidar manualmente.
function clearCache() {
  CACHE.clear();
}

module.exports = {
  getTopByVolume,
  clearCache,
  SUPPORTED_DATASOURCES: Array.from(SUPPORTED_DATASOURCES),
  SUPPORTED_WINDOWS: Array.from(SUPPORTED_WINDOWS),
};
