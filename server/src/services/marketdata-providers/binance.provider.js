const httpClient = require('../../shared/platform/http/http-client');

// Binance klines soporta muchos intervalos; mapeamos nuestros valores estándar
// al formato de su API.
const INTERVAL_MAP = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1w': '1w',
  '1M': '1M',
};

const INTERVAL_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
  '1M': 30 * 24 * 60_000 * 60,
};

const MAX_BATCH_SIZE = 1000;
const MAX_PAGINATED_CANDLES = 10000;

async function fetchCandles({ symbol, timeframe, startTime, endTime }) {
  const interval = INTERVAL_MAP[timeframe];
  if (!interval) {
    throw new Error(`binance: timeframe ${timeframe} no soportado`);
  }

  const normalizedSymbol = String(symbol || '').toUpperCase();
  const normalizedEnd = Number(endTime) || Date.now();
  const intervalMs = INTERVAL_MS[timeframe] || 60_000;
  let cursor = Number(startTime) || (normalizedEnd - (MAX_BATCH_SIZE * intervalMs));
  const rows = [];

  while (cursor < normalizedEnd && rows.length < MAX_PAGINATED_CANDLES) {
    const params = new URLSearchParams({
      symbol: normalizedSymbol,
      interval,
      limit: String(MAX_BATCH_SIZE),
      startTime: String(Math.floor(cursor)),
      endTime: String(Math.floor(normalizedEnd)),
    });

    const url = `https://api.binance.com/api/v3/klines?${params.toString()}`;
    const { data } = await httpClient.get(url, { timeout: 10_000 });
    if (!Array.isArray(data) || data.length === 0) break;
    rows.push(...data);

    const lastOpenTime = Number(data[data.length - 1]?.[0]);
    if (!Number.isFinite(lastOpenTime) || lastOpenTime < cursor) break;
    cursor = lastOpenTime + intervalMs;
    if (data.length < MAX_BATCH_SIZE) break;
  }

  // Formato Binance: [openTime, open, high, low, close, volume, closeTime, ...]
  return rows.slice(0, MAX_PAGINATED_CANDLES).map((row) => ({
    time: Number(row[0]),
    closeTime: Number(row[6]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    trades: Number(row[8] || 0),
  }));
}

module.exports = {
  name: 'binance',
  supportedIntervals: Object.keys(INTERVAL_MAP),
  fetchCandles,
};
