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

async function fetchCandles({ symbol, timeframe, startTime, endTime }) {
  const interval = INTERVAL_MAP[timeframe];
  if (!interval) {
    throw new Error(`binance: timeframe ${timeframe} no soportado`);
  }
  const params = new URLSearchParams({
    symbol: String(symbol || '').toUpperCase(),
    interval,
    limit: '1000',
  });
  if (startTime) params.append('startTime', String(Math.floor(startTime)));
  if (endTime) params.append('endTime', String(Math.floor(endTime)));

  const url = `https://api.binance.com/api/v3/klines?${params.toString()}`;
  const { data } = await httpClient.get(url, { timeout: 10_000 });
  if (!Array.isArray(data)) return [];
  // Formato Binance: [openTime, open, high, low, close, volume, closeTime, ...]
  return data.map((row) => ({
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
